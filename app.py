"""Веб-сервис: увеличение картинки в 4 раза (Upscayl) и конвертация в PDF для печати (img2pdf)."""

import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import img2pdf
from flask import Flask, abort, jsonify, render_template, request, send_file
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = None  # увеличенные картинки бывают очень большими

BASE = Path(__file__).resolve().parent
UPSCAYL_BIN = BASE / "vendor" / "upscayl-bin" / ("upscayl-bin.exe" if os.name == "nt" else "upscayl-bin")
MODELS_DIR = BASE / "vendor" / "models"
WORK = BASE / "work"
WORK.mkdir(exist_ok=True)

JOB_TTL = 24 * 3600
PREVIEW_MAX = 1600

MODELS = {
    "upscayl-standard-4x": "Стандартная — для фото и большинства картинок",
    "upscayl-lite-4x": "Быстрая — для слабых видеокарт",
    "high-fidelity-4x": "Высокая точность — сохраняет мелкие детали",
    "ultrasharp-4x": "Ультрарезкая — максимальная чёткость",
    "remacri-4x": "Remacri — естественная текстура",
    "ultramix-balanced-4x": "Ultramix — сбалансированная",
    "digital-art-4x": "Цифровой арт — рисунки, иллюстрации, аниме",
}

# Размеры листов в мм (книжная ориентация)
PAGE_SIZES = {"A4": (210, 297), "A3": (297, 420), "A2": (420, 594)}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024

jobs = {}
jobs_lock = threading.Lock()


def mm_to_pt(mm):
    return mm * 72 / 25.4


def job_dir(job_id):
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        abort(404)
    d = WORK / job_id
    if not d.is_dir():
        abort(404)
    return d


def cleanup_old_jobs():
    now = time.time()
    for d in WORK.iterdir():
        if d.is_dir() and now - d.stat().st_mtime > JOB_TTL:
            shutil.rmtree(d, ignore_errors=True)
            with jobs_lock:
                jobs.pop(d.name, None)


def make_preview(src, dst):
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        im.thumbnail((PREVIEW_MAX, PREVIEW_MAX))
        flatten(im).save(dst, "JPEG", quality=85)


def flatten(im):
    """Убирает прозрачность (подкладывает белый фон) и приводит к RGB."""
    if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.getchannel("A"))
        return bg
    if im.mode not in ("RGB", "L"):
        return im.convert("RGB")
    return im


def run_upscale(job_id, model):
    d = WORK / job_id
    job = jobs[job_id]
    cmd = [
        str(UPSCAYL_BIN),
        "-i", str(d / "input.png"),
        "-o", str(d / "upscaled.png"),
        "-m", str(MODELS_DIR),
        "-n", model,
        "-s", "4",
        "-f", "png",
    ]
    try:
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=flags)
        buf, log = b"", []
        while True:
            ch = proc.stdout.read(1)
            if not ch:
                break
            if ch in (b"\n", b"\r"):
                line = buf.decode("utf-8", "replace").strip()
                buf = b""
                if not line:
                    continue
                m = re.match(r"^([\d.]+)%$", line)
                if m:
                    job["progress"] = min(float(m.group(1)), 100.0)
                else:
                    log.append(line)
            else:
                buf += ch
        proc.wait()
        out = d / "upscaled.png"
        if proc.returncode != 0 or not out.exists():
            raise RuntimeError("Upscayl завершился с ошибкой:\n" + "\n".join(log[-10:]))
        with Image.open(out) as im:
            job["upscaled_size"] = im.size
        make_preview(out, d / "upscaled_preview.jpg")
        job["progress"] = 100.0
        job["status"] = "done"
    except Exception as e:  # noqa: BLE001
        job["status"] = "error"
        job["error"] = str(e)


@app.get("/")
def index():
    return render_template("index.html", models=MODELS, page_sizes=PAGE_SIZES)


@app.post("/api/upload")
def upload():
    cleanup_old_jobs()
    f = request.files.get("image")
    if not f or not f.filename:
        return jsonify(error="Файл не выбран"), 400
    job_id = uuid.uuid4().hex
    d = WORK / job_id
    d.mkdir()
    raw = d / "original_upload"
    f.save(raw)
    try:
        with Image.open(raw) as im:
            im = ImageOps.exif_transpose(im)
            im.load()
            size = im.size
            # Upscayl принимает только jpg/png/webp — приводим всё к PNG без потерь
            flatten(im).save(d / "input.png", "PNG")
    except Exception:  # noqa: BLE001
        shutil.rmtree(d, ignore_errors=True)
        return jsonify(error="Не удалось прочитать картинку. Поддерживаются JPG, PNG, WEBP, BMP, TIFF, GIF."), 400
    raw.unlink()
    make_preview(d / "input.png", d / "input_preview.jpg")
    with jobs_lock:
        jobs[job_id] = {"status": "uploaded", "progress": 0.0, "original_size": size,
                        "name": Path(f.filename).stem or "image"}
    return jsonify(id=job_id, size=size, preview=f"/files/{job_id}/input_preview.jpg")


