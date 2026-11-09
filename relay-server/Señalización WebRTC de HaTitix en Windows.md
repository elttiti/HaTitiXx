# Señalización WebRTC de HaTitix en Windows

HaTitix comparte las fotos por **WebRTC DataChannel entre los clientes**; este servicio no recibe ni retransmite imágenes. El servidor aquí solo autentica a los clientes, coordina la sala, elige al anfitrión temporal por el ping de Haxball y reenvía ofertas/respuestas SDP y candidatos ICE para establecer los enlaces directos.

Hay dos roles distintos:

- **Servidor de señalización:** debe estar disponible públicamente para ayudar a encontrarse y negociar la conexión. Puede correr en Windows, pero si corre en tu PC, esa PC debe permanecer encendida. Para no depender de tu PC, alojá esta carpeta en una máquina/servicio público siempre activo.
- **Anfitrión WebRTC:** es uno de los HaTitix que están jugando. Se elige según el menor ping informado por la sala; si se desconecta, el servicio elige otro. Este cliente distribuye perfiles a sus pares por WebRTC mientras esté conectado; las fotos no pasan por el servidor de señalización.

Esta guía explica cómo ejecutar el servidor de señalización en Windows 10/11. Para que amigos se conecten desde Internet también necesitás dominio, acceso entrante TCP 80/443 y Caddy, o alojar el mismo servicio en otro host público.

## Requisitos

