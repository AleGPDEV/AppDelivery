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

## 2. `tracking-en-vivo/` (Node + Socket.IO + Supabase)

### Arquitectura
- `server.js` — Express sirve `public/` como estático. Estado:
  - `drivers`: `driverId → {name, lat, lng, updatedAt}` — **en memoria solamente** (se pierde al reiniciar). La posición GPS cambia cada pocos segundos y el delivery la vuelve a mandar apenas reabre `driver.html`, así que persistirla no aporta nada.
  - `orders`: `orderId → {seq, orderNumber, phone, name, lat, lng, label, assignedTo, status, amount, paymentMethod, reconciledAt, archivedAt, updatedAt, source, items}` — **persistido en Supabase** (tabla `orders`), se carga entero al arrancar (`loadOrders()`) y cada cambio se escribe con `persistOrder`/`persistOrderDelete` (fire-and-forget: el Map en memoria + broadcast por socket son los que hacen que la UI se sienta instantánea, Supabase queda consistente unos milisegundos después). `lat`/`lng` son `null` para un pedido que retira en el local. `reconciledAt` marca que ese pedido entregado ya fue incluido en un "Cerrar rendición" anterior (ver 3.1). `archivedAt` marca que quedó incluido en un "Finalizar día" (ver 3.2) — deja de verse en `pedidos.html`/mapa/ruta, pero sigue entero en Supabase para el histórico. `source` es `'admin'` (default, pedidos cargados desde `nuevo-pedido.html`) o `'web'` (pedidos que llegaron solos desde `pedido-cliente.html`, ver 3.3); `items` es el detalle del carrito (`[{productId, name, price, qty}]`) para los pedidos web, vacío para los demás.
  - `categories`/`products` — el catálogo del pedido online, ver 3.3.
  - `expenses` — pagos a proveedores, ver 3.4.
  - `routes`: `driverId → {stops, latlngs, distanceKm, durationMin}` — en memoria, se recalcula on-demand.
  - `formConfig` — persistido en la tabla `form_config` (una sola fila, columna `fields` en JSON): `{name, orderNumber, amount}` (togglables de siempre, aunque ya no aparecen en Ajustes — ver 3.4), `paymentMethods: [{id, name, isCash}]` (la lista de formas de pago, personalizable desde Ajustes, default Efectivo/Transferencia/Débito) y `customFields: [{key, label, visible, required, showToDriver}]` — campos que el admin crea él mismo desde Ajustes (sin límite salvo los 20/60/200 caracteres que sanitiza `sanitizeCustom` en el servidor). Sus valores por pedido viven en la columna `custom` (jsonb) de `orders`, no en columnas propias. **Teléfono y tipo de envío (retira/envía) ya NO están en `formConfig`** — son obligatorios siempre, fijos en el código (ver 3.4).
  - Un delivery sin actualizar en 5 min se borra solo (`STALE_MS`).
  - Cada delivery tiene un color fijo asignado por orden de conexión (`COLOR_PALETTE`, 8 colores que rotan).

- **Login de admin** (`admin_users` en Supabase, un solo usuario): `POST /api/login` verifica usuario/contraseña (`bcryptjs`) y devuelve una cookie httpOnly firmada con JWT (`SESSION_SECRET`, 30 días). `POST /api/logout` la borra. `POST /api/change-password` permite cambiarla estando logueado. Si la tabla `admin_users` está vacía al arrancar, `bootstrapAdmin()` crea el usuario inicial con `ADMIN_USERNAME`/`ADMIN_PASSWORD` (variables de entorno, solo se usan esa primera vez).
  - **Gate de páginas**: un middleware de Express redirige a `/login.html` si falta la cookie válida al pedir `nuevo-pedido.html`, `pedidos.html`, `dashboard.html`, `caja.html`, `analiticas.html`, `catalogo.html` o `proveedores.html`. `driver.html`, `login.html` y `pedido-cliente.html` quedan públicas — cualquier archivo en `public/` que no esté en `PROTECTED_PAGES` se sirve tal cual, no hace falta nada especial para publicar una página nueva.
  - **Gate real (server-side)**: un middleware de Socket.IO (`io.use`) decodifica la misma cookie en el handshake y marca `socket.data.isAdmin`. Los handlers que modifican datos de admin (`order:add`, `order:assign`, `order:edit`, `order:remove`, `driver:clear-log`, `form-config:update`) chequean `socket.data.isAdmin` — el gate de páginas es solo para la experiencia de uso, esta es la barrera real (alguien podría abrir la consola del navegador y emitir eventos directo, sin pasar por ninguna página). Los endpoints HTTP de "Día comercial" (ver 3.2) no son eventos de socket, así que tienen su propio middleware `requireAuth` con la misma lógica.
  - **Interruptor `DISABLE_AUTH`**: con la variable de entorno `DISABLE_AUTH=true`, `AUTH_DISABLED` queda `true` y tanto el gate de páginas como `socket.data.isAdmin` se saltean para todos (nadie necesita loguearse). Pensado para desactivar el login temporalmente sin tocar código — para reactivarlo alcanza con sacar esa variable en Render (o ponerla en `false`) y que redespliegue.
  - `driver:update`, `driver:stop`, `order:delivered` y `driver:route` quedan sin auth: los usa `driver.html`, que no tiene login.

