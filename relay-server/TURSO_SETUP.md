# Configurar HaTitix con Turso

El relay usa Turso/libSQL para cuentas, mensajes, grupos, Parties, mapas y apuestas.

## Variables en Render

Configura estas variables en el servicio del relay:

```env
TURSO_DATABASE_URL=libsql://tu-base-tu-usuario.turso.io
TURSO_AUTH_TOKEN=tu_token_de_turso
RELAY_TOKEN=una-clave-aleatoria-de-al-menos-32-caracteres
TURSO_CLEANUP_DAYS=180
```

`TURSO_CLEANUP_DAYS` elimina en cada arranque los mensajes privados y grupales, apuestas ya terminadas y sesiones expiradas más antiguas que ese número de días. Las invitaciones de Party vencidas se eliminan después de 2 días. Usa `0` para desactivar la limpieza automática.

## Crear la base

Desde la consola de Turso crea una base y genera un token de autenticación. Copia la URL `libsql://...` y el token en Render. El esquema se crea automáticamente cuando el relay arranca; no hay que ejecutar un SQL manual.

## Importante sobre el espacio

Turso tiene cuotas gratuitas. La limpieza evita que crezcan indefinidamente los chats y registros históricos, pero no borra cuentas ni datos actuales de perfiles. Las imágenes base64 guardadas como banners ocupan mucho espacio; para ahorrar almacenamiento usa banners pequeños o URLs HTTPS.

Si la base llega al límite, primero exporta o respalda los datos, elimina mensajes históricos y banners pesados, y luego vuelve a desplegar el relay. Borrar filas reduce los datos activos, pero la forma exacta en que el almacenamiento facturado se actualiza depende de Turso.
