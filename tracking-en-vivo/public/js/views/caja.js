import { Store } from '/js/store.js';
import { Router } from '/js/router.js';
import { createDriverLabel } from '/js/driver-label.js';

const template = `
<main class="wide">
  <section class="panel">
    <h2>Rendición de caja por delivery</h2>
    <p class="hint">Se arma sola con los pedidos que cada delivery entrega (importe + forma de pago elegida al momento de entregar). "Efectivo cambio dado" lo cargás vos acá y se ve en el celular del delivery (de solo lectura ahí). Hay una columna por cada método de pago configurado en Ajustes. "Total a entregar" es efectivo cambio dado + los métodos marcados como efectivo físico (los pagos a proveedores se registran aparte, en "Proveedores").</p>
    <p id="cash-empty" class="hint" hidden>Todavía no hay entregas registradas.</p>
    <div class="table-scroll">
      <table class="order-table" style="white-space: normal;">
        <thead>
          <tr id="cash-thead-row"></tr>
        </thead>
        <tbody id="cash-tbody"></tbody>
      </table>
    </div>
  </section>
</main>
`;

let unsubscribe = null;

function mount(root) {
  const cashTheadRowEl = root.querySelector('#cash-thead-row');
  const cashTbodyEl = root.querySelector('#cash-tbody');
  const cashEmptyEl = root.querySelector('#cash-empty');

  const socket = Store.socket;
  const { driverLabel, teardown: teardownDriverLabel } = createDriverLabel();
  const driverRows = new Map(); // driverId -> refs a los elementos ya creados, para no recrearlos en cada render
  let formConfig = Store.getFormConfig();

  function pendingDeliveries(driverId) {
    return Array.from(Store.getOrders().values()).filter((o) => o.assignedTo === driverId && o.status === 'entregado' && !o.reconciledAt);
  }

  function sumBy(list, predicate) {
    const filtered = list.filter(predicate);
    return { count: filtered.length, total: filtered.reduce((sum, e) => sum + (e.amount || 0), 0) };
  }

  function fmtCell({ count, total }) {
    return `${count} — $${total.toFixed(2)}`;
  }

  function renderHeader() {
    cashTheadRowEl.innerHTML = '';
    ['Delivery activo'].concat(formConfig.paymentMethods.map((m) => m.name), ['Efectivo cambio dado', 'Total a entregar', '']).forEach((label) => {
      const th = document.createElement('th');
      th.textContent = label;
      cashTheadRowEl.appendChild(th);
    });
  }

  function ensureRow(driverId) {
    const existing = driverRows.get(driverId);
    if (existing) return existing;

    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tr.appendChild(tdName);

    const methodCells = new Map(); // paymentMethodId -> td
    formConfig.paymentMethods.forEach((m) => {
      const td = document.createElement('td');
      methodCells.set(m.id, td);
      tr.appendChild(td);
    });

    const tdCambio = document.createElement('td');
    const cambioInput = document.createElement('input');
    cambioInput.type = 'text';
    cambioInput.placeholder = '$ 0,00';
    cambioInput.style.width = '120px';
    cambioInput.addEventListener('input', () => {
      const amount = Geo.parseAmount(cambioInput.value) || 0;
      socket.emit('driver:cash-start', { driverId, amount });
      updateRow(driverId);
    });
    tdCambio.appendChild(cambioInput);
    tr.appendChild(tdCambio);

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
      updateRow(driverId);
    });
    tdActions.appendChild(clearBtn);
    tr.appendChild(tdActions);

    cashTbodyEl.appendChild(tr);
    MoneyCounter.attach(cambioInput);

    const refs = { tr, tdName, methodCells, cambioInput, totalStrong };
    driverRows.set(driverId, refs);
    return refs;
  }

  function updateRow(driverId) {
    const refs = ensureRow(driverId);
    const log = pendingDeliveries(driverId);
    const cashStart = Store.getCashStarts().get(driverId) || 0;
    let cashMethodsTotal = 0;

    refs.tdName.textContent = `${driverLabel(driverId)} (${log.length} sin rendir)`;
    formConfig.paymentMethods.forEach((m) => {
      const cell = sumBy(log, (e) => e.paymentMethod === m.name);
      const td = refs.methodCells.get(m.id);
      if (td) td.textContent = fmtCell(cell);
      if (m.isCash) cashMethodsTotal += cell.total;
    });

    const debe = cashMethodsTotal + cashStart;
    refs.totalStrong.textContent = `$${debe.toFixed(2)}`;
    if (document.activeElement !== refs.cambioInput) refs.cambioInput.value = cashStart || '';
  }

  function renderCashList() {
    const assignedDriverIds = new Set(Array.from(Store.getOrders().values()).map((o) => o.assignedTo).filter(Boolean));
    const driverIds = new Set([...assignedDriverIds, ...Store.getDrivers().keys()]);

    cashEmptyEl.hidden = driverIds.size > 0;
    if (driverIds.size === 0) {
      driverRows.forEach((refs) => refs.tr.remove());
      driverRows.clear();
      return;
    }

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

  function rebuildForNewFormConfig() {
    renderHeader();
    driverRows.forEach((refs) => refs.tr.remove());
    driverRows.clear();
    renderCashList();
  }

  const onDriversSnapshot = () => renderCashList();
  const onDriverUpdate = () => renderCashList();
  const onDriverRemove = () => renderCashList();
  const onOrdersSnapshot = () => renderCashList();
  const onOrderUpdate = () => renderCashList();
  const onOrderRemove = () => renderCashList();
  const onCashStartsSnapshot = () => renderCashList();
  const onDriverCashStart = (e) => {
    if (driverRows.has(e.detail.driverId)) updateRow(e.detail.driverId);
  };
  const onFormConfigSnapshot = (e) => {
    formConfig = e.detail || { paymentMethods: [] };
    if (!Array.isArray(formConfig.paymentMethods)) formConfig.paymentMethods = [];
    rebuildForNewFormConfig();
  };

  Store.on('drivers:snapshot', onDriversSnapshot);
  Store.on('driver:update', onDriverUpdate);
  Store.on('driver:remove', onDriverRemove);
  Store.on('orders:snapshot', onOrdersSnapshot);
  Store.on('order:update', onOrderUpdate);
  Store.on('order:remove', onOrderRemove);
  Store.on('cash-starts:snapshot', onCashStartsSnapshot);
  Store.on('driver:cash-start', onDriverCashStart);
  Store.on('form-config:snapshot', onFormConfigSnapshot);

  unsubscribe = () => {
    Store.off('drivers:snapshot', onDriversSnapshot);
    Store.off('driver:update', onDriverUpdate);
    Store.off('driver:remove', onDriverRemove);
    Store.off('orders:snapshot', onOrdersSnapshot);
    Store.off('order:update', onOrderUpdate);
    Store.off('order:remove', onOrderRemove);
    Store.off('cash-starts:snapshot', onCashStartsSnapshot);
    Store.off('driver:cash-start', onDriverCashStart);
    Store.off('form-config:snapshot', onFormConfigSnapshot);
    teardownDriverLabel();
  };

  renderHeader();
  renderCashList();
}

function unmount() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

Router.register('/caja.html', {
  title: 'Rendición de caja — Deliverys en vivo',
  subtitle: 'Cargá pedidos, asignalos, y mirá cómo se mueven tus deliverys en el mapa.',
  wide: true,
  template,
  mount,
  unmount,
});
