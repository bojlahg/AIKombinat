@echo off
title AIKombinat - Build
cd /d "%~dp0.."
echo ========================================
echo   AIKombinat - Build
echo ========================================
echo.
call npm run build
echo.
echo Build complete!
pause
