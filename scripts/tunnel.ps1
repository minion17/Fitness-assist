# Keeps a localhost.run tunnel up and writes its current https address into .env (WEBAPP_URL).
# The bot follows .env by itself (menu button "Setly"), so no restart is needed after a reconnect.
# localhost.run sometimes drops a tunnel while the ssh connection still looks alive ("no tunnel" page),
# so once a minute the address is checked from outside and the tunnel is rebuilt if it stops answering.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File $HOME\Fitness-assist\scripts\tunnel.ps1
$envFile = Join-Path $PSScriptRoot '..\.env'
$log = Join-Path $env:TEMP 'setly-tunnel.log'
. (Join-Path $PSScriptRoot 'no-quickedit.ps1')
# Windows PowerShell 5 may default to old TLS, and then every https check would fail
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Answers($u) {
    try { Invoke-WebRequest "$u/health" -UseBasicParsing -TimeoutSec 15 | Out-Null; return $true } catch { return $false }
}

while ($true) {
    Write-Host "Подключаю туннель..." -ForegroundColor Cyan
    Remove-Item $log, "$log.err" -ErrorAction SilentlyContinue
    $ssh = Start-Process ssh -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err" -ArgumentList @(
        '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=accept-new',
        '-R', '80:localhost:8000', 'nokey@localhost.run')
    $url = $null; $fails = 0; $next = (Get-Date).AddSeconds(60)
    while (-not $ssh.HasExited) {
        Start-Sleep -Seconds 5
        if (-not $url) {
            $text = (Get-Content $log, "$log.err" -Raw -ErrorAction SilentlyContinue) -join "`n"
            if ($text -match '(https://[a-z0-9]+\.lhr\.life)') {
                $url = $Matches[1]
                (Get-Content $envFile) -replace '^WEBAPP_URL=.*', "WEBAPP_URL=$url" | Set-Content $envFile
                Write-Host ""
                Write-Host "  $(Get-Date -Format HH:mm) Адрес записан в .env: $url" -ForegroundColor Green
                Write-Host "  Открывайте приложение кнопкой Setly слева от поля ввода в чате с ботом." -ForegroundColor Green
                Write-Host ""
            }
        } elseif ((Get-Date) -ge $next) {
            $next = (Get-Date).AddSeconds(60)
            if (Answers $url) { $fails = 0 }
            elseif (-not (Answers 'http://localhost:8000')) {
                Write-Host "  $(Get-Date -Format HH:mm) Сервер не отвечает — проверьте окно 'FA сервер'." -ForegroundColor Yellow
            } elseif (++$fails -ge 2) {
                Write-Host "  $(Get-Date -Format HH:mm) Туннель перестал отвечать — переподключаю." -ForegroundColor Yellow
                Stop-Process -Id $ssh.Id -Force -ErrorAction SilentlyContinue
            }
        }
    }
    Write-Host "Туннель оборвался. Переподключаюсь через 5 секунд (Ctrl+C - выход)..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
