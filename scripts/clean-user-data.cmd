@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo SimpleCode 用户数据清理工具
echo 风险提示：将删除聊天记录、日志、截图、界面配置与 API Key，保留模型权重。
echo.
echo %APPDATA% 下匹配 simple / sinpo 的项目：
dir "%APPDATA%" /b | findstr /i "simple sinpo"
echo.

if exist "%APPDATA%\SimpleCode" echo 将保留：%APPDATA%\SimpleCode\models（本地 GGUF 模型权重，不删除）
echo.
echo 【将删除】
if exist "%APPDATA%\SimpleCode\settings.json" (echo 文件：%APPDATA%\SimpleCode\settings.json) else (echo 不存在，跳过：%APPDATA%\SimpleCode\settings.json)
if exist "%APPDATA%\SimpleCode\agi-experience.json" (echo 文件：%APPDATA%\SimpleCode\agi-experience.json) else (echo 不存在，跳过：%APPDATA%\SimpleCode\agi-experience.json)
if exist "%APPDATA%\SimpleCode\brain-pressure.json" (echo 文件：%APPDATA%\SimpleCode\brain-pressure.json) else (echo 不存在，跳过：%APPDATA%\SimpleCode\brain-pressure.json)
if exist "%APPDATA%\SimpleCode\.migrated-from-sinpo" (echo 文件：%APPDATA%\SimpleCode\.migrated-from-sinpo) else (echo 不存在，跳过：%APPDATA%\SimpleCode\.migrated-from-sinpo)
if exist "%APPDATA%\SimpleCode\app-root" (echo 目录：%APPDATA%\SimpleCode\app-root) else (echo 不存在，跳过：%APPDATA%\SimpleCode\app-root)
if exist "%APPDATA%\SimpleCode\sessions" (echo 目录：%APPDATA%\SimpleCode\sessions) else (echo 不存在，跳过：%APPDATA%\SimpleCode\sessions)
if exist "%APPDATA%\SimpleCode\logs" (echo 目录：%APPDATA%\SimpleCode\logs) else (echo 不存在，跳过：%APPDATA%\SimpleCode\logs)
if exist "%APPDATA%\SimpleCode\ai-sight" (echo 目录：%APPDATA%\SimpleCode\ai-sight) else (echo 不存在，跳过：%APPDATA%\SimpleCode\ai-sight)
if exist "%APPDATA%\SimpleCode\Cache" (echo 目录：%APPDATA%\SimpleCode\Cache) else (echo 不存在，跳过：%APPDATA%\SimpleCode\Cache)
if exist "%APPDATA%\SimpleCode\GPUCache" (echo 目录：%APPDATA%\SimpleCode\GPUCache) else (echo 不存在，跳过：%APPDATA%\SimpleCode\GPUCache)
if exist "%APPDATA%\SimpleCode\Code Cache" (echo 目录：%APPDATA%\SimpleCode\Code Cache) else (echo 不存在，跳过：%APPDATA%\SimpleCode\Code Cache)
if exist "%APPDATA%\SimpleCode\DawnCache" (echo 目录：%APPDATA%\SimpleCode\DawnCache) else (echo 不存在，跳过：%APPDATA%\SimpleCode\DawnCache)
if exist "%APPDATA%\SimpleCode\Local Storage" (echo 目录：%APPDATA%\SimpleCode\Local Storage) else (echo 不存在，跳过：%APPDATA%\SimpleCode\Local Storage)
if exist "%APPDATA%\SimpleCode\Session Storage" (echo 目录：%APPDATA%\SimpleCode\Session Storage) else (echo 不存在，跳过：%APPDATA%\SimpleCode\Session Storage)
if exist "%APPDATA%\SimpleCode\Network" (echo 目录：%APPDATA%\SimpleCode\Network) else (echo 不存在，跳过：%APPDATA%\SimpleCode\Network)
if exist "%APPDATA%\SimpleCode\blob_storage" (echo 目录：%APPDATA%\SimpleCode\blob_storage) else (echo 不存在，跳过：%APPDATA%\SimpleCode\blob_storage)
if exist "%APPDATA%\SimpleCode\Crashpad" (echo 目录：%APPDATA%\SimpleCode\Crashpad) else (echo 不存在，跳过：%APPDATA%\SimpleCode\Crashpad)
if exist "%APPDATA%\SimpleCode\.sinpo-snapshots" (echo 目录：%APPDATA%\SimpleCode\.sinpo-snapshots) else (echo 不存在，跳过：%APPDATA%\SimpleCode\.sinpo-snapshots)
if exist "%APPDATA%\SimpleCode\.simple" (echo 目录：%APPDATA%\SimpleCode\.simple) else (echo 不存在，跳过：%APPDATA%\SimpleCode\.simple)
if exist "%APPDATA%\SimpleCode\.snapshots" (echo 目录：%APPDATA%\SimpleCode\.snapshots) else (echo 不存在，跳过：%APPDATA%\SimpleCode\.snapshots)
if exist "%APPDATA%\SinpoCode" (echo 目录：%APPDATA%\SinpoCode（整个旧名目录）) else (echo 不存在，跳过：%APPDATA%\SinpoCode)
echo.

