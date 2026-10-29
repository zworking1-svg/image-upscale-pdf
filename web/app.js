'use strict';

const $ = id => document.getElementById(id);
const PAGES = { A4: [210, 297], A3: [297, 420], A2: [420, 594] };
const SCALE = 4;
const PAD = 16;                 // перекрытие тайлов, чтобы не было швов
const MAX_OUT_PIXELS = 200e6;   // предел холста браузера для результата

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
ort.env.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 4, 8);

let hasWebGPU = false;
let srcCanvas = null, outCanvas = null, fileName = 'image';
let sessions = {}, stopRequested = false;

(async function detect() {
  const note = $('envNote');
  try {
    hasWebGPU = !!(navigator.gpu && await navigator.gpu.requestAdapter());
  } catch { hasWebGPU = false; }
  if (hasWebGPU) {
    note.innerHTML = '<span class="ok">✓ Видеокарта доступна (WebGPU)</span> — увеличение займёт от нескольких секунд до пары минут.';
  } else {
    note.innerHTML = '<span class="warn">Браузер не даёт доступ к видеокарте (WebGPU).</span> Сайт будет работать на процессоре — медленно. ' +
      'Для быстрой работы откройте сайт в Google Chrome или Microsoft Edge на компьютере.';
    $('model').value = 'realesr-general-x4v3';
  }
})();

// ---------- Шаг 1: загрузка ----------
const drop = $('drop'), fileInput = $('file');
drop.onclick = () => fileInput.click();
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); };
fileInput.onchange = () => fileInput.files[0] && loadFile(fileInput.files[0]);

const OPEN_ERROR = 'Не удалось открыть файл. Поддерживаются JPG, PNG, WEBP, BMP, GIF, AVIF.';

function baseName(file) { return file.name.replace(/\.[^.]+$/, '') || 'image'; }

async function fileToCanvas(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);   // прозрачность → белый фон
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

function show(el, on = true) { el.classList.toggle('hidden', !on); }
function enable(id, on = true) { $(id).classList.toggle('disabled', !on); }

async function loadFile(file) {
  const info = $('uploadInfo');
  show(info); info.className = 'muted'; info.textContent = 'Открываю ' + file.name + '…';
  enable('s2', false);
  outCanvas = null;
  show($('pvAfter'), false); $('capAfter').textContent = ''; show($('dlRow'), false); show($('detailWrap'), false);
  show($('progressWrap'), false); show($('upErr'), false);
  try {
    srcCanvas = await fileToCanvas(file);
  } catch {
    info.className = 'err'; info.textContent = OPEN_ERROR;
    return;
  }
  const w = srcCanvas.width, h = srcCanvas.height;
  fileName = baseName(file);

  const tooBig = w * h * SCALE * SCALE > MAX_OUT_PIXELS;
  info.textContent = `${file.name} · ${w}×${h} px → после увеличения ${w * SCALE}×${h * SCALE} px`;
  drawPreview($('pvBefore'), srcCanvas); show($('pvBefore'));
  $('capBefore').textContent = `Оригинал · ${w}×${h} px`;
  if (tooBig) {
    info.innerHTML += '<br><span class="warn">Картинка слишком большая для увеличения ×4 в браузере. ' +
      'Для печати A3 её разрешения и так достаточно — сразу создайте PDF из оригинала.</span>';
  } else {
    enable('s2');
  }
  enable('s3');
  if ($('source').value !== 'file') $('source').value = 'original';
  updateDpi();
}

function drawPreview(canvas, src, max = 1200) {
  const k = Math.min(1, max / Math.max(src.width, src.height));
  canvas.width = Math.round(src.width * k); canvas.height = Math.round(src.height * k);
  const c = canvas.getContext('2d');
  c.imageSmoothingQuality = 'high';
  c.drawImage(src, 0, 0, canvas.width, canvas.height);
}

// ---------- Шаг 2: увеличение ----------
async function getSession(model) {
  const ep = hasWebGPU ? 'webgpu' : 'wasm';
  const key = model + ep;
  if (!sessions[key]) {
    setProgress(0, 'Загружаю нейросеть (один раз, потом берётся из кэша)…');
    const resp = await fetch(`models/${model}.onnx`);
    if (!resp.ok) throw new Error('Не удалось скачать модель');
    const total = +resp.headers.get('Content-Length') || 0;
    const reader = resp.body.getReader();
    const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      if (total) setProgress(got / total * 100, `Загружаю нейросеть… ${(got / 1048576).toFixed(0)} из ${(total / 1048576).toFixed(0)} МБ`);
    }
    const buf = new Uint8Array(got); let off = 0;
    for (const ch of chunks) { buf.set(ch, off); off += ch.length; }
    setProgress(100, 'Подготавливаю нейросеть…');
    sessions[key] = await ort.InferenceSession.create(buf, { executionProviders: [ep] });
  }
  return sessions[key];
}

