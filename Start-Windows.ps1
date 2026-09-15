param([switch]$Demo, [switch]$Check, [switch]$Smoke)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'native\bin\CodexUsagePlanner.exe'
if (-not (Test-Path $exe)) { & (Join-Path $PSScriptRoot 'Build-Windows.ps1') }
if ($Check) { Write-Output ('STARTUP_CHECK_OK ' + $exe); return }
$arguments = @()
if ($Demo) { $arguments += '--demo' }
if ($Smoke) { $arguments += '--smoke' }
$launch = @{FilePath=$exe; WorkingDirectory=$PSScriptRoot; PassThru=$true}
if ($arguments.Count) { $launch.ArgumentList=$arguments }
$process = Start-Process @launch
if ($Smoke) { $process.WaitForExit(); if ($process.ExitCode -ne 0) { throw 'WebView2 smoke test failed. See native\startup-error.log' }; Write-Output 'WINDOWS_TRAY_SMOKE_OK' }
