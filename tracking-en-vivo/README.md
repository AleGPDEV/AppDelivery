# Tracking en vivo de deliverys

Servidor Node.js + Socket.IO con 5 páginas separadas (cada una su propio HTML/JS, no pestañas de una sola página):

- **`/nuevo-pedido.html`** — agendar un pedido (celular, nombre, número, ubicación opcional, monto, asignar a un delivery) o cargar varios de una pegando desde una planilla.
- **`/pedidos.html`** — el registro de pedidos: una tabla con Teléfono/Nombre/Nº/Monto/Delivery asignado/Método de pago/Estado, todo editable ahí mismo.
- **`/dashboard.html`** — lista de deliverys conectados + el mapa en vivo con sus pedidos coloreados por delivery.
- **`/caja.html`** — rendición de caja por delivery.
- **`/driver.html`** — la abre cada delivery desde su celular. Escribe su nombre, toca "Empezar a compartir ubicación" y el navegador manda su posición GPS automáticamente; ahí también ve sus pedidos asignados (en el orden óptimo) y elige la forma de pago al entregar.

No usa base de datos: todo se guarda en memoria mientras el servidor está corriendo (se pierde si se reinicia), y un delivery se saca del mapa automáticamente si no manda una actualización en 5 minutos.

La geocodificación de direcciones de texto usa Google Maps (Geocoding vía la Maps JavaScript API, cargada en `public/geo.js`) — ver la nota sobre la API key en el README de `optimizador-rutas/`, que aplica igual acá (misma key, mismas restricciones de sitio en Google Cloud Console).

## Correrlo localmente

```bash
npm install
npm start
```

Abre:
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
