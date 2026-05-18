@echo off
title SPVB Server Launcher

echo Starting SPVB servers...
echo.

:: Kill any existing processes on these ports
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":1402 :1403 :1404" ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)

timeout /t 1 /nobreak >nul

:: Start Backend (FastAPI on port 1404)
echo [1/3] Starting Backend on port 1404...
start "SPVB Backend :1404" /D "%~dp0backend" cmd /k "%~dp0backend\venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 1404 --reload"

timeout /t 3 /nobreak >nul

:: Start Frontend (Vite on port 1402)
echo [2/3] Starting Frontend on port 1402...
start "SPVB Frontend :1402" /D "%~dp0frontend" cmd /k "npm run dev"

:: Start Admin (Vite on port 1403)
echo [3/3] Starting Admin on port 1403...
start "SPVB Admin :1403" /D "%~dp0admin" cmd /k "npm run dev"

echo.
echo =========================================
echo   Frontend : http://localhost:1402
echo   Admin    : http://localhost:1403
echo   Backend  : http://localhost:1404
echo =========================================
echo.
echo LAN / Mobile Access (same WiFi):
echo   http://192.168.1.7:1402
echo.
pause
