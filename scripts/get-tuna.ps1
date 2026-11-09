# Downloads the tuna tunnel program (tuna.am, works from Russia and the CIS) into tools\tuna\tuna.exe, once.
param([string]$Dir = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'tools\tuna'))
$exe = Join-Path $Dir 'tuna.exe'
if (Test-Path $exe) { return $true }
$url = 'https://releases.tuna.am/tuna/latest/tuna_windows_amd64.zip'
New-Item -ItemType Directory -Force $Dir | Out-Null
$zip = Join-Path $Dir 'tuna.zip'
Write-Host "Скачиваю tuna (туннель tuna.am)..." -ForegroundColor Cyan
& curl.exe -L --fail --retry 3 --connect-timeout 20 -o $zip $url
if ($LASTEXITCODE -ne 0) {
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest $url -OutFile $zip -UseBasicParsing
    } catch { Write-Host "  Не удалось скачать tuna: $($_.Exception.Message)" -ForegroundColor Red; return $false }
}
Expand-Archive $zip -DestinationPath $Dir -Force
Remove-Item $zip -ErrorAction SilentlyContinue
$found = Get-ChildItem $Dir -Recurse -Filter tuna.exe | Select-Object -First 1
if (-not $found) { Write-Host "  В архиве нет tuna.exe" -ForegroundColor Red; return $false }
if ($found.FullName -ne $exe) { Move-Item $found.FullName $exe -Force }
Write-Host "  tuna скачан." -ForegroundColor Green
return $true
