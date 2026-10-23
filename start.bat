@echo off
setlocal
cd /d "%~dp0"
title EBS Launcher

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)

echo.
echo EBS servers:
echo   Main:   http://localhost:8080  -^>  https://localhost:6767
echo   Admin:  http://localhost:8081  -^>  https://localhost:6768
echo.
echo   This window runs both servers. Close the window to stop them.
echo.

set "ADMIN_PID="
set "PID_FILE=%TEMP%\ebs_admin_server.pid"
del /q "%PID_FILE%" >nul 2>nul
netstat -ano | findstr ":6768" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$psi = New-Object System.Diagnostics.ProcessStartInfo; $psi.FileName = 'node'; $psi.Arguments = 'admin-server.js'; $psi.UseShellExecute = $false; $p = [System.Diagnostics.Process]::Start($psi); Set-Content -LiteralPath (Join-Path $env:TEMP 'ebs_admin_server.pid') -Encoding Ascii -Value $p.Id"
  if exist "%PID_FILE%" set /p ADMIN_PID=<"%PID_FILE%"
  del /q "%PID_FILE%" >nul 2>nul
  if defined ADMIN_PID (
    echo [START] Admin server starting in this window...
  ) else (
    echo [ERROR] Failed to start admin server.
  )
) else (
  echo [SKIP] Admin server is already running on 6768.
)

set "MAIN_STARTED="
netstat -ano | findstr ":6767" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 (
  set "MAIN_STARTED=1"
  title EBS Main Server (6767)
  echo [START] Main server starting in this window. Press Ctrl+C to stop it.
  echo.
  node server.js
) else (
  echo [SKIP] Main server is already running on 6767.
  echo.
)

if defined ADMIN_PID if defined MAIN_STARTED (
  echo [STOP] Stopping admin server...
  taskkill /pid %ADMIN_PID% /t /f >nul 2>nul
)

echo.
echo Setup check finished.
pause >nul