$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$bin = Join-Path $root 'native\bin'
$meta = Get-Content (Join-Path $root 'native\dependency.json') -Raw | ConvertFrom-Json
if (-not (Test-Path (Join-Path $bin 'Microsoft.Web.WebView2.Core.dll'))) {
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    $archive = Join-Path $root 'native\webview-sdk.zip'
    Invoke-WebRequest $meta.url -OutFile $archive -UseBasicParsing
    if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.sha256) { throw 'SDK checksum mismatch' }
    $extract = Join-Path $root 'native\sdk'
    Expand-Archive $archive -DestinationPath $extract -Force
    Copy-Item (Join-Path $extract 'lib\net462\Microsoft.Web.WebView2.Core.dll') $bin -Force
    Copy-Item (Join-Path $extract 'lib\net462\Microsoft.Web.WebView2.WinForms.dll') $bin -Force
    Copy-Item (Join-Path $extract 'runtimes\win-x64\native\WebView2Loader.dll') $bin -Force
}
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:winexe /platform:x64 ('/out:' + (Join-Path $bin 'CodexUsagePlanner.exe')) /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Net.Http.dll /r:System.Web.Extensions.dll ('/r:' + (Join-Path $bin 'Microsoft.Web.WebView2.Core.dll')) ('/r:' + (Join-Path $bin 'Microsoft.Web.WebView2.WinForms.dll')) (Join-Path $root 'native\TrayHost.cs')
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
Write-Output 'WINDOWS_BUILD_OK'
