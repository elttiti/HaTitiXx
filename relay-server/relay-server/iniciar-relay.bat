@echo off
setlocal
title HaTitix - servidor de senalizacion
cd /d "%~dp0"

if not exist "package.json" goto missing_files
if not exist "package-lock.json" goto missing_lockfile

rem Reutilizar el Node portable descargado por iniciar.bat si existe.
if exist "%~dp0..\.runtime\node-v22.23.4-win-x64\node.exe" set "PATH=%~dp0..\.runtime\node-v22.23.4-win-x64;%PATH%"
if exist "%~dp0..\.runtime\node-v22.23.4-win-arm64\node.exe" set "PATH=%~dp0..\.runtime\node-v22.23.4-win-arm64;%PATH%"

where node >nul 2>nul
if errorlevel 1 goto missing_node
where npm >nul 2>nul
if errorlevel 1 goto missing_npm
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major < 22 ? 1 : 0)"
if errorlevel 1 goto old_node

if not exist "node_modules\ws\package.json" goto install_dependencies
goto check_env

:install_dependencies
echo Instalando la dependencia del servidor (ws) desde package-lock.json...
call npm ci --no-audit --no-fund
if errorlevel 1 goto install_failed

echo Dependencias del servidor instaladas correctamente.

:check_env
if not exist ".env" goto create_env
findstr /b /c:"RELAY_TOKEN=REEMPLAZAR_" .env >nul 2>nul
if not errorlevel 1 goto configure_env

echo Iniciando el servidor de senalizacion. Esta ventana debe quedar abierta.
echo Este proceso no abre HaTitix ni retransmite imagenes.
call npm start
if errorlevel 1 goto launch_failed
exit /b 0

:create_env
if exist ".env.example" goto copy_env_template
> ".env" echo # Token compartido para autenticar clientes HaTitix.
>> ".env" echo RELAY_TOKEN=REEMPLAZAR_POR_UN_TOKEN_ALEATORIO_DE_AL_MENOS_32_CARACTERES
>> ".env" echo HOST=127.0.0.1
>> ".env" echo PORT=8787
goto env_template_ready

:copy_env_template
copy /y ".env.example" ".env" >nul

:env_template_ready
echo.
echo Se creo .env, pero falta configurar RELAY_TOKEN.
echo Genera una clave con este comando:
echo node -p "require('node:crypto').randomBytes(32).toString('hex')"
start "" notepad.exe ".env"
goto stop_with_error

:configure_env
echo ERROR: Edita .env y reemplaza el valor REEMPLAZAR... de RELAY_TOKEN.
echo Usa un token aleatorio de al menos 32 caracteres. No lo compartas publicamente.
start "" notepad.exe ".env"
goto stop_with_error

:missing_files
echo ERROR: Falta package.json. Ejecuta este archivo dentro de relay-server.
goto stop_with_error

:missing_lockfile
echo ERROR: Falta package-lock.json. Necesitas la carpeta relay-server completa.
goto stop_with_error

:missing_node
echo ERROR: No encuentro Node.js. Instala Node.js 22 o abre primero iniciar.bat de la carpeta principal.
goto stop_with_error

:missing_npm
echo ERROR: npm no esta disponible. Reinstala Node.js 22 con npm incluido.
goto stop_with_error

:old_node
echo ERROR: El servidor requiere Node.js 22 o posterior.
goto stop_with_error

:install_failed
echo ERROR: npm ci no pudo instalar ws. Revisa Internet y vuelve a ejecutar este archivo.
goto stop_with_error

:launch_failed
echo El servidor termino con un error. Revisa el mensaje anterior.
goto stop_with_error

:stop_with_error
echo.
pause
exit /b 1