- `public/geo.js` — misma lógica de geocodificación/ruteo/expansión de links que `optimizador-rutas/app.js`, compartida por las páginas que la necesitan (`nuevo-pedido.js`, `pedidos.js`, `driver.js` — `dashboard.js` y `caja.js` no la usan). También parsea el formato extendido de carga (ver 3.1) y `parseAmount` (convierte "$ 1.630,00" a número).
- `public/theme.js` — tema claro/oscuro, compartido por las 10 páginas (se carga en `<head>`, antes del resto del body, para no hacer flash del tema equivocado). Sin elección guardada sigue `prefers-color-scheme` del sistema (media query en `style.css`); tocar el botón `#theme-toggle-btn` del nav/header guarda una elección explícita en `localStorage` (`tracking.theme`) como atributo `data-theme` en `<html>`, que pisa la preferencia del sistema — ver las reglas `:root[data-theme="dark"]` / `:root:not([data-theme="light"])` en `style.css`. Cada página solo necesita tener un `<button id="theme-toggle-btn">` en el HTML; `theme.js` le pone el ícono (🌙/☀️) y el listener solo.
- `public/settings.js` — el botón **"⚙ Configuración"** compartido por las 7 páginas de admin (ver 3.4 para el detalle de qué configura). En vez de duplicar el modal en cada HTML, este script se auto-monta al cargar: crea el botón e inyecta el modal entero en `document.body`, abriendo su propia conexión de socket (mismo criterio de "cada script arma la suya" que el resto de la app). Cada página de admin solo necesita un `<script src="settings.js"></script>` — nada de markup propio.
- **10 páginas separadas** (archivos HTML/JS propios cada una — comparten `style.css` y una barra `<nav class="tabs">` con links entre ellas, más un botón "Cerrar sesión" en las 7 de admin):
  1. **`login.html` + `login.js`** — usuario/contraseña, `POST /api/login`, redirige a `nuevo-pedido.html`.
  2. **`nuevo-pedido.html` + `nuevo-pedido.js`** — formulario individual (campos según `formConfig`) para agendar en el momento, más la carga masiva (textarea, pegado de planilla) — la carga masiva **también sigue `formConfig`**: las columnas de la planilla son exactamente los campos activos, en el orden fijo `phone, name, orderNumber, location, amount` filtrado a los visibles (`phone`/`location` ya no se pueden ocultar — ver 3.4), **más los personalizados al final** (`visibleFieldOrder()`), y el texto de ayuda/placeholder se regeneran solos cuando cambia la config.
  3. **`pedidos.html` + `pedidos.js`** — el **registro de pedidos**: una tabla (una fila por pedido, estilo planilla) con **"Ticket" siempre primero y nunca oculto** (ver más abajo), Delivery asignado (dropdown), Método de pago (dropdown editable) y Estado (dropdown: En preparación / En Camino / Entregado) siempre fijas, más las columnas Teléfono/Nombre/Nº pedido/Monto **y los campos personalizados**, todo solo si están activos en `formConfig` (`visibleFieldColumns()` arma tanto el `<thead>` como cada fila; `fieldCellContent()` cae a `o.custom[key]` para cualquier clave que no sea uno de los 4 fijos). Un pedido nunca se borra solo — sigue en la tabla con estado "Entregado" hasta que lo elimines a mano (🗑, **sin confirmación** — ver más abajo). El botón ✏️ abre un popup para editar cualquier campo del pedido (ver más abajo).

### Ticket (`seq`) — el verdadero identificador único
"Nº de pedido" lo tipea el admin y **se puede repetir a propósito** (el aviso de duplicado de nuevo-pedido.js es no bloqueante, y hasta se puede ocultar del todo desde "Personalizar campos"), así que no alcanza para distinguir dos pedidos con certeza. Por eso cada pedido tiene un **`seq`**: un número entero, único y siempre creciente, que asigna el servidor al crear el pedido (`nextSeq++` en el handler de `order:add`) — nunca lo tipea nadie, no se puede ocultar ni editar, y no se reutiliza aunque se borre un pedido o se reinicie el servidor (`loadOrders()` calcula `nextSeq` como el mayor `seq` guardado + 1 al arrancar). Columna `seq bigint` en `orders` (Supabase). Se muestra como "Ticket #N", siempre primera columna en `pedidos.html` (y también en el detalle de un día cerrado en `analiticas.html`). El orden de la tabla sigue siendo por "Nº de pedido" (lo que el negocio usa a diario), con `seq` como desempate si dos pedidos comparten el mismo número.

### Eliminar sin confirmación
El 🗑 de `pedidos.html` borra al toque, sin `confirm()` — a pedido explícito ("si agrego varios pedidos erróneos, estar confirmando uno por uno se vuelve tedioso"). Es la única acción destructiva de la app sin ventana de confirmación (comparar con "Finalizar día"/"Borrar TODO" en `analiticas.html`, que sí la tienen — ahí el volumen de datos en juego es mucho mayor).

### Editar cualquier campo de un pedido
El botón ✏️ en `pedidos.html` abre un popup (mismo patrón `.modal-overlay`/`.modal-box` que "⚙ Configuración", ver `settings.js`) precargado con los valores actuales — Celular, Nombre, Nº de pedido, Monto, y un input por cada campo personalizado (`formConfig.customFields`). La Ubicación es la excepción: se deja **vacía** a propósito (no se re-tipea la dirección completa cada vez que se edita otra cosa); solo si el admin escribe algo ahí se resuelve con `Geo.resolveInput` (igual que al crear un pedido) y se pisan `lat`/`lng`/`label` — si se deja vacío, la ubicación existente no cambia. Al guardar, todo viaja en un solo `order:edit` con los campos que cambiaron; el handler de `server.js` ahora acepta cualquiera de `orderNumber`/`phone`/`name`/`amount`/`label`/`lat`+`lng`/`custom` (antes solo `status`/`paymentMethod`, que los dropdowns sueltos de la tabla siguen usando igual). Como cualquier cambio se sincroniza por el mismo `order:update` de siempre, el delivery lo ve reflejado al toque en su lista y en el popup del mapa — no hace falta ningún aviso aparte.
  4. **`dashboard.html` + `dashboard.js`** — lista de conectados + el mapa en vivo (los pedidos "Entregado" no muestran pin en el mapa, pero siguen en la tabla de `pedidos.html`).
  5. **`caja.html` + `caja.js`** — rendición de caja, ver 3.1.
  6. **`analiticas.html` + `analiticas.js`** — día comercial + histórico, ver 3.2.
  7. **`driver.html` + `driver.js`** — la abre cada delivery, sin login. Nombre + botón "Empezar a compartir ubicación" → `navigator.geolocation.watchPosition` manda su posición por socket. Muestra sus pedidos asignados (en el orden óptimo, con nombre/teléfono del cliente) y, por cada uno, **un botón por cada método de pago configurado** (`formConfig.paymentMethods`, ver 3.4) — tocar cualquiera marca el pedido entregado con esa forma de pago (la que el cliente realmente usó al recibirlo, no la que se haya puesto al cargarlo).
  8. **`catalogo.html` + `catalogo.js`** — panel de admin para armar categorías y productos del pedido online, ver 3.3.
  9. **`pedido-cliente.html` + `pedido-cliente.js`** — la pantalla pública donde el cliente final arma su pedido, ver 3.3.
  10. **`proveedores.html` + `proveedores.js`** — panel de admin para registrar pagos a proveedores, ver 3.4.

  Como son páginas independientes, `nuevo-pedido.js` y `pedidos.js` duplican una versión chica de `recomputeRouteForDriver` cada una (ambas necesitan poder recalcular la ruta de un delivery al asignarle un pedido) — es la misma lógica en los dos archivos, no un bug.

### 3.1 Rendición de caja por delivery

Pensado a partir de la planilla real que ya usa el local (control de efectivo/transferencia por delivery al cierre del día).

