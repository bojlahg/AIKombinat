@echo off
title AIKombinat - Type Check
cd /d "%~dp0.."
echo ========================================
echo   AIKombinat - TypeScript Type Check
echo ========================================
echo.
call npm run typecheck
echo.
if %errorlevel% neq 0 (
    echo Type check failed!
) else (
    echo Type check passed!
)
pause
