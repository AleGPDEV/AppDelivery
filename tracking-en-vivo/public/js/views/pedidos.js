import { Store } from '/js/store.js';
import { Router } from '/js/router.js';
import { recomputeRouteForDriver } from '/js/route-helper.js';
import { createDriverLabel } from '/js/driver-label.js';
import { template as newOrderFormTemplate, mount as mountNewOrderForm, unmount as unmountNewOrderForm } from '/js/views/nuevo-pedido.js';

const template = `
<main class="wide">
  <section class="panel">
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
      <h2 style="margin:0;">Registro de pedidos</h2>
      <button id="new-order-open-btn" type="button" class="primary small">+ Nuevo pedido</button>
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
const FIXED_COLUMNS = ['Delivery asignado', 'Método de pago', 'Estado', ''];

let unsubscribe = null;

function mount(root) {
  const orderTheadRowEl = root.querySelector('#order-thead-row');
  const orderTbodyEl = root.querySelector('#order-tbody');
  const orderCountEl = root.querySelector('#order-count');
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

  const socket = Store.socket;
  const { driverLabel, teardown: teardownDriverLabel } = createDriverLabel();
  let formConfig = Store.getFormConfig();
  let editingOrderId = null;

  // Mismo motivo que en nuevo-pedido.js: el GPS manda driver:update cada
  // pocos segundos y redibujar la tabla entera en cada uno cerraría solo
  // cualquier <select> que tuvieras abierto (ej. "Delivery asignado").
  const knownDriverNames = new Map();
  Store.getDrivers().forEach((d, id) => knownDriverNames.set(id, d.name));

  function paymentOptions() {
    return [''].concat((formConfig.paymentMethods || []).map((m) => m.name));
  }

  function visibleFieldColumns() {
    const builtins = FIELD_COLUMNS.filter((c) => (formConfig[c.key] || { visible: true }).visible !== false);
    const customs = (formConfig.customFields || [])
      .filter((f) => f.visible !== false)
      .map((f) => ({ key: f.key, label: f.label }));
    return [...builtins, ...customs];
  }

  function renderHeader() {
    orderTheadRowEl.innerHTML = '';
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

  function renderOrders() {
    orderTbodyEl.innerHTML = '';
    const active = Array.from(Store.getOrders().entries()).filter(([, o]) => !o.archivedAt);
    orderCountEl.textContent = active.length === 0
      ? 'Todavía no cargaste ningún pedido.'
      : `${active.length} pedido${active.length === 1 ? '' : 's'} registrado${active.length === 1 ? '' : 's'}.`;

    const sorted = active.sort((a, b) => {
      const byNumber = (a[1].orderNumber || '').localeCompare(b[1].orderNumber || '', undefined, { numeric: true });
      if (byNumber !== 0) return byNumber;
      return (a[1].seq || 0) - (b[1].seq || 0);
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
      delBtn.addEventListener('click', () => {
        socket.emit('order:remove', { id });
      });
      tdActions.appendChild(delBtn);

      tr.append(tdAssign, tdPayment, tdStatus, tdActions);
      orderTbodyEl.appendChild(tr);
    });
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

  const onFormConfigSnapshot = (e) => {
    formConfig = e.detail || {};
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

  Store.on('form-config:snapshot', onFormConfigSnapshot);
  Store.on('drivers:snapshot', onDriversSnapshot);
  Store.on('driver:update', onDriverUpdate);
  Store.on('driver:remove', onDriverRemove);
  Store.on('orders:snapshot', onOrdersSnapshot);
  Store.on('order:update', onOrderUpdate);
  Store.on('order:remove', onOrderRemove);

  unsubscribe = () => {
    Store.off('form-config:snapshot', onFormConfigSnapshot);
    Store.off('drivers:snapshot', onDriversSnapshot);
    Store.off('driver:update', onDriverUpdate);
    Store.off('driver:remove', onDriverRemove);
    Store.off('orders:snapshot', onOrdersSnapshot);
    Store.off('order:update', onOrderUpdate);
    Store.off('order:remove', onOrderRemove);
    teardownDriverLabel();
    // Si se navega a otra pestaña con el modal de "Nuevo pedido" todavía
    // abierto, no dejar sus propias suscripciones a Store colgadas.
    if (newOrderFormMounted) unmountNewOrderForm();
  };

  renderHeader();
  renderOrders();
}

function unmount() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

Router.register('/pedidos.html', {
  title: 'Registro de pedidos — Deliverys en vivo',
  subtitle: 'Cargá pedidos, asignalos, y mirá cómo se mueven tus deliverys en el mapa.',
  wide: true,
  template,
  mount,
  unmount,
});