- **Carga extendida** (carga masiva): las columnas de cada línea son las que estén activas en `formConfig` (fijas + personalizadas), en ese orden (ver sección 2). `Geo.parseStopLine(line, fieldOrder)` recibe ese orden explícito: si la línea trae tabulaciones, separa por tab y mapea posicionalmente contra `fieldOrder`; cualquier clave que no sea `phone/name/orderNumber/location/amount` se guarda tal cual en `result.custom[key]` (así un campo personalizado nuevo no necesita tocar `geo.js`); si `fieldOrder` tiene 2 campos o menos y no hay tab, acepta el atajo "valor1 valor2" separado por espacio/coma (para tipear rápido sin tabular). `Geo.parseAmount` interpreta el formato uruguayo ("$ 1.630,00" → `1630`). Ya no hay una columna aparte de "forma de pago esperada" en la carga masiva — la forma de pago real siempre se confirma al entregar.
- El **id de cada pedido lo genera el cliente** (`genId()` en `nuevo-pedido.js`, mismo patrón que `driverId`) y viaja en el propio `order:add`, para poder asignarlo (`order:assign`) en el mismo tick sin esperar una respuesta del servidor.
- **Estado del pedido**: `pending` (En preparación) al crearlo → pasa solo a `en_camino` (En Camino) al asignarlo a un delivery (y vuelve a `pending` si se desasigna) → pasa solo a `entregado` cuando el delivery toca alguno de los 3 botones de forma de pago. El admin puede pisar el estado a mano en cualquier momento desde el dropdown de la tabla.
- Al marcar un pedido entregado (`order:delivered`), el servidor solo actualiza ese mismo pedido: `status='entregado'` y `paymentMethod` con lo que eligió el delivery (pisando cualquier valor puesto antes) — **ya no se borra**. Solo `order:remove` (🗑 en `pedidos.html`) borra un pedido de verdad.
- `caja.js` (`renderCashList`) ya no depende de un historial aparte: filtra `orders` por `assignedTo === driverId && status === 'entregado' && !reconciledAt` y suma por cada método de pago configurado. Con **Cambio inicial** (el campo manual que cargás) calcula `Debe entregar = cambio + suma de los métodos marcados como efectivo físico` — los gastos/pagos a proveedores ya no se restan acá (ver 3.4, ahora son a nivel de todo el negocio, no por delivery).
- **"Cerrar rendición"** (`driver:clear-log`) ya no borra nada — marca `reconciledAt = ahora` en todos los pedidos entregados de ese delivery que todavía no tenían. Esos pedidos siguen para siempre en `pedidos.html` con estado "Entregado", solo dejan de sumar en el total "sin rendir" de `caja.html`. Esto es mejor que el comportamiento viejo (que vaciaba el historial y lo perdía).
- El campo Cambio inicial es **solo del navegador que lo carga** (no se sincroniza por socket con otras pestañas del admin — sí llega a `driver.html`, ver más abajo) — si abrís el panel en otra pestaña no lo vas a ver ahí, solo los totales que sí vienen del servidor.

### Eventos de Socket.IO (referencia)

"Admin" en la columna Auth significa que el servidor descarta el evento si `socket.data.isAdmin` es falso (ver sección de login más arriba).

| Evento | Quién lo emite | Auth | Payload | Qué hace |
|---|---|---|---|---|
| `drivers:snapshot` / `orders:snapshot` / `routes:snapshot` / `form-config:snapshot` | servidor, al conectarse | — | lista completa / config | estado inicial para un cliente recién conectado |
| `driver:update` | driver.js (posición) | — | `{id, name, lat, lng}` | crea/actualiza un delivery; el servidor le agrega `color` y hace broadcast |
| `driver:stop` | driver.js (botón manual) | — | `{id}` | borra al delivery y su ruta |
| `driver:remove` | servidor (broadcast) | — | `{id}` | avisa a todos que ese delivery ya no está |
| `order:add` | nuevo-pedido.js (form individual o carga masiva) | admin | `{id, orderNumber, phone, name, lat, lng, label, amount, custom, pickup}` | crea un pedido y lo guarda en Supabase; rechaza si falta `phone` o si no es `pickup` y falta `lat`/`lng` (tipo de envío obligatorio); `custom` son los valores de los campos personalizados (`sanitizeCustom` en el servidor acota tamaño/cantidad) |
| `order:assign` | pedidos.js / nuevo-pedido.js | admin | `{id, driverId}` | asigna/desasigna un pedido; auto-cambia el estado (pending ↔ en_camino) salvo que ya esté entregado |
| `order:edit` | pedidos.js (dropdowns de la tabla) | admin | `{id, fields: {status?, paymentMethod?}}` | el admin pisa a mano el estado y/o la forma de pago |
| `order:delivered` | driver.js (botón de forma de pago) | — | `{id, paymentMethod}` | pasa el pedido a estado `entregado` (ya no se borra) |
| `order:update` | servidor (broadcast) | — | pedido completo | sincroniza un pedido (nuevo o modificado) en todos los clientes |
| `order:remove` | pedidos.js (🗑 en la tabla) → servidor (broadcast) | admin | `{id}` | borra un pedido de verdad (único caso en que desaparece de la tabla) y de Supabase |
| `driver:route` | nuevo-pedido.js / pedidos.js / driver.js (quien recalcule) | — | `{driverId, stops, latlngs, distanceKm, durationMin}` | comparte la ruta ya calculada (así nadie más repite la llamada a OSRM) |
| `driver:clear-log` | caja.js ("Cerrar rendición") | admin | `{driverId}` | marca como conciliados (`reconciledAt`) los pedidos entregados sin rendir de ese delivery |
| `route:remove` | servidor (broadcast) | — | `{driverId}` | borra la ruta dibujada de ese delivery |
| `form-config:update` | settings.js (reglas fijas informativas, métodos de pago, campos personalizados) | admin | config completa (`{name, orderNumber, amount, paymentMethods: [...], customFields: [...]}`) | guarda en Supabase qué campos se muestran/exigen y la lista de métodos de pago, y lo re-emite a todos |
| `catalog:snapshot` | servidor, al conectarse y tras cada cambio | — | `{categories, products}` | catálogo completo — le llega a todos, admin y clientes anónimos |
| `category:add` / `category:edit` / `category:remove` | catalogo.js | admin | `{name}` / `{id, fields}` / `{id}` | alta/edición/baja de una categoría; `remove` no hace nada si la categoría todavía tiene productos |
| `product:add` / `product:edit` / `product:remove` | catalogo.js | admin | `{categoryId, name, description, price}` / `{id, fields}` / `{id}` | alta/edición/baja de un producto |
| `order:web-add` | pedido-cliente.js (checkout) | — (público, con validación propia) | `{items:[{productId,qty}], phone, name, pickup, lat, lng, label, custom}` + **ack** | crea un pedido `source:'web'`; precio/id siempre calculados en el servidor, nunca confía en el cliente — ver 3.3 |
| `expense:add` / `expense:remove` | proveedores.js | admin | `{description, amount, paymentMethodId}` / `{id}` | alta/baja de un pago a proveedor; `add` no hace nada sin día abierto — ver 3.4 |
| `expenses:snapshot` | servidor, al conectarse (solo admin) y tras cada cambio | admin (sala `admin`, ver 3.4) | lista de gastos del día abierto | a diferencia del resto de los snapshots, este NUNCA le llega a un socket no-admin (es plata) |

