@echo off
REM Build script for hash engine N-API module (Windows)

echo Building hash engine native module...

REM Add Cargo to PATH if it exists in the default location
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
    set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
)

REM Build with cargo (release mode)
cargo build --release

if %errorlevel% neq 0 (
    echo ERROR: Cargo build failed
    exit /b 1
)

REM Copy the built library to index.node
if exist "target\release\HashEngine_napi.dll" (
    copy /Y "target\release\HashEngine_napi.dll" "index.node"
    echo Built: index.node
) else (
    echo ERROR: Could not find HashEngine_napi.dll
    exit /b 1
)

echo Hash engine build complete!
