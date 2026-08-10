// Página pública de seguimiento de UN pedido puntual -- el link
// (seguimiento.html?id=<orderId>) es la única "contraseña": el servidor solo
// entra a quien lo tenga a la room `track:<orderId>` (ver
// socket.on('tracking:subscribe') en server.js) y desde ahí nunca manda nada
// de ningún otro pedido ni delivery, a diferencia de driver.html/
// pedido-cliente.html (que sí reciben el snapshot completo, ver 3.3 de
// DOCUMENTACION.md). Página standalone, socket propio -- mismo patrón que
// driver.js/pedido-cliente.js, no forma parte de la SPA de admin.

const GOOGLE_MAPS_API_KEY = 'AIzaSyDFkwn0iYF1X3S6Zu3B0XhdI1PrRj2zAvQ';
let googleMapsLoadPromise = null;
function loadGoogleMaps() {
  if (googleMapsLoadPromise) return googleMapsLoadPromise;
  googleMapsLoadPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.maps) { resolve(window.google.maps); return; }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}`;
    script.onload = () => resolve(window.google.maps);
    script.onerror = () => reject(new Error('No se pudo cargar el mapa.'));
    document.head.appendChild(script);
    // Algunos navegadores integrados (ej. el de WhatsApp) bloquean o cuelgan
    // la carga de scripts externos sin tirar ni onload ni onerror -- sin este
    // timeout, `getMap()` quedaría esperando para siempre y la página se ve
    // rota (el status de arriba está bien, pero el mapa nunca aparece ni
    // avisa nada).
    setTimeout(() => reject(new Error('El mapa tardó demasiado en cargar.')), 8000);
  });
  return googleMapsLoadPromise;
}

// Google llama a esto globalmente cuando la API key es rechazada (referrer
// no autorizado, etc.) -- pasa en algunos navegadores integrados (WhatsApp)
// que mandan un Referer distinto al del sitio real.
window.gm_authFailure = () => showMapFallback();

function showMapFallback() {
  const mapEl = document.getElementById('track-map');
  if (mapEl.dataset.fallback) return;
  mapEl.dataset.fallback = '1';
  mapEl.classList.add('track-map-fallback');
  mapEl.textContent = '📍 No pudimos cargar el mapa acá.';
  mapHintEl.textContent = 'Probá abriendo este link en tu navegador (Chrome/Safari) en vez de adentro de WhatsApp -- desde el menú ⋮ o el ícono de compartir de arriba, buscá la opción "Abrir en el navegador".';
  mapHintEl.style.display = '';
}

function svgIcon(maps, color, emoji, size, shape) {
  const half = size / 2;
  const shapeSvg = shape === 'circle'
    ? `<circle cx="${half}" cy="${half}" r="${half - 2}" fill="${color}" stroke="white" stroke-width="2"/>`
    : `<rect x="2" y="2" width="${size - 4}" height="${size - 4}" rx="6" fill="${color}" stroke="white" stroke-width="2"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${shapeSvg}<text x="${half}" y="${half + 5}" font-size="${Math.round(size * 0.5)}" text-anchor="middle">${emoji}</text></svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new maps.Size(size, size),
    anchor: new maps.Point(half, half),
  };
}

const titleEl = document.getElementById('track-status-title');
const msgEl = document.getElementById('track-status-msg');
const orderNumEl = document.getElementById('track-order-number');
const mapWrapEl = document.getElementById('track-map-wrap');
const mapHintEl = document.getElementById('track-map-hint');

function showError(title, msg) {
  titleEl.textContent = title;
  msgEl.textContent = msg;
  mapWrapEl.style.display = 'none';
}

