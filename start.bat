@echo off
rem Works from the project folder and from a copy on the Desktop.
set "DIR=%~dp0"
if not exist "%DIR%scripts\start.ps1" set "DIR=%USERPROFILE%\Fitness-assist\"
powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%scripts\start.ps1"
pause
