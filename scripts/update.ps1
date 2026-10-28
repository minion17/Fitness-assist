# One-click update: pull latest code, install dependencies, rebuild the Mini App.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root
Write-Host "== Fitness Assistant: обновление ==" -ForegroundColor Cyan

Write-Host "`n[1/4] Код с GitHub"
git pull
if ($LASTEXITCODE -ne 0) { throw "git pull не удался" }

Write-Host "`n[2/4] Python-окружение"
if (-not (Test-Path '.venv\Scripts\python.exe')) { python -m venv .venv }
& .venv\Scripts\python.exe -m pip install -q -r backend\requirements.txt
if ($LASTEXITCODE -ne 0) { throw "pip install не удался" }

Write-Host "`n[3/4] Зависимости интерфейса"
Set-Location frontend
npm.cmd install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { throw "npm install не удался" }

Write-Host "`n[4/4] Сборка интерфейса"
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw "сборка не удалась" }
Set-Location $root

Write-Host "`nОбновлено. Если сервер и бот уже запущены — закройте их окна и запустите start.bat." -ForegroundColor Green
