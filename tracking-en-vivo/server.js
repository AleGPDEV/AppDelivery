require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', 1);
app.use(express.json());

const SESSION_SECRET = process.env.SESSION_SECRET;
const COOKIE_NAME = 'admin_session';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Interruptor temporal: con DISABLE_AUTH=true en las variables de entorno,
// nadie necesita loguearse (páginas de admin abiertas, sockets tratados como
// admin). Para reactivar el login, sacar esa variable en Render — no hace
// falta tocar código ni volver a desplegar nada más que ese cambio de env var.
const AUTH_DISABLED = process.env.DISABLE_AUTH === 'true';

function getToken(req) {
  const cookies = cookie.parse(req.headers.cookie || '');
  return cookies[COOKIE_NAME];
}

function verifyToken(token) {
  if (!token) return null;
  try { return jwt.verify(token, SESSION_SECRET); } catch { return null; }
}

// Only these pages require login — driver.html (used by delivery people) and
// login.html itself stay public. The real security boundary is the socket
// handler checks below (socket.data.isAdmin), this is just so an anonymous
// visitor lands on the login screen instead of a blank admin page.
const PROTECTED_PAGES = ['/nuevo-pedido.html', '/pedidos.html', '/dashboard.html', '/caja.html'];

app.use((req, res, next) => {
  if (!AUTH_DISABLED && PROTECTED_PAGES.includes(req.path) && !verifyToken(getToken(req))) {
    return res.redirect('/login.html');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Falta usuario o contraseña.' });
  const { data } = await supabase.from('admin_users').select('*').eq('username', username).maybeSingle();
  const ok = data && await bcrypt.compare(password, data.password_hash);
  if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  const token = jwt.sign({ sub: data.id, username: data.username }, SESSION_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

app.post('/api/change-password', async (req, res) => {
  const payload = verifyToken(getToken(req));
  if (!payload) return res.status(401).json({ error: 'No autenticado.' });
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres.' });
  const { data } = await supabase.from('admin_users').select('*').eq('id', payload.sub).maybeSingle();
  const ok = data && await bcrypt.compare(currentPassword || '', data.password_hash);
  if (!ok) return res.status(401).json({ error: 'La contraseña actual no coincide.' });
  const hash = await bcrypt.hash(newPassword, 10);
  await supabase.from('admin_users').update({ password_hash: hash }).eq('id', data.id);
  res.json({ ok: true });
});

// Everything below except `orders` and `formConfig` is in-memory only.
// Driver GPS pings are too frequent/low-value to persist; orders (and the
// admin/form-config tables above) live in Supabase so a Render redeploy
// doesn't wipe the day's registry.

// driverId -> { name, lat, lng, updatedAt }
const drivers = new Map();
// orderId -> { orderNumber, phone, name, lat, lng, label, assignedTo, status, amount, paymentMethod, reconciledAt, updatedAt }
const orders = new Map();
// driverId -> { stops: [{id,lat,lng,label,orderNumber}], latlngs: [[lat,lng],...], distanceKm, durationMin, updatedAt }
const routes = new Map();

let formConfig = {
  phone: { visible: true, required: true },
  name: { visible: true, required: false },
  orderNumber: { visible: true, required: true },
  location: { visible: true, required: false },
  amount: { visible: true, required: true },
  // Campos que el admin agrega él mismo (además de los 5 de arriba):
  // [{ key, label, visible, required }], en el orden en que los creó.
  customFields: [],
};

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

function orderRow(id, o) {
  return {
    id,
    order_number: o.orderNumber || null,
    phone: o.phone || null,
    name: o.name || null,
    lat: o.lat,
    lng: o.lng,
    label: o.label || null,
    assigned_to: o.assignedTo || null,
    status: o.status,
    amount: o.amount,
    payment_method: o.paymentMethod || null,
    reconciled_at: o.reconciledAt ? new Date(o.reconciledAt).toISOString() : null,
    updated_at: new Date(o.updatedAt).toISOString(),
    custom: o.custom || {},
  };
}

// Los campos personalizados que el admin crea en "Personalizar campos del
// formulario" (además de los 5 fijos) no tienen columna propia — se guardan
// acá como texto libre. Se acota tamaño/cantidad para que un cliente mal
// intencionado no pueda inflar el JSON indefinidamente.
function sanitizeCustom(custom) {
  const out = {};
  if (!custom || typeof custom !== 'object') return out;
  Object.keys(custom).slice(0, 20).forEach((key) => {
    if (typeof key === 'string' && key.length <= 60) {
      out[key] = (custom[key] || '').toString().slice(0, 200);
    }
  });
  return out;
}

// Fire-and-forget: the in-memory Map + socket broadcast is what makes the UI
// feel instant, Supabase just needs to end up consistent shortly after.
function persistOrder(id, o) {
  supabase.from('orders').upsert(orderRow(id, o)).then(({ error }) => {
    if (error) console.error('Error guardando pedido en Supabase:', error.message);
  });
}

function persistOrderDelete(id) {
  supabase.from('orders').delete().eq('id', id).then(({ error }) => {
    if (error) console.error('Error borrando pedido en Supabase:', error.message);
  });
}

function removeOrder(id) {
  if (!orders.has(id)) return;
  orders.delete(id);
  persistOrderDelete(id);
  io.emit('order:remove', { id });
}

async function loadOrders() {
  const { data, error } = await supabase.from('orders').select('*');
  if (error) { console.error('Error cargando pedidos de Supabase:', error.message); return; }
  data.forEach((row) => {
    orders.set(row.id, {
      orderNumber: row.order_number,
      phone: row.phone,
      name: row.name,
      lat: row.lat,
      lng: row.lng,
      label: row.label,
      assignedTo: row.assigned_to,
      status: row.status,
      amount: row.amount,
      paymentMethod: row.payment_method,
      reconciledAt: row.reconciled_at ? new Date(row.reconciled_at).getTime() : null,
      updatedAt: new Date(row.updated_at).getTime(),
      custom: row.custom || {},
    });
  });
  console.log(`Pedidos cargados desde Supabase: ${orders.size}`);
}

async function loadFormConfig() {
  const { data, error } = await supabase.from('form_config').select('fields').eq('id', 1).maybeSingle();
  if (!error && data && data.fields) formConfig = data.fields;
  // Config guardada antes de que existieran los campos personalizados no
  // tiene esta clave — se completa acá en vez de forzar otra migración.
  if (!Array.isArray(formConfig.customFields)) formConfig.customFields = [];
}

async function bootstrapAdmin() {
  const { count, error } = await supabase.from('admin_users').select('*', { count: 'exact', head: true });
  if (error) { console.error('Error revisando admin_users en Supabase:', error.message); return; }
  if (count > 0) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password) { console.warn('ADMIN_PASSWORD no está seteada — no se creó ningún admin.'); return; }
  const hash = await bcrypt.hash(password, 10);
  await supabase.from('admin_users').insert({ username, password_hash: hash });
  console.log(`Admin inicial creado: ${username}`);
}

io.use((socket, next) => {
  const cookies = cookie.parse(socket.handshake.headers.cookie || '');
  socket.data.isAdmin = AUTH_DISABLED || !!verifyToken(cookies[COOKIE_NAME]);
  next();
});

io.on('connection', (socket) => {
  socket.emit('drivers:snapshot', driverList());
  socket.emit('orders:snapshot', orderList());
  socket.emit('routes:snapshot', routeList());
  socket.emit('form-config:snapshot', formConfig);

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

  // Admin agendó un pedido (individual o carga masiva) — visible para todos,
  // sin asignar salvo que ya se haya elegido un delivery. `lat`/`lng` son
  // opcionales: un pedido que retira en el local no tiene ubicación.
  // `id` lo genera el cliente (igual que el driverId) para poder asignarlo
  // en el mismo tick sin esperar una confirmación del servidor.
  socket.on('order:add', ({ id, orderNumber, phone, name, lat, lng, label, amount, paymentMethod, custom }) => {
    if (!socket.data.isAdmin || !id) return;
    const hasLocation = typeof lat === 'number' && typeof lng === 'number';
    const entry = {
      orderNumber: (orderNumber || '').toString().slice(0, 20),
      phone: (phone || '').toString().slice(0, 30),
      name: (name || '').toString().slice(0, 60),
      lat: hasLocation ? lat : null,
      lng: hasLocation ? lng : null,
      label: (label || (hasLocation ? '' : 'Retira en el local')).toString().slice(0, 200),
      assignedTo: null,
      status: 'pending',
      amount: typeof amount === 'number' ? amount : null,
      paymentMethod: (paymentMethod || '').toString().slice(0, 30),
      reconciledAt: null,
      updatedAt: Date.now(),
      custom: sanitizeCustom(custom),
    };
    orders.set(id, entry);
    persistOrder(id, entry);
    io.emit('order:update', { id, ...entry });
  });

  // Assigning/unassigning auto-moves the status between "en preparación" and
  // "en camino" (unless it's already "entregado" — delivered stays delivered).
  // The admin can still override the status by hand from the registry table.
  socket.on('order:assign', ({ id, driverId }) => {
    if (!socket.data.isAdmin) return;
    const o = orders.get(id);
    if (!o) return;
    o.assignedTo = driverId || null;
    if (o.status !== 'entregado') o.status = driverId ? 'en_camino' : 'pending';
    o.updatedAt = Date.now();
    persistOrder(id, o);
    io.emit('order:update', { id, ...o });
  });

  // Admin editing a cell directly in the registry table (forma de pago o estado).
  socket.on('order:edit', ({ id, fields }) => {
    if (!socket.data.isAdmin) return;
    const o = orders.get(id);
    if (!o || !fields) return;
    if (typeof fields.status === 'string') o.status = fields.status.slice(0, 20);
    if (typeof fields.paymentMethod === 'string') o.paymentMethod = fields.paymentMethod.slice(0, 30);
    o.updatedAt = Date.now();
    persistOrder(id, o);
    io.emit('order:update', { id, ...o });
  });

  // Marking a pedido delivered (driver.html, no admin session) does NOT
  // delete it — it stays in the registry with status "entregado" so the
  // day's full order history stays visible; only order:remove (admin fixing
  // a mistaken entry) actually deletes it. `paymentMethod` is chosen by the
  // driver at the moment of delivery (how the customer actually paid),
  // overriding whatever expected value the order was created/edited with.
  socket.on('order:delivered', ({ id, paymentMethod }) => {
    const o = orders.get(id);
    if (!o) return;
    o.status = 'entregado';
    if (paymentMethod) o.paymentMethod = paymentMethod;
    o.updatedAt = Date.now();
    persistOrder(id, o);
    io.emit('order:update', { id, ...o });
  });
  socket.on('order:remove', ({ id }) => {
    if (!socket.data.isAdmin) return;
    removeOrder(id);
  });

  // "Cerrar rendición": marca como conciliados los pedidos entregados de ese
  // delivery hasta ahora (no los borra ni pierde el historial — caja.js
  // simplemente deja de sumarlos en el total "pendiente de rendir").
  socket.on('driver:clear-log', ({ driverId }) => {
    if (!socket.data.isAdmin || !driverId) return;
    const now = Date.now();
    orders.forEach((o, id) => {
      if (o.assignedTo === driverId && o.status === 'entregado' && !o.reconciledAt) {
        o.reconciledAt = now;
        o.updatedAt = now;
        persistOrder(id, o);
        io.emit('order:update', { id, ...o });
      }
    });
  });

  // Admin (o, en principio, el propio celular del delivery) calculó una ruta
  // para los pedidos actualmente asignados y la comparte para que cualquier
  // pantalla conectada la dibuje sin repetir la llamada a OSRM.
  socket.on('driver:route', ({ driverId, stops, latlngs, distanceKm, durationMin }) => {
    if (!driverId) return;
    const entry = { stops: stops || [], latlngs: latlngs || [], distanceKm: distanceKm || null, durationMin: durationMin || null, updatedAt: Date.now() };
    routes.set(driverId, entry);
    io.emit('driver:route', { driverId, ...entry, color: colorForDriver(driverId) });
  });

  // El admin personaliza qué campos se muestran/exigen en "Nuevo pedido".
  socket.on('form-config:update', (fields) => {
    if (!socket.data.isAdmin || !fields) return;
    formConfig = fields;
    supabase.from('form_config').update({ fields, updated_at: new Date().toISOString() }).eq('id', 1).then(({ error }) => {
      if (error) console.error('Error guardando la configuración de campos en Supabase:', error.message);
    });
    io.emit('form-config:snapshot', formConfig);
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

async function start() {
  await bootstrapAdmin();
  await loadFormConfig();
  await loadOrders();
  server.listen(PORT, () => {
    console.log(`Tracking en vivo corriendo en http://localhost:${PORT}`);
    console.log(`Login:         http://localhost:${PORT}/login.html`);
    console.log(`Delivery:      http://localhost:${PORT}/driver.html`);
    console.log(`Nuevo pedido:  http://localhost:${PORT}/nuevo-pedido.html`);
    console.log(`Pedidos:       http://localhost:${PORT}/pedidos.html`);
    console.log(`Mapa:          http://localhost:${PORT}/dashboard.html`);
    console.log(`Rendición:     http://localhost:${PORT}/caja.html`);
  });
}

start();
