@echo off
rem Double-click to remove Team Fahad Bridge from this PC (its settings stay in %APPDATA%\TeamFahadBridge).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall
pause
