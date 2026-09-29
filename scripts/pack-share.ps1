# Pack a shareable zip for other people (no personal zai memory)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$src = Join-Path $root 'dist\win-unpacked'
$exe = Join-Path $src 'SimpleCode.exe'
if (-not (Test-Path $exe)) {
  Write-Host 'Missing dist\win-unpacked\SimpleCode.exe. Run: npm run dist:win'
  exit 1
}

$ver = '0.1.0'
try {
  $pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  if ($pkg.version) { $ver = [string]$pkg.version }
} catch { }

$stage = Join-Path $root ("dist\SimpleCode-{0}-share" -f $ver)
$zip = Join-Path $root ("dist\SimpleCode-{0}-share.zip" -f $ver)
$publicMem = Join-Path $root 'rules\zai-memory.public.md'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

Write-Host 'Copying win-unpacked ...'
Copy-Item -Path (Join-Path $src '*') -Destination $stage -Recurse -Force

$memTarget = Join-Path $stage 'resources\app-root\rules\zai-memory.md'
$memDir = Split-Path $memTarget -Parent
if (-not (Test-Path $memDir)) { New-Item -ItemType Directory -Path $memDir -Force | Out-Null }
if (Test-Path $publicMem) {
  Copy-Item $publicMem $memTarget -Force
  Write-Host ('Replaced public memory: {0}' -f $memTarget)
}

$readmeLines = @(
  ('SimpleCode {0} (share build)' -f $ver),
  '========================',
  '',
  '1. Unzip the whole folder (keep all files next to SimpleCode.exe).',
  '2. Double-click SimpleCode.exe',
  '3. Fill your own API Base URL / Key / model in Settings (stored on this PC only).',
  '4. Ships public persona for "zai"; no personal debate memory from the author.',
  '5. First run writes settings under %APPDATA%\SimpleCode',
  '',
  'Do NOT share your %APPDATA%\SimpleCode\settings.json (contains API keys).'
)
$readmeEn = Join-Path $stage 'README-SHARE.txt'
Set-Content -Path $readmeEn -Value ($readmeLines -join "`r`n") -Encoding UTF8
$readmeZhSrc = Join-Path $root 'scripts\share-readme.zh.txt'
if (Test-Path $readmeZhSrc) {
  Copy-Item $readmeZhSrc (Join-Path $stage '使用说明.txt') -Force
}

if (Test-Path $zip) { Remove-Item $zip -Force }
Write-Host ('Zipping -> {0}' -f $zip)

# Compress-Archive can choke on huge trees; prefer tar if available
$tar = Get-Command tar -ErrorAction SilentlyContinue
if ($tar) {
  Push-Location $stage
  try {
    & tar -a -cf $zip *
  } finally {
    Pop-Location
  }
} else {
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
}

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ''
Write-Host ('Done: {0}  ({1} MB)' -f $zip, $mb)
Write-Host 'Run after unzip: SimpleCode.exe'
Write-Host ('Staging folder (optional delete): {0}' -f $stage)
