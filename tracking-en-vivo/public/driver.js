const nameInput = document.getElementById('driver-name');
const toggleBtn = document.getElementById('toggle-btn');
const statusEl = document.getElementById('status');
const mapSectionEl = document.getElementById('map-section');
const ordersSectionEl = document.getElementById('orders-section');
const ordersListEl = document.getElementById('orders-list');
const routeSummaryEl = document.getElementById('route-summary');
const mapsLinkEl = document.getElementById('maps-link');
const cashStartInput = document.getElementById('cash-start-input');
const cashDeliveredSummaryEl = document.getElementById('cash-delivered-summary');
const cashTotalEl = document.getElementById('cash-total');

// Same key as geo.js/dashboard.js — protected by HTTP referrer + API
// restriction in Google Cloud Console, not by secrecy.
const GOOGLE_MAPS_API_KEY = 'AIzaSyDFkwn0iYF1X3S6Zu3B0XhdI1PrRj2zAvQ';

let googleMapsLoadPromise = null;
function loadGoogleMaps() {
  if (googleMapsLoadPromise) return googleMapsLoadPromise;
  googleMapsLoadPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.maps) { resolve(window.google.maps); return; }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}`;
    script.onload = () => resolve(window.google.maps);
    script.onerror = () => reject(new Error('No se pudo cargar Google Maps.'));
    document.head.appendChild(script);
  });
  return googleMapsLoadPromise;
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

// Mapa embebido con SOLO el recorrido de este delivery (a diferencia de
// dashboard.js, que muestra a todos) — así no hace falta salir a Google Maps
// solo para ver dónde están los próximos pedidos.
let mapApi = null;
async function getMap() {
  if (mapApi) return mapApi;
  const maps = await loadGoogleMaps();
  const map = new maps.Map(document.getElementById('map'), {
    center: { lat: -34.9011, lng: -56.1645 },
    zoom: 13,
    mapTypeControl: false,
    streetViewControl: false,
  });
  const infoWindow = new maps.InfoWindow();
  // Tocar el mapa (no un marcador) cierra el popup solo — un click en un
  // marcador es un evento aparte que no llega hasta acá, así que no hace
  // falta distinguirlos.
  map.addListener('click', () => infoWindow.close());
  mapApi = { maps, map, infoWindow, driverMarker: null, orderMarkers: new Map(), routeLine: null };
  return mapApi;
}

function fitMapBounds(api) {
  const points = [];
  if (api.driverMarker) points.push(api.driverMarker.getPosition());
  api.orderMarkers.forEach((m) => points.push(m.getPosition()));
  if (points.length === 0) return;
  const bounds = new api.maps.LatLngBounds();
  points.forEach((p) => bounds.extend(p));
  api.map.fitBounds(bounds, 40);
  api.maps.event.addListenerOnce(api.map, 'bounds_changed', () => {
    if (api.map.getZoom() > 16) api.map.setZoom(16);
  });
}

async function updateDriverMarkerOnMap(lat, lng) {
  const api = await getMap();
  mapSectionEl.hidden = false;
  const position = { lat, lng };
  if (api.driverMarker) {
    api.driverMarker.setPosition(position);
  } else {
    api.driverMarker = new api.maps.Marker({ position, map: api.map, icon: svgIcon(api.maps, '#2563eb', '🛵', 42, 'circle'), zIndex: 10 });
    fitMapBounds(api);
  }
}

// Números uruguayos: 09X XXX XXX (9 dígitos, arranca en 0) → +598 sin el 0,
// para armar un link de WhatsApp directo. Si ya viene con 598 o es otra
// forma, se manda tal cual (mejor esfuerzo, no hay forma de saber el país
// con certeza a partir del número solo).
function whatsappLink(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const intl = digits.startsWith('598') ? digits : (digits.startsWith('0') && digits.length === 9) ? `598${digits.slice(1)}` : `598${digits}`;
  return `https://wa.me/${intl}`;
}

