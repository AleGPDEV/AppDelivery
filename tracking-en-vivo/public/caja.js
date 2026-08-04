const cashTbodyEl = document.getElementById('cash-tbody');
const cashEmptyEl = document.getElementById('cash-empty');

const socket = io();

const drivers = new Map(); // driverId -> { name, ... }
const knownDriverNames = new Map();
const orders = new Map(); // orderId -> order data (misma fuente que pedidos.html)
const cashStarts = new Map(); // driverId -> number, sincronizado con el servidor (y con driver.html)
const gastos = new Map(); // driverId -> number, solo de este navegador (no se sincroniza)
const driverRows = new Map(); // driverId -> refs a los elementos ya creados, para no recrearlos en cada render

function driverLabel(id) {
  const d = drivers.get(id);
  if (d) return d.name;
  return knownDriverNames.get(id) || 'delivery desconectado';
}

function isCash(paymentMethod) {
  const p = (paymentMethod || '').toLowerCase();
  return p === '' || p.includes('efectivo') || p === 'retira';
}

function isTransfer(paymentMethod) {
  return (paymentMethod || '').toLowerCase().includes('transfer');
}

function isDebit(paymentMethod) {
  const p = (paymentMethod || '').toLowerCase();
  return p.includes('débito') || p.includes('debito');
}

// Pedidos entregados y todavía no "cerrados" en una rendición anterior — el
// historial completo queda en `orders` (nunca se borra), esto es solo lo que
// falta rendir ahora mismo.
function pendingDeliveries(driverId) {
  return Array.from(orders.values()).filter((o) => o.assignedTo === driverId && o.status === 'entregado' && !o.reconciledAt);
}

function sumBy(list, predicate) {
  const filtered = list.filter(predicate);
  return { count: filtered.length, total: filtered.reduce((sum, e) => sum + (e.amount || 0), 0) };
}

function fmtCell({ count, total }) {
  return `${count} — $${total.toFixed(2)}`;
}

// La fila de cada delivery se crea una sola vez (`ensureRow()`/`driverRows`
// Map) y se actualiza en su lugar (`updateRow()`) — si se recreara en cada
// render (como en la versión vieja de esta pantalla), tipear en "Efectivo
// cambio dado"/"Gastos" perdía el foco en cada tecla.
function ensureRow(driverId) {
  const existing = driverRows.get(driverId);
  if (existing) return existing;

  const tr = document.createElement('tr');

  const tdName = document.createElement('td');
  tr.appendChild(tdName);

  const tdCambio = document.createElement('td');
  const cambioInput = document.createElement('input');
  cambioInput.type = 'text';
  cambioInput.placeholder = '$ 0,00';
  cambioInput.style.width = '120px';
  cambioInput.addEventListener('input', () => {
    const amount = Geo.parseAmount(cambioInput.value) || 0;
    cashStarts.set(driverId, amount);
    socket.emit('driver:cash-start', { driverId, amount });
    updateRow(driverId);
  });
  tdCambio.appendChild(cambioInput);
  tr.appendChild(tdCambio);

  const tdEfectivo = document.createElement('td');
  tr.appendChild(tdEfectivo);

  const tdTransferencia = document.createElement('td');
  tr.appendChild(tdTransferencia);

  const tdDebito = document.createElement('td');
  tr.appendChild(tdDebito);

  const tdGastos = document.createElement('td');
  const gastosInput = document.createElement('input');
  gastosInput.type = 'text';
  gastosInput.placeholder = '$ 0,00';
  gastosInput.style.width = '120px';
  gastosInput.addEventListener('input', () => {
    gastos.set(driverId, Geo.parseAmount(gastosInput.value) || 0);
    updateRow(driverId);
  });
  tdGastos.appendChild(gastosInput);
  tr.appendChild(tdGastos);

  const tdTotal = document.createElement('td');
  const totalStrong = document.createElement('strong');
  tdTotal.appendChild(totalStrong);
  tr.appendChild(tdTotal);

  const tdActions = document.createElement('td');
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'danger small';
  clearBtn.textContent = 'Cerrar rendición';
  clearBtn.addEventListener('click', () => {
    socket.emit('driver:clear-log', { driverId });
    socket.emit('driver:cash-start', { driverId, amount: 0 });
    gastos.delete(driverId);
    updateRow(driverId);
  });
  tdActions.appendChild(clearBtn);
  tr.appendChild(tdActions);

  cashTbodyEl.appendChild(tr);
  // `cambioInput` recién tiene padre después de este `appendChild` — antes
  // de eso `insertAdjacentElement` no tendría dónde insertar el botón.
  MoneyCounter.attach(cambioInput);

  const refs = { tr, tdName, cambioInput, tdEfectivo, tdTransferencia, tdDebito, gastosInput, totalStrong };
  driverRows.set(driverId, refs);
  return refs;
}

