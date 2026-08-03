const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Everything below is in-memory only and resets on server restart — fine for
// a same-day MVP, would need a real datastore for anything longer-lived.

// driverId -> { name, lat, lng, updatedAt }
const drivers = new Map();
// orderId -> { orderNumber, lat, lng, label, assignedTo, status, amount, paymentMethod, updatedAt }
const orders = new Map();
// driverId -> { stops: [{id,lat,lng,label,orderNumber}], latlngs: [[lat,lng],...], distanceKm, durationMin, updatedAt }
const routes = new Map();
// driverId -> [{orderNumber, amount, paymentMethod, deliveredAt}] — running log for the
// cash reconciliation ("rendición de caja") view. Cleared only on server restart.
const deliveredLogs = new Map();

const STALE_MS = 5 * 60 * 1000; // a driver with no updates for 5 min is dropped as offline

const COLOR_PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];
const driverColors = new Map();
let nextColorIndex = 0;

function colorForDriver(id) {
  if (!driverColors.has(id)) {
    driverColors.set(id, COLOR_PALETTE[nextColorIndex % COLOR_PALETTE.length]);
    nextColorIndex++;
  }
  return driverColors.get(id);
}

function driverList() {
  return Array.from(drivers.entries()).map(([id, d]) => ({ id, ...d, color: colorForDriver(id) }));
}

function orderList() {
  return Array.from(orders.entries()).map(([id, o]) => ({ id, ...o }));
}

function routeList() {
  return Array.from(routes.entries()).map(([driverId, r]) => ({ driverId, ...r, color: colorForDriver(driverId) }));
}

function deliveredLogList() {
  return Array.from(deliveredLogs.entries()).map(([driverId, log]) => ({ driverId, log }));
}

function removeOrder(id) {
  if (!orders.has(id)) return;
  orders.delete(id);
  io.emit('order:remove', { id });
}

io.on('connection', (socket) => {
  socket.emit('drivers:snapshot', driverList());
  socket.emit('orders:snapshot', orderList());
  socket.emit('routes:snapshot', routeList());
  socket.emit('deliveredLogs:snapshot', deliveredLogList());

  socket.on('driver:update', ({ id, name, lat, lng }) => {
    if (!id || typeof lat !== 'number' || typeof lng !== 'number') return;
    const entry = { name: (name || id).slice(0, 40), lat, lng, updatedAt: Date.now() };
    drivers.set(id, entry);
    io.emit('driver:update', { id, ...entry, color: colorForDriver(id) });
  });

  socket.on('driver:stop', ({ id }) => {
    if (!id) return;
    drivers.delete(id);
    routes.delete(id);
    io.emit('driver:remove', { id });
    io.emit('route:remove', { driverId: id });
  });

  // Admin loaded and geocoded a pedido — make it visible to everyone (unassigned by default).
  socket.on('order:add', ({ orderNumber, lat, lng, label, amount, paymentMethod }) => {
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    const id = `o-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry = {
      orderNumber: (orderNumber || '').toString().slice(0, 20),
      lat, lng,
      label: (label || '').toString().slice(0, 200),
      assignedTo: null,
      status: 'pending',
      amount: typeof amount === 'number' ? amount : null,
      paymentMethod: (paymentMethod || '').toString().slice(0, 30),
      updatedAt: Date.now(),
    };
    orders.set(id, entry);
    io.emit('order:update', { id, ...entry });
  });

  socket.on('order:assign', ({ id, driverId }) => {
    const o = orders.get(id);
    if (!o) return;
    o.assignedTo = driverId || null;
    o.updatedAt = Date.now();
    io.emit('order:update', { id, ...o });
  });

  // Marking a pedido delivered logs it (amount + payment method) against the
  // driver it was assigned to, for the cash reconciliation view — a plain
  // admin removal (order:remove, e.g. fixing a mistake) does not.
  socket.on('order:delivered', ({ id }) => {
    const o = orders.get(id);
    if (o && o.assignedTo) {
      const entry = { orderNumber: o.orderNumber, amount: o.amount, paymentMethod: o.paymentMethod, deliveredAt: Date.now() };
      const log = deliveredLogs.get(o.assignedTo) || [];
      log.push(entry);
      deliveredLogs.set(o.assignedTo, log);
      io.emit('driver:delivered-log', { driverId: o.assignedTo, log });
    }
    removeOrder(id);
  });
  socket.on('order:remove', ({ id }) => removeOrder(id));

  // Manual reset of a driver's reconciliation log (e.g. after cashing them out).
  socket.on('driver:clear-log', ({ driverId }) => {
    if (!driverId) return;
    deliveredLogs.set(driverId, []);
    io.emit('driver:delivered-log', { driverId, log: [] });
  });

  // Admin (or, in principle, a driver's own device) computed a route for a
  // driver's currently-assigned pedidos and shares it so every connected
  // dashboard can draw it without each doing its own OSRM calls.
  socket.on('driver:route', ({ driverId, stops, latlngs, distanceKm, durationMin }) => {
    if (!driverId) return;
    const entry = { stops: stops || [], latlngs: latlngs || [], distanceKm: distanceKm || null, durationMin: durationMin || null, updatedAt: Date.now() };
    routes.set(driverId, entry);
    io.emit('driver:route', { driverId, ...entry, color: colorForDriver(driverId) });
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, d] of drivers) {
    if (now - d.updatedAt > STALE_MS) {
      drivers.delete(id);
      routes.delete(id);
      io.emit('driver:remove', { id });
      io.emit('route:remove', { driverId: id });
    }
  }
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tracking en vivo corriendo en http://localhost:${PORT}`);
  console.log(`Delivery: http://localhost:${PORT}/driver.html`);
  console.log(`Panel:    http://localhost:${PORT}/dashboard.html`);
});
