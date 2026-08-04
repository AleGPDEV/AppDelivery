const stopsTextEl = document.getElementById('stops-text');
const loadBtn = document.getElementById('load-btn');
const loadStatusEl = document.getElementById('load-status');
const bulkHintEl = document.getElementById('bulk-hint');
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
const dayGateMsgEl = document.getElementById('day-gate-msg');

function genId() {
  return `o-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const socket = io();

let dayOpen = false;

// Sin un día abierto (ver analiticas.html) no tiene sentido cargar pedidos
// nuevos — quedarían sueltos sin pertenecer a ningún cierre. El servidor
// también rechaza order:add sin día abierto, esto es solo para que no
// parezca que el botón "no anda" sin explicación.
function applyDayGate() {
  dayGateMsgEl.style.display = dayOpen ? 'none' : '';
  newOrderBtn.disabled = !dayOpen;
  loadBtn.disabled = !dayOpen;
}

socket.on('business-day:status', ({ day }) => {
  dayOpen = !!day;
  applyDayGate();
});

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
const FIELD_ORDER = ['phone', 'name', 'orderNumber', 'location', 'amount'];
const FIELD_SAMPLE = {
  phone: '099123456',
  name: 'Matias',
  orderNumber: '3',
  location: 'https://www.google.com/maps?q=-34.7067,-55.9607',
  amount: '$ 1.630,00',
};
let formConfig = { customFields: [] };

function customFields() {
  return formConfig.customFields || [];
}

function labelFor(key) {
  return FIELD_LABELS[key] || (customFields().find((f) => f.key === key) || {}).label || key;
}

// Qué campos están activos y en qué orden — la carga masiva (pegado de
// planilla) sigue exactamente esta lista, así una columna de menos o de más
// nunca desalinea el resto de la fila. Los personalizados van siempre al
// final, en el orden en que se crearon.
function visibleFieldOrder() {
  const builtins = FIELD_ORDER.filter((key) => (formConfig[key] || { visible: true }).visible !== false);
  const customs = customFields().filter((f) => f.visible !== false).map((f) => f.key);
  return [...builtins, ...customs];
}

function updateBulkHint() {
  const fields = visibleFieldOrder();
  const labels = fields.map(labelFor);
  bulkHintEl.textContent = fields.length > 0
    ? `Formato (separado por tabulación, pegado directo de una planilla): ${labels.join(' · ')}. Si alguno falla, se avisa y el resto sigue cargando igual.`
    : 'Activá al menos un campo en "Personalizar campos del formulario" para poder cargar pedidos.';
  stopsTextEl.placeholder = fields.map((k) => FIELD_SAMPLE[k] || labelFor(k)).join('\t');
}

function customFieldInputId(key) {
  return `custom-field-${key}`;
}

// Los campos personalizados no tienen un <input> fijo en el HTML (no se sabe
// de antemano cuáles va a crear el admin) — se arman acá cada vez que cambia
// la configuración.
function renderCustomFieldInputs() {
  const container = document.getElementById('custom-fields-container');
  container.innerHTML = '';
  customFields().forEach((f) => {
    if (f.visible === false) return;
    const div = document.createElement('div');
    div.className = 'field';
    const label = document.createElement('label');
    label.textContent = f.label;
    label.htmlFor = customFieldInputId(f.key);
    const input = document.createElement('input');
    input.type = 'text';
    input.id = customFieldInputId(f.key);
    div.append(label, input);
    container.appendChild(div);
  });
}

function applyFormConfig() {
  Object.keys(FIELD_LABELS).forEach((key) => {
    const wrapper = document.querySelector(`[data-field="${key}"]`);
    const cfg = formConfig[key] || { visible: true, required: false };
    if (wrapper) wrapper.style.display = cfg.visible === false ? 'none' : '';
  });
  renderCustomFieldInputs();
  updateBulkHint();
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

  customFields().forEach((f) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '16px';
    row.style.padding = '6px 0';

    const label = document.createElement('span');
    label.style.flex = '1';
    label.textContent = f.label;

    const visibleLabel = document.createElement('label');
    visibleLabel.style.display = 'flex';
    visibleLabel.style.alignItems = 'center';
    visibleLabel.style.gap = '4px';
    visibleLabel.style.fontSize = '0.85rem';
    const visibleCheck = document.createElement('input');
    visibleCheck.type = 'checkbox';
    visibleCheck.checked = f.visible !== false;
    visibleLabel.append(visibleCheck, 'Mostrar');

    const requiredLabel = document.createElement('label');
    requiredLabel.style.display = 'flex';
    requiredLabel.style.alignItems = 'center';
    requiredLabel.style.gap = '4px';
    requiredLabel.style.fontSize = '0.85rem';
    const requiredCheck = document.createElement('input');
    requiredCheck.type = 'checkbox';
    requiredCheck.checked = !!f.required;
    requiredCheck.disabled = !visibleCheck.checked;
    requiredLabel.append(requiredCheck, 'Obligatorio');

    function emitUpdate() {
      requiredCheck.disabled = !visibleCheck.checked;
      formConfig = {
        ...formConfig,
        customFields: customFields().map((x) => (x.key === f.key
          ? { ...x, visible: visibleCheck.checked, required: visibleCheck.checked && requiredCheck.checked }
          : x)),
      };
      socket.emit('form-config:update', formConfig);
    }
    visibleCheck.addEventListener('change', emitUpdate);
    requiredCheck.addEventListener('change', emitUpdate);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger small';
    delBtn.textContent = 'Eliminar';
    delBtn.addEventListener('click', () => {
      formConfig = { ...formConfig, customFields: customFields().filter((x) => x.key !== f.key) };
      socket.emit('form-config:update', formConfig);
    });

    row.append(label, visibleLabel, requiredLabel, delBtn);
    fieldConfigListEl.appendChild(row);
  });

  const addRow = document.createElement('div');
  addRow.style.display = 'flex';
  addRow.style.gap = '8px';
  addRow.style.marginTop = '10px';
  const newFieldInput = document.createElement('input');
  newFieldInput.type = 'text';
  newFieldInput.placeholder = 'Nombre del campo nuevo (ej: Piso)';
  newFieldInput.style.flex = '1';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'primary small';
  addBtn.textContent = 'Agregar campo';
  addBtn.addEventListener('click', () => {
    const label = newFieldInput.value.trim();
    if (!label) return;
    const key = `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    formConfig = { ...formConfig, customFields: [...customFields(), { key, label, visible: true, required: false }] };
    socket.emit('form-config:update', formConfig);
    newFieldInput.value = '';
  });
  addRow.append(newFieldInput, addBtn);
  fieldConfigListEl.appendChild(addRow);
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

