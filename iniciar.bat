@echo off
setlocal
title HaTitiX
cd /d "%~dp0"

if not exist "package.json" goto missing_project_files
if not exist "package-lock.json" goto missing_lockfile
if not exist "main.js" goto wrong_project
if not exist "client.js" goto wrong_project
if not exist "index.html" goto wrong_project
if /i "%PROCESSOR_ARCHITECTURE%"=="x86" if not defined PROCESSOR_ARCHITEW6432 goto unsupported_arch

where node >nul 2>nul
if errorlevel 1 goto bootstrap_node
node -e "const [major, minor] = process.versions.node.split('.').map(Number); const arch = process.arch; process.exit(major < 22 || (major === 22 && minor < 12) || (arch !== 'x64' && arch !== 'arm64') ? 1 : 0)"
if errorlevel 1 goto bootstrap_node
where npm >nul 2>nul
if errorlevel 1 goto bootstrap_node
goto runtime_ready

:bootstrap_node
set "NODE_VERSION=22.23.4"
set "NODE_ARCH=win-x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NODE_ARCH=win-arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "NODE_ARCH=win-arm64"
set "NODE_ROOT=%~dp0.runtime"
set "NODE_HOME=%NODE_ROOT%\node-v%NODE_VERSION%-%NODE_ARCH%"
set "NODE_ZIP=%TEMP%\hatitix-node-v%NODE_VERSION%-%NODE_ARCH%.zip"
if exist "%NODE_HOME%\node.exe" goto use_portable_node
where powershell >nul 2>nul
if errorlevel 1 goto powershell_missing
if not exist "%NODE_ROOT%" mkdir "%NODE_ROOT%"
echo.
echo No se encontro Node.js compatible. Descargando Node.js portatil...
echo Descarga oficial: Node.js %NODE_VERSION% para %NODE_ARCH%.
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-%NODE_ARCH%.zip' -OutFile $env:NODE_ZIP; Expand-Archive -LiteralPath $env:NODE_ZIP -DestinationPath $env:NODE_ROOT -Force; Remove-Item -LiteralPath $env:NODE_ZIP -Force"
if errorlevel 1 goto node_download_failed
if not exist "%NODE_HOME%\node.exe" goto node_download_failed

:use_portable_node
set "PATH=%NODE_HOME%;%PATH%"

:runtime_ready
where node >nul 2>nul
if errorlevel 1 goto missing_node
where npm >nul 2>nul
if errorlevel 1 goto missing_npm
node -e "const [major, minor] = process.versions.node.split('.').map(Number); const arch = process.arch; process.exit(major < 22 || (major === 22 && minor < 12) || (arch !== 'x64' && arch !== 'arm64') ? 1 : 0)"
if errorlevel 1 goto old_node

if not exist "node_modules\electron\dist\electron.exe" goto install_dependencies
if not exist "node_modules\node-haxball\src\index.js" goto install_dependencies
goto launch

:install_dependencies
echo.
echo Descargando e instalando las dependencias de HaTitiX...
echo Se necesita conexion a Internet; esta instalacion se hace solo cuando faltan dependencias.
call npm ci --include=dev --no-audit --no-fund
if errorlevel 1 goto install_failed

echo.
echo Dependencias instaladas correctamente.

:launch
echo Iniciando HaTitiX...
call npm start
if errorlevel 1 goto launch_failed
exit /b 0

:missing_project_files
echo ERROR: Falta package.json. Comparte la carpeta completa del proyecto, no solo el .bat.
goto stop_with_error

:missing_lockfile
echo ERROR: Falta package-lock.json. Comparte la carpeta completa del proyecto.
goto stop_with_error

:wrong_project
echo ERROR: Esta no es la carpeta principal de HaTitix.
echo Ejecuta iniciar.bat desde la carpeta que contiene main.js, client.js e index.html.
echo La carpeta relay-server solo inicia el servidor de senalizacion; no abre la app.
goto stop_with_error

:unsupported_arch
echo ERROR: HaTitiX necesita Windows de 64 bits.
goto stop_with_error

:powershell_missing
echo ERROR: Windows PowerShell no esta disponible para descargar Node.js.
echo Instala Node.js 22.12 o superior manualmente desde https://nodejs.org/ y vuelve a abrir iniciar.bat.
goto stop_with_error

:node_download_failed
echo ERROR: No se pudo descargar Node.js portatil desde nodejs.org.
echo Revisa tu conexion a Internet y vuelve a abrir iniciar.bat.
goto stop_with_error

:missing_node
echo ERROR: Node.js no esta disponible despues de la descarga.
goto stop_with_error

:missing_npm
echo ERROR: npm no esta disponible con Node.js. Instala Node.js 22.12 o superior desde https://nodejs.org/.
goto stop_with_error

:old_node
echo ERROR: HaTitiX necesita Node.js 22.12 o superior de 64 bits.
goto stop_with_error

:install_failed
echo.
echo ERROR: No se pudieron instalar las dependencias.
echo Revisa tu conexion a Internet y vuelve a ejecutar iniciar.bat.
goto stop_with_error

:launch_failed
echo.
echo HaTitiX termino con un error. Revisa el mensaje anterior.
goto stop_with_error

:stop_with_error
echo.
pause
exit /b 1
