# Скачивает движок upscayl-bin (github.com/upscayl/upscayl-ncnn) и модели (github.com/upscayl/upscayl)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vendor = Join-Path $root "vendor"
$bin = Join-Path $vendor "upscayl-bin"
$models = Join-Path $vendor "models"
New-Item -ItemType Directory -Force $bin, $models | Out-Null

if (-not (Test-Path (Join-Path $bin "upscayl-bin.exe"))) {
    $rel = Invoke-RestMethod "https://api.github.com/repos/upscayl/upscayl-ncnn/releases/latest"
    $asset = $rel.assets | Where-Object { $_.name -like "*windows.zip" } | Select-Object -First 1
    Write-Host "Скачиваю $($asset.name)..."
    $zip = Join-Path $env:TEMP $asset.name
    Invoke-WebRequest $asset.browser_download_url -OutFile $zip
    $tmp = Join-Path $env:TEMP "upscayl-bin-extract"
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive $zip -DestinationPath $tmp
    Get-ChildItem $tmp -Recurse -File | Copy-Item -Destination $bin
    Remove-Item -Recurse -Force $tmp, $zip
}

$list = Invoke-RestMethod "https://api.github.com/repos/upscayl/upscayl/contents/resources/models"
foreach ($f in $list) {
    $dst = Join-Path $models $f.name
    if (-not (Test-Path $dst)) {
        Write-Host "Скачиваю модель $($f.name)..."
        Invoke-WebRequest $f.download_url -OutFile $dst
    }
}
Write-Host "Upscayl установлен."
