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
  - `orders`: `orderId → {orderNumber, phone, name, lat, lng, label, assignedTo, status, amount, paymentMethod, reconciledAt, archivedAt, updatedAt}` — **persistido en Supabase** (tabla `orders`), se carga entero al arrancar (`loadOrders()`) y cada cambio se escribe con `persistOrder`/`persistOrderDelete` (fire-and-forget: el Map en memoria + broadcast por socket son los que hacen que la UI se sienta instantánea, Supabase queda consistente unos milisegundos después). `lat`/`lng` son `null` para un pedido que retira en el local. `reconciledAt` marca que ese pedido entregado ya fue incluido en un "Cerrar rendición" anterior (ver 3.1). `archivedAt` marca que quedó incluido en un "Finalizar día" (ver 3.2) — deja de verse en `pedidos.html`/mapa/ruta, pero sigue entero en Supabase para el histórico.
  - `routes`: `driverId → {stops, latlngs, distanceKm, durationMin}` — en memoria, se recalcula on-demand.
  - `formConfig` — qué campos del formulario de "Nuevo pedido" están visibles/son obligatorios, persistido en la tabla `form_config` (una sola fila, columna `fields` en JSON): `{phone, name, orderNumber, location, amount}` (los 5 fijos) más `customFields: [{key, label, visible, required}]` — campos que el admin crea él mismo desde el botón "Agregar campo" (sin límite salvo los 20/60/200 caracteres que sanitiza `sanitizeCustom` en el servidor). Sus valores por pedido viven en la columna `custom` (jsonb) de `orders`, no en columnas propias.
  - Un delivery sin actualizar en 5 min se borra solo (`STALE_MS`).
  - Cada delivery tiene un color fijo asignado por orden de conexión (`COLOR_PALETTE`, 8 colores que rotan).

- **Login de admin** (`admin_users` en Supabase, un solo usuario): `POST /api/login` verifica usuario/contraseña (`bcryptjs`) y devuelve una cookie httpOnly firmada con JWT (`SESSION_SECRET`, 30 días). `POST /api/logout` la borra. `POST /api/change-password` permite cambiarla estando logueado. Si la tabla `admin_users` está vacía al arrancar, `bootstrapAdmin()` crea el usuario inicial con `ADMIN_USERNAME`/`ADMIN_PASSWORD` (variables de entorno, solo se usan esa primera vez).
  - **Gate de páginas**: un middleware de Express redirige a `/login.html` si falta la cookie válida al pedir `nuevo-pedido.html`, `pedidos.html`, `dashboard.html`, `caja.html` o `analiticas.html`. `driver.html` y `login.html` quedan públicas.
  - **Gate real (server-side)**: un middleware de Socket.IO (`io.use`) decodifica la misma cookie en el handshake y marca `socket.data.isAdmin`. Los handlers que modifican datos de admin (`order:add`, `order:assign`, `order:edit`, `order:remove`, `driver:clear-log`, `form-config:update`) chequean `socket.data.isAdmin` — el gate de páginas es solo para la experiencia de uso, esta es la barrera real (alguien podría abrir la consola del navegador y emitir eventos directo, sin pasar por ninguna página). Los endpoints HTTP de "Día comercial" (ver 3.2) no son eventos de socket, así que tienen su propio middleware `requireAuth` con la misma lógica.
  - **Interruptor `DISABLE_AUTH`**: con la variable de entorno `DISABLE_AUTH=true`, `AUTH_DISABLED` queda `true` y tanto el gate de páginas como `socket.data.isAdmin` se saltean para todos (nadie necesita loguearse). Pensado para desactivar el login temporalmente sin tocar código — para reactivarlo alcanza con sacar esa variable en Render (o ponerla en `false`) y que redespliegue.
  - `driver:update`, `driver:stop`, `order:delivered` y `driver:route` quedan sin auth: los usa `driver.html`, que no tiene login.

