# Documentación técnica — AppDelivery

> Este archivo se mantiene actualizado a medida que se modifica el código. Si algo acá no coincide con el código real, el código manda.

Dos proyectos independientes en este repo:

- **`optimizador-rutas/`** — sitio estático (sin servidor), calcula la ruta más eficiente para una lista de pedidos.
- **`tracking-en-vivo/`** — servidor Node con tracking GPS en vivo de los deliverys + asignación de pedidos.

---

## 1. `optimizador-rutas/` (sitio estático)

Sin backend, sin build. Se abre `index.html` directo o se sirve por GitHub Pages.

### Archivos
- `index.html` — estructura de la página.
- `style.css` — estilos (tema claro/oscuro automático).
- `app.js` — toda la lógica.
- `README.md` — notas de uso.

### Flujo (botón "Calcular ruta óptima")
1. **Parsear** el textarea de pedidos: `parseStopsText` separa cada línea en `{order, raw}` (número de pedido + resto).
2. **Resolver cada ubicación** (`resolveInput`), en este orden:
   - ¿Es un link corto `maps.app.goo.gl`? → se expande primero (ver sección 3).
   - ¿Trae coordenadas literales? (`parseCoordinates` reconoce `!3d..!4d..`, `@lat,lng`, `?q=lat,lng`, `/maps/search/lat,+lng`, o `lat,lng` suelto) → se usan tal cual, `precision: 'input'` (100% confiable).
   - Si no, es una dirección de texto → se geocodifica con Google (`geocodeAddress`).
3. **Geocodificación** (`geocodeOnce` + `addressVariants`): usa `google.maps.Geocoder` (Maps JavaScript API, ver sección 5). Si Google devuelve `ROOFTOP` → `precision: 'exact'`; si `RANGE_INTERPOLATED` → `precision: 'street'` (se marca "aproximado, revisar" en la lista); cualquier otro resultado se descarta y se reintenta con variantes más simples de la dirección (sin títulos, sin "Departamento de X", sin el segmento más específico, etc.) antes de rendirse.
4. **Optimizar el orden** (`optimizeOrder`): heurística de vecino más cercano + mejora 2-opt, usando distancias reales de manejo.
5. **Distancias/ruta reales** (`fetchDrivingMatrix`, `fetchDrivingRoute`): llaman a OSRM (`router.project-osrm.org`, público y gratis). Si falla, cae a distancia en línea recta (`haversineKm`) y avisa con un cartel amarillo.
6. **Dibujar el mapa** (`renderMap`): Google Maps, un marcador arrastrable por parada (arrastrar corrige la posición y regenera el link al instante — `updatePointPosition`).
7. **Link final**: `buildGoogleMapsUrl` arma un link de Google Maps con origen/destino/waypoints en el orden calculado.

### Ida y vuelta al depósito
Checkbox "Volver al punto de partida" — si está marcado, el depósito se agrega también como destino final.

---

## 2. `tracking-en-vivo/` (Node + Socket.IO)

### Arquitectura
- `server.js` — Express sirve `public/` como estático, y mantiene **todo el estado en memoria** (se pierde si el servidor se reinicia — no hay base de datos):
  - `drivers`: `driverId → {name, lat, lng, updatedAt}`
  - `orders`: `orderId → {orderNumber, lat, lng, label, assignedTo, status, amount, paymentMethod, updatedAt}`
  - `routes`: `driverId → {stops, latlngs, distanceKm, durationMin}`
  - `deliveredLogs`: `driverId → [{orderNumber, amount, paymentMethod, deliveredAt}]` — historial de entregas para la rendición de caja (sección 3.1). No se borra con el tiempo, solo al reiniciar el servidor o al tocar "Cerrar rendición".
  - Un delivery sin actualizar en 5 min se borra solo (`STALE_MS`).
  - Cada delivery tiene un color fijo asignado por orden de conexión (`COLOR_PALETTE`, 8 colores que rotan).

- `public/geo.js` — misma lógica de geocodificación/ruteo/expansión de links que `optimizador-rutas/app.js`, pero compartida entre `dashboard.js` y `driver.js` (namespace global `Geo`). También parsea el formato extendido de carga (ver 3.1) y `parseAmount` (convierte "$ 1.630,00" a número).
- `public/dashboard.html` + `dashboard.js` — **pantalla única** para vos: lista de deliverys conectados, cargar pedidos (mismo formato que el optimizador, más importe/forma de pago opcionales), asignarlos a un delivery (dropdown), la rendición de caja de cada uno, y el mapa en vivo con todo.
- `public/driver.html` + `driver.js` — la abre cada delivery. Nombre + botón "Empezar a compartir ubicación" → `navigator.geolocation.watchPosition` manda su posición por socket. Muestra sus pedidos asignados (en el orden óptimo) con botón "Entregado".

### 3.1 Rendición de caja por delivery

