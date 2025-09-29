@echo off

where node >nul 2>nul
if %errorlevel% neq 0 (
	echo Node.js is not installed.
	echo Please install Node.js from https://nodejs.org/
	echo or run "winget install OpenJS.NodeJS" command
	pause
	exit /b 1
)

if not exist "%~dp0node_modules" (
	echo node_modules folder not found, please run \"npm install --omit=dev\"
	pause
	exit /b 1
)

node %~dp0index.ts %*
pause