- `public/geo.js` — misma lógica de geocodificación/ruteo/expansión de links que `optimizador-rutas/app.js`, compartida por las páginas que la necesitan (`nuevo-pedido.js`, `pedidos.js`, `driver.js` — `dashboard.js` y `caja.js` no la usan). También parsea el formato extendido de carga (ver 3.1) y `parseAmount` (convierte "$ 1.630,00" a número).
- **7 páginas separadas** (archivos HTML/JS propios cada una — comparten `style.css` y una barra `<nav class="tabs">` con links entre ellas, más un botón "Cerrar sesión" en las 5 de admin):
  1. **`login.html` + `login.js`** — usuario/contraseña, `POST /api/login`, redirige a `nuevo-pedido.html`.
  2. **`nuevo-pedido.html` + `nuevo-pedido.js`** — formulario individual (campos según `formConfig`) para agendar en el momento, más la carga masiva (textarea, pegado de planilla) — la carga masiva **también sigue `formConfig`**: las columnas de la planilla son exactamente los campos activos, en el orden fijo `phone, name, orderNumber, location, amount` filtrado a los visibles, **más los personalizados al final** (`visibleFieldOrder()`), y el texto de ayuda/placeholder se regeneran solos cuando cambia la config. También tiene el panel **"Personalizar campos del formulario"** (mostrar/ocultar y marcar obligatorio cada campo fijo, `form-config:update`; **"Agregar campo"** crea uno propio con `key` autogenerada tipo `custom_<timestamp><random>`, cada uno con su fila Mostrar/Obligatorio/Eliminar; `renderCustomFieldInputs()` arma sus `<input>` dinámicamente ya que no existen en el HTML) y **"Cuenta"** (cambiar contraseña).
  3. **`pedidos.html` + `pedidos.js`** — el **registro de pedidos**: una tabla (una fila por pedido, estilo planilla) con Delivery asignado (dropdown), Método de pago (dropdown editable) y Estado (dropdown: En preparación / En Camino / Entregado) siempre fijas, más las columnas Teléfono/Nombre/Nº pedido/Monto **y los campos personalizados**, todo solo si están activos en `formConfig` (`visibleFieldColumns()` arma tanto el `<thead>` como cada fila; `fieldCellContent()` cae a `o.custom[key]` para cualquier clave que no sea uno de los 4 fijos). Un pedido nunca se borra solo — sigue en la tabla con estado "Entregado" hasta que lo elimines a mano (🗑).
  4. **`dashboard.html` + `dashboard.js`** — lista de conectados + el mapa en vivo (los pedidos "Entregado" no muestran pin en el mapa, pero siguen en la tabla de `pedidos.html`).
  5. **`caja.html` + `caja.js`** — rendición de caja, ver 3.1.
  6. **`analiticas.html` + `analiticas.js`** — día comercial + histórico, ver 3.2.
  7. **`driver.html` + `driver.js`** — la abre cada delivery, sin login. Nombre + botón "Empezar a compartir ubicación" → `navigator.geolocation.watchPosition` manda su posición por socket. Muestra sus pedidos asignados (en el orden óptimo, con nombre/teléfono del cliente) y, por cada uno, **3 botones de forma de pago** (Efectivo / Transferencia / Débito) — tocar cualquiera marca el pedido entregado con esa forma de pago (la que el cliente realmente usó al recibirlo, no la que se haya puesto al cargarlo).

  Como son páginas independientes, `nuevo-pedido.js` y `pedidos.js` duplican una versión chica de `recomputeRouteForDriver` cada una (ambas necesitan poder recalcular la ruta de un delivery al asignarle un pedido) — es la misma lógica en los dos archivos, no un bug.

### 3.1 Rendición de caja por delivery

Pensado a partir de la planilla real que ya usa el local (control de efectivo/transferencia por delivery al cierre del día).

