const orderTbodyEl = document.getElementById('order-tbody');
const orderCountEl = document.getElementById('order-count');

const STATUS_OPTIONS = [['pending', 'En preparación'], ['en_camino', 'En Camino'], ['entregado', 'Entregado']];
const PAYMENT_OPTIONS = ['', 'Efectivo', 'Transferencia', 'Débito'];

const socket = io();

// This page only needs drivers' names/positions for the assign dropdown and
// route recompute — no map here.
const drivers = new Map(); // driverId -> { name, lat, lng, color }
const orders = new Map(); // orderId -> order data
const knownDriverNames = new Map(); // survives a driver going offline, so old assignments still show a name

function driverLabel(id) {
  const d = drivers.get(id);
  if (d) return d.name;
  return knownDriverNames.get(id) || 'delivery desconectado';
}

function orderPrecisionTag(o) {
  if (o.precision === 'street') return ' (aproximado: a nivel de calle, revisar)';
  if (o.precision === 'exact') return ' (verificar pin en el mapa)';
  return '';
}

function renderOrders() {
  orderTbodyEl.innerHTML = '';
  orderCountEl.textContent = orders.size === 0
    ? 'Todavía no cargaste ningún pedido.'
    : `${orders.size} pedido${orders.size === 1 ? '' : 's'} registrado${orders.size === 1 ? '' : 's'}.`;

  const sorted = Array.from(orders.entries()).sort((a, b) => (a[1].orderNumber || '').localeCompare(b[1].orderNumber || '', undefined, { numeric: true }));

  sorted.forEach(([id, o]) => {
    const tr = document.createElement('tr');

    const tdPhone = document.createElement('td');
    tdPhone.textContent = o.phone || '';

    const tdName = document.createElement('td');
    tdName.textContent = `${o.name || ''}${orderPrecisionTag(o)}`;

    const tdNum = document.createElement('td');
    tdNum.textContent = o.orderNumber || '';

    const tdAmount = document.createElement('td');
    tdAmount.textContent = o.amount != null ? `$${o.amount.toFixed(2)}` : '';

    const tdAssign = document.createElement('td');
    const assignSelect = document.createElement('select');
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'Sin asignar';
    assignSelect.appendChild(noneOpt);
    drivers.forEach((d, driverId) => {
      const opt = document.createElement('option');
      opt.value = driverId;
      opt.textContent = d.name;
      assignSelect.appendChild(opt);
    });
    if (o.assignedTo && !drivers.has(o.assignedTo)) {
      const opt = document.createElement('option');
      opt.value = o.assignedTo;
      opt.textContent = `${driverLabel(o.assignedTo)} (desconectado)`;
      assignSelect.appendChild(opt);
    }
    assignSelect.value = o.assignedTo || '';
    assignSelect.addEventListener('change', () => assignOrder(id, assignSelect.value || null));
    tdAssign.appendChild(assignSelect);

    const tdPayment = document.createElement('td');
    const paySelect = document.createElement('select');
    PAYMENT_OPTIONS.forEach((pm) => {
      const opt = document.createElement('option');
      opt.value = pm;
      opt.textContent = pm || 'Sin especificar';
      paySelect.appendChild(opt);
    });
    paySelect.value = o.paymentMethod || '';
    paySelect.addEventListener('change', () => {
      socket.emit('order:edit', { id, fields: { paymentMethod: paySelect.value } });
    });
    tdPayment.appendChild(paySelect);

    const tdStatus = document.createElement('td');
    const statusSelect = document.createElement('select');
    STATUS_OPTIONS.forEach(([value, text]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      statusSelect.appendChild(opt);
    });
    statusSelect.value = o.status || 'pending';
    statusSelect.addEventListener('change', () => {
      socket.emit('order:edit', { id, fields: { status: statusSelect.value } });
    });
    tdStatus.appendChild(statusSelect);

    const tdActions = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger small';
    delBtn.textContent = '🗑';
    delBtn.title = 'Eliminar pedido';
    delBtn.addEventListener('click', () => {
      if (confirm(`¿Eliminar el pedido #${o.orderNumber || '?'}?`)) socket.emit('order:remove', { id });
    });
    tdActions.appendChild(delBtn);

    tr.append(tdPhone, tdName, tdNum, tdAmount, tdAssign, tdPayment, tdStatus, tdActions);
    orderTbodyEl.appendChild(tr);
  });
}

function assignOrder(orderId, driverId) {
  const order = orders.get(orderId);
  socket.emit('order:assign', { id: orderId, driverId });
  if (order) order.assignedTo = driverId;
  renderOrders();
  recomputeRouteForDriver(order ? order.assignedTo : null);
  recomputeRouteForDriver(driverId);
}

// Recomputes and broadcasts the optimal route for everything currently
// assigned to this driver, starting from their last known live position —
// same logic as nuevo-pedido.js, kept independent since these are separate pages.
async function recomputeRouteForDriver(driverId) {
  if (!driverId) return;
  const driver = drivers.get(driverId);
  if (!driver) return;

  const assigned = Array.from(orders.entries())
    .filter(([, o]) => o.assignedTo === driverId && o.lat != null && o.status !== 'entregado')
    .map(([id, o]) => ({ id, lat: o.lat, lng: o.lng, label: o.label, orderNumber: o.orderNumber }));

  if (assigned.length === 0) {
    socket.emit('driver:route', { driverId, stops: [], latlngs: [] });
    return;
  }

  try {
    const result = await Geo.computeRoute({ lat: driver.lat, lng: driver.lng }, assigned);
    const stops = result.orderedPoints.slice(1).map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, label: p.label, orderNumber: p.orderNumber }));
    socket.emit('driver:route', { driverId, stops, latlngs: result.latlngs, distanceKm: result.distanceKm, durationMin: result.durationMin });
  } catch (e) {
    // best-effort — if OSRM is briefly unreachable, the previous route stays displayed
  }
}

socket.on('drivers:snapshot', (list) => { list.forEach((d) => { drivers.set(d.id, d); knownDriverNames.set(d.id, d.name); }); renderOrders(); });
socket.on('driver:update', (d) => { drivers.set(d.id, d); knownDriverNames.set(d.id, d.name); renderOrders(); });
socket.on('driver:remove', ({ id }) => { drivers.delete(id); renderOrders(); });

socket.on('orders:snapshot', (list) => { list.forEach((o) => orders.set(o.id, o)); renderOrders(); });
socket.on('order:update', (o) => {
  orders.set(o.id, o);
  renderOrders();
  if (o.assignedTo) recomputeRouteForDriver(o.assignedTo);
});
socket.on('order:remove', ({ id }) => { orders.delete(id); renderOrders(); });