### ¿Quién recalcula la ruta óptima de un delivery?
Dos disparadores, para que funcione aunque uno de los dos no esté con la pantalla abierta:
1. `dashboard.js` → al asignar/desasignar un pedido (`recomputeRouteForDriver`).
2. `driver.js` → al marcar "Entregado" (`recomputeMyRoute`), usando su propia última posición conocida.

Ambos usan `Geo.computeRoute(inicio, pedidos)` y emiten `driver:route` con el resultado.

### Persistencia del lado del delivery (localStorage)
- `tracking.driverId` — UUID generado una vez, para que recargar la página no cree "otro" delivery.
- `tracking.driverName` — se recuerda el nombre.
- `tracking.sharing` — flag que dice "estaba compartiendo". Si la pestaña se cierra sin querer (no se tocó "Dejar de compartir"), al reabrir la página **retoma solo**, sin tocar nada. Cerrar la pestaña **no** avisa al servidor (no hay `beforeunload`); el delivery solo se borra si pasan 5 min sin actualizar o si se toca el botón manualmente.

(El efectivo inicial de "Rendición del recorrido" ya **no** es localStorage — lo carga el admin y se sincroniza por socket, ver más abajo.)

### Mapa propio en driver.html
Antes había que salir a Google Maps para ver dónde quedaban los próximos pedidos; ahora `driver.js` dibuja su propio mapa embebido (`#map-section`, oculto hasta la primera posición) con **solo lo suyo** — no todos los deliverys como en `dashboard.js`. Es una copia chica y autocontenida de la lógica de `dashboard.js` (mismo `loadGoogleMaps()`/`svgIcon()`, misma API key, duplicados a propósito — ver el resto de este documento sobre por qué cada página repite en vez de compartir): marcador propio (🛵, se actualiza en cada `sendPosition`), un marcador 📦 por pedido asignado sin entregar, y la polilínea de la ruta (`driver:route`). El link **"Abrir ruta en Google Maps (navegación)"** se mantiene aparte — el mapa embebido es para tener una vista general sin salir de la página, pero para navegación turn-by-turn real conviene la app de Maps.

**Popup de cada pedido en el mapa** (`orderPopupContent()` en `driver.js`, tocando el marcador 📦):
- Color de texto **fijo** (`#1c1e21`, forzado con un `style` inline) — el InfoWindow de Google Maps siempre tiene fondo blanco, pero si no se fuerza el color, el texto hereda `var(--text)` de la página y en modo oscuro queda blanco sobre blanco (invisible). Mismo arreglo aplicado a `dashboard.js` (`popupWrap()`), tenía el mismo bug.
- **Teléfono siempre visible** (no es opcional) como link de WhatsApp: `whatsappLink()` convierte un número uruguayo de 9 dígitos que arranca en 0 (formato `09X XXX XXX`) a `+598` sin el 0; si ya viene con `598` o con otro formato, lo manda tal cual (mejor esfuerzo).
- **"Cómo llegar desde acá" siempre visible** (no es opcional) — arma la ruta con `Geo.buildGoogleMapsUrl([lastPosition, {lat,lng}], false)`: origen la última posición GPS conocida del delivery, destino ese pedido puntual (a diferencia del link de arriba de la página, que enruta por *todos* los pedidos pendientes en orden óptimo). No aparece si todavía no hay un `lastPosition` (sin fix de GPS).
- **Campos personalizados**: cada uno en `formConfig.customFields` tiene ahora `showToDriver` (además de `visible`/`required`) — un tercer checkbox "Mostrar al delivery" en el panel de "Personalizar campos del formulario" (`nuevo-pedido.js`, junto a "Mostrar"/"Obligatorio"; los 5 campos fijos no lo tienen, porque teléfono/ubicación ya son siempre visibles y los otros no aplican). Por defecto `true` en los campos nuevos. Solo se muestran los que tengan valor cargado en ese pedido (`o.custom[key]`).
- El contenido se arma **al tocar el marcador**, no al crearlo (`myOrders.get(id)` en vez de capturar el pedido en el cierre del `forEach`) — así siempre refleja los datos más recientes (ej. si se reasigna el método de pago esperado o se edita algo después de que el marcador ya existía en el mapa).
- **Un solo `InfoWindow` compartido** (`api.infoWindow`, creado una vez en `getMap()`), no uno por marcador — abrirlo para un pedido distinto simplemente lo reposiciona y le cambia el contenido, así que tocar otro pedido "cierra" el anterior solo. Tocar el mapa (no un marcador) también lo cierra (`map.addListener('click', () => infoWindow.close())`) — el click de un marcador es un evento aparte que no dispara el del mapa, así que no hace falta distinguirlos a mano. Antes cada marcador tenía su propio `InfoWindow`, por eso había que usar la cruz para cerrarlo.
- **Botón "Entregado" dentro del popup** (`buildOrderPopup()` devuelve un elemento DOM, no un string, para poder colgarle listeners): arranca mostrando solo "Entregado"; al tocarlo se oculta y aparecen los mismos 3 botones de forma de pago que la lista de abajo del mapa (Efectivo/Transferencia/Débito) — tocar uno emite `order:delivered` igual que siempre, recalcula la ruta, y cierra el `InfoWindow`.

### Rendición del recorrido (driver.js + caja.js)