- **Carga extendida** (carga masiva): las columnas de cada línea son las que estén activas en `formConfig` (fijas + personalizadas), en ese orden (ver sección 2). `Geo.parseStopLine(line, fieldOrder)` recibe ese orden explícito: si la línea trae tabulaciones, separa por tab y mapea posicionalmente contra `fieldOrder`; cualquier clave que no sea `phone/name/orderNumber/location/amount` se guarda tal cual en `result.custom[key]` (así un campo personalizado nuevo no necesita tocar `geo.js`); si `fieldOrder` tiene 2 campos o menos y no hay tab, acepta el atajo "valor1 valor2" separado por espacio/coma (para tipear rápido sin tabular). `Geo.parseAmount` interpreta el formato uruguayo ("$ 1.630,00" → `1630`). Ya no hay una columna aparte de "forma de pago esperada" en la carga masiva — la forma de pago real siempre se confirma al entregar.
- El **id de cada pedido lo genera el cliente** (`genId()` en `nuevo-pedido.js`, mismo patrón que `driverId`) y viaja en el propio `order:add`, para poder asignarlo (`order:assign`) en el mismo tick sin esperar una respuesta del servidor.
- **Estado del pedido**: `pending` (En preparación) al crearlo → pasa solo a `en_camino` (En Camino) al asignarlo a un delivery (y vuelve a `pending` si se desasigna) → pasa solo a `entregado` cuando el delivery toca alguno de los 3 botones de forma de pago. El admin puede pisar el estado a mano en cualquier momento desde el dropdown de la tabla.
- Al marcar un pedido entregado (`order:delivered`), el servidor solo actualiza ese mismo pedido: `status='entregado'` y `paymentMethod` con lo que eligió el delivery (pisando cualquier valor puesto antes) — **ya no se borra**. Solo `order:remove` (🗑 en `pedidos.html`) borra un pedido de verdad.
- `caja.js` (`renderCashList`) ya no depende de un historial aparte: filtra `orders` por `assignedTo === driverId && status === 'entregado' && !reconciledAt` y suma efectivo cobrado (todo lo que no sea claramente otro medio de pago) vs. otros medios. Con dos campos manuales que vos cargás (**Cambio inicial**, **Gastos**) calcula `Debe entregar = efectivo cobrado + cambio - gastos` — misma lógica que la planilla original.
- **"Cerrar rendición"** (`driver:clear-log`) ya no borra nada — marca `reconciledAt = ahora` en todos los pedidos entregados de ese delivery que todavía no tenían. Esos pedidos siguen para siempre en `pedidos.html` con estado "Entregado", solo dejan de sumar en el total "sin rendir" de `caja.html`. Esto es mejor que el comportamiento viejo (que vaciaba el historial y lo perdía).
- Los campos Cambio/Gastos son **solo del navegador que los carga** (no se sincronizan por socket) — si abrís el panel en otra pestaña no los vas a ver ahí, solo los totales que sí vienen del servidor.

### Eventos de Socket.IO (referencia)

"Admin" en la columna Auth significa que el servidor descarta el evento si `socket.data.isAdmin` es falso (ver sección de login más arriba).

