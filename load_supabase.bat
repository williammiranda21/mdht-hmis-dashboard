@echo off
REM ── Load dashboard data into Supabase ────────────────────────────────────
REM Run this AFTER running supabase\schema.sql in the Supabase SQL Editor,
REM and after a data refresh so it loads current outputs.
cd /d "%~dp0"
echo.
echo === Dry run (row counts only, no data written) ===
python pipeline\upsert_to_supabase.py --dry-run
echo.
set /p GO="Proceed with the real load? (y/n): "
if /i not "%GO%"=="y" goto :eof
python pipeline\upsert_to_supabase.py --verify
echo.
echo === Recomputing utilization (DV-excluded) ===
python pipeline\recompute_util.py
echo.
echo Done. Now run start_web.bat to test the app.
pause