socket.on('drivers:snapshot', (list) => { list.forEach((d) => drivers.set(d.id, d)); renderAssignOptions(); });
// El GPS manda `driver:update` cada pocos segundos — redibujar el <select>
// "Asignar a" en cada uno lo cerraría solo si lo tenías abierto para elegir.
// Solo hace falta redibujar cuando aparece un delivery nuevo o cambia su nombre.
socket.on('driver:update', (d) => {
  const existing = drivers.get(d.id);
  const needsRerender = !existing || existing.name !== d.name;
  drivers.set(d.id, d);
  if (needsRerender) renderAssignOptions();
});
socket.on('driver:remove', ({ id }) => { drivers.delete(id); renderAssignOptions(); });

socket.on('orders:snapshot', (list) => list.forEach((o) => orders.set(o.id, o)));
socket.on('order:update', (o) => {
  orders.set(o.id, o);
  if (o.assignedTo) recomputeRouteForDriver(o.assignedTo);
});
socket.on('order:remove', ({ id }) => orders.delete(id));

loadBtn.addEventListener('click', async () => {
  const fields = visibleFieldOrder();
  const rows = Geo.parseStopsText(stopsTextEl.value, fields);
  if (rows.length === 0) {
    loadStatusEl.textContent = 'Pegá al menos un pedido.';
    loadStatusEl.className = 'status error';
    return;
  }

  loadBtn.disabled = true;
  let okCount = 0;
  const failed = [];

  for (let i = 0; i < rows.length; i++) {
    const { order, raw, amount, phone, name, custom } = rows[i];
    const label = order ? `el pedido #${order} (línea ${i + 1})` : `la línea ${i + 1}`;
    let point = null;
    if (raw) {
      try {
        point = await Geo.resolveInput(raw, label, (msg) => {
          loadStatusEl.textContent = msg;
          loadStatusEl.className = 'status';
        });
      } catch (e) {
        failed.push(`${order ? `#${order}` : `línea ${i + 1}`}: ${e.message}`);
        continue;
      }
    }
    socket.emit('order:add', { id: genId(), orderNumber: order, phone, name, lat: point ? point.lat : null, lng: point ? point.lng : null, label: point ? point.label : '', amount, custom });
    okCount++;
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
  const missingCustomFields = customFields().filter((f) => {
    if (f.visible === false || !f.required) return false;
    const input = document.getElementById(customFieldInputId(f.key));
    return !input || !input.value.trim();
  });
  if (missing.length > 0 || missingCustomFields.length > 0) {
    const labels = [...missing.map(labelFor), ...missingCustomFields.map((f) => f.label)];
    newOrderStatusEl.textContent = `Falta completar: ${labels.join(', ')}.`;
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
  const custom = {};
  customFields().forEach((f) => {
    if (f.visible === false) return;
    const input = document.getElementById(customFieldInputId(f.key));
    if (input) custom[f.key] = input.value.trim();
  });

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
    custom,
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
  customFields().forEach((f) => {
    const input = document.getElementById(customFieldInputId(f.key));
    if (input) input.value = '';
  });
  newOrderBtn.disabled = false;
});
