@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Установка: Python-библиотеки ===
if not exist .venv python -m venv .venv
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install -r requirements.txt
echo === Установка: Upscayl (движок и модели с GitHub) ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_upscayl.ps1"
echo.
echo Готово! Запускайте start.bat
pause
