# Keeps a public https tunnel to the local server up and writes its address into .env (WEBAPP_URL).
# The bot follows .env by itself (menu button "Setly"), so nothing needs a restart after a reconnect.
#
# Two free providers, tried in turn: Cloudflare quick tunnel (tools\cloudflared.exe, downloaded by update.bat)
# and localhost.run (plain ssh). Either can silently stop forwarding (localhost.run then shows "no tunnel"),
# so once a minute the address is checked from outside; after two failed checks the tunnel is rebuilt with
# the other provider.
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$envFile = Join-Path $root '.env'
$cloudflared = Join-Path $root 'tools\cloudflared.exe'
$log = Join-Path $root 'tools\tunnel.log'  # not %TEMP%: with a Cyrillic user name it is an 8.3 path PowerShell trips on
New-Item -ItemType Directory -Force (Join-Path $root 'tools') | Out-Null
. (Join-Path $PSScriptRoot 'no-quickedit.ps1')
# Windows PowerShell 5 may default to old TLS, and then every https check would fail
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Answers($u) {
    try { Invoke-WebRequest "$u/health" -UseBasicParsing -TimeoutSec 15 | Out-Null; return $true } catch { return $false }
}

function Start-Tunnel($provider) {
    foreach ($f in $log, "$log.err") { try { [IO.File]::Delete($f) } catch {} }
    if ($provider -eq 'cloudflare') {
        $a = @('tunnel', '--url', 'http://localhost:8000', '--no-autoupdate', '--protocol', 'http2')
        return Start-Process $cloudflared -ArgumentList $a -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    }
    $a = @('-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=accept-new',
              '-R', '80:localhost:8000', 'nokey@localhost.run')
    return Start-Process ssh -ArgumentList $a -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
}

$null = & (Join-Path $PSScriptRoot 'get-cloudflared.ps1') -Dest $cloudflared  # no-op once downloaded
$providers = @('localhost.run')
if (Test-Path $cloudflared) { $providers = @('cloudflare', 'localhost.run') }
else { Write-Host "Без cloudflared пробую только localhost.run — он у вас сейчас может не работать." -ForegroundColor Yellow }
$turn = 0

while ($true) {
    $provider = $providers[$turn % $providers.Count]
    Write-Host "$(Get-Date -Format HH:mm) Подключаю туннель ($provider)..." -ForegroundColor Cyan
    $proc = Start-Tunnel $provider
    $url = $null; $fails = 0; $started = Get-Date; $next = (Get-Date).AddSeconds(45)
    while (-not $proc.HasExited) {
        Start-Sleep -Seconds 3
        if (-not $url) {
            $text = (Get-Content $log, "$log.err" -Raw -ErrorAction SilentlyContinue) -join "`n"
            if ($text -match '(https://[a-z0-9-]+\.trycloudflare\.com|https://[a-z0-9]+\.lhr\.life)') {
                $url = $Matches[1]
                $next = (Get-Date).AddSeconds(20)  # first check soon: catch an address that never worked
            } elseif ((Get-Date) -gt $started.AddSeconds(60)) {
                Write-Host "  Адрес не получен за минуту — пробую другой способ." -ForegroundColor Yellow
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            }
        } elseif ((Get-Date) -ge $next) {
            $next = (Get-Date).AddSeconds(60)
            if (Answers $url) {
                if ($fails -ge 0) {  # first success for this address: publish it
                    (Get-Content $envFile) -replace '^WEBAPP_URL=.*', "WEBAPP_URL=$url" | Set-Content $envFile
                    Write-Host ""
                    Write-Host "  $(Get-Date -Format HH:mm) Работает: $url" -ForegroundColor Green
                    Write-Host "  Открывайте приложение кнопкой Setly слева от поля ввода в чате с ботом." -ForegroundColor Green
                    Write-Host ""
                }
                $fails = -1  # -1 = published and healthy
            } elseif (-not (Answers 'http://localhost:8000')) {
                Write-Host "  $(Get-Date -Format HH:mm) Сервер не отвечает — проверьте окно 'FA сервер'." -ForegroundColor Yellow
            } else {
                $fails = [Math]::Max($fails, 0) + 1
                if ($fails -ge 2) {
                    Write-Host "  $(Get-Date -Format HH:mm) Туннель не отвечает — переподключаю другим способом." -ForegroundColor Yellow
                    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }
    $turn++
    Start-Sleep -Seconds 3
}