Pensado a partir de la planilla real que ya usa el local (control de efectivo/transferencia por delivery al cierre del día).

- **Carga extendida**: al pegar pedidos en `dashboard.html`, cada línea puede tener 2 campos (número + ubicación, como siempre) o 4 separados por **tabulación** (pegado directo de una planilla): `número · ubicación · importe · forma de pago`. `Geo.parseStopLine` detecta el tab y separa los 4 campos; `Geo.parseAmount` interpreta el formato uruguayo ("$ 1.630,00" → `1630`).
- Al marcar un pedido **Entregado**, el servidor lo agrega al `deliveredLogs` del delivery que lo tenía asignado (no pasa esto si se borra un pedido a mano con `order:remove`).
- La sección "Rendición de caja por delivery" en `dashboard.js` (`renderCashList`) suma, por delivery: efectivo cobrado (todo lo que no sea claramente otro medio de pago) vs. otros medios, y con dos campos manuales que vos cargás (**Cambio inicial**, **Gastos**) calcula `Debe entregar = efectivo cobrado + cambio - gastos` — misma lógica que la planilla original. "Cerrar rendición" limpia el historial de ese delivery (`driver:clear-log`).
- Los campos Cambio/Gastos son **solo del navegador que los carga** (no se sincronizan por socket) — si abrís el panel en otra pestaña no los vas a ver ahí, solo los totales que sí vienen del servidor.

### Eventos de Socket.IO (referencia)

| Evento | Quién lo emite | Payload | Qué hace |
|---|---|---|---|
| `drivers:snapshot` / `orders:snapshot` / `routes:snapshot` / `deliveredLogs:snapshot` | servidor, al conectarse | lista completa | estado inicial para un cliente recién conectado |
| `driver:update` | driver.js (posición) | `{id, name, lat, lng}` | crea/actualiza un delivery; el servidor le agrega `color` y hace broadcast |
| `driver:stop` | driver.js (botón manual) | `{id}` | borra al delivery y su ruta |
| `driver:remove` | servidor (broadcast) | `{id}` | avisa a todos que ese delivery ya no está |
| `order:add` | dashboard.js (cargar pedidos) | `{orderNumber, lat, lng, label, amount, paymentMethod}` | crea un pedido sin asignar |
| `order:assign` | dashboard.js (dropdown) | `{id, driverId}` | asigna/desasigna un pedido |
| `order:delivered` | driver.js (botón Entregado) | `{id}` | borra el pedido y lo agrega al `deliveredLogs` del delivery asignado |
| `order:update` / `order:remove` | servidor (broadcast) | pedido completo / `{id}` | sincroniza pedidos en todos los clientes |
| `driver:route` | dashboard.js **o** driver.js (quien recalcule) | `{driverId, stops, latlngs, distanceKm, durationMin}` | comparte la ruta ya calculada (así nadie más repite la llamada a OSRM) |
| `driver:clear-log` | dashboard.js ("Cerrar rendición") | `{driverId}` | vacía el historial de entregas de ese delivery |
| `driver:delivered-log` | servidor (broadcast) | `{driverId, log}` | sincroniza el historial de entregas (rendición de caja) |
| `route:remove` | servidor (broadcast) | `{driverId}` | borra la ruta dibujada de ese delivery |

### ¿Quién recalcula la ruta óptima de un delivery?
Dos disparadores, para que funcione aunque uno de los dos no esté con la pantalla abierta:
1. `dashboard.js` → al asignar/desasignar un pedido (`recomputeRouteForDriver`).
2. `driver.js` → al marcar "Entregado" (`recomputeMyRoute`), usando su propia última posición conocida.

Ambos usan `Geo.computeRoute(inicio, pedidos)` y emiten `driver:route` con el resultado.

### Persistencia del lado del delivery (localStorage)
- `tracking.driverId` — UUID generado una vez, para que recargar la página no cree "otro" delivery.
- `tracking.driverName` — se recuerda el nombre.
- `tracking.sharing` — flag que dice "estaba compartiendo". Si la pestaña se cierra sin querer (no se tocó "Dejar de compartir"), al reabrir la página **retoma solo**, sin tocar nada. Cerrar la pestaña **no** avisa al servidor (no hay `beforeunload`); el delivery solo se borra si pasan 5 min sin actualizar o si se toca el botón manualmente.

### Íconos del mapa
`svgIcon()` genera un pin como SVG inline (data URI): círculo con 🛵 para delivery, cuadrado redondeado con 📦 para pedido, coloreado según a qué delivery está asignado (gris si no tiene asignar).

---

## 3. Links cortos de Google Maps (`maps.app.goo.gl`)

Un navegador no puede seguir esa redirección por su cuenta (CORS bloquea leer a dónde apunta un dominio ajeno). Se usa **corsproxy.io** — un proxy de terceros que hace el fetch del lado del servidor y devuelve la URL final resuelta en el header `x-final-url`. Con esa URL ya expandida entra al parser de coordenadas de siempre.