// Teléfono y "cómo llegar" siempre se muestran (no es opcional); los campos
// personalizados sí, según `formConfig.customFields[].showToDriver` (lo elige
// el admin desde Ajustes -> Pedidos -> "Campos personalizados").
// Devuelve un elemento DOM (no un string) para poder colgarle el botón
// "Entregado" con su propio listener — un InfoWindow de Google Maps acepta
// cualquiera de los dos como contenido.
function buildOrderPopup(api, o) {
  // Color fijo: el InfoWindow de Google Maps siempre tiene fondo blanco, pero
  // sin esto el texto hereda var(--text) de la página — invisible en modo oscuro.
  const container = document.createElement('div');
  container.style.color = '#1c1e21';
  container.style.fontSize = '0.9rem';
  container.style.lineHeight = '1.5';

  const lines = [`<strong>Pedido #${o.orderNumber || '?'}</strong>`];
  if (o.name) lines.push(o.name);
  if (o.phone) {
    const wa = whatsappLink(o.phone);
    lines.push(wa ? `<a href="${wa}" target="_blank" rel="noopener">${o.phone} (WhatsApp)</a>` : o.phone);
  }
  if (o.label) lines.push(o.label);
  if (o.lat != null && o.lng != null && lastPosition) {
    const url = Geo.buildGoogleMapsUrl([lastPosition, { lat: o.lat, lng: o.lng }], false);
    lines.push(`<a href="${url}" target="_blank" rel="noopener">Cómo llegar desde acá</a>`);
  }
  (formConfig.customFields || []).forEach((f) => {
    if (f.showToDriver === false) return;
    const value = o.custom && o.custom[f.key];
    if (value) lines.push(`${f.label}: ${value}`);
  });
  const info = document.createElement('div');
  info.innerHTML = lines.join('<br>');
  container.appendChild(info);

  // "Entregado" arranca oculto el segundo paso (los 3 medios de pago) — se
  // muestra recién al tocarlo, mismo flujo que la lista de abajo del mapa.
  const paymentRow = document.createElement('div');
  paymentRow.style.display = 'none';
  paymentRow.style.gap = '4px';
  paymentRow.style.marginTop = '6px';
  paymentRow.style.flexWrap = 'wrap';
  paymentMethodNames().forEach((method) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'danger small';
    btn.textContent = method;
    btn.addEventListener('click', () => {
      socket.emit('order:delivered', { id: o.id, paymentMethod: method });
      recomputeMyRoute();
      api.infoWindow.close();
    });
    paymentRow.appendChild(btn);
  });

  const deliveredBtn = document.createElement('button');
  deliveredBtn.type = 'button';
  deliveredBtn.className = 'danger small';
  deliveredBtn.textContent = 'Entregado';
  deliveredBtn.style.marginTop = '8px';
  deliveredBtn.addEventListener('click', () => {
    deliveredBtn.style.display = 'none';
    paymentRow.style.display = 'flex';
  });

  container.append(deliveredBtn, paymentRow);
  return container;
}

async function updateOrderMarkersOnMap(mine) {
  const api = await getMap();
  const mineIds = new Set(mine.map(([id]) => id));
  let changed = false;
  api.orderMarkers.forEach((marker, id) => {
    if (!mineIds.has(id)) { marker.setMap(null); api.orderMarkers.delete(id); changed = true; }
  });
  mine.forEach(([id, o]) => {
    if (o.lat == null || o.lng == null) return;
    const position = { lat: o.lat, lng: o.lng };
    const existing = api.orderMarkers.get(id);
    if (existing) {
      existing.setPosition(position);
    } else {
      const marker = new api.maps.Marker({ position, map: api.map, icon: svgIcon(api.maps, '#dc2626', '📦', 36, 'square') });
      marker.addListener('click', () => {
        api.infoWindow.setContent(buildOrderPopup(api, myOrders.get(id) || o));
        api.infoWindow.open({ anchor: marker, map: api.map });
      });
      api.orderMarkers.set(id, marker);
      changed = true;
    }
  });
  if (changed) fitMapBounds(api);
}