- Windows 10/11 de 64 bits.
- Node.js 22 o posterior con npm. Descargalo desde [nodejs.org](https://nodejs.org/en/download) e instalá la versión LTS; deja activa la opción de agregar Node al PATH.
- Un dominio/subdominio apuntado a la máquina pública que ejecuta Caddy.
- Caddy para Windows, que proporciona HTTPS/WSS.
- Una conexión que permita recibir conexiones entrantes si alojas esto en tu casa. Si tu proveedor usa CGNAT, el reenvío del router no será suficiente; usa una VPS o un servicio de alojamiento público.

## 1. Instalar Node y comprobarlo

Después de instalar Node.js, abre una nueva ventana de **PowerShell** y ejecuta:

```powershell
node --version
npm --version
```

Node debe mostrar versión 22 o posterior. Si `node` o `npm` no se reconoce, cierra y vuelve a abrir PowerShell o reinstala Node activando la opción PATH.

## 2. Preparar los archivos y crear una clave

Copia la carpeta `relay-server` de HaTitix a una ruta sencilla, por ejemplo `C:\HaTitixSignal`. Debe incluir `server.js`, `package.json`, `package-lock.json`, `.env.example` e `iniciar-relay.bat`.

En PowerShell, ejecuta:

```powershell
Set-Location C:\HaTitixSignal
Copy-Item .env.example .env
node -p "require('node:crypto').randomBytes(32).toString('hex')"
notepad .env
```

Copia el token hexadecimal que imprimió Node y reemplaza el valor de `RELAY_TOKEN=` en Bloc de notas. Conserva estas líneas así:

```text
HOST=127.0.0.1
PORT=8787
```

Guarda como `.env`, no como `.env.txt`. No compartas el archivo ni publiques el token. Todos los HaTitix autorizados deben introducir la misma clave.

## 3. Probar el servidor localmente

En Windows, también puedes ejecutar `iniciar-relay.bat` dentro de `relay-server`: instala `ws` con `npm ci` si falta y, si no existe `.env`, crea una plantilla (aunque no se haya copiado `.env.example`), abre el Bloc de notas y te indica que debes configurar el token antes de volver a iniciarlo.

Para hacerlo manualmente, en PowerShell desde `C:\HaTitixSignal`, instala dependencias y arranca el servicio:

```powershell
npm install
npm start
```

Deja esta ventana abierta. En otra ventana de PowerShell verifica:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

La respuesta debe indicar `ok: True`, `service: hatitix-webrtc-signaling`, `version: 3` y `mediaRelay: False`. Esto confirma que el proceso está activo y **no es un relay de fotos**.

Para una prueba en la misma PC, configura HaTitix con `ws://localhost:8787/ws` y el mismo token. La app permite `ws://` solo en localhost; para conexiones públicas exige `wss://`.

## 4. Publicar el servidor con dominio y WSS

Si lo alojas en casa, la PC y el router deben estar encendidos. Si no quieres depender de tu PC, copia `relay-server` a una VPS/host público y ejecuta allí Node; la dirección pública resultante se configura igual en HaTitix. El anfitrión temporal de WebRTC seguirá siendo un jugador de la partida, no la VPS.

Para alojarlo en una PC Windows:

1. Reserva una IPv4 local para esa PC en el router (reserva DHCP) o identifícala con `ipconfig`.
2. En el panel DNS de tu dominio, crea un registro `A` como `signal.tudominio.com` que apunte a la IP pública.
3. En el router, reenvía **TCP 80 y TCP 443** hacia la IPv4 local de la PC. No reenvíes el puerto 8787.
4. Abre PowerShell como administrador y permite esos puertos en el Firewall de Windows:

   ```powershell
   New-NetFirewallRule -DisplayName "HaTitix WebRTC Signaling TLS" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80,443
   ```

5. Descarga Caddy para Windows x64 desde [caddyserver.com/download](https://caddyserver.com/download) y guarda `caddy.exe` en `C:\Caddy\caddy.exe`.
6. Crea `C:\Caddy\Caddyfile` (sin extensión `.txt`) con este contenido y tu dominio:

   ```caddy
   signal.tudominio.com {
       reverse_proxy 127.0.0.1:8787
   }
   ```

7. Comprueba primero que el DNS y el reenvío de puertos funcionen. Abre PowerShell como administrador y ejecuta Caddy:

   ```powershell
   Set-Location C:\Caddy
   .\caddy.exe run --config .\Caddyfile
   ```

   Caddy solicitará automáticamente el certificado TLS. Deja esta terminal y la terminal `npm start` abiertas.

8. Prueba desde otra ventana:

   ```powershell
   Invoke-RestMethod https://signal.tudominio.com/health
   ```

   También prueba desde un teléfono usando datos móviles para confirmar acceso desde fuera de tu Wi-Fi. La URL pública para HaTitix será `wss://signal.tudominio.com/ws`.

No abras el puerto 8787 a Internet: Node escucha solo en `127.0.0.1` y Caddy termina TLS en los puertos 80/443. Si cierras las terminales de Node o Caddy, el servidor deja de estar disponible. Para mantenerlo disponible sin una sesión abierta, configura ambos procesos como tareas/servicios de Windows o aloja el servidor en un host público administrado.

## 5. Configurar HaTitix en cada PC

En todas las instalaciones HaTitix que quieran compartir skins:

1. Abre **Ajustes → Red y perfil → Señalización WebRTC**.
2. Pega `wss://signal.tudominio.com/ws` y escribe el `RELAY_TOKEN` configurado en el servidor.
3. Pulsa **Guardar y conectar** y entra a una sala de Haxball.
4. El estado debe mostrar el anfitrión WebRTC o que está estableciendo el enlace directo.
5. En **Personalización**, configura **Mi personaje** y, si quieres, la foto/equipo rojo o azul.
6. Todos los que quieran ver las skins deben usar una versión de HaTitix con soporte WebRTC y entrar a la misma sala.

Si ya habías desplegado la versión anterior del servidor que retransmitía fotos, reemplázala por esta versión de señalización, vuelve a ejecutar `npm install` y reiníciala. La versión anterior no entiende el nuevo protocolo.

## 6. Alcance, privacidad y límites

- Las imágenes WebP comprimidas se envían por un canal WebRTC directo al anfitrión de la sala de skins; este las distribuye a los demás por sus canales WebRTC. **El servidor WSS solo ve autenticación, ID de sala/jugador, ping, SDP y candidatos ICE; no recibe las fotos.**
- Por defecto, el anfitrión se elige usando el ping de sala informado por los clientes; el servidor suaviza varias muestras y evita cambios por fluctuaciones pequeñas. Si alguien activa **Priorizarme** en Red y Perfil, se prioriza a ese cliente; entre varias preferencias manuales gana el de mejor ping. Si sale, se elige otro cliente conectado.
- El servidor de señalización sigue siendo necesario y debe estar disponible para conexiones y cambios de anfitrión. El código de esta carpeta no crea una dirección pública por sí solo.
- El cliente usa STUN público para intentar conexiones directas, pero esta versión no incluye TURN. Algunas redes con NAT estricto/firewall pueden impedir WebRTC; en ese caso el estado avisará que no se pudo establecer el canal. No se enviará la foto al servidor como alternativa.
- ICE puede exponer direcciones de red entre pares, según navegador y red. La señalización no identifica la cuenta Haxball real; el token compartido no impide completamente la suplantación de IDs. Compártelo solo con personas de confianza.
- Los usuarios de Haxball común no reciben estas fotos. Cada persona que las quiera ver debe usar HaTitix compatible.