El **efectivo inicial** de cada delivery lo carga el **admin** desde `caja.html` (no el delivery) — así el número que hay que rendir al final no depende de lo que el delivery diga que le dieron. Se sincroniza por socket:
- `driverCashStarts` en `server.js`: `driverId → number`, **en memoria solamente** (como `drivers`/`routes` — es un dato por recorrido, no historial; el total ya queda fijo en `business_days` al cerrar el día). `socket.emit('cash-starts:snapshot', ...)` al conectar; `driver:cash-start` (admin-only, mismo chequeo `socket.data.isAdmin`) lo actualiza y lo re-emite a todos.
- **`caja.js`**: el input "Efectivo cambio dado" de cada fila emite `driver:cash-start` en cada tecla. Importante: los elementos de cada fila (inputs, celdas) se crean **una sola vez** por delivery (`ensureRow()`/`driverRows` Map) y se actualizan en su lugar (`updateRow()`) — la versión anterior reconstruía toda la lista en cada cambio, lo que le hacía perder el foco al input en cada tecla tipeada (mismo tipo de bug que el de los `<select>` que se cerraban solos, ver más abajo). `updateRow()` tampoco pisa el valor de un input mientras tiene el foco (evita que el eco del propio cambio recién tipeado lo interrumpa).
- **Tabla, no tarjetas**: `caja.html` muestra una fila por delivery con **Delivery activo**, una columna **por cada método de pago configurado** (`formConfig.paymentMethods`, armada dinámicamente por `renderHeader()`/`ensureRow()` — agregar un método nuevo en Ajustes le suma una columna sola, sin tocar código), **Efectivo cambio dado** (input), **Total a entregar** y el botón "Cerrar rendición". Cada columna de método muestra `cantidad — $monto` (comparación exacta contra `order.paymentMethod`, ya no por substring); **Total a entregar** solo suma las columnas cuyo método tiene `isCash:true` (`cashStart + esa suma`) — Transferencia/Débito (o lo que sea que el admin haya marcado como no-efectivo) no son plata física que el delivery tenga que devolver. Si la lista de métodos cambia, `caja.js` reconstruye todas las filas desde cero (evento `form-config:snapshot`) — no hace falta optimizar ese caso raro, solo el de tipear.
- **`driver.html`**: la misma tabla que antes ("Efectivo inicial" / "Entregados en efectivo" / "Debe entregar"), pero el input de "Efectivo inicial" ahora es **`readonly`** — solo lo llena `driver.js` al recibir `cash-starts:snapshot`/`driver:cash-start` para su propio `driverId`. `Debe entregar` se sigue calculando igual (`renderCashSummary()`): filtra `myOrders` por `assignedTo === driverId && status === 'entregado' && !archivedAt`, separa los pagados en efectivo (`isCashPayment()`, ahora busca el método exacto en `formConfig.paymentMethods` en vez de adivinar por substring) y suma. Se "resetea" solo cuando el admin **finaliza el día** (esos pedidos pasan a `archivedAt` y dejan de contar) — para el próximo recorrido el admin carga un efectivo inicial nuevo desde `caja.html`.

### Contador de billetes y monedas (`public/moneyCounter.js`)

Alternativa a tipear el monto a mano en cualquier campo de efectivo: `MoneyCounter.attach(input)` le agrega un botón "🧮 Contar billetes y monedas" al lado que despliega un desglose (cantidad de cada denominación → subtotal → total), y cada cambio pisa `input.value` con el total y dispara un evento `input` sintético — el código que ya escuchaba ese input (para sincronizar, validar, etc.) no necesita saber que existe este contador.
- **Denominaciones "personalizadas"**: guardadas en `localStorage` (clave `tracking.moneyDenominations`, **por navegador**, no por servidor) — se pueden agregar o sacar con los controles del propio desglose. Arranca con los billetes/monedas uruguayos más comunes: `[2000, 1000, 500, 200, 100, 50, 10, 5, 2, 1]`.
- Enganchado en tres lugares: `analiticas.js` → "Efectivo inicial" y "Efectivo final" de "Finalizar día"; `caja.js` → "Efectivo inicial" de cada caja de delivery.
- **Importante en `caja.js`**: `MoneyCounter.attach()` usa `input.insertAdjacentElement('afterend', ...)`, que necesita que el input ya tenga un padre en el DOM — como las cajas de `caja.js` se arman dinámicamente (`ensureBox()`), hay que llamarlo **después** de `row.append(cambioInput, ...)`, no antes (si no, no lanza error pero tampoco inserta nada — el botón simplemente no aparece). En `analiticas.js` no hace falta este cuidado porque esos inputs ya existen fijos en el HTML desde que carga la página.

### Borrar TODO ("Zona de pruebas" en analiticas.html)

`POST /api/admin/reset-today` — a diferencia de la primera versión (que solo tocaba lo activo), ahora borra **absolutamente todo**: todos los pedidos (`orders`, activos y ya archivados) y todos los `business_days` (abiertos y ya cerrados, con su historial), a pedido explícito ("esto es preventivo para pruebas"). Usa `.not('id', 'is', null)` para el `delete()` de Supabase, que es el patrón estándar para "borrar todas las filas" (PostgREST exige algún filtro en un `DELETE`, y esa condición es siempre verdadera en una tabla con `id` como clave). También limpia `driverCashStarts` (emitiendo `driver:cash-start` con `amount: 0` a cada uno antes). **Esto SÍ toca el historial real** — no hay forma de deshacerlo. El botón en `analiticas.js` arma el `confirm()` con la cantidad real de pedidos (`orders.size`, todos, no solo activos) y de días cerrados (`allDays`, guardado del último `loadHistory()`), dejando bien explícito que no es solo "lo de hoy".

⚠️ Por lo mismo, este endpoint nunca se probó de punta a punta contra la base de datos real durante el desarrollo (a diferencia del resto de las features) — probarlo de verdad habría borrado el historial real del local sin forma de recuperarlo. Se verificó por revisión de código y por el patrón `.not('id','is',null)` (ampliamente documentado para Supabase/PostgREST), pero no hay una prueba end-to-end registrada acá.

**Nota sobre `business_days.date`**: originalmente tenía un `unique`, pero eso rompía si se abría un día nuevo en una fecha calendario donde ya había un día *cerrado* anteriormente (pasa seguido probando la app: cerrar y volver a abrir el mismo día). Se sacó esa restricción (`alter table business_days drop constraint if exists business_days_date_key;`) — puede haber más de un `business_days` con la misma `date` si el local abrió y cerró más de una vez ese día.

### Íconos del mapa
`svgIcon()` genera un pin como SVG inline (data URI): círculo con 🛵 para delivery, cuadrado redondeado con 📦 para pedido, coloreado según a qué delivery está asignado (gris si no tiene asignar).

### 3.2 Día comercial y analíticas (`analiticas.html`)

Pensado para llevar un histórico real de pedidos/ingresos por día y por mes, con un ritual explícito de "Iniciar día"/"Finalizar día" en vez de derivarlo automáticamente de la fecha calendario — así un viernes a la noche que sigue hasta pasada la medianoche cuenta como un solo día comercial, no dos.

