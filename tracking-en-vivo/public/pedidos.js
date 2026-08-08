const orderTheadRowEl = document.getElementById('order-thead-row');
const orderTbodyEl = document.getElementById('order-tbody');
const orderCountEl = document.getElementById('order-count');
const editOverlay = document.getElementById('edit-overlay');
const editCloseBtn = document.getElementById('edit-close-btn');
const editPhoneEl = document.getElementById('edit-phone');
const editNameEl = document.getElementById('edit-name');
const editOrderNumEl = document.getElementById('edit-ordernum');
const editLocationEl = document.getElementById('edit-location');
const editLocationCurrentEl = document.getElementById('edit-location-current');
const editAmountEl = document.getElementById('edit-amount');
const editCustomContainerEl = document.getElementById('edit-custom-fields-container');
const editSaveBtn = document.getElementById('edit-save-btn');
const editStatusEl = document.getElementById('edit-status');
const itemsOverlay = document.getElementById('items-overlay');
const itemsCloseBtn = document.getElementById('items-close-btn');
const itemsListEl = document.getElementById('items-list');
const itemsTotalEl = document.getElementById('items-total');

const STATUS_OPTIONS = [['pending', 'En preparación'], ['en_camino', 'En Camino'], ['entregado', 'Entregado']];

// Antes era una lista fija acá — ahora sale de Ajustes (formConfig.paymentMethods),
// para que un método nuevo aparezca solo, sin tocar código.
function paymentOptions() {
  return [''].concat((formConfig.paymentMethods || []).map((m) => m.name));
}

// Mismas columnas que se pueden ocultar/mostrar desde Ajustes — la tabla
// sigue esa misma elección (igual que el formulario de nuevo-pedido.js).
const FIELD_COLUMNS = [
  { key: 'phone', label: 'Teléfono' },
  { key: 'name', label: 'Nombre' },
  { key: 'orderNumber', label: 'Nº pedido' },
  { key: 'amount', label: 'Monto' },
];
const FIXED_COLUMNS = ['Delivery asignado', 'Método de pago', 'Estado', ''];

const socket = io();

// This page only needs drivers' names/positions for the assign dropdown and
// route recompute — no map here.
const drivers = new Map(); // driverId -> { name, lat, lng, color }
const orders = new Map(); // orderId -> order data
const knownDriverNames = new Map(); // survives a driver going offline, so old assignments still show a name
let formConfig = { customFields: [], paymentMethods: [] };

function visibleFieldColumns() {
  const builtins = FIELD_COLUMNS.filter((c) => (formConfig[c.key] || { visible: true }).visible !== false);
  const customs = (formConfig.customFields || [])
    .filter((f) => f.visible !== false)
    .map((f) => ({ key: f.key, label: f.label }));
  return [...builtins, ...customs];
}

function renderHeader() {
  orderTheadRowEl.innerHTML = '';
  // "Ticket" (seq) va siempre primero y nunca se puede ocultar — es lo único
  // que distingue con seguridad dos pedidos entre sí. "Nº de pedido" lo
  // tipea el admin y se puede repetir a propósito (y ya se puede ocultar
  // desde "Personalizar campos"), así que no sirve como identificador único.
  const tick = document.createElement('th');
  tick.textContent = 'Ticket';
  orderTheadRowEl.appendChild(tick);
  const origin = document.createElement('th');
  origin.textContent = 'Origen';
  orderTheadRowEl.appendChild(origin);
  visibleFieldColumns().forEach((c) => {
    const th = document.createElement('th');
    th.textContent = c.label;
    orderTheadRowEl.appendChild(th);
  });
  FIXED_COLUMNS.forEach((label) => {
    const th = document.createElement('th');
    th.textContent = label;
    orderTheadRowEl.appendChild(th);
  });
}

