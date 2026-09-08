$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force artifacts\win32 | Out-Null
@{
    os = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
    osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    nodeArch = (& node -p process.arch)
    sessionId = (Get-Process -Id $PID).SessionId
} | ConvertTo-Json | Set-Content artifacts\win32\environment.json
& npm.cmd ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
& node node_modules\electron\install.js
if ($LASTEXITCODE -ne 0) {
    & node scripts\install-electron-windows.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Electron system extraction failed' }
}
& npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'Native verification failed; inspect artifacts' }
& npm.cmd run bench
if ($LASTEXITCODE -ne 0) { throw 'Benchmark failed' }