- Tabla nueva en Supabase, **`business_days`**: `id, date (única), started_at, ended_at, total_orders, total_revenue, cash_start, cash_end, cash_expected`. Un día "abierto" es el que tiene `ended_at IS NULL`. Cacheado en memoria en `openBusinessDay` (no una consulta por request) para poder mandarlo en el snapshot inicial de cada socket y no pegarle a Supabase en cada conexión — se carga una vez al arrancar (`loadOpenBusinessDay()`) y se actualiza en memoria cada vez que se inicia/finaliza un día.
- **Bloqueo de carga sin día abierto**: `order:add` (handler de socket) rechaza silenciosamente si `!openBusinessDay` — esta es la barrera real. `nuevo-pedido.js` escucha el evento `business-day:status` (emitido al conectarse y cada vez que se inicia/finaliza un día) y deshabilita "Agregar pedido"/"Cargar pedidos" + muestra un cartel ("Iniciá el día desde \"Analíticas\"...") cuando no hay día abierto — así el botón no queda "roto" sin explicación, pero el chequeo del servidor es el que realmente importa.
- **`POST /api/business-day/start`**: si ya hay uno abierto lo devuelve tal cual (idempotente, no duplica); si no, crea uno con `date` = fecha calendario del momento y `started_at = ahora`, y hace `io.emit('business-day:status', {day})` para que todas las pantallas conectadas se enteren al instante. No acepta ningún monto de efectivo — eso ahora va por `POST /api/business-day/cash-start`, ver 3.4.
- **`POST /api/business-day/end`**: recibe `{cashStart, cashEnd}` en el body (obligatorios, valida con `Number.isFinite`) — el efectivo con el que arrancó la caja y lo que se contó al cerrar, para comparar contra lo que los pedidos dicen que debería haber. Junta todos los pedidos activos (`!archivedAt`) sin importar su estado, les pone `archivedAt = ahora` (dejan de verse en `pedidos.html`, en el mapa y en el cálculo de rutas — ver los filtros `!o.archivedAt` agregados en `dashboard.js`, `nuevo-pedido.js`, `pedidos.js` y `driver.js`), calcula `total_revenue` (suma de `amount` de los `status === 'entregado'`, plata realmente cobrada) y `cashFromOrders` (lo mismo pero solo los pagados en efectivo, mismo criterio `isCashPayment()` que ya usaba `caja.js`), y guarda `cash_expected = cashStart + cashFromOrders` junto con `cash_start`/`cash_end` tal cual se mandaron — la diferencia (`cash_end - cash_expected`) se calcula al vuelo en el frontend, no se guarda aparte. El frontend (`analiticas.js`) arma la ventana de `confirm()` antes de llamar a este endpoint, y si hay pedidos no entregados entre los activos avisa explícitamente antes de dejar seguir. Al terminar, `openBusinessDay = null` y se vuelve a emitir `business-day:status`.
- **`GET /api/business-day/current`** / **`GET /api/business-days`**: estado del día abierto (desde la caché en memoria) y el historial completo (hasta 400 filas), usados por `analiticas.js` para pintar el estado, el gráfico de barras de ingresos (últimos 14 días cerrados) y las tablas diaria/mensual (el resumen mensual se arma en el cliente agrupando por `date.slice(0,7)`, no hay una tabla mensual separada en Supabase). Los días cerrados antes de que existieran las columnas de efectivo muestran "—" en esas celdas (`cash_expected`/`cash_end` quedan `null`).
- **`GET /api/business-day/:id/orders`**: el detalle de un día ya cerrado (para el click en una fila de "Historial diario"). No hay una relación `day_id` en `orders` — el join es implícito: al cerrar, cada pedido archivado y el `business_days` de ese cierre reciben el **mismo** `now` (mismo milisegundo, mismo string ISO), así que filtrar `orders` por `archived_at = business_days.ended_at` (igualdad exacta) devuelve justo los pedidos de ese cierre. Funciona porque hoy `archivedAt` solo se setea desde este único lugar (`/api/business-day/end`) — si en algún momento se agrega otra forma de archivar pedidos, este join dejaría de ser confiable y haría falta una columna `day_id` de verdad.
- Ninguno de estos 5 endpoints es un evento de Socket.IO — son HTTP normales protegidos por el middleware `requireAuth` (mismo criterio que `socket.data.isAdmin`, respeta `DISABLE_AUTH`). El evento `business-day:status` sí es un socket (broadcast de solo lectura, sin gate de admin — no hay nada sensible en saber si hay un día abierto).
- Los pedidos archivados **no se borran ni pierden ningún dato** — siguen enteros en la tabla `orders` de Supabase, solo dejan de aparecer en las pantallas del día a día. Si en el futuro hace falta un desglose más fino (por forma de pago, por delivery, por franja horaria), esos datos ya están ahí para consultarlos; hoy `business_days` solo guarda el total agregado porque es lo único que se pidió mostrar. El detalle por pedido de un día cerrado se ve tocando la fila correspondiente en "Historial diario" (`toggleDayDetail()` en `analiticas.js`, expande/colapsa una sub-tabla, una sola abierta a la vez); no muestra el delivery asignado porque el nombre del driver solo vive en memoria y no queda registrado históricamente.
- **Aviso de número de pedido repetido**: no bloqueante, a propósito. En el formulario individual (`nuevo-pedido.js`), tipear un Nº de pedido que coincide con otro pedido **activo** (`!archivedAt`) muestra un cartel bajo el campo (`findActiveOrderByNumber()`), pero no impide tocar "Agregar pedido". En la carga masiva, el mismo chequeo corre por fila (más un chequeo contra los números ya vistos en el mismo pegado) y el aviso aparece al final junto con el resumen de cuántos se cargaron. Solo compara contra pedidos activos, no contra el histórico — los números pueden repetirse legítimamente día a día.

### 3.3 Catálogo de productos y pedido online (`catalogo.html` + `pedido-cliente.html`)

Pantalla pública separada de la de administración: el cliente final entra, arma un carrito con lo que el admin cargó en el catálogo, completa un formulario (los mismos campos/obligatoriedad que ya configura el admin para `nuevo-pedido.html`), y el pedido entra al circuito de siempre (aparece en `pedidos.html`, se asigna a un delivery, se ve en el mapa, cuenta para caja/analíticas) — no es un sistema aparte.

**Catálogo (`categories`/`products` en Supabase, cacheados en memoria igual que `formConfig`)**:
- `categories`: `id, name, sort_order, visible`. `products`: `id, category_id, name, description, price, image_url, sort_order, visible`.
- El admin lo arma desde `catalogo.html` (protegida, agregada a `PROTECTED_PAGES`). Cada alta/edición/baja (`category:add/edit/remove`, `product:add/edit/remove`, todos con el mismo chequeo `socket.data.isAdmin` que el resto de los handlers de admin) persiste en Supabase y reemite un `catalog:snapshot` completo (`{categories, products}`) a **todos** los sockets conectados — a diferencia de `orders:snapshot`, este sí tiene que llegarle también a los clientes anónimos en `pedido-cliente.html`, porque son ellos los que están mirando el catálogo en vivo.
- Borrar una categoría con productos adentro está bloqueado del lado del servidor (`category:remove` no hace nada si `products` todavía tiene alguno con ese `categoryId`) — el botón 🗑 de `catalogo.js` queda deshabilitado con un tooltip explicando por qué, en vez de dejar que el `on delete cascade` de la base borre productos sin que el admin lo vea venir.
- **Foto de producto**: subida real desde el celular/PC del admin (no un link pegado). `POST /api/products/:id/image` (protegido con `requireAuth`, no es un evento de socket porque los archivos van mejor por HTTP) recibe el archivo con `multer` (en memoria, máximo 5MB, solo `image/*`), lo sube al bucket público de Supabase Storage **`product-images`** (creado a mano una sola vez desde el panel de Supabase, no hay SQL para esto), guarda la URL pública en `products.image_url` y reemite `catalog:snapshot`. El bucket es público de lectura porque las fotos las tiene que poder ver cualquier cliente anónimo en `pedido-cliente.html`; la subida sí requiere sesión de admin.

