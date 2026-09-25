@echo off
rem Double-click to start the study system and open it in the browser.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

if not exist web\dist\index.html (
  echo Building the interface...
  call npm run build
  if errorlevel 1 goto :fail
)

node --disable-warning=ExperimentalWarning server\main.ts --open
rem Keep the window open on failure so the message can be read.
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
echo Something went wrong. See the messages above.
pause
exit /b 1
