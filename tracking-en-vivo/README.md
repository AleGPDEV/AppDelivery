# Tracking en vivo de deliverys

Servidor Node.js + Socket.IO con 5 páginas separadas (cada una su propio HTML/JS, no pestañas de una sola página):

- **`/login.html`** — pantalla de acceso del admin (usuario/contraseña).
- **`/nuevo-pedido.html`** — agendar un pedido (campos personalizables, ver abajo) o cargar varios de una pegando desde una planilla. También tiene la configuración de campos y el cambio de contraseña.
- **`/pedidos.html`** — el registro de pedidos: una tabla con Teléfono/Nombre/Nº/Monto/Delivery asignado/Método de pago/Estado, todo editable ahí mismo.
- **`/dashboard.html`** — lista de deliverys conectados + el mapa en vivo con sus pedidos coloreados por delivery.
- **`/caja.html`** — rendición de caja por delivery.
- **`/driver.html`** — la abre cada delivery desde su celular, sin login. Escribe su nombre, toca "Empezar a compartir ubicación" y el navegador manda su posición GPS automáticamente; ahí también ve sus pedidos asignados (en el orden óptimo) y elige la forma de pago al entregar.

Las primeras 4 páginas requieren haber iniciado sesión como admin (si no, redirigen a `/login.html`); `driver.html` y `login.html` quedan públicas.

**Persistencia (Supabase)**: los pedidos, el usuario admin y la configuración de campos viven en Supabase (Postgres), así que sobreviven a un reinicio/redeploy del servidor. Los deliverys (posición GPS en vivo) siguen solo en memoria — no vale la pena persistir algo que cambia cada pocos segundos y que de todos modos se recrea solo apenas el delivery vuelve a compartir ubicación.

**Campos personalizables**: desde "Nuevo pedido" el admin elige qué campos mostrar y cuáles son obligatorios (celular, nombre, nº de pedido, ubicación, monto) — se guarda en Supabase y aplica para todos.

La geocodificación de direcciones de texto usa Google Maps (Geocoding vía la Maps JavaScript API, cargada en `public/geo.js`) — ver la nota sobre la API key en el README de `optimizador-rutas/`, que aplica igual acá (misma key, mismas restricciones de sitio en Google Cloud Console).

## Correrlo localmente

Necesita un archivo `.env` (ver `.env.example`) con `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SESSION_SECRET`, `ADMIN_USERNAME` y `ADMIN_PASSWORD`. El admin se crea solo la primera vez que arranca el servidor (si la tabla `admin_users` está vacía).

```bash
npm install
npm start
```

Abre:
- Login: http://localhost:3000/login.html
- Delivery: http://localhost:3000/driver.html
- Nuevo pedido: http://localhost:3000/nuevo-pedido.html
- Pedidos: http://localhost:3000/pedidos.html
- Mapa: http://localhost:3000/dashboard.html
- Rendición: http://localhost:3000/caja.html

## Importante: para usarlo con celulares reales

Los navegadores (Chrome, Safari) **no permiten pedir la ubicación GPS salvo que la página se sirva por HTTPS** (o desde `localhost` en la misma compu). Mientras el servidor corra solo en tu PC local, `driver.html` va a andar si lo abrís vos mismo en esa PC, pero **no va a funcionar si un delivery lo abre desde su celular** conectándose a tu IP local — el navegador va a bloquear el permiso de ubicación por no ser HTTPS.

Para que los deliveries lo usen de verdad desde la calle hace falta desplegar este servidor en algún lugar con HTTPS. Opciones simples y con capa gratuita:

- **Render.com** (`render.com`) — conectás este repo de GitHub y despliega solo, con HTTPS incluido.
- **Railway.app** — similar, deploy directo desde GitHub.
- Cualquier VPS con un dominio y certificado (más trabajo de configurar).

Esto requiere crear una cuenta en el servicio que elijas (no lo puedo hacer por vos). Una vez desplegado, actualizá los links que le pasás a cada delivery por el dominio público que te den (ej: `https://tu-app.onrender.com/driver.html`).