**Pedido del cliente (`order:web-add`, evento de socket público — sin `socket.data.isAdmin`)**: no reutiliza `order:add` porque el modelo de confianza es el inverso (nadie logueado del otro lado). Devuelve el resultado con un **ack de Socket.IO** (`socket.emit('order:web-add', payload, callback)`) en vez del broadcast fire-and-forget de siempre, porque acá sí hay alguien esperando una confirmación o un error puntual:
- **Precio**: nunca se confía en lo que mande el navegador — el `amount` final siempre se recalcula del lado del servidor recorriendo el carrito contra el cache de `products` (precio actual, no el que tenía el producto cuando el cliente abrió la página).
- **Producto 86'd o borrado**: si algo del carrito ya no existe o se ocultó (`visible:false`) entre que el cliente lo agregó y tocó "Enviar pedido", se rechaza explícito en vez de aceptarlo o descartarlo en silencio.
- **Id del pedido**: lo genera el servidor (`crypto.randomUUID()`), no el cliente — a diferencia de `order:add` (que confía en el id que manda un admin ya logueado), acá cualquiera anónimo podría mandar un id que ya existe e intentar pisar un pedido ajeno.
- **Campos obligatorios**: se validan del lado del servidor contra el mismo `formConfig` que ya usa `nuevo-pedido.html` (teléfono/nombre/ubicación + `customFields`), salteando `orderNumber` (el servidor le pone `WEB-{seq}`) y `amount` (se calcula, no se pide). La validación del navegador es solo para no hacer ir y volver al cliente — la que importa de verdad es esta.
- **Día cerrado**: mismo chequeo que `order:add` (`!openBusinessDay`), pero acá sí se le avisa al cliente con un mensaje claro ("No estamos aceptando pedidos en este momento") en vez del no-op silencioso que tiene el handler de admin.
- **Límite de envíos**: `webOrderCooldown` (`Map` en memoria, `socket.id → timestamp`) frena un segundo pedido del mismo socket antes de 15 segundos — no hay ninguna librería de rate-limiting en el proyecto, se resolvió con un `Map` como el resto del estado en memoria de `server.js`.
- **Retiro en el local**: el checkbox "Retiro en el local" de `pedido-cliente.js` reutiliza el mismo concepto que ya existe en `order:add` — sin `lat`/`lng`, `label` cae a `"Retira en el local"`.

**Carrito**: vive solo en el navegador del cliente (`localStorage`, clave `tracking.cart`, mismo criterio que `tracking.driverId` en `driver.js` — no hay cuenta de cliente, así que no hay dónde más guardarlo). Se valida contra el catálogo vigente cada vez que llega un `catalog:snapshot` nuevo (un producto sacado o escondido se saca solo de un carrito guardado de una sesión vieja).

**Privacidad — decisión de alcance (MVP)**: como cualquier socket, el de `pedido-cliente.html` recibe igual el `orders:snapshot`/`order:update`/`drivers:snapshot` completos (con teléfono/nombre/dirección de **todos** los clientes) — es el mismo diseño que ya tenía `driver.html`. La diferencia es que esa URL no se difunde, y `pedido-cliente.html` sí (va a estar linkeada desde un menú/redes). Para esta primera versión, `pedido-cliente.js` directamente **no se suscribe** a esos eventos (la data cruza igual por el socket, pero no se renderiza nada con eso) — no toca nada del código existente. Si en algún momento hace falta cerrar esto del todo, la mejora sería agrupar sockets en salas (`trusted` para admin/driver) y cambiar esos `io.emit` puntuales a `io.to('trusted').emit`.

**En `pedidos.html`**: los pedidos con `source === 'web'` muestran una columna "Origen" con 🌐 Web, y si tienen `items` cargados aparece un botón 🧾 que abre un popup de solo lectura con el detalle del carrito (igual patrón `.modal-overlay`/`.modal-box` que "Editar pedido") — el monto se sigue editando desde el ✏️ de siempre, esto es solo para ver qué compró.

### 3.4 Ajustes globales, reglas fijas, métodos de pago y Proveedores

**El botón "⚙ Configuración" (`settings.js`) ahora aparece en las 7 páginas de admin**, no solo en `nuevo-pedido.html` — ver la descripción de `public/settings.js` más arriba. Adentro tiene: **Reglas fijas** (texto informativo, sin checkboxes: tipo de envío y teléfono siempre son obligatorios, no se pueden desactivar), **Métodos de pago**, **Campos personalizados** (el sistema de siempre: agregar/mostrar/obligatorio/mostrar al delivery) y **Cuenta** (cambiar contraseña).

**Tipo de envío y teléfono pasaron a ser fijos, no configurables**: antes `location` era un campo de texto libre y opcional en `nuevo-pedido.html` (sin ningún control de "retira o envía"), y `phone` se podía ocultar/hacer opcional desde Ajustes. Ahora:
- `nuevo-pedido.html` tiene dos botones obligatorios **"Retira en el local" / "Envío"** (ninguno preseleccionado — hay que elegir uno), y el campo de ubicación (`Geo.resolveInput`, igual que siempre) solo aparece si se elige "Envío". `pedido-cliente.html` ya tenía este mecanismo resuelto con el checkbox "Retiro en el local" (que sigue igual).
- Tanto `order:add` (admin) como `order:web-add` (cliente) ahora **validan esto del lado del servidor**: rechazan si falta el teléfono, o si no es retiro y no hay `lat`/`lng` resueltos — antes esa segunda validación en `order:web-add` estaba rota (comparaba contra un campo `payload.location` que el cliente nunca manda, así que en la práctica nunca bloqueaba nada).
- `formConfig` ya no tiene las claves `phone`/`location` — quedan hardcodeadas como obligatorias en el código de cada página, no en la config.

**Métodos de pago — una sola lista configurable, en vez de cuatro copias hardcodeadas**: antes existían por separado `PAYMENT_OPTIONS` en `pedidos.js`, dos arrays sueltos en `driver.js`, y las funciones `isCash/isTransfer/isDebit` de `caja.js` + `isCashPayment()` de `server.js` (todas adivinando por substring, ej. `.includes('efectivo')`). Ahora todo sale de `formConfig.paymentMethods: [{id, name, isCash}]` (default: Efectivo/isCash:true, Transferencia/isCash:false, Débito/isCash:false), editable desde Ajustes (agregar/renombrar/eliminar, tildar "Es efectivo físico"). `isCashPayment()` en el servidor y en `driver.js` ahora buscan el método exacto en esa lista en vez de adivinar por texto — un pedido con un método que ya no existe en la config simplemente no cuenta como efectivo. `driver.js` arma sus botones de "marcar entregado" y `pedidos.js` su `<select>` de "Método de pago" iterando esta misma lista.

