@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
set "BINARY=galene.exe"
set "MEDIAPIPE_PACKAGE=@mediapipe/tasks-vision"
set "MEDIAPIPE_DIR=static\third-party\tasks-vision"
set "MODELS_DIR=%MEDIAPIPE_DIR%\models"
set "MODEL_URL=https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite"
set "TARGET=%~1"
set "EXITCODE=0"
set "ROOT_URI=%ROOT:\=/%"

if not defined TARGET set "TARGET=build"

pushd "%ROOT%" >nul || (
    echo Failed to enter project directory: %ROOT%
    exit /b 1
)

if /I "%TARGET%"=="build" (
    call :build
    set "EXITCODE=!ERRORLEVEL!"
    goto :end
)

if /I "%TARGET%"=="blur" (
    call :blur
    set "EXITCODE=!ERRORLEVEL!"
    goto :end
)

if /I "%TARGET%"=="all" (
    call :build
    if errorlevel 1 (
        set "EXITCODE=!ERRORLEVEL!"
        goto :end
    )
    call :blur
    set "EXITCODE=!ERRORLEVEL!"
    goto :end
)

if /I "%TARGET%"=="clean" (
    call :clean
    set "EXITCODE=!ERRORLEVEL!"
    goto :end
)

if /I "%TARGET%"=="help" goto :help
if /I "%TARGET%"=="-h" goto :help
if /I "%TARGET%"=="--help" goto :help

echo Unknown target: %TARGET%
set "EXITCODE=1"
goto :help

:build
where /q go.exe
if errorlevel 1 (
    echo Required tool not found: go.exe
    exit /b 1
)

if not defined CGO_ENABLED set "CGO_ENABLED=0"
if not defined GOCACHE (
    if exist "%ROOT%.gocache\" (
        set "GOCACHE=%ROOT%.gocache"
    ) else if exist "%ROOT%tmp-gocache\" (
        set "GOCACHE=%ROOT%tmp-gocache"
    ) else (
        set "GOCACHE=%TEMP%\galene-gocache"
    )
)

if not defined GOMODCACHE (
    if exist "%ROOT%.gomodcache\" (
        set "GOMODCACHE=%ROOT%.gomodcache"
    ) else if exist "%ROOT%tmp-gomodcache\" (
        set "GOMODCACHE=%ROOT%tmp-gomodcache"
    ) else (
        set "GOMODCACHE=%TEMP%\galene-gomodcache"
    )
)

if not exist "%GOCACHE%" mkdir "%GOCACHE%" >nul 2>&1
if errorlevel 1 (
    echo Failed to create Go build cache: %GOCACHE%
    exit /b 1
)

if not exist "%GOMODCACHE%" mkdir "%GOMODCACHE%" >nul 2>&1
if errorlevel 1 (
    echo Failed to create Go module cache: %GOMODCACHE%
    exit /b 1
)

if not defined GOSUMDB set "GOSUMDB=off"
if not defined GOPROXY (
    if exist "%ROOT%tmp-gomodcache\cache\download\" (
        set "GOPROXY=file:///%ROOT_URI%tmp-gomodcache/cache/download"
    )
)

echo Building %BINARY%...
go build -buildvcs=false -trimpath -ldflags="-s -w" -o "%BINARY%" .
if errorlevel 1 (
    echo Build failed.
    exit /b 1
)

echo Built: %ROOT%%BINARY%
exit /b 0

:blur
where /q npm.cmd
if errorlevel 1 (
    echo Required tool not found: npm.cmd
    exit /b 1
)
where /q curl.exe
if errorlevel 1 (
    echo Required tool not found: curl.exe
    exit /b 1
)
where /q tar.exe
if errorlevel 1 (
    echo Required tool not found: tar.exe
    exit /b 1
)
where /q robocopy.exe
if errorlevel 1 (
    echo Required tool not found: robocopy.exe
    exit /b 1
)

set "TMP_DIR=%TEMP%\galene-mediapipe-%RANDOM%%RANDOM%"
set "PACKAGE_ARCHIVE="

mkdir "%TMP_DIR%" >nul 2>&1
if errorlevel 1 (
    echo Failed to create temp directory: %TMP_DIR%
    exit /b 1
)

echo Installing background blur assets...
pushd "%TMP_DIR%" >nul || (
    echo Failed to enter temp directory: %TMP_DIR%
    rmdir /s /q "%TMP_DIR%" >nul 2>&1
    exit /b 1
)

call npm.cmd pack %MEDIAPIPE_PACKAGE% --silent >nul
if errorlevel 1 (
    popd >nul
    rmdir /s /q "%TMP_DIR%" >nul 2>&1
    echo Failed to download %MEDIAPIPE_PACKAGE%.
    exit /b 1
)

for /f "delims=" %%F in ('dir /b mediapipe-tasks-vision-*.tgz 2^>nul') do (
    if not defined PACKAGE_ARCHIVE set "PACKAGE_ARCHIVE=%%F"
)

if not defined PACKAGE_ARCHIVE (
    popd >nul
    rmdir /s /q "%TMP_DIR%" >nul 2>&1
    echo Could not locate downloaded MediaPipe package archive.
    exit /b 1
)

tar.exe -xzf "%PACKAGE_ARCHIVE%" >nul
if errorlevel 1 (
    popd >nul
    rmdir /s /q "%TMP_DIR%" >nul 2>&1
    echo Failed to extract %PACKAGE_ARCHIVE%.
    exit /b 1
)

if exist "%ROOT%%MEDIAPIPE_DIR%" (
    rmdir /s /q "%ROOT%%MEDIAPIPE_DIR%"
    if exist "%ROOT%%MEDIAPIPE_DIR%" (
        popd >nul
        rmdir /s /q "%TMP_DIR%" >nul 2>&1
        echo Failed to remove existing %MEDIAPIPE_DIR%.
        exit /b 1
    )
)

robocopy.exe "package" "%ROOT%%MEDIAPIPE_DIR%" /E /NFL /NDL /NJH /NJS /NC /NS >nul
set "ROBOCOPY_EXIT=!ERRORLEVEL!"
if !ROBOCOPY_EXIT! GEQ 8 (
    popd >nul
    rmdir /s /q "%TMP_DIR%" >nul 2>&1
    echo Failed to copy MediaPipe assets.
    exit /b 1
)

mkdir "%ROOT%%MODELS_DIR%" >nul 2>&1
curl.exe -L --fail --silent --show-error "%MODEL_URL%" -o "%ROOT%%MODELS_DIR%\selfie_segmenter.tflite"
if errorlevel 1 (
    popd >nul
    rmdir /s /q "%TMP_DIR%" >nul 2>&1
    echo Failed to download background blur model.
    exit /b 1
)

popd >nul
rmdir /s /q "%TMP_DIR%" >nul 2>&1
echo Background blur enabled.
exit /b 0

:clean
if exist "%BINARY%" del /f /q "%BINARY%" >nul 2>&1
if exist "%MEDIAPIPE_DIR%" rmdir /s /q "%MEDIAPIPE_DIR%" >nul 2>&1
echo Cleaned build artifacts.
exit /b 0

:help
echo Owly Windows build script
echo.
echo Usage:
echo   build.cmd [build^|blur^|all^|clean^|help]
echo.
echo Targets:
echo   build  Build %BINARY% with CGO disabled by default.
echo   blur   Install optional MediaPipe assets for background blur.
echo   all    Run build and blur.
echo   clean  Remove %BINARY% and MediaPipe assets.
echo   help   Show this message.

:end
popd >nul
exit /b %EXITCODE%
