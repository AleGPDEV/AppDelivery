const driverCountEl = document.getElementById('driver-count');

const map = L.map('map').setView([-34.9011, -56.1645], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

// driverId -> { marker, name, lat, lng, updatedAt }
const drivers = new Map();
let hasFitBounds = false;

function timeAgo(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `hace ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `hace ${minutes} min`;
}

function popupText(d) {
  return `<strong>${d.name}</strong><br>${timeAgo(d.updatedAt)}`;
}

function upsertDriver(d) {
  const existing = drivers.get(d.id);
  if (existing) {
    existing.name = d.name;
    existing.lat = d.lat;
    existing.lng = d.lng;
    existing.updatedAt = d.updatedAt;
    existing.marker.setLatLng([d.lat, d.lng]);
    existing.marker.setPopupContent(popupText(existing));
  } else {
    const marker = L.marker([d.lat, d.lng]).addTo(map).bindPopup(popupText(d));
    drivers.set(d.id, { name: d.name, lat: d.lat, lng: d.lng, updatedAt: d.updatedAt, marker });
    fitBoundsToDrivers();
  }
  updateCount();
}

function removeDriver(id) {
  const existing = drivers.get(id);
  if (existing) {
    map.removeLayer(existing.marker);
    drivers.delete(id);
  }
  updateCount();
}

function fitBoundsToDrivers() {
  if (drivers.size === 0) return;
  const bounds = L.latLngBounds(Array.from(drivers.values()).map(d => [d.lat, d.lng]));
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  hasFitBounds = true;
}

function updateCount() {
  driverCountEl.textContent = drivers.size === 0
    ? 'Ningún delivery está compartiendo su ubicación ahora mismo.'
    : `${drivers.size} delivery${drivers.size === 1 ? '' : 's'} en línea.`;
}

// Refresh the "hace Xs/min" labels even without new position updates.
setInterval(() => {
  drivers.forEach((d) => d.marker.setPopupContent(popupText(d)));
}, 5000);

const socket = io();

socket.on('drivers:snapshot', (list) => {
  list.forEach(upsertDriver);
  if (!hasFitBounds) fitBoundsToDrivers();
});

socket.on('driver:update', upsertDriver);
socket.on('driver:remove', ({ id }) => removeDriver(id));
