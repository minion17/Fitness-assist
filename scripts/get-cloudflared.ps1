# Downloads Cloudflare's tunnel program into tools\cloudflared.exe (one ~60 MB file, once).
# curl.exe ships with Windows 10+; Invoke-WebRequest is the fallback (slow in Windows PowerShell 5 with a progress bar).
param([string]$Dest = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'tools\cloudflared.exe'))
$url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
if (Test-Path $Dest) { return $true }
New-Item -ItemType Directory -Force (Split-Path $Dest) | Out-Null
$tmp = "$Dest.download"
Write-Host "Скачиваю cloudflared (туннель Cloudflare, ~60 МБ)..." -ForegroundColor Cyan
try {
    & curl.exe -L --fail --retry 3 --connect-timeout 20 -o $tmp $url
    if ($LASTEXITCODE -ne 0) { throw "curl exit $LASTEXITCODE" }
} catch {
    Write-Host "  curl не справился ($_), пробую другим способом..." -ForegroundColor Yellow
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest $url -OutFile $tmp -UseBasicParsing
    } catch {
        Write-Host "  Не удалось скачать cloudflared: $($_.Exception.Message)" -ForegroundColor Red
        Remove-Item $tmp -ErrorAction SilentlyContinue
        return $false
    }
}
if ((Get-Item $tmp).Length -lt 10MB) {
    Write-Host "  Скачался не тот файл (слишком маленький) — возможно, GitHub недоступен." -ForegroundColor Red
    Remove-Item $tmp -ErrorAction SilentlyContinue
    return $false
}
Move-Item $tmp $Dest -Force
Write-Host "  cloudflared скачан." -ForegroundColor Green
return $true
