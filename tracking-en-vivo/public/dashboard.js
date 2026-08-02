const driverCountEl = document.getElementById('driver-count');

const map = L.map('map').setView([-34.9011, -56.1645], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const UNASSIGNED_COLOR = '#9aa1ac';

function driverIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div class="pin driver-pin" style="background:${color}">🛵</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16],
  });
}

function orderIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div class="pin order-pin" style="background:${color}">📦</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -13],
  });
}

// id -> { marker, name/label, ... }
const drivers = new Map();
const orders = new Map();
const routeLines = new Map(); // driverId -> L.Polyline
let hasFitBounds = false;

function timeAgo(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `hace ${seconds}s`;
  return `hace ${Math.round(seconds / 60)} min`;
}

function driverPopup(d) {
  return `<strong>${d.name}</strong><br>${timeAgo(d.updatedAt)}`;
}

function orderPopup(o) {
  const assignedText = o.assignedTo && drivers.has(o.assignedTo)
    ? `Asignado a ${drivers.get(o.assignedTo).name}`
    : 'Sin asignar';
  return `<strong>Pedido #${o.orderNumber || '?'}</strong><br>${o.label}<br>${assignedText}`;
}

function orderColor(o) {
  return (o.assignedTo && drivers.has(o.assignedTo)) ? drivers.get(o.assignedTo).color : UNASSIGNED_COLOR;
}

function upsertDriver(d) {
  const existing = drivers.get(d.id);
  if (existing) {
    Object.assign(existing, d);
    existing.marker.setLatLng([d.lat, d.lng]);
    existing.marker.setIcon(driverIcon(d.color));
    existing.marker.setPopupContent(driverPopup(existing));
  } else {
    const marker = L.marker([d.lat, d.lng], { icon: driverIcon(d.color) }).addTo(map).bindPopup(driverPopup(d));
    drivers.set(d.id, { ...d, marker });
    fitBoundsToEverything();
  }
  updateCount();
  refreshOrderColorsFor(d.id);
}

function removeDriver(id) {
  const existing = drivers.get(id);
  if (existing) {
    map.removeLayer(existing.marker);
    drivers.delete(id);
  }
  const line = routeLines.get(id);
  if (line) { map.removeLayer(line); routeLines.delete(id); }
  updateCount();
}

function refreshOrderColorsFor(driverId) {
  orders.forEach((o) => {
    if (o.assignedTo === driverId) {
      o.marker.setIcon(orderIcon(orderColor(o)));
      o.marker.setPopupContent(orderPopup(o));
    }
  });
}

function upsertOrder(o) {
  const existing = orders.get(o.id);
  const color = orderColor(o);
  if (existing) {
    Object.assign(existing, o);
    existing.marker.setLatLng([o.lat, o.lng]);
    existing.marker.setIcon(orderIcon(color));
    existing.marker.setPopupContent(orderPopup(existing));
  } else {
    const marker = L.marker([o.lat, o.lng], { icon: orderIcon(color) }).addTo(map).bindPopup(orderPopup(o));
    orders.set(o.id, { ...o, marker });
    fitBoundsToEverything();
  }
}

function removeOrderPin(id) {
  const existing = orders.get(id);
  if (existing) {
    map.removeLayer(existing.marker);
    orders.delete(id);
  }
}

function upsertRoute(r) {
  const existing = routeLines.get(r.driverId);
  if (existing) map.removeLayer(existing);
  if (!r.latlngs || r.latlngs.length < 2) {
    routeLines.delete(r.driverId);
    return;
  }
  const line = L.polyline(r.latlngs, { color: r.color, weight: 4, opacity: 0.8 }).addTo(map);
  routeLines.set(r.driverId, line);
}

function removeRoute(driverId) {
  const line = routeLines.get(driverId);
  if (line) { map.removeLayer(line); routeLines.delete(driverId); }
}

function fitBoundsToEverything() {
  const points = [
    ...Array.from(drivers.values()).map(d => [d.lat, d.lng]),
    ...Array.from(orders.values()).map(o => [o.lat, o.lng]),
  ];
  if (points.length === 0) return;
  map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 15 });
  hasFitBounds = true;
}

function updateCount() {
  driverCountEl.textContent = drivers.size === 0
    ? 'Ningún delivery está compartiendo su ubicación ahora mismo.'
    : `${drivers.size} delivery${drivers.size === 1 ? '' : 's'} en línea.`;
}

setInterval(() => {
  drivers.forEach((d) => d.marker.setPopupContent(driverPopup(d)));
}, 5000);

const socket = io();

socket.on('drivers:snapshot', (list) => { list.forEach(upsertDriver); if (!hasFitBounds) fitBoundsToEverything(); });
socket.on('driver:update', upsertDriver);
socket.on('driver:remove', ({ id }) => removeDriver(id));

socket.on('orders:snapshot', (list) => { list.forEach(upsertOrder); if (!hasFitBounds) fitBoundsToEverything(); });
socket.on('order:update', upsertOrder);
socket.on('order:remove', ({ id }) => removeOrderPin(id));

socket.on('routes:snapshot', (list) => list.forEach(upsertRoute));
socket.on('driver:route', upsertRoute);
socket.on('route:remove', ({ driverId }) => removeRoute(driverId));
