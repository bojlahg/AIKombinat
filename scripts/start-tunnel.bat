@echo off
title AIKombinat - Tunnel Mode
cd /d "%~dp0.."
echo ========================================
echo   AIKombinat - Tunnel Mode
echo   Local: http://localhost:3000
echo   Tunnel URL will appear below
echo ========================================
echo.
call npm run start:tunnel
pause
