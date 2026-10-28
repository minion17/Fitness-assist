@echo off
rem Works from the project folder and from a copy on the Desktop.
set "DIR=%~dp0"
if not exist "%DIR%scripts\update.ps1" set "DIR=%USERPROFILE%\Fitness-assist\"
powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%scripts\update.ps1"
pause
