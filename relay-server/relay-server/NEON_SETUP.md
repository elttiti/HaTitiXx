# HaTitix: cuentas y amistades con Neon Postgres

Este cambio añade el registro/inicio de sesión obligatorio, una cuenta HaTitix separada del perfil de jugador Haxball, identificadores `Nombre#1234`, amistades por solicitud con aceptación/rechazo y persistencia PostgreSQL. El canal WebRTC continúa en `/ws`; la API de cuentas está bajo `/api/*`.

## Archivos del paquete

Extrae el paquete en la carpeta raíz del proyecto HaTitix, respetando estas rutas:

- En la raíz: `index.html`, `client.js`, `renderer.js`, `account-client.js` y `render.yaml`.
- En `relay-server/`: `server.js`, `accounts.js`, `package.json` y `package-lock.json`.
- `relay-server/NEON_SETUP.md` es esta guía; no requiere instalación adicional.

No copies ninguna cadena de conexión a los archivos del repositorio. No subas `.env` ni contraseñas.

## Conectar Neon con Render

1. En Render abre el servicio existente `hatitix-webrtc-signaling` y entra a **Environment**.
2. Añade una variable: nombre `DATABASE_URL`; valor, la cadena de conexión PostgreSQL actualizada de Neon para la rama `producción` y la base `Hatitix`. Usa la cadena con agrupación de conexiones activada si fue la opción que seleccionaste en Neon.
3. Guarda los cambios. Render redeplegará el servidor al recibir también los archivos nuevos del repositorio.
4. Al iniciar, el servidor crea automáticamente tablas de cuentas, sesiones, solicitudes y amistades. Abre el endpoint `/health` del dominio del relay y comprueba que muestre `"accounts":true`.
5. Mantén el token viejo de señalización `RELAY_TOKEN` como está; es distinto de `DATABASE_URL`.

La configuración actual permite que WebRTC siga funcionando si `DATABASE_URL` todavía no existe; la API de cuentas dará `503` hasta que se añada correctamente.

## Uso en HaTitix

La primera vez aparece registro; después, inicio de sesión. El correo identifica el acceso, la contraseña se almacena como hash scrypt y la sesión se mantiene en el dispositivo. El identificador público es `Nombre#1234`. En **AMIGOS**, busca el ID completo, envía solicitud y acepta o rechaza las solicitudes recibidas. El perfil HaTitix puede guardar por separado el nombre de jugador Haxball y datos básicos del banner.

## Alcance y limitaciones de esta primera versión

- El servidor aún no verifica que el usuario controle el correo y no cuenta con recuperación de contraseña. El formulario lo advierte; recomienda usar una contraseña exclusiva y no usar esta versión para información sensible.
- El banner se guarda como URL HTTPS, no se suben archivos/GIF. El almacenamiento de imágenes y la vista previa del banner quedan pendientes.
- El enlace de sala se puede copiar/compartir. No hay entrega de invitaciones directas a usuarios por cuenta; la presencia WebRTC existente identifica nombres de jugador, no cuentas HaTitix.
- La configuración del correo de verificación y de recuperación requiere un proveedor de email y secretos de servicio separados.

## Rutas disponibles

- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`.
- `GET /api/me`, `PATCH /api/me`.
- `GET /api/users/search?tag=Nombre%231234`.
- `GET /api/friends`, `GET /api/friends/requests`.
- `POST /api/friends/requests`.
- `POST /api/friends/requests/:id/accept` y `/reject`.
- `DELETE /api/friends/:accountId`.
