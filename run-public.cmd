@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "PORT=%~1"

if not defined PORT set "PORT=8080"

pushd "%ROOT%" >nul || (
    echo Failed to enter project directory: %ROOT%
    exit /b 1
)

if not exist "galene.exe" (
    echo owly binary not found. Run build.cmd first.
    popd >nul
    exit /b 1
)

if not exist "data" mkdir "data" >nul 2>&1
if not exist "groups" mkdir "groups" >nul 2>&1
if not exist "recordings" mkdir "recordings" >nul 2>&1

echo Starting Owly on http://0.0.0.0:%PORT%/
echo Open in browser:
echo   http://localhost:%PORT%/
for /f "tokens=2 delims=:" %%I in ('ipconfig ^| findstr /C:"IPv4"') do (
    set "IP=%%I"
    setlocal EnableDelayedExpansion
    set "IP=!IP: =!"
    echo   http://!IP!:%PORT%/
    endlocal
)
echo Public room:
echo   /group/public/
echo Stop the server with Ctrl+C in this window.
echo.

galene.exe -insecure -http :%PORT% -data .\data -groups .\groups -recordings .\recordings -turn ""
set "EXITCODE=%ERRORLEVEL%"
popd >nul
exit /b %EXITCODE%
