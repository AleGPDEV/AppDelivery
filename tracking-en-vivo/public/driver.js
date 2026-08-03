const nameInput = document.getElementById('driver-name');
const toggleBtn = document.getElementById('toggle-btn');
const statusEl = document.getElementById('status');
const ordersSectionEl = document.getElementById('orders-section');
const ordersListEl = document.getElementById('orders-list');
const routeSummaryEl = document.getElementById('route-summary');
const mapsLinkEl = document.getElementById('maps-link');

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

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` ${kind}` : ''}`;
}

function renderOrders() {
  const mine = Array.from(myOrders.entries()).filter(([, o]) => o.assignedTo === driverId && o.status !== 'entregado');
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

    ['Efectivo', 'Transferencia', 'Débito'].forEach((method) => {
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

socket.on('orders:snapshot', (list) => { list.forEach((o) => myOrders.set(o.id, o)); renderOrders(); });
socket.on('order:update', (o) => { myOrders.set(o.id, o); renderOrders(); });
socket.on('order:remove', ({ id }) => { myOrders.delete(id); renderOrders(); });

socket.on('routes:snapshot', (list) => { const mine = list.find((r) => r.driverId === driverId); if (mine) renderRoute(mine); });
socket.on('driver:route', (r) => { if (r.driverId === driverId) renderRoute(r); });

function renderRoute(r) {
  myRouteOrder = (r.stops || []).map((s) => s.id);
  renderOrders();

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
  const assigned = Array.from(myOrders.values()).filter((o) => o.assignedTo === driverId && o.status !== 'entregado' && o.lat != null);
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
  localStorage.setItem(SHARING_KEY, '1');

  watchId = navigator.geolocation.watchPosition(
    sendPosition,
    (err) => setStatus(`No se pudo obtener la ubicación: ${err.message}`, 'error'),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );

  toggleBtn.textContent = 'Dejar de compartir';
  toggleBtn.classList.remove('primary');
  toggleBtn.classList.add('danger');
  nameInput.disabled = true;
  setStatus('Buscando tu ubicación...');
}

function stopSharing() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  localStorage.removeItem(SHARING_KEY);
  socket.emit('driver:stop', { id: driverId });
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
