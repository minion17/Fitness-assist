# Keeps a public https tunnel to the local server up and writes its address into .env (WEBAPP_URL).
# The bot follows .env by itself (menu button "Setly"), so nothing needs a restart after a reconnect.
#
# Providers, tried in turn:
#   tuna.am      - when TUNA_API_KEY (or the older TUNA_TOKEN) is in .env; not blocked in Russia/CIS.
#                  TUNA_SUBDOMAIN in .env gives the free permanent address (same URL after every reconnect).
#   cloudflare   - quick tunnel (tools\cloudflared.exe)
#   localhost.run - plain ssh
# Any of them can silently stop forwarding, so once a minute the address is checked from outside; after two
# failed checks the tunnel is rebuilt with the next provider.
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
    if ($provider -eq 'tuna') {
        $a = @('http', '8000')
        if ($conf.TUNA_SUBDOMAIN) { $a += "--subdomain=$($conf.TUNA_SUBDOMAIN)" }
        return Start-Process $tuna -ArgumentList $a -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    }
    if ($provider -eq 'cloudflare') {
        $a = @('tunnel', '--url', 'http://localhost:8000', '--no-autoupdate', '--protocol', 'http2')
        return Start-Process $cloudflared -ArgumentList $a -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    }
    $a = @('-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=accept-new',
              '-R', '80:localhost:8000', 'nokey@localhost.run')
    return Start-Process ssh -ArgumentList $a -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
}

$tuna = Join-Path $root 'tools\tuna\tuna.exe'

# tuna settings from .env (the key never leaves this computer; tuna reads it from the environment)
$conf = @{}
foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*(TUNA_API_KEY|TUNA_TOKEN|TUNA_SUBDOMAIN)\s*=\s*(\S+)') { $conf[$Matches[1]] = $Matches[2] }
}
$providers = @()
if ($conf.TUNA_API_KEY -or $conf.TUNA_TOKEN) {
    if (& (Join-Path $PSScriptRoot 'get-tuna.ps1')) { $providers += 'tuna' }
    if ($conf.TUNA_API_KEY) { $env:TUNA_API_KEY = $conf.TUNA_API_KEY } else { $env:TUNA_TOKEN = $conf.TUNA_TOKEN }
    $env:TUNA_TUI = '0'; $env:TUNA_INSPECT = 'false'
}
if (& (Join-Path $PSScriptRoot 'get-cloudflared.ps1') -Dest $cloudflared) { $providers += 'cloudflare' }
$providers += 'localhost.run'
Write-Host "Способы туннеля по очереди: $($providers -join ', ')" -ForegroundColor DarkGray
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
            if ($text -match '(https://(?!(?:my|docs|www|releases)\.)[a-z0-9-]+\.(?:[a-z0-9-]+\.)*(?:tuna\.am|2na\.am)|https://[a-z0-9-]+\.trycloudflare\.com|https://[a-z0-9]+\.lhr\.life)') {
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