async function updateRouteLineOnMap(latlngs) {
  const api = await getMap();
  if (api.routeLine) { api.routeLine.setMap(null); api.routeLine = null; }
  if (!latlngs || latlngs.length < 2) return;
  const path = latlngs.map(([lat, lng]) => ({ lat, lng }));
  api.routeLine = new api.maps.Polyline({ path, strokeColor: '#2563eb', strokeWeight: 4, strokeOpacity: 0.8, map: api.map });
}

const DRIVER_ID_KEY = 'tracking.driverId';
const DRIVER_NAME_KEY = 'tracking.driverName';
const SHARING_KEY = 'tracking.sharing';

function getDriverId() {
  let id = localStorage.getItem(DRIVER_ID_KEY);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem(DRIVER_ID_KEY, id);
  }
  return id;
}

const driverId = getDriverId();
nameInput.value = localStorage.getItem(DRIVER_NAME_KEY) || '';

const socket = io();
let watchId = null;

// orderId -> { orderNumber, label, assignedTo, ... }, filtered to this driver's own pedidos
const myOrders = new Map();
// Order ids in the optimal visiting sequence, from the last computed route.
let myRouteOrder = [];
let myCashStart = 0; // lo carga el admin desde caja.html — acá es de solo lectura
// Solo se usa acá para saber qué campos personalizados mostrar en el popup
// de cada pedido en el mapa (`showToDriver`, ver buildOrderPopup).
let formConfig = { customFields: [], paymentMethods: [] };
socket.on('form-config:snapshot', (cfg) => {
  formConfig = cfg || { customFields: [], paymentMethods: [] };
  if (!Array.isArray(formConfig.paymentMethods)) formConfig.paymentMethods = [];
  renderOrders();
  renderCashSummary();
  if (window.applyBranding && formConfig.branding) window.applyBranding(formConfig.branding);
});

function paymentMethodNames() {
  return formConfig.paymentMethods.map((m) => m.name);
}

function isCashPayment(paymentMethod) {
  if (!paymentMethod) return false;
  const method = formConfig.paymentMethods.find((m) => m.name === paymentMethod);
  return !!(method && method.isCash);
}

// Se suma solo lo que va entregando en efectivo hasta ahora, sobre el
// efectivo inicial que cargó el admin. No se resetea hasta que el admin
// "Finalice el día" desde Día Comercial, momento en que esos pedidos se
// archivan y dejan de contar.
function renderCashSummary() {
  const delivered = Array.from(myOrders.values()).filter((o) => o.assignedTo === driverId && o.status === 'entregado' && !o.archivedAt);
  const cashDelivered = delivered.filter((o) => isCashPayment(o.paymentMethod));
  const cashTotal = cashDelivered.reduce((sum, o) => sum + (o.amount || 0), 0);
  const mustHandIn = myCashStart + cashTotal;

  cashDeliveredSummaryEl.textContent = `${cashDelivered.length} pedido${cashDelivered.length === 1 ? '' : 's'} — $${cashTotal.toFixed(2)}`;
  cashTotalEl.innerHTML = `<strong>$${mustHandIn.toFixed(2)}</strong>`;
}