function setProgress(pct, text) {
  $('bar').style.width = pct.toFixed(1) + '%';
  $('progressText').textContent = text;
}

$('stopBtn').onclick = () => { stopRequested = true; };

$('upBtn').onclick = async () => {
  if (!srcCanvas) return;
  const model = $('model').value;
  $('upBtn').disabled = true; show($('stopBtn')); show($('upErr'), false); show($('progressWrap'));
  enable('s3', false);
  stopRequested = false;
  try {
    const session = await getSession(model);
    const t0 = performance.now();
    outCanvas = await upscale(session, srcCanvas, hasWebGPU ? 256 : 128);
    const sec = Math.round((performance.now() - t0) / 1000);
    setProgress(100, `Готово за ${sec} с`);
    drawPreview($('pvAfter'), outCanvas); show($('pvAfter'));
    $('capAfter').textContent = `Увеличено ×4 · ${outCanvas.width}×${outCanvas.height} px`;
    drawDetail();
    show($('dlRow'));
    $('source').value = 'upscaled';
  } catch (e) {
    if (e.message !== 'stopped') { $('upErr').textContent = 'Ошибка: ' + e.message; show($('upErr')); }
    show($('progressWrap'), false);
  }
  $('upBtn').disabled = false; show($('stopBtn'), false);
  enable('s3');
  updateDpi();
};

async function upscale(session, src, tileIn) {
  const W = src.width, H = src.height;
  const S = tileIn, core = S - 2 * PAD;
  const pix = src.getContext('2d').getImageData(0, 0, W, H).data;
  const out = document.createElement('canvas');
  out.width = W * SCALE; out.height = H * SCALE;
  const octx = out.getContext('2d');
  const cols = Math.ceil(W / core), rows = Math.ceil(H / core);
  const total = cols * rows;
  const input = new Float32Array(3 * S * S);
  const plane = S * S, oS = S * SCALE, oPlane = oS * oS;
  let done = 0;

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      if (stopRequested) throw new Error('stopped');
      const x0 = tx * core, y0 = ty * core;
      const cw = Math.min(core, W - x0), ch = Math.min(core, H - y0);
      // Тайл с полями; за краем картинки повторяем крайние пиксели
      for (let y = 0; y < S; y++) {
        const sy = Math.min(H - 1, Math.max(0, y0 - PAD + y));
        for (let x = 0; x < S; x++) {
          const sx = Math.min(W - 1, Math.max(0, x0 - PAD + x));
          const si = (sy * W + sx) * 4, di = y * S + x;
          input[di] = pix[si] / 255;
          input[plane + di] = pix[si + 1] / 255;
          input[2 * plane + di] = pix[si + 2] / 255;
        }
      }
      const res = await session.run({ input: new ort.Tensor('float32', input, [1, 3, S, S]) });
      const o = res.output.data;
      const ow = cw * SCALE, oh = ch * SCALE, off = PAD * SCALE;
      const img = new ImageData(ow, oh);
      const d = img.data;
      for (let y = 0; y < oh; y++) {
        const row = (y + off) * oS + off;
        for (let x = 0; x < ow; x++) {
          const si = row + x, di = (y * ow + x) * 4;
          d[di] = o[si] * 255;
          d[di + 1] = o[oPlane + si] * 255;
          d[di + 2] = o[2 * oPlane + si] * 255;
          d[di + 3] = 255;
        }
      }
      res.output.dispose?.();
      octx.putImageData(img, x0 * SCALE, y0 * SCALE);
      done++;
      setProgress(done / total * 100, `Увеличиваю… ${(done / total * 100).toFixed(0)}% (фрагмент ${done} из ${total})`);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  return out;
}

function drawDetail() {
  const W = srcCanvas.width, H = srcCanvas.height;
  const size = Math.min(150, W, H);
  const sx = Math.floor((W - size) / 2), sy = Math.floor((H - size) / 2);
  const outSize = size * SCALE;
  for (const [id, src, s] of [['dtBefore', srcCanvas, 1], ['dtAfter', outCanvas, SCALE]]) {
    const c = $(id);
    c.width = outSize; c.height = outSize;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = s === 1 ? true : false;
    ctx.drawImage(src, sx * s, sy * s, size * s, size * s, 0, 0, outSize, outSize);
  }
  show($('detailWrap'));
}

function canvasBlob(canvas, type, q) {
  return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('Не хватило памяти для сохранения')), type, q));
}

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

