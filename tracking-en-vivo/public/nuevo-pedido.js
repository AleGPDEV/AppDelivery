const stopsTextEl = document.getElementById('stops-text');
const loadBtn = document.getElementById('load-btn');
const loadStatusEl = document.getElementById('load-status');
const bulkHintEl = document.getElementById('bulk-hint');
const newPhoneEl = document.getElementById('new-phone');
const newNameEl = document.getElementById('new-name');
const newOrderNumEl = document.getElementById('new-ordernum');
const newLocationEl = document.getElementById('new-location');
const newLocationFieldEl = document.getElementById('new-location-field');
const deliveryTypePickupBtn = document.getElementById('delivery-type-pickup-btn');
const deliveryTypeShippingBtn = document.getElementById('delivery-type-shipping-btn');
const newAmountEl = document.getElementById('new-amount');
const newAssignEl = document.getElementById('new-assign');
const newOrderBtn = document.getElementById('new-order-btn');
const newOrderStatusEl = document.getElementById('new-order-status');
const dayGateMsgEl = document.getElementById('day-gate-msg');
const orderDupWarningEl = document.getElementById('order-dup-warning');

// Obligatorio elegir uno de los dos — no hay valor por defecto. `null`
// bloquea "Agregar pedido" hasta que se toque alguno de los dos botones.
let deliveryType = null;

function applyDeliveryTypeButtons() {
  deliveryTypePickupBtn.className = deliveryType === 'retira' ? 'primary small' : 'small';
  deliveryTypeShippingBtn.className = deliveryType === 'envio' ? 'primary small' : 'small';
  newLocationFieldEl.style.display = deliveryType === 'envio' ? '' : 'none';
}

deliveryTypePickupBtn.addEventListener('click', () => {
  deliveryType = 'retira';
  newLocationEl.value = '';
  applyDeliveryTypeButtons();
});
deliveryTypeShippingBtn.addEventListener('click', () => {
  deliveryType = 'envio';
  applyDeliveryTypeButtons();
});

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

// Aviso (no bloqueante) si el número de pedido ya está en uso por otro pedido
// activo — no impide cargar, solo evita que dos pedidos distintos con el
// mismo número se confundan entre sí en el registro.
function findActiveOrderByNumber(number) {
  if (!number) return null;
  for (const o of orders.values()) {
    if (!o.archivedAt && o.orderNumber === number) return o;
  }
  return null;
}

newOrderNumEl.addEventListener('input', () => {
  const match = findActiveOrderByNumber(newOrderNumEl.value.trim());
  orderDupWarningEl.style.display = match ? '' : 'none';
  orderDupWarningEl.textContent = match ? `Ya hay un pedido activo con este número${match.name ? ` (${match.name})` : ''} — se puede cargar igual.` : '';
});

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
// nunca desalinea el resto de la fila, y siempre coincide con lo que pide el
// formulario individual de arriba. Los personalizados van siempre al final,
// en el orden en que se crearon. `location` no pasa por acá — siempre va
// (el "retira o envía" de cada línea se infiere de si trae ubicación o no).
function visibleFieldOrder() {
  const builtins = FIELD_ORDER.filter((key) => key === 'location' || (formConfig[key] || { visible: true }).visible !== false);
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
  // location no pasa por acá — tiene su propio mecanismo (el toggle
  // Retira/Envío, ver applyDeliveryTypeButtons).
  ['phone', 'name', 'orderNumber', 'amount'].forEach((key) => {
    const wrapper = document.querySelector(`[data-field="${key}"]`);
    const cfg = formConfig[key] || { visible: true, required: false };
    if (wrapper) wrapper.style.display = cfg.visible === false ? 'none' : '';
  });
  renderCustomFieldInputs();
  updateBulkHint();
}

socket.on('form-config:snapshot', (cfg) => {
  formConfig = cfg || {};
  applyFormConfig();
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
  const duplicates = []; // aviso, no bloquea la carga
  const seenInBatch = new Set();

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
    if (order && (findActiveOrderByNumber(order) || seenInBatch.has(order))) duplicates.push(`#${order}`);
    if (order) seenInBatch.add(order);
    socket.emit('order:add', { id: genId(), orderNumber: order, phone, name, lat: point ? point.lat : null, lng: point ? point.lng : null, label: point ? point.label : '', amount, custom, pickup: !raw });
    okCount++;
  }

  loadBtn.disabled = false;
  let msg = failed.length === 0
    ? `Se cargaron ${okCount} pedido${okCount === 1 ? '' : 's'} correctamente.`
    : `${okCount} cargados. ${failed.length} con problemas:\n${failed.join('\n')}`;
  if (duplicates.length > 0) msg += `\nOjo, número de pedido repetido: ${duplicates.join(', ')}.`;
  loadStatusEl.textContent = msg;
  loadStatusEl.className = failed.length === 0 ? 'status ok' : 'status error';
  if (failed.length === 0) stopsTextEl.value = '';
});

// Tipo de envío es lo único realmente fijo (no queda otra: o retira o
// envía). Celular/Nombre/Nº de pedido/Monto vuelven a depender de Ajustes,
// igual que un campo personalizado.
const FIELD_INPUTS = {
  phone: newPhoneEl,
  name: newNameEl,
  orderNumber: newOrderNumEl,
  amount: newAmountEl,
};

newOrderBtn.addEventListener('click', async () => {
  const missing = Object.keys(FIELD_INPUTS).filter((key) => {
    const cfg = formConfig[key];
    return cfg && cfg.visible !== false && cfg.required && !FIELD_INPUTS[key].value.trim();
  }).map(labelFor);
  if (!deliveryType) missing.push('Tipo de envío (Retira/Envío)');
  const missingCustomFields = customFields().filter((f) => {
    if (f.visible === false || !f.required) return false;
    const input = document.getElementById(customFieldInputId(f.key));
    return !input || !input.value.trim();
  });
  if (missing.length > 0 || missingCustomFields.length > 0) {
    const labels = [...missing, ...missingCustomFields.map((f) => f.label)];
    newOrderStatusEl.textContent = `Falta completar: ${labels.join(', ')}.`;
    newOrderStatusEl.className = 'status error';
    return;
  }
  if (deliveryType === 'envio' && !newLocationEl.value.trim()) {
    newOrderStatusEl.textContent = 'Falta completar: Ubicación de entrega.';
    newOrderStatusEl.className = 'status error';
    return;
  }

  const orderNumber = newOrderNumEl.value.trim();
  newOrderBtn.disabled = true;
  const locationRaw = deliveryType === 'envio' ? newLocationEl.value.trim() : '';
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
    pickup: deliveryType === 'retira',
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
  deliveryType = null;
  applyDeliveryTypeButtons();
  customFields().forEach((f) => {
    const input = document.getElementById(customFieldInputId(f.key));
    if (input) input.value = '';
  });
  newOrderBtn.disabled = false;
});
