@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo  HMIS Web Dashboard - local dev server
echo ============================================
echo.

REM ── Check Node/npm are reachable ─────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found on your PATH.
  echo.
  echo Install Node.js LTS from https://nodejs.org and run this again,
  echo or if it IS installed, open a new window after installing so the
  echo PATH refreshes.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do echo Node version: %%v

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm was not found even though node exists - reinstall Node LTS.
  pause
  exit /b 1
)

REM ── Install dependencies if missing ──────────────────────────────────────
if not exist node_modules (
  echo Installing dependencies - first run only, takes a few minutes...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed - see messages above.
    pause
    exit /b 1
  )
)

echo.
echo Starting the dev server. When you see "Ready", open:
echo.
echo     http://localhost:3000
echo.
echo A browser tab will open automatically in 8 seconds.
echo Keep THIS window open - closing it stops the server. Ctrl+C to stop.
echo.
start "" cmd /c "timeout /t 8 >nul & start http://localhost:3000"
call npm run dev

echo.
echo Server stopped.
pause