socket.on('cash-starts:snapshot', (list) => {
  const mine = list.find((c) => c.driverId === driverId);
  if (mine) { myCashStart = mine.amount; cashStartInput.value = mine.amount ? mine.amount.toFixed(2) : ''; }
  renderCashSummary();
});
socket.on('driver:cash-start', ({ driverId: id, amount }) => {
  if (id !== driverId) return;
  myCashStart = amount;
  cashStartInput.value = amount ? amount.toFixed(2) : '';
  renderCashSummary();
});

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` ${kind}` : ''}`;
}

function renderOrders() {
  const mine = Array.from(myOrders.entries()).filter(([, o]) => o.assignedTo === driverId && o.status !== 'entregado' && !o.archivedAt);
  // Sort by the optimal route sequence when we have one; anything not in it
  // yet (just assigned, route not recomputed) falls to the end.
  mine.sort(([idA], [idB]) => {
    const posA = myRouteOrder.indexOf(idA);
    const posB = myRouteOrder.indexOf(idB);
    if (posA === -1 && posB === -1) return 0;
    if (posA === -1) return 1;
    if (posB === -1) return -1;
    return posA - posB;
  });

  updateOrderMarkersOnMap(mine);

  ordersSectionEl.hidden = mine.length === 0;
  if (mine.length === 0) return;

  routeSummaryEl.textContent = `${mine.length} pedido${mine.length === 1 ? '' : 's'} asignado${mine.length === 1 ? '' : 's'}.`;

  ordersListEl.innerHTML = '';
  mine.forEach(([id, o], idx) => {
    const li = document.createElement('li');
    li.style.flexDirection = 'column';
    li.style.alignItems = 'flex-start';
    li.style.gap = '6px';

    const info = document.createElement('span');
    info.className = 'order-info';
    const who = o.name ? `${o.name}${o.phone ? ` (${o.phone})` : ''} — ` : '';
    info.textContent = `${idx + 1}. #${o.orderNumber || '?'} — ${who}${o.label}`;

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '4px';
    btnRow.style.flexWrap = 'wrap';

    paymentMethodNames().forEach((method) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'danger small';
      btn.textContent = method;
      btn.addEventListener('click', () => {
        socket.emit('order:delivered', { id, paymentMethod: method });
        recomputeMyRoute();
      });
      btnRow.appendChild(btn);
    });

    li.appendChild(info);
    li.appendChild(btnRow);
    ordersListEl.appendChild(li);
  });
}

socket.on('orders:snapshot', (list) => { list.forEach((o) => myOrders.set(o.id, o)); renderOrders(); renderCashSummary(); });
socket.on('order:update', (o) => { myOrders.set(o.id, o); renderOrders(); renderCashSummary(); });
socket.on('order:remove', ({ id }) => { myOrders.delete(id); renderOrders(); renderCashSummary(); });

socket.on('routes:snapshot', (list) => { const mine = list.find((r) => r.driverId === driverId); if (mine) renderRoute(mine); });
socket.on('driver:route', (r) => { if (r.driverId === driverId) renderRoute(r); });

function renderRoute(r) {
  myRouteOrder = (r.stops || []).map((s) => s.id);
  renderOrders();
  updateRouteLineOnMap(r.latlngs);

  if (!r.stops || r.stops.length === 0) {
    mapsLinkEl.hidden = true;
    return;
  }
  if (r.distanceKm != null) {
    const distText = `${r.distanceKm.toFixed(1)} km`;
    const timeText = r.durationMin != null ? ` — ${Math.round(r.durationMin)} min` : '';
    routeSummaryEl.textContent = `${r.stops.length} pedido${r.stops.length === 1 ? '' : 's'} asignado${r.stops.length === 1 ? '' : 's'} — ${distText}${timeText}.`;
  }
  if (!lastPosition) {
    mapsLinkEl.hidden = true; // no GPS fix yet — a link would wrongly point from a stop to itself
    return;
  }
  mapsLinkEl.href = Geo.buildGoogleMapsUrl([lastPosition, ...r.stops], false);
  mapsLinkEl.hidden = false;
}

// Recomputes this driver's own optimal route from their remaining assigned
// pedidos. Normally the admin screen does this on assignment changes, but it
// might not be open when a delivery is marked done here, so the driver
// recomputes it themselves too — keeps the order (and the Maps link) current
// without depending on anyone else's tab being open.
async function recomputeMyRoute() {
  const assigned = Array.from(myOrders.values()).filter((o) => o.assignedTo === driverId && o.status !== 'entregado' && !o.archivedAt && o.lat != null);
  if (assigned.length === 0) {
    socket.emit('driver:route', { driverId, stops: [], latlngs: [] });
    return;
  }
  if (!lastPosition) return;

  const stops = assigned.map((o) => ({ id: o.id, lat: o.lat, lng: o.lng, label: o.label, orderNumber: o.orderNumber }));
  try {
    const result = await Geo.computeRoute(lastPosition, stops);
    const orderedStops = result.orderedPoints.slice(1).map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, label: p.label, orderNumber: p.orderNumber }));
    socket.emit('driver:route', {
      driverId,
      stops: orderedStops,
      latlngs: result.latlngs,
      distanceKm: result.distanceKm,
      durationMin: result.durationMin,
    });
  } catch (e) {
    // best-effort — if OSRM is briefly unreachable, the previous order stays displayed
  }
}

