@echo off
title AIKombinat - Test
cd /d "%~dp0.."
echo ========================================
echo   AIKombinat - Run All Tests
echo ========================================
echo.
call npm test
echo.
if %errorlevel% neq 0 (
    echo Tests failed!
) else (
    echo All tests passed!
)
pause
