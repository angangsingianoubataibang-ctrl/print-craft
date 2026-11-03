@echo off
setlocal EnableDelayedExpansion
title PrintCraft Print Agent
color 0A

cd /d "D:\My_project\demo\online-auto-printing-service\print-agent"

echo ============================================
echo   PrintCraft Print Agent
echo ============================================
echo.

REM ── Sanity checks ──
if not exist "server.js" (
    color 0C
    echo [ERROR] server.js not found in:
    echo         %CD%
    echo         Edit the "cd /d" line in this file.
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    color 0C
    echo [ERROR] Node.js is not installed or not in PATH.
    echo         Install from https://nodejs.org
    pause
    exit /b 1
)

REM ── Environment variables (must match index.html shopKey) ──
set SHOP_KEY=pc-2026-x9k4m2p7
set ADMIN_PASSWORD=Taibang001

REM ═══════════════════════════════════════════
REM   STEP 1 — Release port 3001 (kill stale node)
REM ═══════════════════════════════════════════
echo [1/4] Releasing port 3001 if held by a stale server...
set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3001" ^| findstr "LISTENING"') do (
    echo       Killing stale PID %%p
    taskkill /F /PID %%p >nul 2>nul
    set FOUND=1
)
if "!FOUND!"=="0" echo       Port is free.
timeout /t 1 /nobreak >nul

REM ═══════════════════════════════════════════
REM   STEP 2 — Verify Tailscale is running
REM ═══════════════════════════════════════════
echo.
echo [2/4] Checking Tailscale...
if not exist "C:\Program Files\Tailscale\tailscale.exe" (
    color 0E
    echo       [WARN] tailscale.exe not found at the default path.
    echo              Install Tailscale or edit this .bat file.
    color 0A
    goto :startServer
)

set TS_ATTEMPTS=0
:checkTailscale
"C:\Program Files\Tailscale\tailscale.exe" status >nul 2>nul
if not errorlevel 1 goto :tailscaleReady
set /a TS_ATTEMPTS+=1
if !TS_ATTEMPTS! GEQ 12 goto :tailscaleUnavailable
echo       Tailscale is still starting. Retrying in 5 seconds...
timeout /t 5 /nobreak >nul
goto :checkTailscale

:tailscaleUnavailable
    color 0E
    echo       [WARN] Tailscale is not running or not signed in.
    echo              Open the Tailscale tray icon and sign in.
    echo              Local printing will still work.
    color 0A
    goto :startServer

:tailscaleReady
echo       Tailscale OK.

REM ═══════════════════════════════════════════
REM   STEP 3 — Apply Tailscale Funnel
REM ═══════════════════════════════════════════
echo.
echo [3/4] Applying Tailscale Funnel on port 3001...
"C:\Program Files\Tailscale\tailscale.exe" funnel --bg --https=443 --yes 3001 >nul 2>nul
if errorlevel 1 (
    echo       First attempt failed - resetting funnel and retrying...
    "C:\Program Files\Tailscale\tailscale.exe" funnel reset >nul 2>nul
    "C:\Program Files\Tailscale\tailscale.exe" funnel --bg --https=443 --yes 3001 >nul 2>nul
)

"C:\Program Files\Tailscale\tailscale.exe" funnel status | findstr /C:"proxy http://127.0.0.1:3001" >nul
if errorlevel 1 (
    color 0E
    echo       [WARN] Funnel is NOT proxying to port 3001.
    echo              Run this manually to inspect:
    echo              "C:\Program Files\Tailscale\tailscale.exe" funnel status
    color 0A
) else (
    echo       Funnel OK - https://dorin.tail95d8ca.ts.net
)

timeout /t 2 /nobreak >nul

REM ═══════════════════════════════════════════
REM   STEP 4 — Start server (auto-restart on crash)
REM ═══════════════════════════════════════════
:startServer
echo.
echo [4/4] Starting PrintCraft server on port 3001...
echo.
echo ============================================
echo   Public URL : https://dorin.tail95d8ca.ts.net
echo   Local URL  : http://localhost:3001
echo   Admin      : http://localhost:3001/admin
echo ============================================
echo.
echo   Keep this window open while the shop is running.
echo   Press Ctrl+C to stop everything.
echo.

:runloop
node server.js
set EXITCODE=%ERRORLEVEL%

echo.
echo ============================================
color 0C
echo   Server exited with code %EXITCODE%.
echo   Restarting in 5 seconds... (Ctrl+C to stop)
echo ============================================
color 0A
timeout /t 5 /nobreak >nul
goto runloop