| Evento | Quién lo emite | Auth | Payload | Qué hace |
|---|---|---|---|---|
| `drivers:snapshot` / `orders:snapshot` / `routes:snapshot` / `form-config:snapshot` | servidor, al conectarse | — | lista completa / config | estado inicial para un cliente recién conectado |
| `driver:update` | driver.js (posición) | — | `{id, name, lat, lng}` | crea/actualiza un delivery; el servidor le agrega `color` y hace broadcast |
| `driver:stop` | driver.js (botón manual) | — | `{id}` | borra al delivery y su ruta |
| `driver:remove` | servidor (broadcast) | — | `{id}` | avisa a todos que ese delivery ya no está |
| `order:add` | nuevo-pedido.js (form individual o carga masiva) | admin | `{id, orderNumber, phone, name, lat, lng, label, amount, custom}` | crea un pedido y lo guarda en Supabase; `lat`/`lng` opcionales (`null` = retira); `custom` son los valores de los campos personalizados (`sanitizeCustom` en el servidor acota tamaño/cantidad) |
| `order:assign` | pedidos.js / nuevo-pedido.js | admin | `{id, driverId}` | asigna/desasigna un pedido; auto-cambia el estado (pending ↔ en_camino) salvo que ya esté entregado |
| `order:edit` | pedidos.js (dropdowns de la tabla) | admin | `{id, fields: {status?, paymentMethod?}}` | el admin pisa a mano el estado y/o la forma de pago |
| `order:delivered` | driver.js (botón de forma de pago) | — | `{id, paymentMethod}` | pasa el pedido a estado `entregado` (ya no se borra) |
| `order:update` | servidor (broadcast) | — | pedido completo | sincroniza un pedido (nuevo o modificado) en todos los clientes |
| `order:remove` | pedidos.js (🗑 en la tabla) → servidor (broadcast) | admin | `{id}` | borra un pedido de verdad (único caso en que desaparece de la tabla) y de Supabase |
| `driver:route` | nuevo-pedido.js / pedidos.js / driver.js (quien recalcule) | — | `{driverId, stops, latlngs, distanceKm, durationMin}` | comparte la ruta ya calculada (así nadie más repite la llamada a OSRM) |
| `driver:clear-log` | caja.js ("Cerrar rendición") | admin | `{driverId}` | marca como conciliados (`reconciledAt`) los pedidos entregados sin rendir de ese delivery |
| `route:remove` | servidor (broadcast) | — | `{driverId}` | borra la ruta dibujada de ese delivery |
| `form-config:update` | nuevo-pedido.js (toggles fijos, alta/baja de campos personalizados) | admin | config completa (`{phone, name, orderNumber, location, amount, customFields: [...]}`) | guarda en Supabase qué campos se muestran/exigen (fijos y personalizados) y lo re-emite a todos |

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

### 3.2 Día comercial y analíticas (`analiticas.html`)

Pensado para llevar un histórico real de pedidos/ingresos por día y por mes, con un ritual explícito de "Iniciar día"/"Finalizar día" en vez de derivarlo automáticamente de la fecha calendario — así un viernes a la noche que sigue hasta pasada la medianoche cuenta como un solo día comercial, no dos.