**Proveedores (`public/proveedores.html` + `proveedores.js`, tabla `expenses` en Supabase)**: reemplaza al viejo campo "Gastos" de `caja.js` (que era un número suelto por delivery, solo del navegador, nunca llegaba al servidor). Ahora es una pantalla nueva, a nivel de todo el negocio (no por delivery):
```sql
create table expenses (
  id uuid primary key default gen_random_uuid(),
  description text not null,
  amount numeric(10,2) not null default 0,
  payment_method_id text,
  payment_method_name text,
  payment_method_is_cash boolean not null default false,
  business_day_id uuid references business_days(id),
  created_at timestamptz not null default now()
);
```
`payment_method_name`/`payment_method_is_cash` quedan **congelados** al cargar el gasto (mismo criterio que `items.name`/`price` en los pedidos web) — si después se edita o borra ese método de pago en Ajustes, el cálculo de un día ya cerrado no cambia retroactivamente. `expense:add`/`expense:remove` (eventos de socket, admin-gated, mismo patrón que `category:add`/`product:add`) solo funcionan con el día abierto (`businessDayId: openBusinessDay.id`). El 🗑 de `proveedores.js` borra sin confirmación, mismo criterio que `pedidos.js`.
- **Difusión solo a admins**: a diferencia del catálogo (que sí le llega a `pedido-cliente.html`), los gastos son plata — el middleware `io.use(...)` mete a los sockets admin en una sala Socket.IO (`socket.join('admin')`), y tanto el snapshot inicial como cada mutación se mandan con `io.to('admin').emit('expenses:snapshot', ...)` en vez de `io.emit(...)`. Es la primera vez que se usa una sala en este proyecto — antes todo era `io.emit()` a todo el mundo o nada.
- **`/api/business-day/end`** ahora resta del efectivo esperado los gastos en efectivo del día: `cashExpected = cashStart + cashFromOrders - cashExpensesTotal` (suma de `expenses` de ese `business_day_id` con `payment_method_is_cash`).

**El efectivo inicial del día ya no se pierde al cambiar de pantalla**: antes `/api/business-day/start` no aceptaba ningún monto — el campo "Efectivo inicial" de `analiticas.html` se mostraba apenas se abría el día, pero nada lo guardaba hasta tocar "Finalizar día" (que manda `cashStart`/`cashEnd` juntos). Si se tipeaba y se navegaba a otra pantalla antes de cerrar el día, se perdía. Ahora:
- Nuevo endpoint `POST /api/business-day/cash-start` (`requireAuth`, `{cashStart}`) actualiza `business_days.cash_start` de la fila abierta ahí mismo y reemite `business-day:status` con el día actualizado.
- `analiticas.js` guarda solo (con un debounce de 600ms, no hace falta a cada tecla) apenas hay un día abierto, y `renderDayStatus()` repuebla el input desde `currentDay.cash_start` cada vez que llega un snapshot nuevo — salvo que el input tenga el foco en ese momento (mismo guard que ya usaba `caja.js` para "Efectivo cambio dado").
- "Finalizar día" sigue aceptando `cashStart`/`cashEnd` juntos por si se quiere corregir en el momento de cerrar, pero ya no es la única forma de guardar el inicial.

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
| `tracking-en-vivo/` | Render.com (plan free) | Root directory `tracking-en-vivo`, build `npm install`, start `npm start`. Se redespliega solo con cada push. **El plan gratis "duerme" el servidor tras 15 min sin tráfico** (incluye mensajes de WebSocket, no solo pedidos HTTP nuevos) — la primera conexión después tarda ~1 minuto en responder mientras se despierta. Si al menos un delivery está mandando ubicación, esto no pasa. Necesita las variables de entorno de abajo configuradas en Render (Settings → Environment). |

**Variables de entorno necesarias** (`tracking-en-vivo/.env` en local, ver `.env.example`; en Render se cargan en Settings → Environment, no en un archivo):
- `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` — del proyecto de Supabase (Settings → API). La *service role key* nunca se expone al navegador, solo la usa el servidor.
- `SESSION_SECRET` — string random largo, firma las cookies de sesión del admin.
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — solo se usan la primera vez que arranca el servidor con la tabla `admin_users` vacía, para crear el usuario inicial. Cambios posteriores de contraseña se hacen desde "Cuenta" en `nuevo-pedido.html`, no tocando esta variable.
- `DISABLE_AUTH` (opcional) — con `true`, se saltea el login para todos (páginas y sockets). Pensado para desactivarlo temporalmente sin tocar código; sacar la variable (o ponerla en `false`) y redesplegar para reactivarlo.

**Setup manual único en Supabase** (no hay herramienta de migraciones en este proyecto — todo se corre a mano en el SQL Editor, o desde el panel para lo que no es SQL):
- Tablas `categories`/`products` y las columnas `orders.source`/`orders.items` (ver 3.3).
- Bucket de Storage **`product-images`** (Storage → New bucket → Public) — ahí se guardan las fotos de producto.
- Tabla `expenses` (ver 3.4).

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

- **Persistencia parcial**: pedidos, usuario admin y configuración de campos viven en Supabase (sobreviven a un reinicio); deliverys y rutas siguen solo en memoria (a propósito, ver sección 2 — no aporta persistir una posición GPS que cambia cada pocos segundos).
- **Un solo admin, sin multi-cliente**: hay un único usuario/contraseña de administrador (sin roles ni cuentas separadas). No está pensado todavía para vender a más de un restaurante (haría falta separar cuentas/datos por cliente en Supabase, ej. una fila por restaurante y filtrar todo por esa clave).
- **Tracking en segundo plano**: es una web, no una app nativa — si el celular del delivery se bloquea o cambia de app, el navegador frena la ubicación por su cuenta (no hay forma de evitarlo desde una web). Solo una app nativa (Android/iOS) resolvería esto de raíz.
- **Geocodificación de direcciones de texto**: aunque Google es mucho mejor que Nominatim, no es infalible — por eso los pines son arrastrables y las direcciones "aproximadas" (a nivel de calle) se marcan para revisar.
- **corsproxy.io y OSRM son servicios de terceros gratuitos**: no tienen garantía de actividad. Si alguno falla, la app avisa y sigue funcionando con una alternativa más simple (pegar el link completo, o distancia en línea recta) en vez de romperse.
