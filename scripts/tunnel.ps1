# Keeps a localhost.run tunnel up and writes its current https address into .env (WEBAPP_URL).
# The bot re-reads .env on every /start, so no bot restart is needed after a reconnect.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File $HOME\Fitness-assist\scripts\tunnel.ps1
$envFile = Join-Path $PSScriptRoot '..\.env'

while ($true) {
    Write-Host "Подключаю туннель..." -ForegroundColor Cyan
    ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new `
        -R 80:localhost:8000 nokey@localhost.run 2>&1 | ForEach-Object {
        Write-Host $_
        if ("$_" -match '(https://[a-z0-9]+\.lhr\.life)') {
            $url = $Matches[1]
            (Get-Content $envFile) -replace '^WEBAPP_URL=.*', "WEBAPP_URL=$url" | Set-Content $envFile
            Write-Host ""
            Write-Host "  Адрес записан в .env: $url" -ForegroundColor Green
            Write-Host "  Отправьте боту /start и нажмите кнопку в новом сообщении." -ForegroundColor Green
            Write-Host ""
        }
    }
    Write-Host "Туннель оборвался. Переподключаюсь через 5 секунд (Ctrl+C - выход)..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