$('dlPng').onclick = async () => {
  const b = $('dlPng'); b.disabled = true; b.textContent = 'Сохраняю…';
  try { saveBlob(await canvasBlob(outCanvas, 'image/png'), `${fileName}_x4.png`); }
  catch (e) { alert(e.message); }
  b.disabled = false; b.textContent = 'Скачать увеличенную картинку (PNG)';
};

// ---------- Шаг 3: PDF ----------
function pageLayout(size) {
  let [pw, ph] = PAGES[$('paper').value];
  const o = $('orientation').value;
  if (o === 'landscape' || (o === 'auto' && size[0] > size[1])) [pw, ph] = [ph, pw];
  const m = Math.min(50, Math.max(0, +$('margin').value || 0));
  const aw = pw - 2 * m, ah = ph - 2 * m;
  const fit = $('fit').value;
  let w, h;
  if (fit === 'exact') { w = aw; h = ah; }
  else {
    const k = fit === 'into' ? Math.min(aw / size[0], ah / size[1]) : Math.max(aw / size[0], ah / size[1]);
    w = size[0] * k; h = size[1] * k;
  }
  return { pw, ph, w, h, x: (pw - w) / 2, y: (ph - h) / 2 };
}

// Картинка с компьютера специально для PDF (без увеличения)
let pdfCanvas = null, pdfFileName = 'image';
$('pdfFileBtn').onclick = () => $('pdfFile').click();
$('pdfFile').onchange = async () => {
  const file = $('pdfFile').files[0];
  if (!file) return;
  const info = $('pdfFileInfo');
  info.className = 'muted'; info.textContent = 'Открываю…';
  try {
    pdfCanvas = await fileToCanvas(file);
  } catch {
    info.className = 'err'; info.textContent = OPEN_ERROR;
    return;
  }
  pdfFileName = baseName(file);
  info.textContent = `${file.name} · ${pdfCanvas.width}×${pdfCanvas.height} px`;
  $('source').value = 'file';
  updateDpi();
  $('pdfFile').value = '';
};

function currentSource() {
  return { upscaled: outCanvas, original: srcCanvas, file: pdfCanvas }[$('source').value];
}

function updateDpi() {
  const el = $('dpi');
  const src = currentSource();
  if (!src) {
    const msg = {
      upscaled: 'Сначала загрузите и увеличьте картинку (шаги 1–2) — или выберите картинку с компьютера кнопкой выше.',
      original: 'Сначала загрузите картинку на шаге 1 — или выберите картинку с компьютера кнопкой выше.',
      file: 'Нажмите «Выбрать картинку с компьютера для PDF».',
    }[$('source').value];
    el.innerHTML = `<span class="warn">${msg}</span>`;
    return;
  }
  const L = pageLayout([src.width, src.height]);
  const dpi = Math.round(Math.min(src.width / (L.w / 25.4), src.height / (L.h / 25.4)));
  let verdict;
  if (dpi >= 300) verdict = '<span class="ok">✓ Отлично для типографии (300+ DPI)</span>';
  else if (dpi >= 200) verdict = '<span class="warn">Хорошо — печать будет качественной, но не идеальной</span>';
  else verdict = '<span class="err">Низкое разрешение — на печати будет заметна размытость</span>';
  el.innerHTML = `В PDF: ${src.width}×${src.height} px · лист ${L.pw}×${L.ph} мм · разрешение при печати ≈ <b>${dpi} DPI</b> · ${verdict}`;
}
['paper', 'orientation', 'fit', 'margin', 'source'].forEach(id => $(id).addEventListener('input', updateDpi));

$('pdfBtn').onclick = async () => {
  const src = currentSource();
  if (!src) { updateDpi(); return; }
  const name = $('source').value === 'file' ? pdfFileName : fileName;
  const btn = $('pdfBtn'); btn.disabled = true; btn.textContent = 'Создаю PDF…'; show($('pdfErr'), false);
  try {
    const L = pageLayout([src.width, src.height]);
    const jpeg = new Uint8Array(await (await canvasBlob(src, 'image/jpeg', 0.95)).arrayBuffer());
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: L.pw > L.ph ? 'landscape' : 'portrait', unit: 'mm', format: [L.pw, L.ph] });
    doc.setProperties({ title: name });
    // JPEG встраивается как есть, без повторного сжатия
    doc.addImage(jpeg, 'JPEG', L.x, L.y, L.w, L.h, undefined, 'NONE');
    saveBlob(doc.output('blob'), `${name}_${$('paper').value}.pdf`);
  } catch (e) { $('pdfErr').textContent = 'Ошибка: ' + e.message; show($('pdfErr')); }
  btn.disabled = false; btn.textContent = 'Скачать PDF';
};
updateDpi();