function updateRow(driverId) {
  const refs = ensureRow(driverId);
  const log = pendingDeliveries(driverId);
  const cash = sumBy(log, (e) => isCash(e.paymentMethod));
  const transfer = sumBy(log, (e) => isTransfer(e.paymentMethod));
  const debit = sumBy(log, (e) => isDebit(e.paymentMethod));
  const cashStart = cashStarts.get(driverId) || 0;
  const gasto = gastos.get(driverId) || 0;
  const debe = cash.total + cashStart - gasto;

  refs.tdName.textContent = `${driverLabel(driverId)} (${log.length} sin rendir)`;
  refs.tdEfectivo.textContent = fmtCell(cash);
  refs.tdTransferencia.textContent = fmtCell(transfer);
  refs.tdDebito.textContent = fmtCell(debit);
  refs.totalStrong.textContent = `$${debe.toFixed(2)}`;
  // No pisar lo que se está tipeando ahora mismo (por ej. un eco del propio cambio recién emitido).
  if (document.activeElement !== refs.cambioInput) refs.cambioInput.value = cashStart || '';
  if (document.activeElement !== refs.gastosInput) refs.gastosInput.value = gasto || '';
}

function renderCashList() {
  const assignedDriverIds = new Set(Array.from(orders.values()).map((o) => o.assignedTo).filter(Boolean));
  const driverIds = new Set([...assignedDriverIds, ...drivers.keys()]);

  cashEmptyEl.hidden = driverIds.size > 0;
  if (driverIds.size === 0) {
    driverRows.forEach((refs) => refs.tr.remove());
    driverRows.clear();
    return;
  }

  // Saca de la tabla las filas de deliveries que ya no corresponden mostrar.
  driverRows.forEach((refs, driverId) => {
    if (!driverIds.has(driverId)) {
      refs.tr.remove();
      driverRows.delete(driverId);
    }
  });

  driverIds.forEach((driverId) => {
    const refs = ensureRow(driverId);
    if (!refs.tr.isConnected) cashTbodyEl.appendChild(refs.tr);
    updateRow(driverId);
  });
}

socket.on('drivers:snapshot', (list) => { list.forEach((d) => { drivers.set(d.id, d); knownDriverNames.set(d.id, d.name); }); renderCashList(); });
socket.on('driver:update', (d) => { drivers.set(d.id, d); knownDriverNames.set(d.id, d.name); renderCashList(); });
socket.on('driver:remove', ({ id }) => { drivers.delete(id); renderCashList(); });

socket.on('orders:snapshot', (list) => { list.forEach((o) => orders.set(o.id, o)); renderCashList(); });
socket.on('order:update', (o) => { orders.set(o.id, o); renderCashList(); });
socket.on('order:remove', ({ id }) => { orders.delete(id); renderCashList(); });

socket.on('cash-starts:snapshot', (list) => { list.forEach(({ driverId, amount }) => cashStarts.set(driverId, amount)); renderCashList(); });
socket.on('driver:cash-start', ({ driverId, amount }) => { cashStarts.set(driverId, amount); if (driverRows.has(driverId)) updateRow(driverId); });
