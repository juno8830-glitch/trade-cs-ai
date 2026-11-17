@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\start.js
if errorlevel 1 echo Program stopped unexpectedly. Please screenshot this window.
echo.
pause
