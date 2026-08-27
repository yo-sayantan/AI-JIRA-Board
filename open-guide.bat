@echo off
REM ===========================================================================
REM  Open the Setup ^& Deployment guide  (Windows)
REM ===========================================================================
REM  Opens docs\index.html in your default browser. Needs NOTHING running - no
REM  Docker, no Node, no server. This is the page to reach for when the board
REM  itself won't start.
REM
REM  Usage:  double-click this file, or run  open-guide.bat  in a terminal.
REM ===========================================================================

setlocal
REM %~dp0 = the folder this script lives in (with trailing backslash).
set "GUIDE=%~dp0docs\index.html"

if not exist "%GUIDE%" (
  echo.
  echo   [X] Guide not found at:
  echo       %GUIDE%
  echo   Run this from inside the repo ^(it expects .\docs\index.html^).
  echo.
  pause
  exit /b 1
)

echo.
echo   Opening the Setup ^& Deployment guide...
echo       %GUIDE%
echo.

start "" "%GUIDE%"
endlocal
