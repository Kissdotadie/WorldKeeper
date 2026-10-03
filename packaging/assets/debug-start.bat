@echo off
rem ============================================================
rem  WorldKeeper - debug start (console visible)
rem
rem  It is written in PURE ASCII on purpose: a .bat with non-ASCII
rem  text gets mangled by whatever code page the user's cmd.exe
rem  happens to use, and then the debug script itself becomes a bug.
rem
rem  WHY THIS FILE EXISTS
rem  The normal icon starts the tray launcher. The tray has NO console,
rem  so if startup fails you see absolutely nothing. This file runs the
rem  BACKEND in this window instead, so every error prints right here.
rem  The tray launcher shows a balloon pointing at this script.
rem
rem  WHAT TO DO IF IT FAILS
rem  Screenshot this whole window and send it back.
rem ============================================================
setlocal

set "APP=%~dp0"
if not exist "%APP%runtime\python.exe" set "APP=%ProgramFiles%\WorldKeeper\"
if not exist "%APP%runtime\python.exe" set "APP=%ProgramFiles(x86)%\WorldKeeper\"
if not exist "%APP%runtime\python.exe" set "APP=%LOCALAPPDATA%\Programs\WorldKeeper\"

if not exist "%APP%runtime\python.exe" (
    echo [X] Cannot find the install directory.
    echo     Put this file next to WorldKeeper.exe and run it again.
    echo.
    pause
    exit /b 1
)

cd /d "%APP%"
echo [i] Install dir : %APP%
echo [i] Interpreter : %APP%runtime\python.exe
echo.
echo [i] Starting the backend in THIS window.
echo     Keep this window open; closing it stops the service.
echo     Press Ctrl+C to stop.
echo ------------------------------------------------------------
set PYTHONFAULTHANDLER=1
set WKV_NO_AUTOLAUNCH=1
"%APP%runtime\python.exe" -m app.main
echo ------------------------------------------------------------
echo [i] The backend exited. Code: %ERRORLEVEL%
echo.
echo If nothing worked, screenshot this window and send it back.
echo The log file is in your data directory: logs\
echo.
pause
