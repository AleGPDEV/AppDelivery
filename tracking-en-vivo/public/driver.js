const nameInput = document.getElementById('driver-name');
const toggleBtn = document.getElementById('toggle-btn');
const statusEl = document.getElementById('status');

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

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` ${kind}` : ''}`;
}

function sendPosition(pos) {
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
