@echo off
title AIKombinat - Production
cd /d "%~dp0.."
echo ========================================
echo   AIKombinat - Production Mode
echo   http://localhost:3000
echo ========================================
echo.
call npm run start
pause