function fieldCellContent(key, o) {
  if (key === 'phone') return o.phone || '';
  if (key === 'name') return `${o.name || ''}${orderPrecisionTag(o)}`;
  if (key === 'orderNumber') return o.orderNumber || '';
  if (key === 'amount') return o.amount != null ? `$${o.amount.toFixed(2)}` : '';
  return (o.custom && o.custom[key]) || ''; // campo personalizado
}

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
  // Un pedido archivado (día ya finalizado en "Analíticas") sale del registro
  // del día a día — sigue existiendo en Supabase para el histórico/analíticas,
  // pero ya no tiene sentido seguir operándolo acá.
  const active = Array.from(orders.entries()).filter(([, o]) => !o.archivedAt);
  orderCountEl.textContent = active.length === 0
    ? 'Todavía no cargaste ningún pedido.'
    : `${active.length} pedido${active.length === 1 ? '' : 's'} registrado${active.length === 1 ? '' : 's'}.`;

  const sorted = active.sort((a, b) => {
    const byNumber = (a[1].orderNumber || '').localeCompare(b[1].orderNumber || '', undefined, { numeric: true });
    if (byNumber !== 0) return byNumber;
    return (a[1].seq || 0) - (b[1].seq || 0); // desempate estable si el Nº de pedido se repite
  });

  const fieldColumns = visibleFieldColumns();

  sorted.forEach(([id, o]) => {
    const tr = document.createElement('tr');

    const tdTicket = document.createElement('td');
    tdTicket.textContent = o.seq != null ? `#${o.seq}` : '';
    tr.appendChild(tdTicket);

    const tdOrigin = document.createElement('td');
    tdOrigin.textContent = o.source === 'web' ? '🌐 Web' : '';
    tr.appendChild(tdOrigin);

    fieldColumns.forEach((c) => {
      const td = document.createElement('td');
      td.textContent = fieldCellContent(c.key, o);
      tr.appendChild(td);
    });

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
    paymentOptions().forEach((pm) => {
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
    statusSelect.className = 'status-select';
    STATUS_OPTIONS.forEach(([value, text]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      statusSelect.appendChild(opt);
    });
    statusSelect.value = o.status || 'pending';
    statusSelect.dataset.status = statusSelect.value;
    statusSelect.addEventListener('change', () => {
      statusSelect.dataset.status = statusSelect.value;
      socket.emit('order:edit', { id, fields: { status: statusSelect.value } });
    });
    tdStatus.appendChild(statusSelect);

    const tdActions = document.createElement('td');
    tdActions.style.display = 'flex';
    tdActions.style.gap = '4px';

    if (o.items && o.items.length > 0) {
      const itemsBtn = document.createElement('button');
      itemsBtn.type = 'button';
      itemsBtn.className = 'small';
      itemsBtn.textContent = '🧾';
      itemsBtn.title = 'Ver detalle del pedido';
      itemsBtn.addEventListener('click', () => openItemsModal(o));
      tdActions.appendChild(itemsBtn);
    }

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'small';
    editBtn.textContent = '✏️';
    editBtn.title = 'Editar pedido';
    editBtn.addEventListener('click', () => openEditModal(id, o));
    tdActions.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger small';
    delBtn.textContent = '🗑';
    delBtn.title = 'Eliminar pedido';
    // Sin confirm() a propósito: limpiar varios pedidos cargados mal, uno por
    // uno con una ventana de confirmación cada vez, era tedioso.
    delBtn.addEventListener('click', () => {
      socket.emit('order:remove', { id });
    });
    tdActions.appendChild(delBtn);

    tr.append(tdAssign, tdPayment, tdStatus, tdActions);
    orderTbodyEl.appendChild(tr);
  });
}

// Pedido web (source: 'web'): detalle de solo lectura de lo que el cliente
// puso en el carrito — el monto sigue editándose desde "Editar pedido" como
// cualquier otro pedido, esto es solo para ver qué compró.
function openItemsModal(o) {
  itemsListEl.innerHTML = '';
  (o.items || []).forEach((item) => {
    const row = document.createElement('div');
    row.className = 'cart-item';
    const label = document.createElement('span');
    label.textContent = `${item.qty} × ${item.name}`;
    const amount = document.createElement('span');
    amount.textContent = `$${(item.price * item.qty).toFixed(2)}`;
    row.append(label, amount);
    itemsListEl.appendChild(row);
  });
  itemsTotalEl.innerHTML = `<span>Total</span><span>$${(o.amount || 0).toFixed(2)}</span>`;
  itemsOverlay.style.display = 'flex';
}

itemsCloseBtn.addEventListener('click', () => { itemsOverlay.style.display = 'none'; });
itemsOverlay.addEventListener('click', (e) => { if (e.target === itemsOverlay) itemsOverlay.style.display = 'none'; });

// "Editar pedido": a diferencia de los dropdowns sueltos de la tabla (que
// solo tocan estado/forma de pago), esto deja cambiar cualquier campo. El
// cambio se manda por el mismo order:edit de siempre — el delivery lo ve
// actualizado al toque en su lista/mapa, no hace falta avisarle aparte.
let editingOrderId = null;

function openEditModal(id, o) {
  editingOrderId = id;
  editPhoneEl.value = o.phone || '';
  editNameEl.value = o.name || '';
  editOrderNumEl.value = o.orderNumber || '';
  editLocationEl.value = '';
  editLocationCurrentEl.textContent = o.label ? `Ubicación actual: ${o.label}` : 'Sin ubicación (retira en el local).';
  editAmountEl.value = o.amount != null ? o.amount.toFixed(2) : '';
  editStatusEl.textContent = '';
  editStatusEl.className = 'status';

  editCustomContainerEl.innerHTML = '';
  (formConfig.customFields || []).forEach((f) => {
    const div = document.createElement('div');
    div.className = 'field';
    const label = document.createElement('label');
    label.textContent = f.label;
    label.htmlFor = `edit-custom-${f.key}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = `edit-custom-${f.key}`;
    input.value = (o.custom && o.custom[f.key]) || '';
    div.append(label, input);
    editCustomContainerEl.appendChild(div);
  });

  editOverlay.style.display = 'flex';
}

editCloseBtn.addEventListener('click', () => { editOverlay.style.display = 'none'; });
editOverlay.addEventListener('click', (e) => { if (e.target === editOverlay) editOverlay.style.display = 'none'; });

editSaveBtn.addEventListener('click', async () => {
  if (!editingOrderId) return;
  const fields = {
    phone: editPhoneEl.value.trim(),
    name: editNameEl.value.trim(),
    orderNumber: editOrderNumEl.value.trim(),
    amount: Geo.parseAmount(editAmountEl.value) || 0,
  };
  const custom = {};
  (formConfig.customFields || []).forEach((f) => {
    const input = document.getElementById(`edit-custom-${f.key}`);
    if (input) custom[f.key] = input.value.trim();
  });
  if (Object.keys(custom).length > 0) fields.custom = custom;

  const locationRaw = editLocationEl.value.trim();
  if (locationRaw) {
    editSaveBtn.disabled = true;
    try {
      const point = await Geo.resolveInput(locationRaw, 'este pedido', (msg) => {
        editStatusEl.textContent = msg;
        editStatusEl.className = 'status';
      });
      fields.lat = point.lat;
      fields.lng = point.lng;
      fields.label = point.label;
    } catch (e) {
      editStatusEl.textContent = e.message;
      editStatusEl.className = 'status error';
      editSaveBtn.disabled = false;
      return;
    }
  }

  socket.emit('order:edit', { id: editingOrderId, fields });
  editSaveBtn.disabled = false;
  editOverlay.style.display = 'none';
});

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
    .filter(([, o]) => o.assignedTo === driverId && o.lat != null && o.status !== 'entregado' && !o.archivedAt)
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

socket.on('form-config:snapshot', (cfg) => { formConfig = cfg || {}; renderHeader(); renderOrders(); });

socket.on('drivers:snapshot', (list) => { list.forEach((d) => { drivers.set(d.id, d); knownDriverNames.set(d.id, d.name); }); renderOrders(); });
// El GPS del delivery manda `driver:update` cada pocos segundos — si eso
// redibujara toda la tabla cada vez, un <select> que tuvieras abierto (ej.
// "Delivery asignado") se cerraría solo antes de poder elegir una opción.
// Solo hace falta redibujar cuando aparece un delivery nuevo o cambia su
// nombre; la posición no afecta nada de lo que se ve en esta tabla.
socket.on('driver:update', (d) => {
  const existing = drivers.get(d.id);
  const needsRerender = !existing || existing.name !== d.name;
  drivers.set(d.id, d);
  knownDriverNames.set(d.id, d.name);
  if (needsRerender) renderOrders();
});
socket.on('driver:remove', ({ id }) => { drivers.delete(id); renderOrders(); });

socket.on('orders:snapshot', (list) => { list.forEach((o) => orders.set(o.id, o)); renderOrders(); });
socket.on('order:update', (o) => {
  orders.set(o.id, o);
  renderOrders();
  if (o.assignedTo) recomputeRouteForDriver(o.assignedTo);
});
socket.on('order:remove', ({ id }) => { orders.delete(id); renderOrders(); });
