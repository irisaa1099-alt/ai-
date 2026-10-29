@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title Quliao - Local Qwen3
pushd "%~dp0"
if errorlevel 1 goto :path_error
if not exist "runtime\node\win32-x64\node.exe" goto :missing_runtime
if not exist "runtime\ollama\win32-x64\ollama.exe" goto :missing_runtime
echo Starting Quliao with the bundled local model...
echo Keep this window open. Press Ctrl+C to stop the app.
echo.
"runtime\node\win32-x64\node.exe" "app\local-start.mjs"
set "QULIAO_EXIT=%ERRORLEVEL%"
popd
if "%QULIAO_EXIT%"=="0" exit /b 0
echo.
echo Startup failed. See the message above and README-Windows.txt.
pause
exit /b %QULIAO_EXIT%
:missing_runtime
echo Missing Windows runtime. Extract the entire ZIP before starting.
popd
pause
exit /b 1
:path_error
echo Cannot open the application folder. Move the extracted folder to a writable local disk.
pause
exit /b 1
