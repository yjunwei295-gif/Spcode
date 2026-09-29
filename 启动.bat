@echo off
chcp 65001 >nul
cd /d "%~dp0"
title SimpleCode
node "%~dp0scripts\launch.js"
echo.
pause
exit /b %ERRORLEVEL%
