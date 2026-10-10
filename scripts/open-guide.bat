@echo off
REM ===========================================================================
REM  Open the Setup ^& Deployment guide  (Windows)
REM ===========================================================================
REM  Opens help\00-start-here.html in your default browser. Needs NOTHING running - no
REM  Docker, no Node, no server. This is the page to reach for when the board
REM  itself won't start.
REM
REM  Usage:  double-click this file, or run  scripts\open-guide.bat  in a terminal.
REM ===========================================================================

setlocal EnableDelayedExpansion
REM %~dp0 = the folder this script lives in (with trailing backslash).
REM Delayed expansion (!GUIDE!) keeps a path containing ) or & from breaking the
REM parenthesised block below.
set "GUIDE=%~dp0..\help\00-start-here.html"

if not exist "!GUIDE!" (
  echo.
  echo   [X] Guide not found at:
  echo       !GUIDE!
  echo   Run this from inside the repo ^(it expects .\help\00-start-here.html^).
  echo.
  pause
  exit /b 1
)

echo.
echo   Opening the Setup ^& Deployment guide...
echo       !GUIDE!
echo.

start "" "!GUIDE!"
endlocal
