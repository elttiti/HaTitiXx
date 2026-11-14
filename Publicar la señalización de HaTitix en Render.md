# Publicar la señalización de HaTitix en Render

La nube mantiene disponible la **señalización WebRTC**. No almacena ni retransmite fotos: los perfiles van directamente entre clientes HaTitix conectados. La plantilla `render.yaml`, en la raíz del proyecto, configura Render para usar `relay-server`.

## 1. Subir el proyecto a GitHub

Render necesita leer el código desde un repositorio Git. Si todavía no tienes uno, instala GitHub Desktop, inicia sesión y crea un repositorio local a partir de la carpeta principal de HaTitix; publícalo como **privado**. Asegúrate de que queden incluidos el `render.yaml` de la raíz y la carpeta `relay-server`.

El `.gitignore` de la raíz excluye `node_modules`, `.runtime` y los archivos `.env` que contienen claves. **No subas manualmente tu `.env` ni compartas su token.** Render generará un token separado para el servidor en la nube.

## 2. Crear el servidor en Render

1. Entra a [Render](https://render.com/) y conecta la cuenta de GitHub donde publicaste el repositorio.
2. En el dashboard de Render, elige **New → Blueprint** y selecciona el repositorio de HaTitix.
3. Render leerá `render.yaml`. Revisa la configuración antes de confirmar: crea un servicio Node en la carpeta `relay-server`, con el plan **Free** para probar; configura el host público y genera `RELAY_TOKEN` dentro de Render. La plantilla no publica una dirección para tu computadora ni tu `localhost`.
4. Espera a que el servicio figure **Live**. Render le asignará un dominio parecido a `https://NOMBRE.onrender.com`. Abre `https://NOMBRE.onrender.com/health`. La respuesta debe incluir `"ok":true`, `"version":3` y `"mediaRelay":false`.

La URL que debes poner en HaTitix es ese mismo dominio, con `wss://` y la ruta `/ws`. Por ejemplo: `wss://NOMBRE.onrender.com/ws`.

## 3. Configurar HaTitix

En Render, abre el servicio y copia el valor de `RELAY_TOKEN` desde **Environment**. Si se muestra oculto, usa el botón para revelar el valor. No lo publiques. En cada HaTitix, entra a **⚙ → Ajustes → RED Y PERFIL → Señalización WebRTC**, pega la URL `wss://.../ws` y ese mismo token, y pulsa **Guardar y conectar**.

Cuando las instancias ya conecten con la nube, puedes cerrar el servidor local de Windows y dejar de usar `ws://localhost:8787/ws`. Tus amigos deben usar la URL pública y el token de Render; la contraseña de la sala Haxball sigue siendo una credencial distinta.

## 4. Qué pasa cuando te desconectas y cuánto cuesta

En el HaTitix que quieres priorizar, activa **Priorizarme** en **RED Y PERFIL**. Mientras siga en la sala, el servicio lo preferirá como anfitrión directo de las skins. Al salir, se elige otro cliente HaTitix conectado; si no queda nadie en esa sala, no hay un anfitrión que distribuya las fotos. La nube coordina las conexiones, no conserva las imágenes.

El plan Free sirve para probar y no tiene coste de instancia, pero Render duerme el servicio tras 15 minutos sin tráfico entrante y suele tardar alrededor de un minuto en despertarlo cuando llega una conexión. Si quieres evitar ese tiempo de espera, los servicios web Starter aparecen desde **USD 7 al mes** en la página de precios; confirma el precio que Render te muestre antes de cambiar de plan. [Limitaciones del plan Free](https://render.com/docs/free) · [Precios](https://render.com/pricing).

Render admite WebSockets desde Internet y recomienda `wss://` para conexiones públicas. [Documentación de WebSockets](https://render.com/docs/websocket) · [Referencia de Blueprint](https://render.com/docs/blueprint-spec).
