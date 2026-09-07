@echo off
rem Engram source-mode installer entry (double-click friendly); all text lives in setup-source.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-source.ps1" %*
pause
