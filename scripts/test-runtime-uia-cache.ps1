# 加载生产帮助进程的定义部分，核对只读 Observe 不会使旧 Scan 的操作句柄失效。
param([Parameter(Mandatory=$true)][string]$WindowHandle)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$helperPath = Join-Path $PSScriptRoot '../electron/lib/desktop-hand.ps1'
$source = [IO.File]::ReadAllText($helperPath, [Text.Encoding]::UTF8)
$entry = $source.IndexOf('while ($true) {')
if ($entry -lt 0) { throw 'Missing helper entry' }
& ([scriptblock]::Create($source.Substring(0, $entry)))
$scan = [Uia]::Scan([IntPtr][int64]$WindowHandle, 32, 2500)
if ([int]$scan[0] -lt 0) { throw [string]$scan[1] }
$index = -1
foreach ($item in $scan[2]) {
 if ($item[2] -eq 'SpCode Runtime Editor') { $index = [int]$item[0] }
}
if ($index -lt 0) { throw 'Missing fixture editor' }
$observed = [Uia]::Observe([int64]$WindowHandle, [string[]]@('editor'), [string[]]@('SpCode Runtime Editor'), [string[]]@(''), [string[]]@('Edit'), 2500)
$acted = [Uia]::Act([int]$scan[0], $index, 'set_text', 'cache-survives')
if ($acted -ne 'ok') { throw ('Original scan no longer usable: ' + $acted) }
[Console]::WriteLine((@{ok=$true;seq=[int]$scan[0];index=$index;observed=$observed['editor']['name']} | ConvertTo-Json -Compress))
