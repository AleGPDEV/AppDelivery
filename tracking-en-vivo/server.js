require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const path = require('path');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const ExcelJS = require('exceljs');
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
const PROTECTED_PAGES = ['/pedidos.html', '/dashboard.html', '/analiticas.html', '/catalogo.html', '/proveedores.html'];

app.use((req, res, next) => {
  if (!AUTH_DISABLED && PROTECTED_PAGES.includes(req.path) && !verifyToken(getToken(req))) {
    return res.redirect('/login.html');
  }
  next();
});

// Same check as the page gate above, but for the plain HTTP endpoints below
// (business-day start/end/history) — those aren't Socket.IO events so they
// need their own auth check instead of `socket.data.isAdmin`.
function requireAuth(req, res, next) {
  if (AUTH_DISABLED || verifyToken(getToken(req))) return next();
  res.status(401).json({ error: 'No autenticado.' });
}

// Las 7 páginas de admin son ahora una SPA: todas sirven el mismo shell
// (nav/header una sola vez, ruteo del lado del cliente entre vistas, un
// solo socket compartido — ver public/js/store.js y public/js/router.js).
// Va antes de express.static para interceptar esas 7 rutas exactas; el
// gate de auth de arriba ya corrió, así que acá solo llegan pedidos
// autenticados (o cualquiera si AUTH_DISABLED).
app.get(PROTECTED_PAGES, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-shell.html'));
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
// orderId -> { seq, orderNumber, phone, name, lat, lng, label, assignedTo, status, amount, paymentMethod, reconciledAt, updatedAt }
const orders = new Map();
// Número de ticket, único y creciente, asignado por el servidor — a
// diferencia de "Nº de pedido" (lo tipea el admin, se puede repetir a
// propósito), esto es lo único que diferencia dos pedidos con total
// seguridad. Se calcula al arrancar como el mayor `seq` ya guardado + 1
// (ver loadOrders) para no repetir números aunque el servidor se reinicie.
let nextSeq = 1;
// driverId -> { stops: [{id,lat,lng,label,orderNumber}], latlngs: [[lat,lng],...], distanceKm, durationMin, updatedAt }
const routes = new Map();
// driverId -> number — el efectivo con el que salió ese delivery, lo carga el
// admin desde la tarjeta de rendición en dashboard.html y driver.html solo
// lo muestra (de solo lectura ahí).
// Cacheado en memoria (como drivers/routes) pero SÍ persistido en Supabase
// (tabla driver_cash_starts) — antes era solo memoria, y un reinicio del
// server (Render duerme el free tier tras 15 min sin tráfico) lo borraba en
// silencio a mitad de turno sin que nadie se diera cuenta. No es un
// registro histórico de verdad (el "Debe entregar" ya queda fijo en
// business_days al cerrar el día) — es más un "no perder lo que ya se
// cargó hoy" ante un restart.
const driverCashStarts = new Map();

function persistDriverCashStart(driverId, amount) {
  supabase.from('driver_cash_starts').upsert({ driver_id: driverId, amount, updated_at: new Date().toISOString() }).then(({ error }) => {
    if (error) console.error('Error guardando efectivo inicial del delivery en Supabase:', error.message);
  });
}

async function loadDriverCashStarts() {
  const { data, error } = await supabase.from('driver_cash_starts').select('driver_id, amount');
  if (error) { console.error('Error cargando efectivo inicial de deliverys de Supabase:', error.message); return; }
  data.forEach((row) => driverCashStarts.set(row.driver_id, row.amount));
  console.log(`Efectivo inicial de deliverys cargado desde Supabase: ${driverCashStarts.size}`);
}
// socket.id -> timestamp del último pedido web aceptado, para frenar spam
// sin agregar ninguna librería de rate-limiting — mismo criterio "resolvelo
// con un Map" que el resto de este archivo.
const webOrderCooldown = new Map();
const WEB_ORDER_COOLDOWN_MS = 15000;

// categoryId -> { name, sortOrder, visible }
const categories = new Map();
// productId -> { categoryId, name, description, price, imageUrl, sortOrder, visible }
const products = new Map();
// expenseId -> { description, amount, paymentMethodId, paymentMethodName,
// paymentMethodIsCash, businessDayId, createdAt } — pagos a proveedores
// (reemplaza al viejo "Gastos" de caja.js, que era solo del navegador y
// nunca llegaba al servidor). `paymentMethodName`/`paymentMethodIsCash`
// quedan "congelados" al cargar el gasto, igual que `items.name`/`price` en
// los pedidos, para que el cierre de día no cambie si después se edita o
// borra ese método de pago.
const expenses = new Map();

// "Tipo de envío" (retira/envía) es el único campo realmente fijo — siempre
// obligatorio, no vive acá (ver order:add/order:web-add y
// nuevo-pedido.js/pedido-cliente.js). `phone`/`name`/`orderNumber`/`amount`
// SÍ son personalizables de nuevo desde Ajustes (mostrar/ocultar y marcar
// obligatorio), igual que un campo personalizado — con una excepción: el
// pedido online (pedido-cliente.js/order:web-add) exige el teléfono siempre,
// sin importar este valor, porque ahí no hay otra forma de contactar a un
// cliente anónimo. Para carga manual del admin sí se puede relajar (ej. un
// cliente conocido de cuenta corriente).
let formConfig = {
  phone: { visible: true, required: true },
  name: { visible: true, required: false },
  orderNumber: { visible: true, required: true },
  amount: { visible: true, required: true },
  // Lo único realmente agregable/editable desde Ajustes: la lista de formas
  // en que puede salir/entrar plata. `isCash` marca si ese método representa
  // efectivo físico en la caja (afecta el cálculo de "Total a entregar" y el
  // cierre de día) — Efectivo por defecto es el único marcado así.
  paymentMethods: [
    { id: 'efectivo', name: 'Efectivo', isCash: true },
    { id: 'transferencia', name: 'Transferencia', isCash: false },
    { id: 'debito', name: 'Débito', isCash: false },
  ],
  // Campos que el admin agrega él mismo (además de los de arriba):
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

function cashStartList() {
  return Array.from(driverCashStarts.entries()).map(([driverId, amount]) => ({ driverId, amount }));
}

function categoryList() {
  return Array.from(categories.entries())
    .map(([id, c]) => ({ id, ...c }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function productList() {
  return Array.from(products.entries())
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function catalogSnapshot() {
  return { categories: categoryList(), products: productList() };
}

function categoryRow(id, c) {
  return { id, name: c.name, sort_order: c.sortOrder, visible: c.visible, image_url: c.imageUrl || null };
}

function productRow(id, p) {
  return {
    id,
    category_id: p.categoryId,
    name: p.name,
    description: p.description || null,
    price: p.price,
    image_url: p.imageUrl || null,
    sort_order: p.sortOrder,
    visible: p.visible,
  };
}

function persistCategory(id, c) {
  supabase.from('categories').upsert(categoryRow(id, c)).then(({ error }) => {
    if (error) console.error('Error guardando categoría en Supabase:', error.message);
  });
}

function persistProduct(id, p) {
  supabase.from('products').upsert(productRow(id, p)).then(({ error }) => {
    if (error) console.error('Error guardando producto en Supabase:', error.message);
  });
}

// Solo se muestran/mandan los gastos del día abierto actual — el historial
// completo se conserva igual en Supabase por si algún día hace falta
// consultarlo, pero no hay pantalla para eso todavía.
function expenseList() {
  return Array.from(expenses.entries())
    .filter(([, e]) => e.businessDayId === (openBusinessDay && openBusinessDay.id))
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function expenseRow(id, e) {
  return {
    id,
    description: e.description,
    amount: e.amount,
    payment_method_id: e.paymentMethodId || null,
    payment_method_name: e.paymentMethodName || null,
    payment_method_is_cash: !!e.paymentMethodIsCash,
    business_day_id: e.businessDayId || null,
    created_at: new Date(e.createdAt).toISOString(),
    driver_id: e.driverId || null,
  };
}

function persistExpense(id, e) {
  supabase.from('expenses').upsert(expenseRow(id, e)).then(({ error }) => {
    if (error) console.error('Error guardando gasto en Supabase:', error.message);
  });
}

async function loadExpenses() {
  const { data, error } = await supabase.from('expenses').select('*');
  if (error) { console.error('Error cargando gastos de Supabase:', error.message); return; }
  data.forEach((row) => {
    expenses.set(row.id, {
      description: row.description,
      amount: row.amount,
      paymentMethodId: row.payment_method_id,
      paymentMethodName: row.payment_method_name,
      paymentMethodIsCash: row.payment_method_is_cash,
      businessDayId: row.business_day_id,
      createdAt: new Date(row.created_at).getTime(),
      driverId: row.driver_id || null,
    });
  });
  console.log(`Gastos cargados desde Supabase: ${expenses.size}`);
}

async function loadCatalog() {
  const { data: catRows, error: catError } = await supabase.from('categories').select('*');
  if (catError) { console.error('Error cargando categorías de Supabase:', catError.message); return; }
  catRows.forEach((row) => {
    categories.set(row.id, { name: row.name, sortOrder: row.sort_order, visible: row.visible, imageUrl: row.image_url || null });
  });

  const { data: prodRows, error: prodError } = await supabase.from('products').select('*');
  if (prodError) { console.error('Error cargando productos de Supabase:', prodError.message); return; }
  prodRows.forEach((row) => {
    products.set(row.id, {
      categoryId: row.category_id,
      name: row.name,
      description: row.description,
      price: row.price,
      imageUrl: row.image_url,
      sortOrder: row.sort_order,
      visible: row.visible,
    });
  });
  console.log(`Catálogo cargado desde Supabase: ${categories.size} categorías, ${products.size} productos`);
}

function orderRow(id, o) {
  return {
    id,
    seq: o.seq,
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
    archived_at: o.archivedAt ? new Date(o.archivedAt).toISOString() : null,
    updated_at: new Date(o.updatedAt).toISOString(),
    custom: o.custom || {},
    source: o.source || 'admin',
    items: o.items || [],
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
    if (typeof row.seq === 'number' && row.seq >= nextSeq) nextSeq = row.seq + 1;
    orders.set(row.id, {
      seq: row.seq,
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
      archivedAt: row.archived_at ? new Date(row.archived_at).getTime() : null,
      updatedAt: new Date(row.updated_at).getTime(),
      custom: row.custom || {},
      source: row.source || 'admin',
      items: row.items || [],
    });
  });
  console.log(`Pedidos cargados desde Supabase: ${orders.size}`);
}

// Completa los defaults de una config parcial/vieja (guardada antes de que
// existiera tal o cual clave) — función pura, sin tocar el `formConfig` del
// módulo, así se puede testear con cualquier objeto de entrada sin depender
// de Supabase ni de estado global. `loadFormConfig()` es la única que la usa
// contra el `formConfig` real.
function normalizeFormConfig(fields) {
  const cfg = fields && typeof fields === 'object' ? { ...fields } : {};
  // Config guardada antes de que existieran los campos personalizados no
  // tiene esta clave.
  if (!Array.isArray(cfg.customFields)) cfg.customFields = [];
  // Ídem para configuraciones guardadas antes de que existiera la lista de
  // métodos de pago.
  if (!Array.isArray(cfg.paymentMethods)) {
    cfg.paymentMethods = [
      { id: 'efectivo', name: 'Efectivo', isCash: true },
      { id: 'transferencia', name: 'Transferencia', isCash: false },
      { id: 'debito', name: 'Débito', isCash: false },
    ];
  }
  // Ídem para phone/name/orderNumber/amount — volvieron a ser personalizables,
  // así que necesitan un default sensato si la config guardada no los trae.
  // Este es exactamente el bug que hubo que arreglar a mano en Supabase una
  // vez (ver DOCUMENTACION.md 3.4) — de ahí que esté cubierto por un test.
  if (!cfg.phone) cfg.phone = { visible: true, required: true };
  if (!cfg.name) cfg.name = { visible: true, required: false };
  if (!cfg.orderNumber) cfg.orderNumber = { visible: true, required: true };
  if (!cfg.amount) cfg.amount = { visible: true, required: true };
  return cfg;
}

async function loadFormConfig() {
  const { data, error } = await supabase.from('form_config').select('fields').eq('id', 1).maybeSingle();
  if (!error && data && data.fields) formConfig = data.fields;
  formConfig = normalizeFormConfig(formConfig);
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

// "Día comercial": un botón "Iniciar día"/"Finalizar día" en analiticas.html,
// pensado para reflejar cómo el local ya piensa su jornada (no necesariamente
// medianoche a medianoche — un viernes a la noche puede seguir "abierto"
// después de las 00:00). Mientras no haya un día abierto, no se pueden cargar
// pedidos nuevos (ver el chequeo en order:add). Al finalizar, se archivan los
// pedidos activos (dejan de verse en pedidos.html) y se congela un total de
// ese día para que ediciones futuras no lo alteren.

// Cacheado en memoria (no una consulta por request) para poder mandarlo en
// el snapshot inicial de cada socket sin pegarle a Supabase en cada conexión.
let openBusinessDay = null;

async function loadOpenBusinessDay() {
  const { data, error } = await supabase.from('business_days').select('*').is('ended_at', null).order('started_at', { ascending: false }).limit(1).maybeSingle();
  if (error) { console.error('Error leyendo business_days en Supabase:', error.message); return; }
  openBusinessDay = data || null;
}

// Antes esto adivinaba por substring ("efectivo" en el texto); ahora que los
// métodos de pago son una lista configurable, se busca el match exacto y se
// usa su flag `isCash`. Un pedido sin forma de pago asignada todavía (recién
// creado, no entregado) no cuenta como efectivo ni como no-efectivo.
// `paymentMethods` es un parámetro explícito (default: la config actual) en
// vez de leer el `formConfig` del módulo directamente, para poder testear
// esta función sola sin depender de estado global.
function isCashPayment(paymentMethod, paymentMethods = formConfig.paymentMethods) {
  if (!paymentMethod) return false;
  const method = (paymentMethods || []).find((m) => m.name === paymentMethod);
  return !!(method && method.isCash);
}

// El efectivo inicial es obligatorio para poder abrir el día -- a pedido
// explícito del usuario ("si no lo coloco no puedo utilizar nada"), ya que
// todo el resto de la app (Pedidos, Proveedores, etc.) queda habilitado en
// cuanto hay un día abierto. Antes se podía iniciar sin monto y cargarlo
// después (o nunca) desde /api/business-day/cash-start -- ese endpoint sigue
// existiendo tal cual, para poder editarlo una vez que el día ya arrancó.
app.post('/api/business-day/start', requireAuth, async (req, res) => {
  if (openBusinessDay) return res.json({ day: openBusinessDay });
  const cashStart = Number(req.body?.cashStart);
  if (!Number.isFinite(cashStart)) return res.status(400).json({ error: 'Falta el efectivo inicial.' });
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.from('business_days')
    .insert({ date: today, started_at: new Date().toISOString(), cash_start: cashStart })
    .select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  openBusinessDay = data;
  io.emit('business-day:status', { day: openBusinessDay });
  res.json({ day: data });
});

// Antes el efectivo inicial solo se guardaba junto con el final, al cerrar el
// día — si el admin lo tipeaba y cambiaba de pantalla antes de cerrar, se
// perdía (nunca había viajado a ningún lado). Ahora se guarda apenas se
// carga, en la fila ya abierta, y se re-manda por business-day:status para
// que cualquier pantalla conectada lo vea igual.
app.post('/api/business-day/cash-start', requireAuth, async (req, res) => {
  if (!openBusinessDay) return res.status(400).json({ error: 'No hay ningún día abierto.' });
  const cashStart = Number(req.body?.cashStart);
  if (!Number.isFinite(cashStart)) return res.status(400).json({ error: 'Falta el efectivo inicial.' });
  const { data, error } = await supabase.from('business_days')
    .update({ cash_start: cashStart })
    .eq('id', openBusinessDay.id).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  openBusinessDay = data;
  io.emit('business-day:status', { day: openBusinessDay });
  res.json({ day: data });
});

app.get('/api/business-day/current', requireAuth, (req, res) => {
  res.json({ day: openBusinessDay });
});

// Archiva TODOS los pedidos activos (no solo los entregados) — si queda
// alguno sin entregar, el frontend ya avisó y pidió confirmación antes de
// llegar acá. Los ingresos solo suman los que sí se entregaron (plata real
// cobrada); la cantidad de pedidos cuenta todo lo archivado. `cashStart`
// (efectivo con el que arrancó la caja) + lo cobrado en efectivo según los
// pedidos entregados = `cashExpected`, para comparar contra `cashEnd` (lo que
// realmente se contó al cerrar) — mismo espíritu que "Cambio inicial"/
// "Gastos" en caja.js, pero a nivel de todo el día en vez de por delivery.
app.post('/api/business-day/end', requireAuth, async (req, res) => {
  if (!openBusinessDay) return res.status(400).json({ error: 'No hay ningún día abierto.' });
  const cashStart = Number(req.body?.cashStart);
  const cashEnd = Number(req.body?.cashEnd);
  if (!Number.isFinite(cashStart) || !Number.isFinite(cashEnd)) {
    return res.status(400).json({ error: 'Falta el efectivo inicial y/o final.' });
  }

  const now = Date.now();
  const active = Array.from(orders.entries()).filter(([, o]) => !o.archivedAt);
  let totalRevenue = 0;
  let cashFromOrders = 0;
  active.forEach(([id, o]) => {
    o.archivedAt = now;
    o.updatedAt = now;
    if (o.status === 'entregado' && typeof o.amount === 'number') {
      totalRevenue += o.amount;
      if (isCashPayment(o.paymentMethod)) cashFromOrders += o.amount;
    }
    persistOrder(id, o);
    io.emit('order:update', { id, ...o });
  });

  // Proveedores pagados en efectivo salen de la misma caja física — se restan
  // del efectivo esperado, igual que antes hacía "Gastos" en caja.js (pero
  // ahora sí queda guardado y a nivel de todo el negocio, no por delivery).
  const cashExpensesTotal = Array.from(expenses.values())
    .filter((e) => e.businessDayId === openBusinessDay.id && e.paymentMethodIsCash)
    .reduce((sum, e) => sum + e.amount, 0);

  const cashExpected = cashStart + cashFromOrders - cashExpensesTotal;
  const { data, error } = await supabase.from('business_days')
    .update({
      ended_at: new Date(now).toISOString(),
      total_orders: active.length,
      total_revenue: totalRevenue,
      cash_start: cashStart,
      cash_end: cashEnd,
      cash_expected: cashExpected,
    })
    .eq('id', openBusinessDay.id).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  openBusinessDay = null;
  io.emit('business-day:status', { day: null });
  res.json({ day: data });
});

app.get('/api/business-days', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('business_days').select('*').order('date', { ascending: false }).limit(400);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ days: data || [] });
});

// Detalle de un día ya cerrado: los pedidos que se archivaron en ese mismo
// "Finalizar día" comparten exactamente el mismo `archived_at` que el
// `ended_at` de ese business_day (mismo `now` en el momento de cerrar, ver
// /api/business-day/end) — no hace falta guardar una relación aparte.
app.get('/api/business-day/:id/orders', requireAuth, async (req, res) => {
  const { data: day, error: dayError } = await supabase.from('business_days').select('ended_at').eq('id', req.params.id).maybeSingle();
  if (dayError) return res.status(500).json({ error: dayError.message });
  if (!day || !day.ended_at) return res.status(404).json({ error: 'Día no encontrado o todavía abierto.' });
  const { data, error } = await supabase.from('orders').select('*').eq('archived_at', day.ended_at).order('order_number', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ orders: data || [] });
});

// Exportar a CSV, para contabilidad o como respaldo manual además de lo que
// Supabase guarde por su cuenta (ver DOCUMENTACION.md, sección de backup).
// Sin librería nueva — un CSV es texto simple, esto alcanza: comillas dobles
// alrededor de cualquier campo con coma/comilla/salto de línea, y las
// comillas internas se duplican (regla estándar de CSV, RFC 4180).
function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  rows.forEach((row) => lines.push(row.map(csvCell).join(',')));
  return lines.join('\r\n');
}

app.get('/api/export/orders.csv', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('orders').select('*').order('seq', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  const headers = ['Ticket', 'Nº de pedido', 'Nombre', 'Teléfono', 'Monto', 'Método de pago', 'Estado', 'Origen', 'Actualizado'];
  const rows = (data || []).map((o) => [
    o.seq, o.order_number, o.name, o.phone, o.amount, o.payment_method, o.status,
    o.source === 'web' ? 'Web' : 'Admin', o.updated_at,
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pedidos.csv"');
  res.send(toCsv(headers, rows));
});

app.get('/api/export/business-days.csv', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('business_days').select('*').order('date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const headers = ['Fecha', 'Iniciado', 'Finalizado', 'Pedidos', 'Ingresos', 'Efectivo inicial', 'Efectivo esperado', 'Efectivo contado'];
  const rows = (data || []).map((d) => [
    d.date, d.started_at, d.ended_at, d.total_orders, d.total_revenue, d.cash_start, d.cash_expected, d.cash_end,
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="dias-comerciales.csv"');
  res.send(toCsv(headers, rows));
});

// Borra ABSOLUTAMENTE TODOS los pedidos (activos y ya archivados) y TODOS
// los business_days (abiertos y ya cerrados) — a pedido explícito, "esto es
// preventivo para pruebas". A diferencia de antes, esto SÍ toca el
// historial real: no hay forma de recuperar nada después de tocarlo. El
// frontend (analiticas.js) avisa esto bien claro antes de llamar acá.
const productImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

app.post('/api/products/:id/image', requireAuth, productImageUpload.single('image'), async (req, res) => {
  const p = products.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado.' });
  if (!req.file) return res.status(400).json({ error: 'Falta la imagen.' });

  const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase().slice(0, 10);
  const path = `${req.params.id}-${Date.now()}.${ext}`;
  const { error: uploadError } = await supabase.storage.from('product-images')
    .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
  if (uploadError) return res.status(500).json({ error: uploadError.message });

  const { data } = supabase.storage.from('product-images').getPublicUrl(path);
  p.imageUrl = data.publicUrl;
  persistProduct(req.params.id, p);
  io.emit('catalog:snapshot', catalogSnapshot());
  res.json({ ok: true, imageUrl: p.imageUrl });
});

// Misma mecánica que la de arriba, para la foto de portada de una categoría
// (la grilla de categorías del pedido online la usa como fondo de cada
// tarjeta) — reusa el mismo bucket "product-images" con un prefijo
// "category-" en el nombre del archivo, en vez de pedir un bucket nuevo.
app.post('/api/categories/:id/image', requireAuth, productImageUpload.single('image'), async (req, res) => {
  const c = categories.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Categoría no encontrada.' });
  if (!req.file) return res.status(400).json({ error: 'Falta la imagen.' });

  const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase().slice(0, 10);
  const path = `category-${req.params.id}-${Date.now()}.${ext}`;
  const { error: uploadError } = await supabase.storage.from('product-images')
    .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
  if (uploadError) return res.status(500).json({ error: uploadError.message });

  const { data } = supabase.storage.from('product-images').getPublicUrl(path);
  c.imageUrl = data.publicUrl;
  persistCategory(req.params.id, c);
  io.emit('catalog:snapshot', catalogSnapshot());
  res.json({ ok: true, imageUrl: c.imageUrl });
});

// Carga rápida del catálogo vía Excel -- pensada para arrancar el sistema
// desde cero sin tener que cargar producto por producto. Descarga (abajo) y
// carga (más abajo) comparten formato: una fila por producto, columnas
// Categoría/Producto/Descripción/Precio/Mostrar, sin ningún id que el admin
// tenga que manejar -- categorías y productos se identifican por nombre.
app.get('/api/catalog/template.xlsx', requireAuth, async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Catálogo');
  sheet.columns = [
    { header: 'Categoría', key: 'category', width: 22 },
    { header: 'Producto', key: 'product', width: 30 },
    { header: 'Descripción', key: 'description', width: 42 },
    { header: 'Precio', key: 'price', width: 12 },
    { header: 'Mostrar (Sí/No)', key: 'visible', width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const cats = categoryList();
  const prods = productList();
  if (cats.length > 0) {
    // Ya hay catálogo cargado: se exporta tal cual (una fila por producto, o
    // una fila "solo categoría" si todavía no tiene ninguno) para que este
    // mismo archivo sirva también para editar/agregar en lote, no solo para
    // arrancar de cero.
    cats.forEach((c) => {
      const items = prods.filter((p) => p.categoryId === c.id);
      if (items.length === 0) {
        sheet.addRow({ category: c.name, product: '', description: '', price: '', visible: '' });
      } else {
        items.forEach((p) => {
          sheet.addRow({
            category: c.name,
            product: p.name,
            description: p.description || '',
            price: p.price || 0,
            visible: p.visible === false ? 'No' : 'Sí',
          });
        });
      }
    });
  } else {
    sheet.addRow({ category: 'Rolls', product: 'Roll California', description: 'Palta, kanikama, queso crema', price: 450, visible: 'Sí' });
    sheet.addRow({ category: 'Rolls', product: 'Roll Philadelphia', description: 'Salmón, queso crema', price: 480, visible: 'Sí' });
    sheet.addRow({ category: 'Bebidas', product: 'Coca-Cola 500ml', description: '', price: 150, visible: 'Sí' });
  }

  // Desplegable Sí/No en la columna "Mostrar" -- para las filas ya cargadas y
  // para varios cientos de filas vacías de más, así las filas nuevas que
  // agregue el admin también lo tienen.
  const lastRow = sheet.rowCount + 500;
  for (let r = 2; r <= lastRow; r++) {
    sheet.getCell(`E${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Sí,No"'] };
  }

  const instructions = workbook.addWorksheet('Instrucciones');
  instructions.columns = [{ width: 95 }];
  [
    'Cómo usar esta planilla',
    '',
    '1. Completá una fila por producto. El nombre de "Categoría" se puede repetir -- todos los productos con el mismo nombre de categoría quedan agrupados ahí.',
    '2. Si una categoría todavía no tiene productos, dejá una fila con solo el nombre de la categoría (el resto vacío).',
    '3. "Mostrar" controla si ese producto aparece en el pedido online -- dejalo en "Sí" salvo que quieras cargarlo pero ocultarlo por ahora.',
    '4. Guardá el archivo y subilo desde Catálogo -> "Cargar Excel". No hace falta completar ningún ID -- las categorías y productos se identifican por nombre.',
    '5. Volver a subir el mismo archivo (editado) actualiza los productos que ya existan (por nombre + categoría) y crea los que sean nuevos -- no borra nada. Para borrar un producto o categoría, hacelo desde la pantalla de Catálogo.',
    '6. Las fotos no se pueden cargar desde acá -- se suben una por una tocando el ✏️ de cada producto/categoría en Catálogo, después de importar.',
  ].forEach((line) => instructions.addRow([line]));
  instructions.getRow(1).font = { bold: true, size: 13 };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="catalogo.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

const catalogImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Mismo parseo que Geo.parseAmount del lado del cliente ("$ 1.630,00" ->
// 1630), pero server.js no tiene acceso a geo.js (es un script de browser) --
// duplicado acá a propósito, self-contained, para esta única función.
function parsePriceCell(cell) {
  if (typeof cell.value === 'number') return cell.value;
  const raw = (cell.text || '').toString().trim();
  if (!raw) return 0;
  const cleaned = raw.replace(/[^\d,.-]/g, '');
  const normalized = cleaned.includes(',') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned;
  const n = parseFloat(normalized);
  return Number.isNaN(n) ? 0 : n;
}

// Nunca borra nada: identifica categorías y productos por nombre (sin
// importar mayúsculas/espacios) y hace upsert -- si ya existe uno con ese
// nombre (en esa categoría, para productos) lo actualiza, si no, lo crea.
// Para borrar algo hay que hacerlo a mano desde Catálogo -- evita que un
// error de tipeo en la planilla se lleve puesto un producto real sin avisar.
app.post('/api/catalog/import', requireAuth, catalogImportUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo.' });

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: 'No se pudo leer el archivo -- ¿es un .xlsx válido?' });
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return res.status(400).json({ error: 'El archivo no tiene ninguna hoja con datos.' });

  const categoryIdByName = new Map();
  categories.forEach((c, id) => categoryIdByName.set(c.name.trim().toLowerCase(), id));
  const productIdByKey = new Map();
  products.forEach((p, id) => productIdByKey.set(`${p.categoryId}::${p.name.trim().toLowerCase()}`, id));

  const result = { categoriesCreated: 0, productsCreated: 0, productsUpdated: 0, errors: [] };

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // encabezado

    const categoryName = (row.getCell(1).text || '').toString().trim();
    const productName = (row.getCell(2).text || '').toString().trim();
    if (!categoryName) {
      if (productName) result.errors.push(`Fila ${rowNumber}: falta la categoría, se ignoró.`);
      return;
    }

    const catKey = categoryName.toLowerCase();
    let categoryId = categoryIdByName.get(catKey);
    if (!categoryId) {
      categoryId = crypto.randomUUID();
      const entry = { name: categoryName.slice(0, 60), sortOrder: categories.size, visible: true };
      categories.set(categoryId, entry);
      persistCategory(categoryId, entry);
      categoryIdByName.set(catKey, categoryId);
      result.categoriesCreated++;
    }

    if (!productName) return; // fila "solo categoría" -- ya quedó creada/asegurada arriba

    const description = (row.getCell(3).text || '').toString().trim();
    const price = parsePriceCell(row.getCell(4));
    const visibleRaw = (row.getCell(5).text || '').toString().trim().toLowerCase();
    const visible = visibleRaw !== 'no';

    const key = `${categoryId}::${productName.toLowerCase()}`;
    const existingId = productIdByKey.get(key);
    if (existingId) {
      const p = products.get(existingId);
      p.description = description.slice(0, 300);
      p.price = price;
      p.visible = visible;
      persistProduct(existingId, p);
      result.productsUpdated++;
    } else {
      const id = crypto.randomUUID();
      const entry = {
        categoryId,
        name: productName.slice(0, 80),
        description: description.slice(0, 300),
        price,
        imageUrl: null,
        sortOrder: products.size,
        visible,
      };
      products.set(id, entry);
      persistProduct(id, entry);
      productIdByKey.set(key, id);
      result.productsCreated++;
    }
  });

  io.emit('catalog:snapshot', catalogSnapshot());
  res.json({ ok: true, ...result });
});

app.post('/api/admin/reset-today', requireAuth, async (req, res) => {
  const allOrderIds = Array.from(orders.keys());
  orders.clear();
  if (allOrderIds.length > 0) {
    const { error } = await supabase.from('orders').delete().not('id', 'is', null);
    if (error) console.error('Error borrando pedidos en Supabase:', error.message);
    allOrderIds.forEach((id) => io.emit('order:remove', { id }));
  }

  const { error: daysError } = await supabase.from('business_days').delete().not('id', 'is', null);
  if (daysError) console.error('Error borrando business_days en Supabase:', daysError.message);
  openBusinessDay = null;
  io.emit('business-day:status', { day: null });

  driverCashStarts.forEach((amount, driverId) => io.emit('driver:cash-start', { driverId, amount: 0 }));
  driverCashStarts.clear();
  const { error: cashStartsError } = await supabase.from('driver_cash_starts').delete().not('driver_id', 'is', null);
  if (cashStartsError) console.error('Error borrando efectivo inicial de deliverys en Supabase:', cashStartsError.message);

  res.json({ ok: true, deletedOrders: allOrderIds.length });
});

io.use((socket, next) => {
  const cookies = cookie.parse(socket.handshake.headers.cookie || '');
  socket.data.isAdmin = AUTH_DISABLED || !!verifyToken(cookies[COOKIE_NAME]);
  // Los gastos (Proveedores) son plata — a diferencia del catálogo/formConfig
  // no le pueden llegar a un socket público (pedido-cliente.html). Se junta a
  // los admins en una sala para poder difundir solo ahí.
  if (socket.data.isAdmin) socket.join('admin');
  next();
});

io.on('connection', (socket) => {
  socket.emit('drivers:snapshot', driverList());
  socket.emit('orders:snapshot', orderList());
  socket.emit('routes:snapshot', routeList());
  socket.emit('form-config:snapshot', formConfig);
  socket.emit('business-day:status', { day: openBusinessDay });
  socket.emit('cash-starts:snapshot', cashStartList());
  socket.emit('catalog:snapshot', catalogSnapshot());
  if (socket.data.isAdmin) socket.emit('expenses:snapshot', expenseList());

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
  socket.on('order:add', ({ id, orderNumber, phone, name, lat, lng, label, amount, paymentMethod, custom, pickup }) => {
    if (!socket.data.isAdmin || !id || !openBusinessDay) return;
    const hasLocation = typeof lat === 'number' && typeof lng === 'number';
    // Tipo de envío obligatorio: o retira (pickup) o tiene que traer una
    // ubicación resuelta — no queda una tercera opción de "ninguna de las
    // dos", esto no es configurable. El teléfono acá sí vuelve a depender de
    // Ajustes (el admin puede relajarlo para carga manual) — a diferencia de
    // order:web-add, que lo exige siempre porque ahí no hay otra forma de
    // contactar a un cliente anónimo.
    if ((formConfig.phone?.required && !phone) || !(pickup || hasLocation)) return;
    const entry = {
      seq: nextSeq++,
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
      archivedAt: null,
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

  // El admin edita un pedido — desde un dropdown suelto en la tabla (solo
  // status/paymentMethod) o desde el popup "Editar pedido" (cualquier
  // campo). Cualquier cambio se propaga solo por el broadcast de
  // order:update de siempre — el delivery lo ve al toque, no hace falta
  // avisarle aparte.
  socket.on('order:edit', ({ id, fields }) => {
    if (!socket.data.isAdmin) return;
    const o = orders.get(id);
    if (!o || !fields) return;
    if (typeof fields.status === 'string') o.status = fields.status.slice(0, 20);
    if (typeof fields.paymentMethod === 'string') o.paymentMethod = fields.paymentMethod.slice(0, 30);
    if (typeof fields.orderNumber === 'string') o.orderNumber = fields.orderNumber.slice(0, 20);
    if (typeof fields.phone === 'string') o.phone = fields.phone.slice(0, 30);
    if (typeof fields.name === 'string') o.name = fields.name.slice(0, 60);
    if (typeof fields.amount === 'number') o.amount = fields.amount;
    if (typeof fields.label === 'string') o.label = fields.label.slice(0, 200);
    if (typeof fields.lat === 'number' && typeof fields.lng === 'number') { o.lat = fields.lat; o.lng = fields.lng; }
    if (fields.custom && typeof fields.custom === 'object') o.custom = { ...o.custom, ...sanitizeCustom(fields.custom) };
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

  // El admin carga cuánto efectivo le dio a un delivery al salir (tarjeta de rendición en dashboard.html);
  // driver.html solo lo muestra, no puede editarlo — evita que el número que
  // hay que rendir al final dependa de lo que el delivery diga que le dieron.
  socket.on('driver:cash-start', ({ driverId, amount }) => {
    if (!socket.data.isAdmin || !driverId || typeof amount !== 'number') return;
    driverCashStarts.set(driverId, amount);
    persistDriverCashStart(driverId, amount);
    io.emit('driver:cash-start', { driverId, amount });
  });

  // Catálogo (pantalla del cliente): el admin arma categorías y productos
  // acá; cualquier socket conectado (admin o cliente) recibe el snapshot
  // completo, a diferencia de orders:snapshot que sí es sensible.
  socket.on('category:add', ({ name }) => {
    if (!socket.data.isAdmin || !name) return;
    const id = crypto.randomUUID();
    const entry = { name: name.toString().slice(0, 60), sortOrder: categories.size, visible: true };
    categories.set(id, entry);
    persistCategory(id, entry);
    io.emit('catalog:snapshot', catalogSnapshot());
  });

  socket.on('category:edit', ({ id, fields }) => {
    if (!socket.data.isAdmin) return;
    const c = categories.get(id);
    if (!c || !fields) return;
    if (typeof fields.name === 'string') c.name = fields.name.slice(0, 60);
    if (typeof fields.sortOrder === 'number') c.sortOrder = fields.sortOrder;
    if (typeof fields.visible === 'boolean') c.visible = fields.visible;
    persistCategory(id, c);
    io.emit('catalog:snapshot', catalogSnapshot());
  });

  socket.on('category:remove', ({ id }) => {
    if (!socket.data.isAdmin || !id) return;
    const hasProducts = Array.from(products.values()).some((p) => p.categoryId === id);
    if (hasProducts) return; // el admin tiene que vaciar/mover los productos primero
    categories.delete(id);
    supabase.from('categories').delete().eq('id', id).then(({ error }) => {
      if (error) console.error('Error borrando categoría en Supabase:', error.message);
    });
    io.emit('catalog:snapshot', catalogSnapshot());
  });

  socket.on('product:add', ({ categoryId, name, description, price }) => {
    if (!socket.data.isAdmin || !categoryId || !name) return;
    const id = crypto.randomUUID();
    const entry = {
      categoryId,
      name: name.toString().slice(0, 80),
      description: (description || '').toString().slice(0, 300),
      price: typeof price === 'number' ? price : 0,
      imageUrl: null,
      sortOrder: products.size,
      visible: true,
    };
    products.set(id, entry);
    persistProduct(id, entry);
    io.emit('catalog:snapshot', catalogSnapshot());
  });

  socket.on('product:edit', ({ id, fields }) => {
    if (!socket.data.isAdmin) return;
    const p = products.get(id);
    if (!p || !fields) return;
    if (typeof fields.categoryId === 'string') p.categoryId = fields.categoryId;
    if (typeof fields.name === 'string') p.name = fields.name.slice(0, 80);
    if (typeof fields.description === 'string') p.description = fields.description.slice(0, 300);
    if (typeof fields.price === 'number') p.price = fields.price;
    if (typeof fields.sortOrder === 'number') p.sortOrder = fields.sortOrder;
    if (typeof fields.visible === 'boolean') p.visible = fields.visible;
    persistProduct(id, p);
    io.emit('catalog:snapshot', catalogSnapshot());
  });

  socket.on('product:remove', ({ id }) => {
    if (!socket.data.isAdmin || !id) return;
    products.delete(id);
    supabase.from('products').delete().eq('id', id).then(({ error }) => {
      if (error) console.error('Error borrando producto en Supabase:', error.message);
    });
    io.emit('catalog:snapshot', catalogSnapshot());
  });

  // Proveedores: un pago que sale de la caja del negocio (no de un delivery
  // en particular). Solo tiene sentido con el día abierto, para poder
  // asociarlo y restarlo del efectivo esperado al cerrar (ver
  // /api/business-day/end). `paymentMethodName`/`isCash` se copian de la
  // config actual y quedan fijos en el gasto (ver comentario en el Map).
  socket.on('expense:add', ({ description, amount, paymentMethodId, driverId }) => {
    if (!socket.data.isAdmin || !description || typeof amount !== 'number' || !openBusinessDay) return;
    const method = formConfig.paymentMethods.find((m) => m.id === paymentMethodId);
    const id = crypto.randomUUID();
    const entry = {
      description: description.toString().slice(0, 200),
      amount,
      paymentMethodId: method ? method.id : null,
      paymentMethodName: method ? method.name : null,
      paymentMethodIsCash: method ? method.isCash : false,
      businessDayId: openBusinessDay.id,
      createdAt: Date.now(),
      // Opcional: si el gasto se pagó con la plata que ya tenía el delivery
      // encima (ej. "comprale tal cosa con la plata que llevás"), se le
      // resta a ese delivery en su "Total a entregar" — ver dashboard.js.
      // Sin asignar (null) sigue siendo un gasto del negocio en general, no
      // afecta a ningún delivery en particular.
      driverId: driverId || null,
    };
    expenses.set(id, entry);
    persistExpense(id, entry);
    io.to('admin').emit('expenses:snapshot', expenseList());
  });

  socket.on('expense:remove', ({ id }) => {
    if (!socket.data.isAdmin || !id) return;
    expenses.delete(id);
    supabase.from('expenses').delete().eq('id', id).then(({ error }) => {
      if (error) console.error('Error borrando gasto en Supabase:', error.message);
    });
    io.to('admin').emit('expenses:snapshot', expenseList());
  });

  // Pedido enviado desde pedido-cliente.html — socket público, sin
  // socket.data.isAdmin. A diferencia de order:add (que confía en un admin
  // ya logueado), acá no se confía en nada de lo que mande el cliente salvo
  // el id de cada producto: precio, nombre e id del pedido siempre se
  // recalculan/generan del lado del servidor. Usa ack para poder avisarle al
  // cliente si algo salió mal (order:add es fire-and-forget porque el admin
  // ve el resultado al toque en la tabla; acá no hay tabla que mirar).
  socket.on('order:web-add', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};

    const last = webOrderCooldown.get(socket.id) || 0;
    if (Date.now() - last < WEB_ORDER_COOLDOWN_MS) {
      return ack({ ok: false, error: 'Esperá un momento antes de enviar otro pedido.' });
    }
    if (!openBusinessDay) {
      return ack({ ok: false, error: 'No estamos aceptando pedidos en este momento.' });
    }

    const cartItems = Array.isArray(payload?.items) ? payload.items.slice(0, 30) : [];
    if (cartItems.length === 0) return ack({ ok: false, error: 'El carrito está vacío.' });

    const resolvedItems = [];
    let amount = 0;
    for (const it of cartItems) {
      const p = products.get(it?.productId);
      const qty = Math.min(Math.max(parseInt(it?.qty, 10) || 0, 1), 50);
      if (!p || p.visible === false) {
        return ack({ ok: false, error: 'Un producto de tu carrito ya no está disponible. Actualizá la página e intentá de nuevo.' });
      }
      resolvedItems.push({ productId: it.productId, name: p.name, price: p.price, qty });
      amount += p.price * qty;
    }

    // Teléfono y tipo de envío (retira/envía) son siempre obligatorios, ya no
    // dependen de formConfig — igual que en order:add (lado admin). Antes acá
    // se chequeaba `payload.location` (un campo que el cliente nunca manda —
    // la dirección ya viaja resuelta en lat/lng), así que en la práctica
    // nunca bloqueaba nada; ahora sí valida de verdad que haya una ubicación
    // resuelta cuando no es retiro.
    const hasLocation = typeof payload?.lat === 'number' && typeof payload?.lng === 'number';
    const missing = [];
    if (!payload?.phone) missing.push('Celular');
    if (formConfig.name?.required && !payload?.name) missing.push('Nombre');
    if (!payload?.pickup && !hasLocation) missing.push('Ubicación de entrega');
    (formConfig.customFields || []).forEach((f) => {
      if (f.visible !== false && f.required && !(payload?.custom && payload.custom[f.key])) missing.push(f.label);
    });
    if (missing.length > 0) return ack({ ok: false, error: `Falta completar: ${missing.join(', ')}.` });

    const id = crypto.randomUUID();
    const seq = nextSeq++;
    const entry = {
      seq,
      orderNumber: `WEB-${seq}`,
      phone: (payload.phone || '').toString().slice(0, 30),
      name: (payload.name || '').toString().slice(0, 60),
      lat: hasLocation ? payload.lat : null,
      lng: hasLocation ? payload.lng : null,
      label: (payload.label || (payload.pickup ? 'Retira en el local' : '')).toString().slice(0, 200),
      assignedTo: null,
      status: 'pending',
      amount,
      paymentMethod: '',
      reconciledAt: null,
      archivedAt: null,
      updatedAt: Date.now(),
      custom: sanitizeCustom(payload.custom),
      source: 'web',
      items: resolvedItems,
    };
    orders.set(id, entry);
    persistOrder(id, entry);
    io.emit('order:update', { id, ...entry });
    webOrderCooldown.set(socket.id, Date.now());
    ack({ ok: true, orderNumber: entry.orderNumber, seq });
  });
});

// `.unref()`: en producción esto igual corre cada 30s mientras el server
// esté levantado (lo que lo mantiene vivo es `server.listen()`, no este
// timer) — pero si alguien hace `require('./server.js')` sin escuchar en
// ningún puerto (los tests), este timer solo no debe impedir que el
// proceso termine solo.
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
}, 30000).unref();

const PORT = process.env.PORT || 3000;

async function start() {
  await bootstrapAdmin();
  await loadFormConfig();
  await loadOrders();
  await loadOpenBusinessDay();
  await loadCatalog();
  await loadExpenses();
  await loadDriverCashStarts();
  server.listen(PORT, () => {
    console.log(`Tracking en vivo corriendo en http://localhost:${PORT}`);
    console.log(`Login:         http://localhost:${PORT}/login.html`);
    console.log(`Delivery:      http://localhost:${PORT}/driver.html`);
    console.log(`Pedidos:       http://localhost:${PORT}/pedidos.html (incluye "+ Nuevo pedido")`);
    console.log(`Mapa:          http://localhost:${PORT}/dashboard.html (incluye rendición por delivery)`);
    console.log(`Analíticas:    http://localhost:${PORT}/analiticas.html`);
    console.log(`Catálogo:      http://localhost:${PORT}/catalogo.html`);
    console.log(`Proveedores:   http://localhost:${PORT}/proveedores.html`);
    console.log(`Pedido online: http://localhost:${PORT}/pedido-cliente.html`);
  });
}

// `require.main === module` es falso cuando este archivo se importa desde
// otro lado (los tests, `test/server.test.js`) en vez de ejecutarse
// directo (`node server.js`) — así los tests pueden importar las funciones
// puras de abajo sin levantar el servidor real ni escuchar en ningún puerto.
if (require.main === module) {
  start();
}

module.exports = {
  sanitizeCustom,
  isCashPayment,
  normalizeFormConfig,
  orderRow,
  categoryRow,
  productRow,
  expenseRow,
  csvCell,
  toCsv,
};
