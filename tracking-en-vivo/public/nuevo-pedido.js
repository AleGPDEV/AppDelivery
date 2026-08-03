const stopsTextEl = document.getElementById('stops-text');
const loadBtn = document.getElementById('load-btn');
const loadStatusEl = document.getElementById('load-status');
const newPhoneEl = document.getElementById('new-phone');
const newNameEl = document.getElementById('new-name');
const newOrderNumEl = document.getElementById('new-ordernum');
const newLocationEl = document.getElementById('new-location');
const newAmountEl = document.getElementById('new-amount');
const newAssignEl = document.getElementById('new-assign');
const newOrderBtn = document.getElementById('new-order-btn');
const newOrderStatusEl = document.getElementById('new-order-status');
const fieldConfigListEl = document.getElementById('field-config-list');
const pwCurrentEl = document.getElementById('pw-current');
const pwNewEl = document.getElementById('pw-new');
const pwBtnEl = document.getElementById('pw-btn');
const pwStatusEl = document.getElementById('pw-status');

function genId() {
  return `o-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const socket = io();

// This page only needs drivers' live positions (to compute routes and offer
// them in the "Asignar a" dropdown) — no map, no order list rendering here.
const drivers = new Map(); // driverId -> { name, lat, lng, color }
const orders = new Map(); // orderId -> order data, kept locally just so a freshly-created order can be routed right away

// Which fields the admin chose to show/require in the form below — persisted
// server-side (Supabase) so it applies for every device, not just this one.
const FIELD_LABELS = {
  phone: 'Celular',
  name: 'Nombre',
  orderNumber: 'Nº de pedido',
  location: 'Ubicación de entrega',
  amount: 'Monto',
};
let formConfig = {};

function applyFormConfig() {
  Object.keys(FIELD_LABELS).forEach((key) => {
    const wrapper = document.querySelector(`[data-field="${key}"]`);
    const cfg = formConfig[key] || { visible: true, required: false };
    if (wrapper) wrapper.style.display = cfg.visible === false ? 'none' : '';
  });
}

function renderFieldConfig() {
  fieldConfigListEl.innerHTML = '';
  Object.keys(FIELD_LABELS).forEach((key) => {
    const cfg = formConfig[key] || { visible: true, required: false };
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '16px';
    row.style.padding = '6px 0';

    const label = document.createElement('span');
    label.style.flex = '1';
    label.textContent = FIELD_LABELS[key];

    const visibleLabel = document.createElement('label');
    visibleLabel.style.display = 'flex';
    visibleLabel.style.alignItems = 'center';
    visibleLabel.style.gap = '4px';
    visibleLabel.style.fontSize = '0.85rem';
    const visibleCheck = document.createElement('input');
    visibleCheck.type = 'checkbox';
    visibleCheck.checked = cfg.visible !== false;
    visibleLabel.append(visibleCheck, 'Mostrar');

    const requiredLabel = document.createElement('label');
    requiredLabel.style.display = 'flex';
    requiredLabel.style.alignItems = 'center';
    requiredLabel.style.gap = '4px';
    requiredLabel.style.fontSize = '0.85rem';
    const requiredCheck = document.createElement('input');
    requiredCheck.type = 'checkbox';
    requiredCheck.checked = !!cfg.required;
    requiredCheck.disabled = !visibleCheck.checked;
    requiredLabel.append(requiredCheck, 'Obligatorio');

    function emitUpdate() {
      requiredCheck.disabled = !visibleCheck.checked;
      formConfig = { ...formConfig, [key]: { visible: visibleCheck.checked, required: visibleCheck.checked && requiredCheck.checked } };
      socket.emit('form-config:update', formConfig);
    }
    visibleCheck.addEventListener('change', emitUpdate);
    requiredCheck.addEventListener('change', emitUpdate);

    row.append(label, visibleLabel, requiredLabel);
    fieldConfigListEl.appendChild(row);
  });
}

socket.on('form-config:snapshot', (cfg) => {
  formConfig = cfg || {};
  applyFormConfig();
  renderFieldConfig();
});

pwBtnEl.addEventListener('click', async () => {
  const currentPassword = pwCurrentEl.value;
  const newPassword = pwNewEl.value;
  pwBtnEl.disabled = true;
  pwStatusEl.textContent = '';
  try {
    const res = await fetch('/api/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo cambiar la contraseña.');
    pwStatusEl.textContent = 'Contraseña actualizada.';
    pwStatusEl.className = 'status ok';
    pwCurrentEl.value = '';
    pwNewEl.value = '';
  } catch (e) {
    pwStatusEl.textContent = e.message;
    pwStatusEl.className = 'status error';
  }
  pwBtnEl.disabled = false;
});

function renderAssignOptions() {
  const previousValue = newAssignEl.value;
  newAssignEl.innerHTML = '<option value="">Sin asignar</option>';
  drivers.forEach((d, driverId) => {
    const opt = document.createElement('option');
    opt.value = driverId;
    opt.textContent = d.name;
    newAssignEl.appendChild(opt);
  });
  newAssignEl.value = previousValue;
}

// Recomputes and broadcasts the optimal route for everything currently
// assigned to this driver, starting from their last known live position —
// same logic as pedidos.js, kept independent since these are separate pages.
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

socket.on('drivers:snapshot', (list) => { list.forEach((d) => drivers.set(d.id, d)); renderAssignOptions(); });
socket.on('driver:update', (d) => { drivers.set(d.id, d); renderAssignOptions(); });
socket.on('driver:remove', ({ id }) => { drivers.delete(id); renderAssignOptions(); });

socket.on('orders:snapshot', (list) => list.forEach((o) => orders.set(o.id, o)));
socket.on('order:update', (o) => {
  orders.set(o.id, o);
  if (o.assignedTo) recomputeRouteForDriver(o.assignedTo);
});
socket.on('order:remove', ({ id }) => orders.delete(id));

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
    const { order, raw, amount, paymentMethod } = rows[i];
    const label = order ? `el pedido #${order} (línea ${i + 1})` : `la línea ${i + 1}`;
    try {
      const point = await Geo.resolveInput(raw, label, (msg) => {
        loadStatusEl.textContent = msg;
        loadStatusEl.className = 'status';
      });
      socket.emit('order:add', { id: genId(), orderNumber: order, lat: point.lat, lng: point.lng, label: point.label, amount, paymentMethod });
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

const FIELD_INPUTS = {
  phone: newPhoneEl,
  name: newNameEl,
  orderNumber: newOrderNumEl,
  location: newLocationEl,
  amount: newAmountEl,
};

newOrderBtn.addEventListener('click', async () => {
  const missing = Object.keys(FIELD_INPUTS).filter((key) => {
    const cfg = formConfig[key];
    return cfg && cfg.visible !== false && cfg.required && !FIELD_INPUTS[key].value.trim();
  });
  if (missing.length > 0) {
    newOrderStatusEl.textContent = `Falta completar: ${missing.map((k) => FIELD_LABELS[k]).join(', ')}.`;
    newOrderStatusEl.className = 'status error';
    return;
  }

  const orderNumber = newOrderNumEl.value.trim();
  newOrderBtn.disabled = true;
  const locationRaw = newLocationEl.value.trim();
  const phone = newPhoneEl.value.trim();
  const name = newNameEl.value.trim();
  const assignTo = newAssignEl.value || null;
  const amount = Geo.parseAmount(newAmountEl.value);

  let point = null;
  if (locationRaw) {
    try {
      point = await Geo.resolveInput(locationRaw, `el pedido #${orderNumber}`, (msg) => {
        newOrderStatusEl.textContent = msg;
        newOrderStatusEl.className = 'status';
      });
    } catch (e) {
      newOrderStatusEl.textContent = e.message;
      newOrderStatusEl.className = 'status error';
      newOrderBtn.disabled = false;
      return;
    }
  }

  const id = genId();
  socket.emit('order:add', {
    id,
    orderNumber,
    phone,
    name,
    lat: point ? point.lat : null,
    lng: point ? point.lng : null,
    label: point ? point.label : '',
    amount,
  });
  if (assignTo) {
    socket.emit('order:assign', { id, driverId: assignTo });
  }

  newOrderStatusEl.textContent = `Pedido #${orderNumber} agregado.`;
  newOrderStatusEl.className = 'status ok';
  newPhoneEl.value = '';
  newNameEl.value = '';
  newOrderNumEl.value = '';
  newLocationEl.value = '';
  newAmountEl.value = '';
  newAssignEl.value = '';
  newOrderBtn.disabled = false;
});