set /p sure=确认删除请输入 Y 后回车（其他任意键取消）: 
if /i "!sure!"=="Y" goto confirmed
echo 已取消，未删除任何文件
goto finished

:confirmed
echo.
echo 正在清理用户数据……
if exist "%APPDATA%\SimpleCode\settings.json" (
  del /f /q "%APPDATA%\SimpleCode\settings.json" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\settings.json" echo 已删除：%APPDATA%\SimpleCode\settings.json
)
if exist "%APPDATA%\SimpleCode\agi-experience.json" (
  del /f /q "%APPDATA%\SimpleCode\agi-experience.json" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\agi-experience.json" echo 已删除：%APPDATA%\SimpleCode\agi-experience.json
)
if exist "%APPDATA%\SimpleCode\brain-pressure.json" (
  del /f /q "%APPDATA%\SimpleCode\brain-pressure.json" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\brain-pressure.json" echo 已删除：%APPDATA%\SimpleCode\brain-pressure.json
)
if exist "%APPDATA%\SimpleCode\.migrated-from-sinpo" (
  del /f /q "%APPDATA%\SimpleCode\.migrated-from-sinpo" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\.migrated-from-sinpo" echo 已删除：%APPDATA%\SimpleCode\.migrated-from-sinpo
)
if exist "%APPDATA%\SimpleCode\app-root" (
  rmdir /s /q "%APPDATA%\SimpleCode\app-root" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\app-root" echo 已删除：%APPDATA%\SimpleCode\app-root
)
if exist "%APPDATA%\SimpleCode\sessions" (
  rmdir /s /q "%APPDATA%\SimpleCode\sessions" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\sessions" echo 已删除：%APPDATA%\SimpleCode\sessions
)
if exist "%APPDATA%\SimpleCode\logs" (
  rmdir /s /q "%APPDATA%\SimpleCode\logs" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\logs" echo 已删除：%APPDATA%\SimpleCode\logs
)
if exist "%APPDATA%\SimpleCode\ai-sight" (
  rmdir /s /q "%APPDATA%\SimpleCode\ai-sight" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\ai-sight" echo 已删除：%APPDATA%\SimpleCode\ai-sight
)
if exist "%APPDATA%\SimpleCode\Cache" (
  rmdir /s /q "%APPDATA%\SimpleCode\Cache" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\Cache" echo 已删除：%APPDATA%\SimpleCode\Cache
)
if exist "%APPDATA%\SimpleCode\GPUCache" (
  rmdir /s /q "%APPDATA%\SimpleCode\GPUCache" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\GPUCache" echo 已删除：%APPDATA%\SimpleCode\GPUCache
)
if exist "%APPDATA%\SimpleCode\Code Cache" (
  rmdir /s /q "%APPDATA%\SimpleCode\Code Cache" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\Code Cache" echo 已删除：%APPDATA%\SimpleCode\Code Cache
)
if exist "%APPDATA%\SimpleCode\DawnCache" (
  rmdir /s /q "%APPDATA%\SimpleCode\DawnCache" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\DawnCache" echo 已删除：%APPDATA%\SimpleCode\DawnCache
)
if exist "%APPDATA%\SimpleCode\Local Storage" (
  rmdir /s /q "%APPDATA%\SimpleCode\Local Storage" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\Local Storage" echo 已删除：%APPDATA%\SimpleCode\Local Storage
)
if exist "%APPDATA%\SimpleCode\Session Storage" (
  rmdir /s /q "%APPDATA%\SimpleCode\Session Storage" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\Session Storage" echo 已删除：%APPDATA%\SimpleCode\Session Storage
)
if exist "%APPDATA%\SimpleCode\Network" (
  rmdir /s /q "%APPDATA%\SimpleCode\Network" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\Network" echo 已删除：%APPDATA%\SimpleCode\Network
)
if exist "%APPDATA%\SimpleCode\blob_storage" (
  rmdir /s /q "%APPDATA%\SimpleCode\blob_storage" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\blob_storage" echo 已删除：%APPDATA%\SimpleCode\blob_storage
)
if exist "%APPDATA%\SimpleCode\Crashpad" (
  rmdir /s /q "%APPDATA%\SimpleCode\Crashpad" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\Crashpad" echo 已删除：%APPDATA%\SimpleCode\Crashpad
)
if exist "%APPDATA%\SimpleCode\.sinpo-snapshots" (
  rmdir /s /q "%APPDATA%\SimpleCode\.sinpo-snapshots" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\.sinpo-snapshots" echo 已删除：%APPDATA%\SimpleCode\.sinpo-snapshots
)
if exist "%APPDATA%\SimpleCode\.simple" (
  rmdir /s /q "%APPDATA%\SimpleCode\.simple" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\.simple" echo 已删除：%APPDATA%\SimpleCode\.simple
)
if exist "%APPDATA%\SimpleCode\.snapshots" (
  rmdir /s /q "%APPDATA%\SimpleCode\.snapshots" >nul 2>nul
  if not exist "%APPDATA%\SimpleCode\.snapshots" echo 已删除：%APPDATA%\SimpleCode\.snapshots
)
if exist "%APPDATA%\SinpoCode" (
  rmdir /s /q "%APPDATA%\SinpoCode" >nul 2>nul
  if not exist "%APPDATA%\SinpoCode" echo 已删除：%APPDATA%\SinpoCode
)

