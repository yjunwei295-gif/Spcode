# 发布到 NeicunDongwuyuan：
#   MemWatch.exe     = 启动器（自动检测/下载 .NET 8 Desktop Runtime）
#   MemWatch.App.exe = 主程序（依赖本机运行时）

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
if (-not (Test-Path (Join-Path $root "MemWatch\MemWatch.csproj"))) {
    $root = Split-Path -Parent $PSScriptRoot
}
if (-not (Test-Path (Join-Path $root "MemWatch\MemWatch.csproj"))) {
    throw "找不到 MemWatch\MemWatch.csproj，请在本仓库根目录运行 publish.ps1"
}
$out = Join-Path $root "NeicunDongwuyuan"
$dotnet = "C:\Program Files\dotnet\dotnet.exe"

New-Item -ItemType Directory -Force -Path $out | Out-Null
Get-Process MemWatch, "MemWatch.App" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

Get-ChildItem $out -Exclude "MemWatch.levels.json" | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue

& $dotnet publish (Join-Path $root "MemWatch\MemWatch.csproj") -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=false -p:AssemblyName=MemWatch.App -o $out

& $dotnet publish (Join-Path $root "MemWatch.Bootstrap\MemWatch.Bootstrap.csproj") -c Release -o $out

$oceanSrc = Join-Path $root "MemWatch\Assets\Ocean"
$oceanDst = Join-Path $out "Assets\Ocean"
if (Test-Path $oceanSrc) {
    New-Item -ItemType Directory -Force -Path $oceanDst | Out-Null
    Copy-Item (Join-Path $oceanSrc "*.png") $oceanDst -Force
}

Write-Host "Published:"
Get-ChildItem $out | Format-Table Name, @{N='KB';E={[math]::Round($_.Length/1KB,1)}} -AutoSize
