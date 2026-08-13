import { Store } from '/js/store.js';
import { Router } from '/js/router.js';
import { recomputeRouteForDriver } from '/js/route-helper.js';
import { createDriverLabel } from '/js/driver-label.js';
import { createMapPanel } from '/js/map-panel.js';
import { initReorderDrag } from '/js/reorder-drag.js';
import { template as newOrderFormTemplate, mount as mountNewOrderForm, unmount as unmountNewOrderForm } from '/js/views/nuevo-pedido.js';

// Mapa y "Deliverys activos y pedidos asignados" son 2 paneles flotantes
// (`.pedidos-float-panel`, `position:absolute`) que se despliegan por
// encima de la tabla al tocar su barra -- a pedido explícito: NO tienen que
// modificar el tamaño/posición del contenedor de "Registro de pedidos" ni
// empujarlo, a diferencia de una sección colapsable normal que sí ocupa
// lugar real en el documento. Arrancan cerrados (ver mount()) para que la
// tabla tenga el máximo espacio posible por defecto. Pedidos se queda solo
// con lo operativo (entran los pedidos, se asignan, se controla qué tiene
// cada delivery y sus rutas) — el desglose de dinero por delivery se mudó a
// Día Comercial junto con el resto de lo administrativo (ver analiticas.js).
// Arrastrar pedidos con un orden personalizado y "separadores" (barreras
// con texto) que se pueden intercalar entre pedidos sigue igual: el orden
// se guarda para todos (persistido en Supabase vía
// order:reorder/separator:*), no es una preferencia local de quien mira.
const template = `
<main class="wide">
  <div class="pedidos-float-triggers">
    <div class="pedidos-float-wrap">
      <button id="map-toggle-btn" type="button" class="pedidos-float-trigger">
        <span id="driver-count" class="driver-count" style="margin:0;">Esperando deliverys conectados...</span>
        <span class="pedidos-float-caret">▾</span>
      </button>
      <div id="pedidos-map-panel" class="pedidos-float-panel" aria-hidden="true">
        <div id="map"></div>
      </div>
    </div>

    <div class="pedidos-float-wrap">
      <button id="assigned-toggle-btn" type="button" class="pedidos-float-trigger">
        <span>Deliverys activos y pedidos asignados</span>
        <span class="pedidos-float-caret">▾</span>
      </button>
      <div id="pedidos-assigned-panel" class="pedidos-float-panel" aria-hidden="true">
        <p id="assigned-empty" class="hint" hidden>Todavía no hay deliverys conectados.</p>
        <div id="assigned-cards"></div>
      </div>
    </div>
  </div>

  <section class="panel">
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
      <h2 style="margin:0;">Registro de pedidos</h2>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button id="add-separator-btn" type="button" class="small">+ Agregar separador</button>
        <button id="new-order-open-btn" type="button" class="primary small">+ Nuevo pedido</button>
      </div>
    </div>
    <p id="order-count" class="driver-count">Todavía no cargaste ningún pedido.</p>
    <div class="table-scroll">
      <table class="order-table">
        <thead>
          <tr id="order-thead-row"></tr>
        </thead>
        <tbody id="order-tbody"></tbody>
      </table>
    </div>
  </section>
</main>

<div id="new-order-overlay" class="modal-overlay" style="display:none;">
  <div class="modal-box">
    <button id="new-order-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
    <h2>Nuevo pedido</h2>
    <div id="new-order-modal-body"></div>
  </div>
</div>

<div id="items-overlay" class="modal-overlay" style="display:none;">
  <div class="modal-box">
    <button id="items-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
    <h2>Detalle del pedido</h2>
    <div id="items-list"></div>
    <div id="items-total" class="cart-total"></div>
  </div>
</div>

<div id="edit-overlay" class="modal-overlay" style="display:none;">
  <div class="modal-box">
    <button id="edit-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
    <h2>Editar pedido</h2>
    <div class="field">
      <label for="edit-phone">Celular</label>
      <input type="text" id="edit-phone">
    </div>
    <div class="field">
      <label for="edit-name">Nombre</label>
      <input type="text" id="edit-name">
    </div>
    <div class="field">
      <label for="edit-ordernum">Nº de pedido</label>
      <input type="text" id="edit-ordernum">
    </div>
    <div class="field">
      <label for="edit-location">Ubicación (dejar vacío para no cambiarla)</label>
      <input type="text" id="edit-location" placeholder="Link de Google Maps, dirección o coordenadas">
      <p id="edit-location-current" class="hint"></p>
    </div>
    <div class="field">
      <label for="edit-amount">Monto</label>
      <input type="text" id="edit-amount">
    </div>
    <div id="edit-custom-fields-container"></div>
    <button id="edit-save-btn" type="button" class="primary">Guardar cambios</button>
    <p id="edit-status" class="status"></p>
  </div>
</div>
`;