Es un servicio externo que no operamos nosotros: si no responde, se avisa y se pide pegar el link completo, la dirección o las coordenadas en su lugar.

---

## 4. Ruteo real por calles (OSRM)

`router.project-osrm.org` — servidor público y gratis, sin API key. Se usa para:
- **Matriz de distancias** (`/table/...`) entre todos los puntos, para elegir el orden óptimo.
- **Geometría de la ruta** (`/route/...`) para dibujar la línea siguiendo las calles y mostrar distancia/tiempo reales.

Es apto para uso liviano/prototipo. Si en algún momento el volumen de uso es alto y empieza a fallar seguido, la alternativa es self-hostear OSRM.

---

## 5. Google Maps (geocodificación + mapa visual)

Ambos proyectos usan la misma **API key de Google Maps** (constante `GOOGLE_MAPS_API_KEY` en `optimizador-rutas/app.js`, `tracking-en-vivo/public/geo.js` y `tracking-en-vivo/public/dashboard.js`).

- **Por qué está a la vista en el código**: son sitios sin servidor propio (o, en el caso de tracking-en-vivo, la key se usa del lado del navegador igual, no del servidor) — no hay dónde "esconderla". Se protege con **restricciones en Google Cloud Console**, no con secreto:
  - **Restricción de sitio (HTTP referrer)**: solo funciona desde los dominios cargados ahí (localhost de desarrollo, GitHub Pages, la URL de Render). Se probó en vivo que un dominio no autorizado recibe `RefererNotAllowedMapError`.
  - **Restricción de API**: solo puede usarse para Geocoding API y Maps JavaScript API, nada más.
- **Costo**: capa gratuita de Google Maps Platform da miles de solicitudes gratis por mes (por API), que se renueva todos los meses. Para ver uso real: Google Cloud Console → Facturación → Informes (no la pantalla de "Cuotas", que solo cuenta pedidos, no dinero).
- **Si se agrega un dominio nuevo** (ej. otro hosting): hay que sumarlo a la restricción de sitio en Cloud Console o esa página va a fallar con `RefererNotAllowedMapError`.

### ¿Por qué Google y no algo gratis como Nominatim/OpenStreetMap?
Se probó primero con Nominatim (gratis, sin key) pero tenía errores reales de datos en la zona de Pando (una calle sin mapear, un complejo desconocido, y dos calles distintas resueltas al mismo punto). Google tiene mejor cobertura para direcciones reales.

---

## 6. Despliegue

| Proyecto | Dónde | Notas |
|---|---|---|
| `optimizador-rutas/` | GitHub Pages | `https://alegpdev.github.io/AppDelivery/optimizador-rutas/` — se actualiza solo con cada push a `main`. |
| `tracking-en-vivo/` | Render.com (plan free) | Root directory `tracking-en-vivo`, build `npm install`, start `npm start`. Se redespliega solo con cada push. **El plan gratis "duerme" el servidor tras 15 min sin tráfico** (incluye mensajes de WebSocket, no solo pedidos HTTP nuevos) — la primera conexión después tarda ~1 minuto en responder mientras se despierta. Si al menos un delivery está mandando ubicación, esto no pasa. |

Repo: `https://github.com/AleGPDEV/AppDelivery` (público).

---

## 7. Desarrollo local

```bash
# optimizador-rutas (estático, cualquier servidor sirve)
cd optimizador-rutas
python -m http.server 4321

# tracking-en-vivo
cd tracking-en-vivo
npm install
npm start   # sirve en http://localhost:3000
```

`.claude/launch.json` ya tiene ambos configurados para preview automático.

---

## 8. Limitaciones conocidas / a tener en cuenta

- **Sin base de datos**: todo el estado de `tracking-en-vivo` (deliverys, pedidos, rutas) vive en memoria y se pierde si el servidor se reinicia.
- **Sin login / multi-cliente**: cualquiera con el link puede ver y operar todo. No está pensado todavía para vender a más de un restaurante (haría falta separar cuentas/datos por cliente).
- **Tracking en segundo plano**: es una web, no una app nativa — si el celular del delivery se bloquea o cambia de app, el navegador frena la ubicación por su cuenta (no hay forma de evitarlo desde una web). Solo una app nativa (Android/iOS) resolvería esto de raíz.
- **Geocodificación de direcciones de texto**: aunque Google es mucho mejor que Nominatim, no es infalible — por eso los pines son arrastrables y las direcciones "aproximadas" (a nivel de calle) se marcan para revisar.
- **corsproxy.io y OSRM son servicios de terceros gratuitos**: no tienen garantía de actividad. Si alguno falla, la app avisa y sigue funcionando con una alternativa más simple (pegar el link completo, o distancia en línea recta) en vez de romperse.
