const cashListEl = document.getElementById('cash-list');

const socket = io();

const drivers = new Map(); // driverId -> { name, ... }
const knownDriverNames = new Map();
const orders = new Map(); // orderId -> order data (misma fuente que pedidos.html)
const cashStarts = new Map(); // driverId -> number, sincronizado con el servidor (y con driver.html)
const gastos = new Map(); // driverId -> number, solo de este navegador (no se sincroniza)
const driverBoxes = new Map(); // driverId -> refs a los elementos ya creados, para no recrearlos en cada render

function driverLabel(id) {
  const d = drivers.get(id);
  if (d) return d.name;
  return knownDriverNames.get(id) || 'delivery desconectado';
}

function isCash(paymentMethod) {
  const p = (paymentMethod || '').toLowerCase();
  return p === '' || p.includes('efectivo') || p === 'retira';
}

// Pedidos entregados y todavía no "cerrados" en una rendición anterior — el
// historial completo queda en `orders` (nunca se borra), esto es solo lo que
// falta rendir ahora mismo.
function pendingDeliveries(driverId) {
  return Array.from(orders.values()).filter((o) => o.assignedTo === driverId && o.status === 'entregado' && !o.reconciledAt);
}

// Los elementos de cada caja se crean una sola vez y se van actualizando en
// su lugar — si se recrearan en cada render (como antes), tipear en
// "Efectivo inicial"/"Gastos" perdía el foco en cada tecla.
function ensureBox(driverId) {
  const existing = driverBoxes.get(driverId);
  if (existing) return existing;

  const box = document.createElement('div');
  box.className = 'field';
  box.style.borderBottom = '1px solid var(--border)';
  box.style.paddingBottom = '12px';
  box.style.marginBottom = '12px';

  const titleEl = document.createElement('label');
  box.appendChild(titleEl);

  const summaryEl = document.createElement('p');
  summaryEl.className = 'hint';
  box.appendChild(summaryEl);

  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '8px';
  row.style.alignItems = 'center';
  row.style.flexWrap = 'wrap';

  const cambioInput = document.createElement('input');
  cambioInput.type = 'text';
  cambioInput.placeholder = 'Efectivo inicial';
  cambioInput.style.width = '140px';
  cambioInput.addEventListener('input', () => {
    const amount = Geo.parseAmount(cambioInput.value) || 0;
    cashStarts.set(driverId, amount);
    socket.emit('driver:cash-start', { driverId, amount });
    updateBox(driverId);
  });

  const gastosInput = document.createElement('input');
  gastosInput.type = 'text';
  gastosInput.placeholder = 'Gastos';
  gastosInput.style.width = '140px';
  gastosInput.addEventListener('input', () => {
    gastos.set(driverId, Geo.parseAmount(gastosInput.value) || 0);
    updateBox(driverId);
  });

  const debeText = document.createElement('strong');

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'danger small';
  clearBtn.textContent = 'Cerrar rendición';
  clearBtn.addEventListener('click', () => {
    socket.emit('driver:clear-log', { driverId });
    socket.emit('driver:cash-start', { driverId, amount: 0 });
    gastos.delete(driverId);
    updateBox(driverId);
  });

  row.append(cambioInput, gastosInput, debeText, clearBtn);
  box.appendChild(row);
  // Recién acá `cambioInput` ya tiene padre (`row`) — antes de este punto
  // `insertAdjacentElement('afterend', ...)` no tiene dónde insertar nada.
  MoneyCounter.attach(cambioInput);

  const refs = { box, titleEl, summaryEl, cambioInput, gastosInput, debeText };
  driverBoxes.set(driverId, refs);
  return refs;
}

function updateBox(driverId) {
  const refs = ensureBox(driverId);
  const log = pendingDeliveries(driverId);
  const cashTotal = log.filter((e) => isCash(e.paymentMethod)).reduce((sum, e) => sum + (e.amount || 0), 0);
  const otherTotal = log.filter((e) => !isCash(e.paymentMethod)).reduce((sum, e) => sum + (e.amount || 0), 0);
  const cashStart = cashStarts.get(driverId) || 0;
  const gasto = gastos.get(driverId) || 0;
  const debe = cashTotal + cashStart - gasto;

  refs.titleEl.textContent = `${driverLabel(driverId)} — ${log.length} entregado${log.length === 1 ? '' : 's'} sin rendir`;
  refs.summaryEl.textContent = `Efectivo cobrado: $${cashTotal.toFixed(2)} — Otros medios: $${otherTotal.toFixed(2)}`;
  refs.debeText.textContent = `Debe entregar: $${debe.toFixed(2)}`;
  // No pisar lo que se está tipeando ahora mismo (por ej. un eco del propio cambio recién emitido).
  if (document.activeElement !== refs.cambioInput) refs.cambioInput.value = cashStart || '';
  if (document.activeElement !== refs.gastosInput) refs.gastosInput.value = gasto || '';
}

function renderCashList() {
  const assignedDriverIds = new Set(Array.from(orders.values()).map((o) => o.assignedTo).filter(Boolean));
  const driverIds = new Set([...assignedDriverIds, ...drivers.keys()]);

  if (driverIds.size === 0) {
    cashListEl.innerHTML = '<p class="hint">Todavía no hay entregas registradas.</p>';
    driverBoxes.clear();
    return;
  }
  if (cashListEl.querySelector('.hint')) cashListEl.innerHTML = '';

  // Saca del DOM las cajas de deliveries que ya no corresponden mostrar.
  driverBoxes.forEach((refs, driverId) => {
    if (!driverIds.has(driverId)) {
      refs.box.remove();
      driverBoxes.delete(driverId);
    }
  });

  driverIds.forEach((driverId) => {
    const refs = ensureBox(driverId);
    if (!refs.box.isConnected) cashListEl.appendChild(refs.box);
    updateBox(driverId);
  });
}

socket.on('drivers:snapshot', (list) => { list.forEach((d) => { drivers.set(d.id, d); knownDriverNames.set(d.id, d.name); }); renderCashList(); });
socket.on('driver:update', (d) => { drivers.set(d.id, d); knownDriverNames.set(d.id, d.name); renderCashList(); });
socket.on('driver:remove', ({ id }) => { drivers.delete(id); renderCashList(); });

socket.on('orders:snapshot', (list) => { list.forEach((o) => orders.set(o.id, o)); renderCashList(); });
socket.on('order:update', (o) => { orders.set(o.id, o); renderCashList(); });
socket.on('order:remove', ({ id }) => { orders.delete(id); renderCashList(); });

socket.on('cash-starts:snapshot', (list) => { list.forEach(({ driverId, amount }) => cashStarts.set(driverId, amount)); renderCashList(); });
socket.on('driver:cash-start', ({ driverId, amount }) => { cashStarts.set(driverId, amount); if (driverBoxes.has(driverId)) updateBox(driverId); });