@app.post("/api/upscale/<job_id>")
def upscale(job_id):
    job_dir(job_id)
    job = jobs.get(job_id)
    if not job:
        abort(404)
    if job["status"] == "running":
        return jsonify(error="Уже обрабатывается"), 409
    model = (request.get_json(silent=True) or {}).get("model", "upscayl-standard-4x")
    if model not in MODELS:
        return jsonify(error="Неизвестная модель"), 400
    job.update(status="running", progress=0.0, error=None, model=model)
    threading.Thread(target=run_upscale, args=(job_id, model), daemon=True).start()
    return jsonify(ok=True)


@app.get("/api/job/<job_id>")
def job_status(job_id):
    job_dir(job_id)
    job = jobs.get(job_id)
    if not job:
        abort(404)
    resp = {k: job.get(k) for k in ("status", "progress", "error", "original_size", "upscaled_size")}
    if job["status"] == "done":
        resp["preview"] = f"/files/{job_id}/upscaled_preview.jpg"
        resp["download"] = f"/files/{job_id}/upscaled.png"
    return jsonify(resp)


@app.get("/files/<job_id>/<name>")
def files(job_id, name):
    d = job_dir(job_id)
    if name not in ("input_preview.jpg", "upscaled_preview.jpg", "upscaled.png"):
        abort(404)
    p = d / name
    if not p.exists():
        abort(404)
    job = jobs.get(job_id, {})
    as_attachment = name == "upscaled.png"
    return send_file(p, as_attachment=as_attachment,
                     download_name=f"{job.get('name', 'image')}_x4.png" if as_attachment else None)


@app.post("/api/pdf/<job_id>")
def make_pdf(job_id):
    d = job_dir(job_id)
    job = jobs.get(job_id)
    if not job:
        abort(404)
    opts = request.get_json(silent=True) or {}
    source = d / ("upscaled.png" if opts.get("source", "upscaled") == "upscaled" else "input.png")
    if not source.exists():
        return jsonify(error="Сначала увеличьте картинку"), 400

    paper = opts.get("paper", "A3")
    if paper not in PAGE_SIZES:
        return jsonify(error="Неизвестный формат листа"), 400
    w_mm, h_mm = PAGE_SIZES[paper]
    orientation = opts.get("orientation", "auto")
    with Image.open(source) as im:
        img_w, img_h = im.size
        landscape_img = img_w > img_h
        if orientation == "landscape" or (orientation == "auto" and landscape_img):
            w_mm, h_mm = h_mm, w_mm

        try:
            margin = max(0.0, min(float(opts.get("margin_mm", 0)), 50.0))
        except (TypeError, ValueError):
            margin = 0.0
        fit = {"into": img2pdf.FitMode.into, "fill": img2pdf.FitMode.fill,
               "exact": img2pdf.FitMode.exact}.get(opts.get("fit", "into"), img2pdf.FitMode.into)

        # img2pdf не умеет альфа-канал — сводим на белый фон
        quality = opts.get("quality", "jpeg")
        embedded = d / ("pdf_source.jpg" if quality == "jpeg" else "pdf_source.png")
        img = flatten(im)
        if quality == "jpeg":
            img.save(embedded, "JPEG", quality=95, subsampling=0, dpi=(300, 300))
        else:
            img.save(embedded, "PNG")

    page = (mm_to_pt(w_mm), mm_to_pt(h_mm))
    layout = img2pdf.get_layout_fun(pagesize=page, imgsize=None,
                                    border=(mm_to_pt(margin), mm_to_pt(margin)) if margin else None,
                                    fit=fit, auto_orient=False)
    out = d / "result.pdf"
    with open(out, "wb") as fh:
        img2pdf.convert(str(embedded), layout_fun=layout, outputstream=fh,
                        title=job.get("name", "image"))
    embedded.unlink(missing_ok=True)
    return send_file(out, as_attachment=True, mimetype="application/pdf",
                     download_name=f"{job.get('name', 'image')}_{paper}.pdf")


def check_setup():
    if not UPSCAYL_BIN.exists() or not MODELS_DIR.exists():
        sys.exit("Не найден Upscayl. Сначала запустите setup.bat (скачает upscayl-bin и модели с GitHub).")


if __name__ == "__main__":
    check_setup()
    from waitress import serve
    port = int(os.environ.get("PORT", 5000))
    print(f"Сайт запущен: http://127.0.0.1:{port}")
    serve(app, host="127.0.0.1", port=port, threads=8, max_request_body_size=200 * 1024 * 1024)