- Tabla nueva en Supabase, **`business_days`**: `id, date (única), started_at, ended_at, total_orders, total_revenue, cash_start, cash_end, cash_expected`. Un día "abierto" es el que tiene `ended_at IS NULL`. Cacheado en memoria en `openBusinessDay` (no una consulta por request) para poder mandarlo en el snapshot inicial de cada socket y no pegarle a Supabase en cada conexión — se carga una vez al arrancar (`loadOpenBusinessDay()`) y se actualiza en memoria cada vez que se inicia/finaliza un día.
- **Bloqueo de carga sin día abierto**: `order:add` (handler de socket) rechaza silenciosamente si `!openBusinessDay` — esta es la barrera real. `nuevo-pedido.js` escucha el evento `business-day:status` (emitido al conectarse y cada vez que se inicia/finaliza un día) y deshabilita "Agregar pedido"/"Cargar pedidos" + muestra un cartel ("Iniciá el día desde \"Analíticas\"...") cuando no hay día abierto — así el botón no queda "roto" sin explicación, pero el chequeo del servidor es el que realmente importa.
- **`POST /api/business-day/start`**: si ya hay uno abierto lo devuelve tal cual (idempotente, no duplica); si no, crea uno con `date` = fecha calendario del momento y `started_at = ahora`, y hace `io.emit('business-day:status', {day})` para que todas las pantallas conectadas se enteren al instante.
- **`POST /api/business-day/end`**: recibe `{cashStart, cashEnd}` en el body (obligatorios, valida con `Number.isFinite`) — el efectivo con el que arrancó la caja y lo que se contó al cerrar, para comparar contra lo que los pedidos dicen que debería haber. Junta todos los pedidos activos (`!archivedAt`) sin importar su estado, les pone `archivedAt = ahora` (dejan de verse en `pedidos.html`, en el mapa y en el cálculo de rutas — ver los filtros `!o.archivedAt` agregados en `dashboard.js`, `nuevo-pedido.js`, `pedidos.js` y `driver.js`), calcula `total_revenue` (suma de `amount` de los `status === 'entregado'`, plata realmente cobrada) y `cashFromOrders` (lo mismo pero solo los pagados en efectivo, mismo criterio `isCashPayment()` que ya usaba `caja.js`), y guarda `cash_expected = cashStart + cashFromOrders` junto con `cash_start`/`cash_end` tal cual se mandaron — la diferencia (`cash_end - cash_expected`) se calcula al vuelo en el frontend, no se guarda aparte. El frontend (`analiticas.js`) arma la ventana de `confirm()` antes de llamar a este endpoint, y si hay pedidos no entregados entre los activos avisa explícitamente antes de dejar seguir. Al terminar, `openBusinessDay = null` y se vuelve a emitir `business-day:status`.
- **`GET /api/business-day/current`** / **`GET /api/business-days`**: estado del día abierto (desde la caché en memoria) y el historial completo (hasta 400 filas), usados por `analiticas.js` para pintar el estado, el gráfico de barras de ingresos (últimos 14 días cerrados) y las tablas diaria/mensual (el resumen mensual se arma en el cliente agrupando por `date.slice(0,7)`, no hay una tabla mensual separada en Supabase). Los días cerrados antes de que existieran las columnas de efectivo muestran "—" en esas celdas (`cash_expected`/`cash_end` quedan `null`).
- **`GET /api/business-day/:id/orders`**: el detalle de un día ya cerrado (para el click en una fila de "Historial diario"). No hay una relación `day_id` en `orders` — el join es implícito: al cerrar, cada pedido archivado y el `business_days` de ese cierre reciben el **mismo** `now` (mismo milisegundo, mismo string ISO), así que filtrar `orders` por `archived_at = business_days.ended_at` (igualdad exacta) devuelve justo los pedidos de ese cierre. Funciona porque hoy `archivedAt` solo se setea desde este único lugar (`/api/business-day/end`) — si en algún momento se agrega otra forma de archivar pedidos, este join dejaría de ser confiable y haría falta una columna `day_id` de verdad.
- Ninguno de estos 5 endpoints es un evento de Socket.IO — son HTTP normales protegidos por el middleware `requireAuth` (mismo criterio que `socket.data.isAdmin`, respeta `DISABLE_AUTH`). El evento `business-day:status` sí es un socket (broadcast de solo lectura, sin gate de admin — no hay nada sensible en saber si hay un día abierto).
- Los pedidos archivados **no se borran ni pierden ningún dato** — siguen enteros en la tabla `orders` de Supabase, solo dejan de aparecer en las pantallas del día a día. Si en el futuro hace falta un desglose más fino (por forma de pago, por delivery, por franja horaria), esos datos ya están ahí para consultarlos; hoy `business_days` solo guarda el total agregado porque es lo único que se pidió mostrar. El detalle por pedido de un día cerrado se ve tocando la fila correspondiente en "Historial diario" (`toggleDayDetail()` en `analiticas.js`, expande/colapsa una sub-tabla, una sola abierta a la vez); no muestra el delivery asignado porque el nombre del driver solo vive en memoria y no queda registrado históricamente.
- **Aviso de número de pedido repetido**: no bloqueante, a propósito. En el formulario individual (`nuevo-pedido.js`), tipear un Nº de pedido que coincide con otro pedido **activo** (`!archivedAt`) muestra un cartel bajo el campo (`findActiveOrderByNumber()`), pero no impide tocar "Agregar pedido". En la carga masiva, el mismo chequeo corre por fila (más un chequeo contra los números ya vistos en el mismo pegado) y el aviso aparece al final junto con el resumen de cuántos se cargaron. Solo compara contra pedidos activos, no contra el histórico — los números pueden repetirse legítimamente día a día.

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
