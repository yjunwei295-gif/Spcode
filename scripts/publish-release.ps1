# 发布 SimpleCode 安装包到 GitHub Release
# 用法：cmd 里 cd /d D:\SpCode-push 后跑 scripts\publish-release.cmd（大文件上传要挂很久）
# 说明：用本机 git 已存的凭据调 GitHub API；token 只在内存里用，不写进任何文件
# 流程：取凭据 ---> 查同名版本 ---> 建版本并刷新说明 ---> 删同名旧附件 ---> 上传安装包 ---> 核对大小
# 版本说明正文放在 scripts\release-notes.md（UTF-8），脚本按 UTF-8 读入后整段发给 GitHub
# 注意：本文件必须存成带 UTF-8 BOM 的 .ps1，否则 Windows PowerShell 5.1 会按 ANSI 读中文，整段变乱码
# 网络：本机直连 github 会出现 TCP 连得上、数据一个字节都不传的挂死，所有请求统一走本机代理 $proxy
# 输出：只写日志文件，不用 Write-Host。控制台一旦被文本选中就会冻结输出，脚本会跟着一起挂住
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 本机代理端口；要换端口就设 HTTPS_PROXY 环境变量
$proxy = $env:HTTPS_PROXY
if (-not $proxy) {
  $proxy = 'http://127.0.0.1:19828'
}

# 用 -File 跑时按脚本所在目录定位仓库根；用 ScriptBlock 方式跑时按当前目录
$root = (Get-Location).Path
if ($PSScriptRoot) {
  $root = Split-Path $PSScriptRoot -Parent
}
Set-Location $root
$logPath = Join-Path $root 'dist\publish-release.log'

# 统一带时间戳写日志：只写文件，方便后台跑完后核对进度
# 不写控制台：控制台一旦被文本选中就会冻结输出，脚本会跟着一起挂住
function Say($msg) {
  $line = (Get-Date).ToString('HH:mm:ss') + '  ' + $msg
  [IO.File]::AppendAllText($logPath, $line + "`r`n", (New-Object Text.UTF8Encoding($false)))
}

# 统一的 GitHub API 调用：curl 结果先落文件，再按 UTF-8 读回
# 直接接管道会让 PowerShell 5.1 按控制台代码页解码，中文会变乱码、JSON 还会解析失败
function Call-GitHub($method, $url, $jsonFile) {
  $outFile = Join-Path $root 'dist\api-response.json'
  if ($jsonFile) {
    curl.exe -s -x $proxy --connect-timeout 20 -m 120 -o $outFile -X $method -H $authHeader -H 'Content-Type: application/json' --data-binary ('@' + $jsonFile) $url
  } else {
    curl.exe -s -x $proxy --connect-timeout 20 -m 120 -o $outFile -X $method -H $authHeader $url
  }
  return [IO.File]::ReadAllText($outFile, [Text.Encoding]::UTF8)
}

Say '==== 开始发布 ===='
$repo = 'yjunwei295-gif/Spcode'
# 发布版本和安装包名称统一来自项目版本，避免上传旧版安装包。
$version = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$tag = 'v' + $version
$releaseTitle = 'SimpleCode ' + $version
$assetName = 'SimpleCode-Setup-' + $version + '.exe'
$exePath = Join-Path $root ('dist\SimpleCode Setup ' + $version + '.exe')
$notesPath = Join-Path $root 'scripts\release-notes.md'
if (-not (Test-Path $exePath)) {
  throw ('找不到安装包：' + $exePath)
}
$exeSize = (Get-Item $exePath).Length
Say ('安装包 ' + $exePath + '  ' + [Math]::Round($exeSize / 1MB, 1) + ' MB')

# 从 git 凭据管理器里取 token
$credOut = ('url=https://github.com' | git credential fill)
$token = ($credOut | Where-Object { $_ -match '^password=' }) -replace '^password=', ''
if ($token.Length -lt 10) {
  throw '未能取到 git 凭据 token'
}
Say '已取到 GitHub 凭据'

$api = 'https://api.github.com/repos/' + $repo
$authHeader = 'Authorization: token ' + $token

# 版本说明 + 版本体：中文说明整段来自 release-notes.md
$notes = ''
if (Test-Path $notesPath) {
  $notes = [IO.File]::ReadAllText($notesPath, [Text.Encoding]::UTF8)
}
$bodyObj = @{
  tag_name         = $tag
  target_commitish = 'main'
  name             = $releaseTitle
  draft            = $false
  prerelease       = $false
  body             = $notes
}
$bodyFile = Join-Path $root 'dist\release-body.json'
# 明确写 UTF-8 无 BOM，避免中文说明上传后变乱码
[IO.File]::WriteAllText($bodyFile, ($bodyObj | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))

# 已经有同名版本就直接复用，避免重复建
$rel = $null
$existingRaw = Call-GitHub 'GET' ($api + '/releases/tags/' + $tag) $null
if ($existingRaw) {
  $existing = $existingRaw | ConvertFrom-Json
  if ($existing.id) {
    $rel = $existing
    Say ('复用已有版本 ' + $tag + '（id=' + $rel.id + '）')
  }
}

if (-not $rel) {
  Say ('创建版本 ' + $tag + ' ...')
  $rel = (Call-GitHub 'POST' ($api + '/releases') $bodyFile) | ConvertFrom-Json
  if (-not $rel.id) {
    throw ('创建版本失败，请看 dist\api-response.json')
  }
  Say ('已创建版本 ' + $rel.tag_name + '（id=' + $rel.id + '，draft=' + $rel.draft + '）')
} else {
  # 说明文字以本地 release-notes.md 为准，顺手刷一遍，保证中文正确
  $patched = (Call-GitHub 'PATCH' ($api + '/releases/' + $rel.id) $bodyFile) | ConvertFrom-Json
  if ($patched.id) {
    Say '已刷新版本说明'
  }
}

# 上传前先清掉同名旧附件，保证附件是最新那份
foreach ($old in @($rel.assets)) {
  if ($old.name -eq $assetName) {
    Say ('删除同名旧附件 ' + $old.name)
    Call-GitHub 'DELETE' ($api + '/releases/assets/' + $old.id) $null | Out-Null
  }
}

$uploadUrl = 'https://uploads.github.com/repos/' + $repo + '/releases/' + $rel.id + '/assets?name=' + $assetName
$respFile = Join-Path $root 'dist\upload-response.json'
$progFile = Join-Path $root 'dist\upload-progress.txt'
Say '开始上传（大文件，耐心等）...'
# -T 是流式上传，不会把整包读进内存
# 注意这里不能用 -s：silent 会把进度表一起静音，导致上传期间看不到任何进度
# 用 -S 只显示错误，进度表写进 dist\upload-progress.txt，外部可以随时查看
curl.exe -S -x $proxy --connect-timeout 30 --speed-time 300 --speed-limit 1024 -m 3600 --stderr $progFile -X POST -H $authHeader -H 'Content-Type: application/octet-stream' -T $exePath -o $respFile $uploadUrl
Say '上传请求已返回，核对结果...'

$asset = ([IO.File]::ReadAllText($respFile, [Text.Encoding]::UTF8)) | ConvertFrom-Json
if ($asset.id -and $asset.size -eq $exeSize) {
  Say ('上传成功：' + $asset.name + '  大小 ' + [Math]::Round($asset.size / 1MB, 1) + ' MB')
  Say ('下载地址：' + $asset.browser_download_url)
  Say ('发布页：' + $rel.html_url)
} else {
  Say '上传结果异常，请看 dist\upload-response.json'
}
Say '==== 结束 ===='