const STATUS_OPTIONS = [['pending', 'En preparación'], ['en_camino', 'En Camino'], ['entregado', 'Entregado']];

const FIELD_COLUMNS = [
  { key: 'phone', label: 'Teléfono' },
  { key: 'name', label: 'Nombre' },
  { key: 'orderNumber', label: 'Nº pedido' },
  { key: 'amount', label: 'Monto' },
];

// Token de "generación": mismo mecanismo que dashboard.js — mount() es
// async (espera a que cargue Google Maps), y si el usuario navega a otra
// pestaña durante esa espera, la continuación no debe tocar un DOM que ya
// no está montado.
let currentGeneration = 0;
let active = null; // { mapPanel, unsubscribe, teardownDriverLabel } de la instancia montada

function teardownActive() {
  if (!active) return;
  active.mapPanel.teardown();
  active.unsubscribe();
  active.teardownDriverLabel();
  clearInterval(active.freshnessIntervalId);
  active = null;
}

async function mount(root) {
  const myGeneration = ++currentGeneration;
  const driverCountEl = root.querySelector('#driver-count');
  const orderTheadRowEl = root.querySelector('#order-thead-row');
  const orderTbodyEl = root.querySelector('#order-tbody');
  const orderCountEl = root.querySelector('#order-count');
  const addSeparatorBtn = root.querySelector('#add-separator-btn');
  const editOverlay = root.querySelector('#edit-overlay');
  const editCloseBtn = root.querySelector('#edit-close-btn');
  const editPhoneEl = root.querySelector('#edit-phone');
  const editNameEl = root.querySelector('#edit-name');
  const editOrderNumEl = root.querySelector('#edit-ordernum');
  const editLocationEl = root.querySelector('#edit-location');
  const editLocationCurrentEl = root.querySelector('#edit-location-current');
  const editAmountEl = root.querySelector('#edit-amount');
  const editCustomContainerEl = root.querySelector('#edit-custom-fields-container');
  const editSaveBtn = root.querySelector('#edit-save-btn');
  const editStatusEl = root.querySelector('#edit-status');
  const itemsOverlay = root.querySelector('#items-overlay');
  const itemsCloseBtn = root.querySelector('#items-close-btn');
  const itemsListEl = root.querySelector('#items-list');
  const itemsTotalEl = root.querySelector('#items-total');
  const newOrderOpenBtn = root.querySelector('#new-order-open-btn');
  const newOrderOverlay = root.querySelector('#new-order-overlay');
  const newOrderCloseBtn = root.querySelector('#new-order-close-btn');
  const newOrderModalBodyEl = root.querySelector('#new-order-modal-body');
  const assignedCardsEl = root.querySelector('#assigned-cards');
  const assignedEmptyEl = root.querySelector('#assigned-empty');

  // #map arranca dentro de un panel flotante cerrado -- a diferencia de la
  // primera versión de este panel, ahora se oculta con `visibility:hidden`
  // (no `display:none`, ver `.pedidos-float-panel` en style.css) para poder
  // animar la apertura/cierre, lo que de paso evita el bug de "Google Maps
  // mide 0x0 porque nace oculto" (ver seguimiento.html) -- el contenedor
  // tiene un tamaño real incluso cerrado. `toggleFloat('map', ...)` más
  // abajo igual dispara un resize + reencuadre al abrir, como backstop.
  const mapPanel = await createMapPanel(root.querySelector('#map'), { driverCountEl });
  if (myGeneration !== currentGeneration) { mapPanel.teardown(); return; } // se navegó a otra vista mientras cargaba

  // Mapa y "Deliverys activos" son paneles flotantes (`position:absolute`,
  // ver style.css) que se despliegan encima de la tabla sin empujarla ni
  // cambiarle el tamaño -- a diferencia de una sección colapsable normal.
  // Arrancan cerrados; tocar la barra abre uno y cierra el otro (no tiene
  // sentido tener los dos flotando a la vez, se pisarían). Un click afuera
  // de ambos también cierra el que esté abierto (mismo patrón que un
  // dropdown común).
  const floatWraps = {
    map: root.querySelector('#pedidos-map-panel').closest('.pedidos-float-wrap'),
    assigned: root.querySelector('#pedidos-assigned-panel').closest('.pedidos-float-wrap'),
  };
  const floatPanels = {
    map: root.querySelector('#pedidos-map-panel'),
    assigned: root.querySelector('#pedidos-assigned-panel'),
  };
  const floatTriggers = {
    map: root.querySelector('#map-toggle-btn'),
    assigned: root.querySelector('#assigned-toggle-btn'),
  };
  let openFloat = null;

  function closeFloat() {
    if (!openFloat) return;
    floatWraps[openFloat].classList.remove('open');
    floatPanels[openFloat].setAttribute('aria-hidden', 'true');
    openFloat = null;
  }

  function toggleFloat(key) {
    const wasOpen = openFloat === key;
    closeFloat();
    if (wasOpen) return;
    openFloat = key;
    floatWraps[key].classList.add('open');
    floatPanels[key].setAttribute('aria-hidden', 'false');
    if (key === 'map') {
      // El panel cerrado usa visibility:hidden (no display:none, ver
      // style.css) para que la animación de apertura pueda transicionar y
      // para que el contenedor ya tenga un tamaño real medido incluso
      // cerrado -- pero se dispara igual un resize + reencuadre acá como
      // backstop, mismo criterio "defensa en profundidad" que ya se usa en
      // seguimiento.html.
      window.google.maps.event.trigger(mapPanel.map, 'resize');
      mapPanel.fitBoundsToEverything();
    }
  }

  floatTriggers.map.addEventListener('click', (e) => { e.stopPropagation(); toggleFloat('map'); });
  floatTriggers.assigned.addEventListener('click', (e) => { e.stopPropagation(); toggleFloat('assigned'); });
  document.addEventListener('click', (e) => {
    if (openFloat && !floatWraps[openFloat].contains(e.target)) closeFloat();
  });

  const socket = Store.socket;
  const { driverLabel, teardown: teardownDriverLabel } = createDriverLabel();
  let formConfig = Store.getFormConfig();
  if (!Array.isArray(formConfig.paymentMethods)) formConfig.paymentMethods = [];
  let editingOrderId = null;

  // null = orden personalizado (persistido, arrastrable, con separadores
  // intercalados). { key, dir } = ordenado por esa columna (asc/desc); en
  // ese modo los separadores se ocultan y arrastrar queda deshabilitado —
  // un 3er click en la misma columna vuelve a null.
  let currentSort = null;
  const itemTypeById = new Map(); // id -> 'order' | 'separator', reconstruido en cada render

  // Mismo motivo que en nuevo-pedido.js: el GPS manda driver:update cada
  // pocos segundos y redibujar la tabla entera en cada uno cerraría solo
  // cualquier <select> que tuvieras abierto (ej. "Delivery asignado").
  const knownDriverNames = new Map();
  Store.getDrivers().forEach((d, id) => knownDriverNames.set(id, d.name));

  function paymentOptions() {
    return [''].concat((formConfig.paymentMethods || []).map((m) => m.name));
  }

  function visibleFieldColumns() {
    // Los 4 builtins (Teléfono/Nombre/Nº pedido/Monto) ya no son
    // configurables desde Ajustes (ver el comentario en
    // nuevo-pedido.js/applyFormConfig()) -- siempre se muestran. Solo los
    // Campos personalizados siguen siendo filtrables por visibilidad.
    const customs = (formConfig.customFields || [])
      .filter((f) => f.visible !== false)
      .map((f) => ({ key: f.key, label: f.label }));
    return [...FIELD_COLUMNS, ...customs];
  }

  // Columnas ordenables (todas menos la de agarrar-y-arrastrar y la de
  // acciones) — "porque nunca sabes por qué el cliente va a querer ordenar".
  function columnDefs() {
    const cols = [
      { sortKey: 'seq', label: 'Ticket' },
      { sortKey: 'source', label: 'Origen' },
    ];
    visibleFieldColumns().forEach((c) => cols.push({ sortKey: c.key, label: c.label }));
    cols.push({ sortKey: 'assignedTo', label: 'Delivery asignado' });
    cols.push({ sortKey: 'paymentMethod', label: 'Método de pago' });
    cols.push({ sortKey: 'status', label: 'Estado' });
    cols.push({ sortKey: null, label: '' });
    return cols;
  }

  function cycleSort(key) {
    if (!currentSort || currentSort.key !== key) {
      currentSort = { key, dir: 'asc' };
    } else if (currentSort.dir === 'asc') {
      currentSort = { key, dir: 'desc' };
    } else {
      currentSort = null;
    }
    renderHeader();
    renderOrders();
  }

  function renderHeader() {
    orderTheadRowEl.innerHTML = '';
    const handleTh = document.createElement('th');
    handleTh.className = 'order-th-handle';
    orderTheadRowEl.appendChild(handleTh);

    columnDefs().forEach((col) => {
      const th = document.createElement('th');
      let text = col.label;
      if (col.sortKey) {
        th.classList.add('sortable');
        th.addEventListener('click', () => cycleSort(col.sortKey));
        if (currentSort && currentSort.key === col.sortKey) {
          text += currentSort.dir === 'asc' ? ' ▲' : ' ▼';
        }
      }
      th.textContent = text;
      orderTheadRowEl.appendChild(th);
    });

    addSeparatorBtn.disabled = !!currentSort;
    addSeparatorBtn.title = currentSort ? 'Limpiá el ordenamiento por columna para agregar separadores' : '';
  }

  function orderPrecisionTag(o) {
    if (o.precision === 'street') return ' (aproximado: a nivel de calle, revisar)';
    if (o.precision === 'exact') return ' (verificar pin en el mapa)';
    return '';
  }

  function fieldCellContent(key, o) {
    if (key === 'phone') return o.phone || '';
    if (key === 'name') return `${o.name || ''}${orderPrecisionTag(o)}`;
    if (key === 'orderNumber') return o.orderNumber || '';
    if (key === 'amount') return o.amount != null ? `$${o.amount.toFixed(2)}` : '';
    return (o.custom && o.custom[key]) || '';
  }

  function valueForSortKey(key, o) {
    if (key === 'seq') return o.seq || 0;
    if (key === 'source') return o.source === 'web' ? 'Web' : '';
    if (key === 'amount') return o.amount || 0;
    if (key === 'assignedTo') return o.assignedTo ? driverLabel(o.assignedTo) : '';
    if (key === 'paymentMethod') return o.paymentMethod || '';
    if (key === 'status') {
      const found = STATUS_OPTIONS.find(([value]) => value === (o.status || 'pending'));
      return found ? found[1] : '';
    }
    if (key === 'phone' || key === 'name' || key === 'orderNumber') return o[key] || '';
    return (o.custom && o.custom[key]) || '';
  }

  function compareByKey(key, a, b) {
    const av = valueForSortKey(key, a);
    const bv = valueForSortKey(key, b);
    if (typeof av === 'number' && typeof bv === 'number') return av - bv;
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
  }

  // Orden personalizado: pedidos + separadores comparten el mismo espacio
  // numérico de sortOrder para poder intercalarse en una sola lista. Un
  // pedido que nunca se arrastró no tiene sortOrder todavía — cae ordenado
  // por su ticket (orden de creación) entre los que sí lo tienen.
  function effectiveSortOrder(item) {
    if (item.data.sortOrder != null) return item.data.sortOrder;
    return item.type === 'order' ? (item.data.seq || 0) : 0;
  }

  function combinedList() {
    const orders = Array.from(Store.getOrders().entries())
      .filter(([, o]) => !o.archivedAt)
      .map(([id, o]) => ({ type: 'order', id, data: o }));

    if (currentSort) {
      const { key, dir } = currentSort;
      const factor = dir === 'asc' ? 1 : -1;
      return orders.slice().sort((a, b) => factor * compareByKey(key, a.data, b.data));
    }

    const separators = Array.from(Store.getSeparators().entries())
      .map(([id, s]) => ({ type: 'separator', id, data: s }));
    const combined = [...orders, ...separators];
    combined.sort((a, b) => effectiveSortOrder(a) - effectiveSortOrder(b));
    return combined;
  }

  function handleCell(dragEnabled) {
    const td = document.createElement('td');
    td.className = 'order-drag-cell';
    if (dragEnabled) {
      const handle = document.createElement('span');
      handle.className = 'reorder-handle';
      handle.textContent = '⠿';
      td.appendChild(handle);
    }
    return td;
  }

  function buildOrderRow(id, o, fieldColumns, dragEnabled) {
    const tr = document.createElement('tr');
    tr.dataset.id = id;
    tr.appendChild(handleCell(dragEnabled));

    const tdTicket = document.createElement('td');
    tdTicket.textContent = o.seq != null ? `#${o.seq}` : '';
    tr.appendChild(tdTicket);

    // Un pedido sin lat/lng nunca tuvo una dirección resuelta -- es "Retira
    // en el local" (mismo criterio que ya usan map-panel.js/route-helper.js
    // para no dibujarle pin ni meterlo en una ruta). A pedido explícito: se
    // marca en Origen para verlo de un vistazo, y la celda de "Delivery
    // asignado" deja de mostrar un <select> -- asignarle un delivery a algo
    // que el cliente retira él mismo no tiene sentido y generaba confusión
    // ("aparece para asignar un delivery y no aparece nada que remarque
    // que pasa a retirar").
    const isPickup = o.lat == null;

    const tdOrigin = document.createElement('td');
    tdOrigin.style.display = 'flex';
    tdOrigin.style.gap = '4px';
    tdOrigin.style.flexWrap = 'wrap';
    if (o.source === 'web') {
      const webBadge = document.createElement('span');
      webBadge.textContent = '🌐 Web';
      tdOrigin.appendChild(webBadge);
    }
    if (isPickup) {
      const pickupBadge = document.createElement('span');
      pickupBadge.className = 'pickup-badge';
      pickupBadge.textContent = '🏠 Retira';
      pickupBadge.title = 'El cliente retira en el local -- no hace falta asignarle delivery.';
      tdOrigin.appendChild(pickupBadge);
    }
    tr.appendChild(tdOrigin);

    fieldColumns.forEach((c) => {
      const td = document.createElement('td');
      td.textContent = fieldCellContent(c.key, o);
      tr.appendChild(td);
    });

    const tdAssign = document.createElement('td');
    if (isPickup) {
      const pickupLabel = document.createElement('span');
      pickupLabel.className = 'hint';
      pickupLabel.textContent = 'Retira en el local';
      tdAssign.appendChild(pickupLabel);
    } else {
      const assignSelect = document.createElement('select');
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = 'Sin asignar';
      assignSelect.appendChild(noneOpt);
      Store.getDrivers().forEach((d, driverId) => {
        const opt = document.createElement('option');
        opt.value = driverId;
        opt.textContent = d.name;
        assignSelect.appendChild(opt);
      });
      if (o.assignedTo && !Store.getDrivers().has(o.assignedTo)) {
        const opt = document.createElement('option');
        opt.value = o.assignedTo;
        opt.textContent = `${driverLabel(o.assignedTo)} (desconectado)`;
        assignSelect.appendChild(opt);
      }
      assignSelect.value = o.assignedTo || '';
      assignSelect.addEventListener('change', () => assignOrder(id, assignSelect.value || null));
      tdAssign.appendChild(assignSelect);
    }

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
    tdActions.style.flexWrap = 'wrap';

    if (o.items && o.items.length > 0) {
      const itemsBtn = document.createElement('button');
      itemsBtn.type = 'button';
      itemsBtn.className = 'small';
      itemsBtn.textContent = '🧾';
      itemsBtn.title = 'Ver detalle del pedido';
      itemsBtn.addEventListener('click', () => openItemsModal(o));
      tdActions.appendChild(itemsBtn);
    }

    const trackBtn = document.createElement('button');
    trackBtn.type = 'button';
    trackBtn.className = 'small';
    trackBtn.textContent = '📍';
    trackBtn.title = 'Mandar link de seguimiento en vivo al cliente';
    trackBtn.addEventListener('click', () => sendTrackingLink(o));
    tdActions.appendChild(trackBtn);

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
    delBtn.addEventListener('click', () => {
      socket.emit('order:remove', { id });
    });
    tdActions.appendChild(delBtn);

    tr.append(tdAssign, tdPayment, tdStatus, tdActions);
    return tr;
  }

  function buildSeparatorRow(id, s, colspanCount, dragEnabled) {
    const tr = document.createElement('tr');
    tr.dataset.id = id;
    tr.className = 'separator-row';
    tr.appendChild(handleCell(dragEnabled));

    const td = document.createElement('td');
    td.colSpan = colspanCount;
    td.className = 'separator-cell';

    // `display:flex` directo sobre el <td> con colspan no estira de forma
    // confiable en todos los navegadores (el input quedaba angosto, como si
    // el <td> no tomara el ancho de las columnas que abarca) — un <div>
    // interno con width:100% sí lo hace de forma consistente.
    const inner = document.createElement('div');
    inner.className = 'separator-cell-inner';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Texto del separador (opcional)';
    input.maxLength = 80;
    input.value = s.text || '';
    let saveTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        socket.emit('separator:edit', { id, text: input.value });
      }, 400);
    });
    inner.appendChild(input);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger small';
    delBtn.textContent = '🗑';
    delBtn.title = 'Eliminar separador';
    delBtn.addEventListener('click', () => socket.emit('separator:remove', { id }));
    inner.appendChild(delBtn);

    td.appendChild(inner);
    tr.appendChild(td);
    return tr;
  }

  // Mientras se está escribiendo en el texto de un separador, cualquier
  // render disparado por un evento de Store (incluido el eco del propio
  // `separator:edit` que uno mismo acaba de emitir, ya que el servidor lo
  // reemite a todos vía `separators:snapshot`) destruye y reconstruye la
  // fila entera — perdiendo el foco y, con debounce de 400ms, cortando la
  // escritura en cada pausa. Mismo tipo de bug que ya se evitó en otros
  // lados (ver driver:update en pedidos/dashboard) — acá se resuelve
  // saltando el render mientras el input activo sea uno de separador.
  function isEditingSeparatorText() {
    const active = document.activeElement;
    return !!(active && active.tagName === 'INPUT' && active.closest('.separator-cell'));
  }

  function renderOrders() {
    if (isEditingSeparatorText()) return;
    orderTbodyEl.innerHTML = '';
    itemTypeById.clear();

    const items = combinedList();
    const totalOrders = items.filter((it) => it.type === 'order').length;
    orderCountEl.textContent = totalOrders === 0
      ? 'Todavía no cargaste ningún pedido.'
      : `${totalOrders} pedido${totalOrders === 1 ? '' : 's'} registrado${totalOrders === 1 ? '' : 's'}.`;

    const fieldColumns = visibleFieldColumns();
    const dragEnabled = !currentSort;
    const colspanCount = columnDefs().length; // toda la fila salvo la columna de arrastrar, igual de larga que un pedido

    items.forEach((item) => {
      itemTypeById.set(item.id, item.type);
      if (item.type === 'separator') {
        orderTbodyEl.appendChild(buildSeparatorRow(item.id, item.data, colspanCount, dragEnabled));
      } else {
        orderTbodyEl.appendChild(buildOrderRow(item.id, item.data, fieldColumns, dragEnabled));
      }
    });
  }

  function persistReorder(orderedIds) {
    const items = orderedIds
      .filter((id) => itemTypeById.has(id))
      .map((id) => ({ id, type: itemTypeById.get(id) }));
    socket.emit('order:reorder', { items });
  }

  initReorderDrag(orderTbodyEl, persistReorder);

  addSeparatorBtn.addEventListener('click', () => {
    if (currentSort) return;
    socket.emit('separator:add', { id: crypto.randomUUID(), text: '' });
  });

  // Números uruguayos: 09X XXX XXX (9 dígitos, arranca en 0) → +598 sin el 0,
  // para armar un link de WhatsApp directo -- mismo criterio que driver.js.
  function whatsappLink(phone) {
    const digits = (phone || '').replace(/\D/g, '');
    if (!digits) return null;
    const intl = digits.startsWith('598') ? digits : (digits.startsWith('0') && digits.length === 9) ? `598${digits.slice(1)}` : `598${digits}`;
    return `https://wa.me/${intl}`;
  }

  // Con teléfono cargado, abre WhatsApp con el link ya escrito (el admin solo
  // tiene que tocar "Enviar"); sin teléfono, copia el link al portapapeles
  // para que el admin lo pegue donde le haya llegado el pedido (llamada,
  // Instagram, etc.).
  function sendTrackingLink(o) {
    const link = `${location.origin}/seguimiento.html?id=${o.id}`;
    const wa = whatsappLink(o.phone);
    if (wa) {
      const text = `Hola${o.name ? ` ${o.name}` : ''}! Así podés seguir tu pedido en vivo: ${link}`;
      window.open(`${wa}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(link);
    }
  }

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

  // "Nuevo pedido" ya no es una pestaña aparte — el formulario/carga masiva
  // se monta adentro de este modal, reusando tal cual el módulo que antes
  // registraba su propia vista (ver nuevo-pedido.js). Se monta recién al
  // abrir (no de una, al montar Pedidos) para no tener dos Store.on(...)
  // duplicados corriendo en segundo plano sin necesidad.
  let newOrderFormMounted = false;

  function openNewOrderModal() {
    newOrderModalBodyEl.innerHTML = newOrderFormTemplate;
    mountNewOrderForm(newOrderModalBodyEl);
    newOrderFormMounted = true;
    newOrderOverlay.style.display = 'flex';
  }

  function closeNewOrderModal() {
    newOrderOverlay.style.display = 'none';
    if (newOrderFormMounted) {
      unmountNewOrderForm();
      newOrderFormMounted = false;
    }
    newOrderModalBodyEl.innerHTML = '';
  }

  newOrderOpenBtn.addEventListener('click', openNewOrderModal);
  newOrderCloseBtn.addEventListener('click', closeNewOrderModal);
  newOrderOverlay.addEventListener('click', (e) => { if (e.target === newOrderOverlay) closeNewOrderModal(); });

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
      const input = root.querySelector(`#edit-custom-${f.key}`);
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
    const order = Store.getOrders().get(orderId);
    socket.emit('order:assign', { id: orderId, driverId });
    if (order) order.assignedTo = driverId;
    renderOrders();
    recomputeRouteForDriver(order ? order.assignedTo : null);
    recomputeRouteForDriver(driverId);
  }

  // ---------- Deliverys activos y pedidos asignados ----------
  // Mismo contenido que antes vivía solo en la pestaña "Deliverys y mapa"
  // (la mitad "operativa" de la rendición por delivery — quién tiene qué
  // pedido sin entregar). La otra mitad, el desglose de dinero (cambio
  // inicial, por método de pago, gastos, total a entregar, cerrar
  // rendición), se mudó a Día Comercial junto con el resto de lo
  // administrativo — acá solo queda lo que hace falta para controlar
  // pedidos/asignación/rutas. Reusa el `driverLabel` que ya existe más
  // arriba (misma instancia que usan los <select> "Delivery asignado" de
  // la tabla) y reacciona a cambios de delivery/pedido/ruta a través de
  // `mapPanel.onChange(...)` en vez de abrir una segunda tanda de
  // suscripciones a Store para lo mismo.
  const assignedCards = new Map(); // driverId -> refs

  function assignedActiveOrders(driverId) {
    return Array.from(Store.getOrders().values()).filter((o) => o.assignedTo === driverId && o.status !== 'entregado' && !o.archivedAt);
  }

  function ensureAssignedCard(driverId) {
    const existing = assignedCards.get(driverId);
    if (existing) return existing;
    const card = document.createElement('div');
    card.className = 'panel driver-card';
    const header = document.createElement('div');
    header.className = 'driver-card-header';
    const nameEl = document.createElement('strong');
    header.appendChild(nameEl);
    // Un delivery puede dejar de mandar ubicación (cerró la app, se le
    // apagó el celular, perdió señal) sin desconectarse del todo -- el
    // servidor recién lo saca de Store.getDrivers() a los 5 min sin pings
    // (STALE_MS en server.js). Sin esto, la tarjeta lo sigue mostrando
    // "conectado" con su última posición sin ningún aviso de que hace rato
    // no actualiza -- mismo problema que se resolvió del lado del cliente
    // en seguimiento.js.
    const freshnessEl = document.createElement('span');
    freshnessEl.className = 'driver-card-freshness';
    header.appendChild(freshnessEl);
    card.appendChild(header);
    const ordersSection = document.createElement('div');
    ordersSection.className = 'driver-card-orders';
    const ordersList = document.createElement('ul');
    ordersSection.appendChild(ordersList);
    card.appendChild(ordersSection);
    assignedCardsEl.appendChild(card);
    const refs = { card, nameEl, freshnessEl, ordersList };
    assignedCards.set(driverId, refs);
    return refs;
  }

  // Mismo umbral que seguimiento.js -- bastante por encima del intervalo
  // normal de GPS (cada pocos segundos) para no marcar falso positivo por
  // una demora momentánea de red.
  const DRIVER_STALE_MS = 90 * 1000;

  function updateAssignedCard(driverId) {
    const refs = ensureAssignedCard(driverId);
    const pending = assignedActiveOrders(driverId);
    refs.nameEl.textContent = `${driverLabel(driverId)} (${pending.length} sin entregar)`;

    const d = Store.getDrivers().get(driverId);
    if (!d) {
      refs.freshnessEl.textContent = '';
      refs.freshnessEl.classList.remove('driver-card-freshness-warning');
    } else {
      const seconds = Math.max(0, Math.round((Date.now() - d.updatedAt) / 1000));
      const label = seconds < 60 ? `hace ${seconds}s` : `hace ${Math.round(seconds / 60)} min`;
      const stale = Date.now() - d.updatedAt > DRIVER_STALE_MS;
      refs.freshnessEl.textContent = stale ? `⚠️ sin actualizar ${label}` : `actualizado ${label}`;
      refs.freshnessEl.classList.toggle('driver-card-freshness-warning', stale);
    }

    refs.ordersList.innerHTML = '';
    if (pending.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Ningún pedido asignado todavía.';
      refs.ordersList.appendChild(li);
    } else {
      pending.forEach((o) => {
        const li = document.createElement('li');
        li.textContent = `Pedido #${o.orderNumber || o.seq}`;
        if (o.lat != null) {
          li.classList.add('clickable');
          li.title = 'Ver en el mapa';
          li.addEventListener('click', () => mapPanel.focusOrder(o.id));
        }
        refs.ordersList.appendChild(li);
      });
    }
  }

  function renderAssignedCards() {
    // Solo pedidos activos (no entregados/archivados) mantienen la tarjeta --
    // si no, un delivery desconectado con historial viejo (entregas de hace
    // rato) queda pegado en pantalla para siempre.
    const assignedDriverIds = new Set(
      Array.from(Store.getOrders().values())
        .filter((o) => o.assignedTo && o.status !== 'entregado' && !o.archivedAt)
        .map((o) => o.assignedTo)
    );
    const driverIds = new Set([...assignedDriverIds, ...Store.getDrivers().keys()]);

    assignedEmptyEl.hidden = driverIds.size > 0;

    if (driverIds.size === 0) {
      assignedCards.forEach((refs) => refs.card.remove());
      assignedCards.clear();
      return;
    }

    assignedCards.forEach((refs, driverId) => {
      if (!driverIds.has(driverId)) { refs.card.remove(); assignedCards.delete(driverId); }
    });

    driverIds.forEach((driverId) => {
      const refs = ensureAssignedCard(driverId);
      if (!refs.card.isConnected) assignedCardsEl.appendChild(refs.card);
      updateAssignedCard(driverId);
    });
  }

  mapPanel.onChange(renderAssignedCards);

  const onFormConfigSnapshot = (e) => {
    formConfig = e.detail || {};
    if (!Array.isArray(formConfig.paymentMethods)) formConfig.paymentMethods = [];
    renderHeader();
    renderOrders();
  };
  const onDriversSnapshot = (e) => {
    (e.detail || []).forEach((d) => knownDriverNames.set(d.id, d.name));
    renderOrders();
  };
  const onDriverUpdate = (e) => {
    const needsRerender = knownDriverNames.get(e.detail.id) !== e.detail.name;
    knownDriverNames.set(e.detail.id, e.detail.name);
    if (needsRerender) renderOrders();
  };
  const onDriverRemove = (e) => {
    knownDriverNames.delete(e.detail.id);
    renderOrders();
  };
  const onOrdersSnapshot = () => renderOrders();
  const onOrderUpdate = (e) => {
    renderOrders();
    if (e.detail.assignedTo) recomputeRouteForDriver(e.detail.assignedTo);
  };
  const onOrderRemove = () => renderOrders();
  const onSeparatorsSnapshot = () => renderOrders();

  Store.on('form-config:snapshot', onFormConfigSnapshot);
  Store.on('drivers:snapshot', onDriversSnapshot);
  Store.on('driver:update', onDriverUpdate);
  Store.on('driver:remove', onDriverRemove);
  Store.on('orders:snapshot', onOrdersSnapshot);
  Store.on('order:update', onOrderUpdate);
  Store.on('order:remove', onOrderRemove);
  Store.on('separators:snapshot', onSeparatorsSnapshot);

  const unsubscribe = () => {
    Store.off('form-config:snapshot', onFormConfigSnapshot);
    Store.off('drivers:snapshot', onDriversSnapshot);
    Store.off('driver:update', onDriverUpdate);
    Store.off('driver:remove', onDriverRemove);
    Store.off('orders:snapshot', onOrdersSnapshot);
    Store.off('order:update', onOrderUpdate);
    Store.off('order:remove', onOrderRemove);
    Store.off('separators:snapshot', onSeparatorsSnapshot);
    // Si se navega a otra pestaña con el modal de "Nuevo pedido" todavía
    // abierto, no dejar sus propias suscripciones a Store colgadas.
    if (newOrderFormMounted) unmountNewOrderForm();
  };

  // Las tarjetas solo se re-renderizan por eventos de Store (driver:update,
  // etc.) -- un delivery que deja de mandar pings no dispara ningún evento
  // nuevo, así que sin este tick propio el texto "actualizado hace Xs"
  // quedaría congelado en vez de ir avisando que pasa el tiempo.
  const freshnessIntervalId = setInterval(renderAssignedCards, 5000);

  active = { mapPanel, unsubscribe, teardownDriverLabel, freshnessIntervalId };
  renderHeader();
  renderOrders();
  renderAssignedCards();
}

function unmount() {
  currentGeneration++;
  teardownActive();
}

Router.register('/pedidos.html', {
  title: 'Registro de pedidos — Deliverys en vivo',
  wide: true,
  template,
  mount,
  unmount,
});