let lastPosition = null;

function sendPosition(pos) {
  lastPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  socket.emit('driver:update', {
    id: driverId,
    name: nameInput.value.trim() || 'Delivery',
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
  });
  updateDriverMarkerOnMap(pos.coords.latitude, pos.coords.longitude);
  const time = new Date().toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  setStatus(`Compartiendo ubicación — última actualización ${time}`, 'ok');
}

function startSharing() {
  if (!nameInput.value.trim()) {
    setStatus('Escribí tu nombre antes de empezar.', 'error');
    return;
  }
  if (!('geolocation' in navigator)) {
    setStatus('Este navegador no soporta geolocalización.', 'error');
    return;
  }
  if (!window.isSecureContext) {
    setStatus('Esta página necesita abrirse por HTTPS (o localhost) para compartir la ubicación.', 'error');
    return;
  }

  localStorage.setItem(DRIVER_NAME_KEY, nameInput.value.trim());

  // El botón/SHARING_KEY recién se confirman como "compartiendo" cuando
  // llega la primera posición real -- antes quedaban en ese estado apenas
  // se llamaba a watchPosition(), así que si el permiso estaba denegado (o
  // no había señal) el botón decía "Dejar de compartir" mientras el status
  // de abajo avisaba que había fallado -- estado contradictorio, y encima
  // SHARING_KEY quedaba guardado, así que la próxima vez que el delivery
  // abría la página reintentaba solo y volvía a fallar en silencio.
  let gotFirstFix = false;
  toggleBtn.disabled = true;
  toggleBtn.textContent = 'Buscando ubicación...';
  nameInput.disabled = true;
  setStatus('Buscando tu ubicación...');

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (!gotFirstFix) {
        gotFirstFix = true;
        localStorage.setItem(SHARING_KEY, '1');
        toggleBtn.disabled = false;
        toggleBtn.textContent = 'Dejar de compartir';
        toggleBtn.classList.remove('primary');
        toggleBtn.classList.add('danger');
      }
      sendPosition(pos);
    },
    (err) => {
      setStatus(`No se pudo obtener la ubicación: ${err.message}`, 'error');
      if (!gotFirstFix) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
        localStorage.removeItem(SHARING_KEY);
        toggleBtn.disabled = false;
        toggleBtn.textContent = 'Empezar a compartir ubicación';
        nameInput.disabled = false;
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function stopSharing() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  localStorage.removeItem(SHARING_KEY);
  socket.emit('driver:stop', { id: driverId });
  mapSectionEl.hidden = true;
  toggleBtn.textContent = 'Empezar a compartir ubicación';
  toggleBtn.classList.remove('danger');
  toggleBtn.classList.add('primary');
  nameInput.disabled = false;
  setStatus('Dejaste de compartir tu ubicación.');
}

toggleBtn.addEventListener('click', () => {
  if (watchId === null) startSharing();
  else stopSharing();
});

// Only an explicit "Dejar de compartir" click stops sharing. Closing the tab,
// losing signal, or the OS killing a backgrounded page does NOT — the driver
// just keeps showing at their last known position (the server drops them
// after 5 min with no update regardless) until they come back, at which point
// this resumes automatically without needing the button pressed again.
if (localStorage.getItem(SHARING_KEY) === '1' && localStorage.getItem(DRIVER_NAME_KEY)) {
  startSharing();
}

renderCashSummary();
