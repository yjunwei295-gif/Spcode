# auto-build.ps1 - 自动打包 SimpleCode，遇到网络/代理错误时自动重试直到成功
param(
    [int]$MaxRetry = 50,
    [int]$WaitSeconds = 15
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$tmpDir = Join-Path $projectRoot "tmp-build"
$logFile = Join-Path $tmpDir "auto-build.log"
$successFlag = Join-Path $tmpDir "build-success.flag"
$failFlag = Join-Path $tmpDir "build-fail.flag"

# 确保临时目录存在
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

# 清除旧的状态标记
Remove-Item $successFlag -ErrorAction SilentlyContinue
Remove-Item $failFlag -ErrorAction SilentlyContinue

function Write-Log {
    param([string]$msg)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line -Encoding UTF8
}

# 禁用可能干扰的代理环境变量
$env:HTTP_PROXY = $null
$env:HTTPS_PROXY = $null
$env:http_proxy = $null
$env:https_proxy = $null
$env:ELECTRON_GET_USE_PROXY = "false"
$env:ELECTRON_BUILDER_ALLOW_UNRESOLVED = $null

Set-Location $projectRoot

# 检查 npm 是否可用
try {
    $npmVersion = npm --version 2>$null
    Write-Log "npm 版本: $npmVersion"
} catch {
    Write-Log "无法调用 npm，请检查 Node.js 环境"
    New-Item -ItemType File -Path $failFlag -Force | Out-Null
    exit 1
}

for ($i = 1; $i -le $MaxRetry; $i++) {
    Write-Log "===== 第 $i / $MaxRetry 次打包尝试 ====="
    
    $timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    $runLog = Join-Path $tmpDir "run-$timestamp.log"
    
    # 清理上一次的 dist，避免残留文件干扰判断
    $distDir = Join-Path $projectRoot "dist"
    if (Test-Path $distDir) {
        Remove-Item -Recurse -Force $distDir -ErrorAction SilentlyContinue
        Write-Log "已清理旧 dist 目录"
    }
    
    # 启动打包进程并等待结束
    $proc = Start-Process -FilePath "npm" -ArgumentList "run", "dist" -NoNewWindow -PassThru -RedirectStandardOutput $runLog -RedirectStandardError $runLog -WorkingDirectory $projectRoot
    $proc.WaitForExit()
    $exitCode = $proc.ExitCode
    
    # 读取本次输出并写入总日志
    $output = ""
    if (Test-Path $runLog) {
        $output = Get-Content $runLog -Raw -ErrorAction SilentlyContinue
        Add-Content -Path $logFile -Value $output -Encoding UTF8
    }
    
    Write-Log "本次打包退出码: $exitCode"
    
    if ($exitCode -eq 0) {
        # 检查是否真的生成了安装包
        $setup = Get-ChildItem -Path $distDir -Filter "SimpleCode Setup *.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
        $portable = Get-ChildItem -Path $distDir -Filter "SimpleCode-Portable-*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
        
        if ($setup -and $portable) {
            Write-Log "打包成功！"
            Write-Log "安装包: $($setup.FullName)"
            Write-Log "便携包: $($portable.FullName)"
            New-Item -ItemType File -Path $successFlag -Force | Out-Null
            exit 0
        } else {
            Write-Log "npm 退出码为 0，但未找到预期的安装包，继续重试..."
        }
    }
    
    # 判断错误类型
    $isProxyError = $output -match "ERR_PROXY_CONNECTION_FAILED"
    $isNetworkError = $output -match "(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|tunneling socket|getaddrinfo)"
    $isElectronDownloadError = $output -match "(cannot download|download failed|Failed to fetch)"
    
    if ($isProxyError) {
        Write-Log "检测到代理连接失败 (ERR_PROXY_CONNECTION_FAILED)，$WaitSeconds 秒后重试..."
    } elseif ($isNetworkError -or $isElectronDownloadError) {
        Write-Log "检测到网络/下载错误，$WaitSeconds 秒后重试..."
    } else {
        Write-Log "打包失败，$WaitSeconds 秒后重试..."
    }
    
    Start-Sleep -Seconds $WaitSeconds
}

Write-Log "达到最大重试次数 $MaxRetry，打包失败。"
New-Item -ItemType File -Path $failFlag -Force | Out-Null
exit 1
