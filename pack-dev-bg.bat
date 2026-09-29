@echo off
chcp 65001 >nul
cd /d D:\SpCode
set SKIP_DIST_PROXY=1
call npm run pack:dev > pack-dev.log 2>&1
echo BUILD_DONE >> pack-dev.log
