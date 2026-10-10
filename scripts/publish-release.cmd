@echo off
rem SimpleCode release publisher launcher.
rem Why a launcher: long uploads need to run detached (the calling sandbox kills commands after 60s),
rem and this launcher reads publish-release.ps1 as UTF-8 explicitly, so Chinese text stays intact
rem on Windows PowerShell 5.1 (that version reads .ps1 without BOM as ANSI).
rem Keep this file ASCII-only: cmd.exe reads .cmd in the OEM codepage and would garble non-ASCII.
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([ScriptBlock]::Create([IO.File]::ReadAllText('%~dp0publish-release.ps1',[Text.Encoding]::UTF8)))"
