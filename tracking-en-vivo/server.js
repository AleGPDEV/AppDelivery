const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory only: driverId -> { name, lat, lng, updatedAt }. Resets on server restart.
const drivers = new Map();

const STALE_MS = 5 * 60 * 1000; // a driver with no updates for 5 min is dropped as offline

function driverList() {
  return Array.from(drivers.entries()).map(([id, d]) => ({ id, ...d }));
}

io.on('connection', (socket) => {
  socket.emit('drivers:snapshot', driverList());

  socket.on('driver:update', ({ id, name, lat, lng }) => {
    if (!id || typeof lat !== 'number' || typeof lng !== 'number') return;
    const entry = { name: (name || id).slice(0, 40), lat, lng, updatedAt: Date.now() };
    drivers.set(id, entry);
    io.emit('driver:update', { id, ...entry });
  });

  socket.on('driver:stop', ({ id }) => {
    if (!id) return;
    drivers.delete(id);
    io.emit('driver:remove', { id });
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, d] of drivers) {
    if (now - d.updatedAt > STALE_MS) {
      drivers.delete(id);
      io.emit('driver:remove', { id });
    }
  }
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tracking en vivo corriendo en http://localhost:${PORT}`);
  console.log(`Delivery: http://localhost:${PORT}/driver.html`);
  console.log(`Panel:    http://localhost:${PORT}/dashboard.html`);
});
