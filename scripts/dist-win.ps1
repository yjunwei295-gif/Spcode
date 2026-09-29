# Windows 打包：需可访问 electron / electron-builder 二进制（直连不稳时开代理）
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
  $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}
if (-not $env:ELECTRON_MIRROR) {
  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
}

# 默认尝试本机常见代理；不需要时设 SKIP_DIST_PROXY=1
if (-not $env:SKIP_DIST_PROXY) {
  if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = 'http://127.0.0.1:19828' }
  if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = $env:HTTP_PROXY }
}

npm run dist
Write-Host "`n产物:"
Get-ChildItem (Join-Path (Get-Location) 'dist\*.exe') | ForEach-Object {
  Write-Host ("  {0}  ({1:N1} MB)" -f $_.FullName, ($_.Length / 1MB))
}
Write-Host "也可直接运行: dist\win-unpacked\SimpleCode.exe"
