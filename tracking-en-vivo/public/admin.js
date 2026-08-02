const stopsTextEl = document.getElementById('stops-text');
const loadBtn = document.getElementById('load-btn');
const loadStatusEl = document.getElementById('load-status');
const driverListEl = document.getElementById('driver-list');
const orderListEl = document.getElementById('order-list');
const orderCountEl = document.getElementById('order-count');

const socket = io();

// id -> data, kept in sync with the server via socket events
const drivers = new Map();
const orders = new Map();
const knownDriverNames = new Map(); // survives a driver going offline, so old assignments still show a name

function driverLabel(id) {
  const d = drivers.get(id);
  if (d) return d.name;
  return knownDriverNames.get(id) || 'delivery desconectado';
}

function renderDrivers() {
  driverListEl.innerHTML = '';
  if (drivers.size === 0) {
    driverListEl.innerHTML = '<li class="empty">Ningún delivery está compartiendo su ubicación ahora mismo.</li>';
    return;
  }
  drivers.forEach((d) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="swatch" style="background:${d.color}"></span> ${d.name}`;
    driverListEl.appendChild(li);
  });
}

function orderPrecisionTag(o) {
  if (o.precision === 'street') return ' (aproximado: a nivel de calle, revisar)';
  if (o.precision === 'exact') return ' (verificar pin en el mapa)';
  return '';
}

function renderOrders() {
  orderListEl.innerHTML = '';
  orderCountEl.textContent = orders.size === 0
    ? 'Todavía no cargaste ningún pedido.'
    : `${orders.size} pedido${orders.size === 1 ? '' : 's'} pendiente${orders.size === 1 ? '' : 's'}.`;

  const sorted = Array.from(orders.entries()).sort((a, b) => (a[1].orderNumber || '').localeCompare(b[1].orderNumber || '', undefined, { numeric: true }));

  sorted.forEach(([id, o]) => {
    const li = document.createElement('li');

    const info = document.createElement('span');
    info.className = 'order-info';
    info.textContent = `#${o.orderNumber || '?'} — ${o.label}${orderPrecisionTag(o)}`;

    const select = document.createElement('select');
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'Sin asignar';
    select.appendChild(noneOpt);
    drivers.forEach((d, driverId) => {
      const opt = document.createElement('option');
      opt.value = driverId;
      opt.textContent = d.name;
      select.appendChild(opt);
    });
    if (o.assignedTo && !drivers.has(o.assignedTo)) {
      const opt = document.createElement('option');
      opt.value = o.assignedTo;
      opt.textContent = `${driverLabel(o.assignedTo)} (desconectado)`;
      select.appendChild(opt);
    }
    select.value = o.assignedTo || '';
    select.addEventListener('change', () => assignOrder(id, select.value || null));

    li.appendChild(info);
    li.appendChild(select);
    orderListEl.appendChild(li);
  });
}

function assignOrder(orderId, driverId) {
  const order = orders.get(orderId);
  const previousDriverId = order ? order.assignedTo : null;
  socket.emit('order:assign', { id: orderId, driverId });
  if (order) order.assignedTo = driverId;
  renderOrders();
  recomputeRouteForDriver(previousDriverId);
  recomputeRouteForDriver(driverId);
}

// Recomputes and broadcasts the optimal route for everything currently
// assigned to this driver, starting from their last known live position.
async function recomputeRouteForDriver(driverId) {
  if (!driverId) return;
  const driver = drivers.get(driverId);
  if (!driver) return;

  const assigned = Array.from(orders.entries())
    .filter(([, o]) => o.assignedTo === driverId)
    .map(([id, o]) => ({ id, lat: o.lat, lng: o.lng, label: o.label, orderNumber: o.orderNumber }));

  if (assigned.length === 0) {
    socket.emit('driver:route', { driverId, stops: [], latlngs: [] });
    return;
  }

  try {
    const result = await Geo.computeRoute({ lat: driver.lat, lng: driver.lng }, assigned);
    const stops = result.orderedPoints.slice(1).map(p => ({ id: p.id, lat: p.lat, lng: p.lng, label: p.label, orderNumber: p.orderNumber }));
    socket.emit('driver:route', {
      driverId,
      stops,
      latlngs: result.latlngs,
      distanceKm: result.distanceKm,
      durationMin: result.durationMin,
    });
  } catch (e) {
    // Best-effort: if OSRM is briefly unreachable, the previous route stays displayed.
  }
}

socket.on('drivers:snapshot', (list) => {
  list.forEach((d) => { drivers.set(d.id, d); knownDriverNames.set(d.id, d.name); });
  renderDrivers();
  renderOrders();
});
socket.on('driver:update', (d) => {
  drivers.set(d.id, d);
  knownDriverNames.set(d.id, d.name);
  renderDrivers();
  renderOrders();
});
socket.on('driver:remove', ({ id }) => {
  drivers.delete(id);
  renderDrivers();
  renderOrders();
});

socket.on('orders:snapshot', (list) => {
  list.forEach((o) => orders.set(o.id, o));
  renderOrders();
});
socket.on('order:update', (o) => {
  orders.set(o.id, o);
  renderOrders();
});
socket.on('order:remove', ({ id }) => {
  const wasAssignedTo = orders.get(id)?.assignedTo;
  orders.delete(id);
  renderOrders();
  // Covers both a driver marking it delivered and an admin removing it —
  // either way, that driver's route needs to drop this stop.
  if (wasAssignedTo) recomputeRouteForDriver(wasAssignedTo);
});

loadBtn.addEventListener('click', async () => {
  const rows = Geo.parseStopsText(stopsTextEl.value);
  if (rows.length === 0) {
    loadStatusEl.textContent = 'Pegá al menos un pedido (número de pedido + ubicación).';
    loadStatusEl.className = 'status error';
    return;
  }

  loadBtn.disabled = true;
  let okCount = 0;
  const failed = [];

  for (let i = 0; i < rows.length; i++) {
    const { order, raw } = rows[i];
    const label = order ? `el pedido #${order} (línea ${i + 1})` : `la línea ${i + 1}`;
    try {
      const point = await Geo.resolveInput(raw, label, (msg) => {
        loadStatusEl.textContent = msg;
        loadStatusEl.className = 'status';
      });
      socket.emit('order:add', { orderNumber: order, lat: point.lat, lng: point.lng, label: point.label });
      okCount++;
    } catch (e) {
      failed.push(`${order ? `#${order}` : `línea ${i + 1}`}: ${e.message}`);
    }
  }

  loadBtn.disabled = false;
  if (failed.length === 0) {
    loadStatusEl.textContent = `Se cargaron ${okCount} pedido${okCount === 1 ? '' : 's'} correctamente.`;
    loadStatusEl.className = 'status ok';
    stopsTextEl.value = '';
  } else {
    loadStatusEl.textContent = `${okCount} cargados. ${failed.length} con problemas:\n${failed.join('\n')}`;
    loadStatusEl.className = 'status error';
  }
});
