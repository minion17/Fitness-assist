# One-click start: database, API server, auto-reconnecting tunnel, bot.
# Anything already running is left alone, so double-clicking start.bat twice is safe.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$py = Join-Path $root '.venv\Scripts\python.exe'
$pgBin = 'C:\pgsql\bin'
$pgData = 'C:\pgsql\data'

function Running($pattern) {
    Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='powershell.exe'" |
        Where-Object { $_.CommandLine -like "*$pattern*" -and $_.ProcessId -ne $PID }
}

function Open-Window($title, $command) {
    $cmd = "`$host.UI.RawUI.WindowTitle = '$title'; Set-Location '$root'; $command"
    Start-Process powershell -WorkingDirectory $root -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', $cmd
}

Write-Host "== Fitness Assistant: запуск ==" -ForegroundColor Cyan

if (-not (Test-Path $py)) { throw "Нет .venv — сначала запустите update.bat" }
if (-not (Test-Path (Join-Path $root 'frontend\dist\index.html'))) { throw "Интерфейс не собран — сначала запустите update.bat" }

# 1. Database
& "$pgBin\pg_ctl.exe" -D $pgData status *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "База данных: запускаю..."
    & "$pgBin\pg_ctl.exe" -D $pgData -l C:\pgsql\log.txt -w start | Out-Null
} else { Write-Host "База данных: уже работает" }

# 2. API server + Mini App
if (Running 'uvicorn backend.api.main') { Write-Host "Сервер: уже работает" }
else {
    Write-Host "Сервер: запускаю (окно 'FA сервер')"
    Open-Window 'FA сервер' "& '$py' -m uvicorn backend.api.main:app --port 8000"
}

# 3. Tunnel (rewrites WEBAPP_URL in .env on every reconnect)
if (Running 'tunnel.ps1') { Write-Host "Туннель: уже работает" }
else {
    Write-Host "Туннель: запускаю (окно 'FA туннель')"
    Open-Window 'FA туннель' "& '$root\scripts\tunnel.ps1'"
}

# 4. Bot (reads WEBAPP_URL from .env on every /start)
if (Running 'backend.bot.main') { Write-Host "Бот: уже работает" }
else {
    Write-Host "Бот: запускаю (окно 'FA бот')"
    Open-Window 'FA бот' "& '$py' -m backend.bot.main"
}

Write-Host ""
Write-Host "Готово. Через ~10 секунд отправьте боту /start." -ForegroundColor Green
Write-Host "Остановить всё — закрыть окна 'FA сервер', 'FA туннель', 'FA бот'."
