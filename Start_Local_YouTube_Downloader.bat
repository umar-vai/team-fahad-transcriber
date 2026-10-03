@echo off
setlocal
cd /d "%~dp0"

set "VENV=.team-fahad-local-downloader"
set "APP=local_downloader\app.py"
set "REQ=local_downloader\requirements.txt"

where py >nul 2>nul
if %errorlevel%==0 (
    set "PY=py -3"
) else (
    where python >nul 2>nul
    if %errorlevel%==0 (
        set "PY=python"
    ) else (
        echo.
        echo Python 3 was not found on this PC.
        echo Install Python from https://www.python.org/downloads/ and enable "Add Python to PATH".
        echo Then double-click this file again.
        echo.
        pause
        exit /b 1
    )
)

if not exist "%VENV%\Scripts\python.exe" (
    echo Setting up Team Fahad Local YouTube Downloader for the first time...
    %PY% -m venv "%VENV%"
    if errorlevel 1 goto :setup_error
)

call "%VENV%\Scripts\activate.bat"

echo Checking downloader dependencies...
python -m pip install --disable-pip-version-check --quiet --upgrade pip
python -m pip install --disable-pip-version-check --quiet --upgrade -r "%REQ%"
if errorlevel 1 goto :setup_error

echo.
echo Starting Team Fahad Local YouTube Downloader...
echo Keep this window open while the downloader is running.
echo Your browser should open automatically.
echo.
python -m streamlit run "%APP%" --server.address 127.0.0.1 --server.port 8765 --browser.gatherUsageStats false
exit /b 0

:setup_error
echo.
echo Setup failed. Check your internet connection and Python installation, then try again.
echo.
pause
exit /b 1
