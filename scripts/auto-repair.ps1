# 自动修复/重启脚本：SimpleCode 遇到 ERR_PROXY_CONNECTION_FAILED 等代理错误时自动重启
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/auto-repair.ps1
param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [int]$CheckIntervalSeconds = 5,
  [int]$ProxyErrorCooldownSeconds = 10
)

$ErrorActionPreference = 'Continue'
$procName = 'SimpleCode'
$npmStartInfo = New-Object System.Diagnostics.ProcessStartInfo
$npmStartInfo.FileName = 'npm'
$npmStartInfo.Arguments = 'start'
$npmStartInfo.WorkingDirectory = $ProjectRoot
$npmStartInfo.UseShellExecute = $false
$npmStartInfo.RedirectStandardOutput = $true
$npmStartInfo.RedirectStandardError = $true
$npmStartInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
$npmStartInfo.StandardErrorEncoding = [Text.Encoding]::UTF8

function Write-Log($msg) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Write-Host "[$ts] $msg"
}

function Start-SpCode {
  Write-Log '启动 SimpleCode...'
  $proc = [System.Diagnostics.Process]::Start($npmStartInfo)
  if ($proc) {
    # 异步读取输出，避免缓冲区满导致阻塞
    $null = $proc.BeginOutputReadLine()
    $null = $proc.BeginErrorReadLine()
  }
  return $proc
}

function Stop-SpCode($proc) {
  if ($proc -and -not $proc.HasExited) {
    Write-Log '结束当前 SimpleCode 进程...'
    try { $proc.Kill() } catch { }
    try { $proc.WaitForExit(5000) } catch { }
  }
  # 兜底：按进程名清理残留
  Get-Process -Name $procName -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Log "清理残留进程 PID $($_.Id)"
    try { $_.Kill() } catch { }
  }
  Get-Process -Name 'electron' -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Path -and $_.Path -like '*simplecode*') {
      Write-Log "清理残留 electron PID $($_.Id)"
      try { $_.Kill() } catch { }
    }
  }
}

function Test-ProxyErrorVisible {
  # 通过窗口标题/OCR判断程序界面是否出现代理错误（这里仅兜底，主要依赖日志关键词）
  $wins = Get-Process -Name $procName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty MainWindowTitle
  if ($wins | Where-Object { $_ -match 'ERR_PROXY_CONNECTION_FAILED' }) { return $true }
  return $false
}

# 主循环：看护 SimpleCode，异常退出或检测到代理错误时自动重启
$current = $null
try {
  while ($true) {
    if (-not $current -or $current.HasExited) {
      Stop-SpCode $current
      Start-Sleep -Seconds 1
      $current = Start-SpCode
      continue
    }

    # 检测最近日志/输出里是否出现代理错误
    $proxyErr = Test-ProxyErrorVisible
    if ($proxyErr) {
      Write-Log '检测到 ERR_PROXY_CONNECTION_FAILED，准备重启...'
      Stop-SpCode $current
      Start-Sleep -Seconds $ProxyErrorCooldownSeconds
      $current = Start-SpCode
      continue
    }

    Start-Sleep -Seconds $CheckIntervalSeconds
  }
} finally {
  Stop-SpCode $current
}