const orderId = new URLSearchParams(location.search).get('id');
if (!orderId) {
  showError('Falta el pedido', 'El link no es válido -- revisá que lo hayas copiado completo.');
} else {
  let mapApi = null;

  function fitBoundsIfNeeded(api) {
    const points = [];
    if (api.driverMarker) points.push(api.driverMarker.getPosition());
    if (api.destMarker) points.push(api.destMarker.getPosition());
    if (points.length === 0) return;
    if (points.length === 1) { api.map.setCenter(points[0]); return; }
    const bounds = new api.maps.LatLngBounds();
    points.forEach((p) => bounds.extend(p));
    api.map.fitBounds(bounds, 60);
  }

  async function getMap() {
    if (mapApi) return mapApi;
    const maps = await loadGoogleMaps();
    const mapEl = document.getElementById('track-map');
    const map = new maps.Map(mapEl, {
      center: { lat: -34.9011, lng: -56.1645 },
      zoom: 14,
      mapTypeControl: false,
      streetViewControl: false,
    });
    mapApi = { maps, map, driverMarker: null, destMarker: null };
    // El contenedor está oculto (display:none) hasta un instante antes de
    // crear el mapa -- si Maps mide el tamaño en ese mismo instante (o el
    // layout sigue moviéndose un poco más, visto en vivo en Chrome de
    // escritorio además de navegadores integrados), los tiles quedan mal
    // calculados/desalineados y un solo resize "al toque" no siempre
    // alcanza. Un ResizeObserver es más robusto que adivinar un momento
    // puntual: dispara el resize de Maps cada vez que el contenedor
    // realmente cambia de tamaño, las veces que haga falta -- mismo fix que
    // ya usa pedido-cliente.js para el mapa del checkout, pero con un
    // disparador más confiable que un solo requestAnimationFrame.
    let lastSize = '';
    new ResizeObserver(() => {
      if (mapEl.clientWidth === 0) return;
      const size = `${mapEl.clientWidth}x${mapEl.clientHeight}`;
      if (size === lastSize) return;
      lastSize = size;
      maps.event.trigger(map, 'resize');
      fitBoundsIfNeeded(mapApi);
    }).observe(mapEl);
    return mapApi;
  }

  async function showDestination(lat, lng) {
    let api;
    try { api = await getMap(); } catch (e) { showMapFallback(); return; }
    const position = { lat, lng };
    if (api.destMarker) api.destMarker.setPosition(position);
    else api.destMarker = new api.maps.Marker({ position, map: api.map, icon: svgIcon(api.maps, '#dc2626', '🏠', 38, 'square') });
    fitBoundsIfNeeded(api);
  }

  async function showDriver(lat, lng) {
    let api;
    try { api = await getMap(); } catch (e) { showMapFallback(); return; }
    const position = { lat, lng };
    if (api.driverMarker) api.driverMarker.setPosition(position);
    else api.driverMarker = new api.maps.Marker({ position, map: api.map, icon: svgIcon(api.maps, '#2563eb', '🛵', 44, 'circle'), zIndex: 10 });
    fitBoundsIfNeeded(api);
    mapHintEl.style.display = 'none';
  }

  function render(o) {
    orderNumEl.style.display = o.orderNumber ? '' : 'none';
    orderNumEl.textContent = o.orderNumber ? `Pedido #${o.orderNumber}` : '';

    if (o.status === 'entregado') {
      titleEl.textContent = '✅ Tu pedido fue entregado';
      msgEl.textContent = '¡Buen provecho!';
      mapWrapEl.style.display = 'none';
      return;
    }
    if (o.pickup) {
      titleEl.textContent = '🍳 Tu pedido se está preparando';
      msgEl.textContent = 'Te esperamos para que lo retires en el local.';
      mapWrapEl.style.display = 'none';
      return;
    }

    mapWrapEl.style.display = '';
    if (o.lat != null && o.lng != null) showDestination(o.lat, o.lng);

    if (!o.assigned) {
      titleEl.textContent = '🍳 Tu pedido se está preparando';
      msgEl.textContent = 'En breve lo despachamos con un delivery.';
      mapHintEl.textContent = 'Todavía no salió -- acá vas a ver a tu delivery en vivo apenas salga.';
      mapHintEl.style.display = '';
    } else {
      titleEl.textContent = '🛵 Tu pedido está en camino';
      msgEl.textContent = '';
      mapHintEl.textContent = 'Buscando la ubicación del delivery...';
      mapHintEl.style.display = '';
    }
  }

  const socket = io();
  socket.emit('tracking:subscribe', { orderId });
  socket.on('tracking:order', render);
  socket.on('tracking:driver', ({ lat, lng }) => showDriver(lat, lng));
  socket.on('tracking:removed', () => showError('Este pedido ya no existe', 'Puede que se haya cancelado -- consultanos si tenés dudas.'));
  socket.on('tracking:error', ({ error }) => showError('No encontramos este pedido', error || 'Revisá el link que te enviaron.'));
  socket.on('connect', () => socket.emit('tracking:subscribe', { orderId }));
}