if exist "%APPDATA%\SimpleCode\" (
  for %%I in ("%APPDATA%\SimpleCode\*") do (
    if exist "%%~fI" (
      if /i not "%%~nxI"=="models" (
        if exist "%%~fI\NUL" (
          rmdir /s /q "%%~fI" >nul 2>nul
          if not exist "%%~fI" echo 已删除：%%~fI
        ) else (
          del /f /q "%%~fI" >nul 2>nul
          if not exist "%%~fI" echo 已删除：%%~fI
        )
      )
    )
  )
)

echo.
echo 清理后 SimpleCode 剩余项目：
dir "%APPDATA%\SimpleCode" /b
if exist "%APPDATA%\SinpoCode" (echo 警告：SinpoCode 仍存在) else (echo 检查：SinpoCode 目录已清除)
if exist "%APPDATA%\SimpleCode\settings.json" (echo 警告：settings.json 仍存在) else (echo 检查：settings.json 已清除)
echo.
echo 【下一步】
echo 1. 运行安装包时取消勾选「运行 SimpleCode」，装完不要立刻启动。
echo 2. 装完在 cmd 执行：dir "%APPDATA%" /b ^| findstr /i simple
echo 3. 若此时出现 SimpleCode 目录且里面已有 settings.json，说明是安装包自带配置，把该文件发给我；若没有，说明包是干净的。

echo 清理流程结束。
:finished
pause
exit /b 0
