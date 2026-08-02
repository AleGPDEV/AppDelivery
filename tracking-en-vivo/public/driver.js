const nameInput = document.getElementById('driver-name');
const toggleBtn = document.getElementById('toggle-btn');
const statusEl = document.getElementById('status');
const ordersSectionEl = document.getElementById('orders-section');
const ordersListEl = document.getElementById('orders-list');
const routeSummaryEl = document.getElementById('route-summary');
const mapsLinkEl = document.getElementById('maps-link');

const DRIVER_ID_KEY = 'tracking.driverId';
const DRIVER_NAME_KEY = 'tracking.driverName';

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

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` ${kind}` : ''}`;
}

function renderOrders() {
  const mine = Array.from(myOrders.entries()).filter(([, o]) => o.assignedTo === driverId);
  ordersSectionEl.hidden = mine.length === 0;
  if (mine.length === 0) return;

  routeSummaryEl.textContent = `${mine.length} pedido${mine.length === 1 ? '' : 's'} asignado${mine.length === 1 ? '' : 's'}.`;

  ordersListEl.innerHTML = '';
  mine.forEach(([id, o]) => {
    const li = document.createElement('li');
    const info = document.createElement('span');
    info.className = 'order-info';
    info.textContent = `#${o.orderNumber || '?'} — ${o.label}`;
    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'danger small';
    doneBtn.textContent = 'Entregado';
    doneBtn.addEventListener('click', () => socket.emit('order:delivered', { id }));
    li.appendChild(info);
    li.appendChild(doneBtn);
    ordersListEl.appendChild(li);
  });
}

socket.on('orders:snapshot', (list) => { list.forEach((o) => myOrders.set(o.id, o)); renderOrders(); });
socket.on('order:update', (o) => { myOrders.set(o.id, o); renderOrders(); });
socket.on('order:remove', ({ id }) => { myOrders.delete(id); renderOrders(); });

socket.on('routes:snapshot', (list) => { const mine = list.find((r) => r.driverId === driverId); if (mine) renderRoute(mine); });
socket.on('driver:route', (r) => { if (r.driverId === driverId) renderRoute(r); });

function renderRoute(r) {
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

window.addEventListener('beforeunload', () => {
  if (watchId !== null) socket.emit('driver:stop', { id: driverId });
});
