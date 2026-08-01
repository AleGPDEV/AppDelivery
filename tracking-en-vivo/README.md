# Tracking en vivo de deliverys

Servidor Node.js + Socket.IO con dos páginas:

- **`/driver.html`** — la abre cada delivery desde su celular. Escribe su nombre, toca "Empezar a compartir ubicación" y el navegador manda su posición GPS automáticamente cada vez que cambia.
- **`/dashboard.html`** — el panel para vos: un mapa que muestra a todos los deliveries conectados en tiempo real, con su nombre y hace cuánto se actualizó por última vez.

No usa base de datos: las ubicaciones se guardan en memoria mientras el servidor está corriendo (se pierden si se reinicia), y un delivery se saca del mapa automáticamente si no manda una actualización en 5 minutos.

## Correrlo localmente

```bash
npm install
npm start
```

Abre:
- Delivery: http://localhost:3000/driver.html
- Panel: http://localhost:3000/dashboard.html

## Importante: para usarlo con celulares reales

Los navegadores (Chrome, Safari) **no permiten pedir la ubicación GPS salvo que la página se sirva por HTTPS** (o desde `localhost` en la misma compu). Mientras el servidor corra solo en tu PC local, `driver.html` va a andar si lo abrís vos mismo en esa PC, pero **no va a funcionar si un delivery lo abre desde su celular** conectándose a tu IP local — el navegador va a bloquear el permiso de ubicación por no ser HTTPS.

Para que los deliveries lo usen de verdad desde la calle hace falta desplegar este servidor en algún lugar con HTTPS. Opciones simples y con capa gratuita:

- **Render.com** (`render.com`) — conectás este repo de GitHub y despliega solo, con HTTPS incluido.
- **Railway.app** — similar, deploy directo desde GitHub.
- Cualquier VPS con un dominio y certificado (más trabajo de configurar).

Esto requiere crear una cuenta en el servicio que elijas (no lo puedo hacer por vos). Una vez desplegado, actualizá los links que le pasás a cada delivery por el dominio público que te den (ej: `https://tu-app.onrender.com/driver.html`).
