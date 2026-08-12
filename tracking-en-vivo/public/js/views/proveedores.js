import { Store } from '/js/store.js';
import { Router } from '/js/router.js';
import { createDriverLabel } from '/js/driver-label.js';

const NEW_SUPPLIER_VALUE = '__new__';

// Fragmento sin <main> propio -- se usa tal cual para la ruta /proveedores.html
// (envuelto en <main class="wide">, ver Router.register más abajo) y también
// se embebe directo adentro del <main> de analiticas.js (Día Comercial), que
// ahora agrupa todo lo administrativo/dinero en una sola pantalla. mount()
// sigue haciendo root.querySelector(...) contra lo que sea que haya
// reemplazado a #view-root, así que le da lo mismo montarse solo o adentro
// de otra vista.
export const template = `
  <section class="panel">
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <h2>Gastos a proveedores</h2>
      <button id="new-expense-open-btn" type="button" class="primary small">+ Agregar gasto</button>
    </div>
    <p id="day-gate-msg" class="status error" style="display:none;">Iniciá el día desde "Día Comercial" antes de cargar gastos.</p>

    <div class="driver-card-stats" style="margin-top:14px;">
      <div class="driver-stat"><label>Gastos hoy</label><span class="value" id="expense-count">0</span></div>
      <div class="driver-stat"><label>Total gastado</label><strong id="expense-total">$0.00</strong></div>
      <div class="driver-stat"><label>De eso, efectivo físico</label><span class="value" id="expense-cash-total">$0.00</span></div>
    </div>

    <div class="table-scroll" style="margin-top:14px;">
      <table class="order-table">
        <thead>
          <tr><th>Proveedor</th><th>Monto</th><th>Método</th><th>Asignado a</th><th></th></tr>
        </thead>
        <tbody id="expense-tbody"></tbody>
      </table>
    </div>
  </section>

<div id="new-expense-overlay" class="modal-overlay" style="display:none;">
  <div class="modal-box">
    <button id="new-expense-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
    <h2>Nuevo gasto</h2>
    <div class="field">
      <label for="expense-supplier">Proveedor</label>
      <div style="display:flex; gap:8px; align-items:flex-start;">
        <select id="expense-supplier" style="flex:1;"></select>
        <button id="manage-suppliers-open-btn" type="button" class="small" style="width:auto; flex-shrink:0;" title="Ver, renombrar o borrar los proveedores ya guardados">Gestionar</button>
      </div>
    </div>
    <div class="field" id="new-supplier-inline-field" style="display:none;">
      <label for="new-supplier-inline-name">Nombre del proveedor nuevo</label>
      <input type="text" id="new-supplier-inline-name" placeholder="Ej: Pescadería López">
    </div>
    <div class="field">
      <label for="expense-description">Nota (opcional)</label>
      <input type="text" id="expense-description" placeholder="Ej: compra de la semana">
    </div>
    <div class="field">
      <label for="expense-amount">Monto</label>
      <input type="text" id="expense-amount" placeholder="$ 3.500,00">
    </div>
    <div class="field">
      <label for="expense-payment-method">Método de pago</label>
      <select id="expense-payment-method"></select>
    </div>
    <div class="field">
      <label for="expense-driver">Asignar a (si se pagó con la plata que ya lleva un delivery)</label>
      <select id="expense-driver"><option value="">Sin asignar (gasto del negocio)</option></select>
    </div>
    <button id="add-expense-btn" type="button" class="primary">Agregar gasto</button>
    <p id="add-expense-status" class="status"></p>
  </div>
</div>

<div id="manage-suppliers-overlay" class="modal-overlay" style="display:none;">
  <div class="modal-box">
    <button id="manage-suppliers-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
    <h2>Proveedores</h2>
    <p class="hint">La lista de a quién le pagás -- elegilos del desplegable al cargar un gasto en vez de tipear el nombre cada vez, así después se puede ver cuánto se gastó por proveedor. Tocá el nombre para renombrarlo.</p>
    <div id="supplier-list" style="margin-top:10px;"></div>
    <div class="field" style="margin-top:16px;">
      <label for="new-supplier-name">Agregar proveedor nuevo</label>
      <div style="display:flex; gap:8px;">
        <input type="text" id="new-supplier-name" placeholder="Ej: Pescadería López" style="flex:1;">
        <button id="add-supplier-btn" type="button" class="primary small" style="width:auto; flex-shrink:0;">Agregar</button>
      </div>
    </div>
    <p id="add-supplier-status" class="status"></p>
  </div>
</div>
`;

let unsubscribe = null;

export function mount(root) {
  const dayGateMsgEl = root.querySelector('#day-gate-msg');
  const newExpenseOpenBtn = root.querySelector('#new-expense-open-btn');
  const newExpenseOverlay = root.querySelector('#new-expense-overlay');
  const newExpenseCloseBtn = root.querySelector('#new-expense-close-btn');
  const expenseSupplierEl = root.querySelector('#expense-supplier');
  const newSupplierInlineFieldEl = root.querySelector('#new-supplier-inline-field');
  const newSupplierInlineNameEl = root.querySelector('#new-supplier-inline-name');
  const expenseDescriptionEl = root.querySelector('#expense-description');
  const expenseAmountEl = root.querySelector('#expense-amount');
  const expensePaymentMethodEl = root.querySelector('#expense-payment-method');
  const expenseDriverEl = root.querySelector('#expense-driver');
  const addExpenseBtn = root.querySelector('#add-expense-btn');
  const addExpenseStatusEl = root.querySelector('#add-expense-status');
  const expenseCountEl = root.querySelector('#expense-count');
  const expenseTotalEl = root.querySelector('#expense-total');
  const expenseCashTotalEl = root.querySelector('#expense-cash-total');
  const expenseTbodyEl = root.querySelector('#expense-tbody');
  const supplierListEl = root.querySelector('#supplier-list');
  const manageSuppliersOpenBtn = root.querySelector('#manage-suppliers-open-btn');
  const manageSuppliersOverlay = root.querySelector('#manage-suppliers-overlay');
  const manageSuppliersCloseBtn = root.querySelector('#manage-suppliers-close-btn');
  const newSupplierNameEl = root.querySelector('#new-supplier-name');
  const addSupplierBtn = root.querySelector('#add-supplier-btn');
  const addSupplierStatusEl = root.querySelector('#add-supplier-status');

  const socket = Store.socket;
  const { driverLabel, teardown: teardownDriverLabel } = createDriverLabel();
  let formConfig = Store.getFormConfig();
  let expenses = Array.from(Store.getExpenses().values());
  let dayOpen = !!Store.getBusinessDay();

  function suppliers() { return Store.getSuppliers(); }

  function sortedSuppliers() {
    return Array.from(suppliers().entries()).sort((a, b) => a[1].name.localeCompare(b[1].name, 'es'));
  }

  function supplierHasExpenses(supplierId) {
    return expenses.some((e) => e.supplierId === supplierId);
  }

  function renderDriverSelect() {
    const previous = expenseDriverEl.value;
    expenseDriverEl.innerHTML = '<option value="">Sin asignar (gasto del negocio)</option>';
    Store.getDrivers().forEach((d, driverId) => {
      const opt = document.createElement('option');
      opt.value = driverId;
      opt.textContent = d.name;
      expenseDriverEl.appendChild(opt);
    });
    if (previous) expenseDriverEl.value = previous;
  }

  function renderSupplierSelect() {
    const previous = expenseSupplierEl.value;
    expenseSupplierEl.innerHTML = '';
    sortedSuppliers().forEach(([id, s]) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = s.name;
      expenseSupplierEl.appendChild(opt);
    });
    const newOpt = document.createElement('option');
    newOpt.value = NEW_SUPPLIER_VALUE;
    newOpt.textContent = '+ Nuevo proveedor...';
    expenseSupplierEl.appendChild(newOpt);
    if (previous && Array.from(expenseSupplierEl.options).some((o) => o.value === previous)) {
      expenseSupplierEl.value = previous;
    }
    newSupplierInlineFieldEl.style.display = expenseSupplierEl.value === NEW_SUPPLIER_VALUE ? '' : 'none';
  }

  function applyDayGate() {
    dayGateMsgEl.style.display = dayOpen ? 'none' : '';
    newExpenseOpenBtn.disabled = !dayOpen;
    addExpenseBtn.disabled = !dayOpen;
  }

  function renderPaymentMethodSelect() {
    const previous = expensePaymentMethodEl.value;
    expensePaymentMethodEl.innerHTML = '';
    (formConfig.paymentMethods || []).forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      expensePaymentMethodEl.appendChild(opt);
    });
    if (previous) expensePaymentMethodEl.value = previous;
  }

  function renderExpenses() {
    expenseTbodyEl.innerHTML = '';
    let total = 0;
    let cashTotal = 0;
    expenses.forEach((e) => {
      total += e.amount;
      if (e.paymentMethodIsCash) cashTotal += e.amount;

      const tr = document.createElement('tr');
      const tdSupplier = document.createElement('td');
      const supplierName = document.createElement('div');
      supplierName.textContent = e.supplierName || 'Sin proveedor';
      tdSupplier.appendChild(supplierName);
      if (e.description) {
        const note = document.createElement('div');
        note.className = 'hint';
        note.textContent = e.description;
        tdSupplier.appendChild(note);
      }
      const tdAmount = document.createElement('td');
      tdAmount.textContent = `$${e.amount.toFixed(2)}`;
      const tdMethod = document.createElement('td');
      tdMethod.textContent = e.paymentMethodName || 'Sin especificar';
      const tdDriver = document.createElement('td');
      tdDriver.textContent = e.driverId ? driverLabel(e.driverId) : '—';
      const tdActions = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'danger small';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', () => socket.emit('expense:remove', { id: e.id }));
      tdActions.appendChild(delBtn);
      tr.append(tdSupplier, tdAmount, tdMethod, tdDriver, tdActions);
      expenseTbodyEl.appendChild(tr);
    });
    expenseCountEl.textContent = expenses.length;
    expenseTotalEl.textContent = `$${total.toFixed(2)}`;
    expenseCashTotalEl.textContent = `$${cashTotal.toFixed(2)}`;
  }

  function renderSupplierList() {
    supplierListEl.innerHTML = '';
    sortedSuppliers().forEach(([id, s]) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '10px';
      row.style.padding = '6px 0';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = s.name;
      nameInput.style.flex = '1';
      nameInput.addEventListener('change', () => {
        const name = nameInput.value.trim();
        if (!name) { nameInput.value = s.name; return; }
        socket.emit('supplier:edit', { id, fields: { name } });
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'danger small';
      delBtn.textContent = '🗑';
      const hasExpenses = supplierHasExpenses(id);
      delBtn.disabled = hasExpenses;
      delBtn.title = hasExpenses ? 'Ya tiene gastos cargados -- no se puede borrar sin perder esa trazabilidad.' : 'Eliminar proveedor';
      delBtn.addEventListener('click', () => socket.emit('supplier:remove', { id }));

      row.append(nameInput, delBtn);
      supplierListEl.appendChild(row);
    });
    if (suppliers().size === 0) {
      supplierListEl.innerHTML = '<p class="hint">Todavía no cargaste ningún proveedor.</p>';
    }
  }

  newExpenseOpenBtn.addEventListener('click', () => {
    renderSupplierSelect();
    newSupplierInlineNameEl.value = '';
    expenseDescriptionEl.value = '';
    expenseAmountEl.value = '';
    expenseDriverEl.value = '';
    addExpenseStatusEl.textContent = '';
    addExpenseStatusEl.className = 'status';
    newExpenseOverlay.style.display = 'flex';
  });
  newExpenseCloseBtn.addEventListener('click', () => { newExpenseOverlay.style.display = 'none'; });
  newExpenseOverlay.addEventListener('click', (e) => { if (e.target === newExpenseOverlay) newExpenseOverlay.style.display = 'none'; });

  expenseSupplierEl.addEventListener('change', () => {
    newSupplierInlineFieldEl.style.display = expenseSupplierEl.value === NEW_SUPPLIER_VALUE ? '' : 'none';
    if (expenseSupplierEl.value === NEW_SUPPLIER_VALUE) newSupplierInlineNameEl.focus();
  });

  manageSuppliersOpenBtn.addEventListener('click', () => {
    newSupplierNameEl.value = '';
    addSupplierStatusEl.textContent = '';
    addSupplierStatusEl.className = 'status';
    renderSupplierList();
    manageSuppliersOverlay.style.display = 'flex';
  });
  manageSuppliersCloseBtn.addEventListener('click', () => { manageSuppliersOverlay.style.display = 'none'; });
  manageSuppliersOverlay.addEventListener('click', (e) => { if (e.target === manageSuppliersOverlay) manageSuppliersOverlay.style.display = 'none'; });

  addSupplierBtn.addEventListener('click', () => {
    const name = newSupplierNameEl.value.trim();
    if (!name) {
      addSupplierStatusEl.textContent = 'Escribí un nombre.';
      addSupplierStatusEl.className = 'status error';
      return;
    }
    socket.emit('supplier:add', { id: crypto.randomUUID(), name });
    newSupplierNameEl.value = '';
    addSupplierStatusEl.textContent = 'Proveedor agregado.';
    addSupplierStatusEl.className = 'status ok';
    newSupplierNameEl.focus();
  });

  addExpenseBtn.addEventListener('click', () => {
    let supplierId = expenseSupplierEl.value;
    if (supplierId === NEW_SUPPLIER_VALUE) {
      const newName = newSupplierInlineNameEl.value.trim();
      if (!newName) {
        addExpenseStatusEl.textContent = 'Escribí el nombre del proveedor nuevo.';
        addExpenseStatusEl.className = 'status error';
        newSupplierInlineNameEl.focus();
        return;
      }
      supplierId = crypto.randomUUID();
      socket.emit('supplier:add', { id: supplierId, name: newName });
    }
    if (!supplierId) {
      addExpenseStatusEl.textContent = 'Elegí (o creá) un proveedor.';
      addExpenseStatusEl.className = 'status error';
      return;
    }
    const amount = Geo.parseAmount(expenseAmountEl.value);
    if (!amount) {
      addExpenseStatusEl.textContent = 'Completá el monto.';
      addExpenseStatusEl.className = 'status error';
      return;
    }
    socket.emit('expense:add', {
      supplierId,
      description: expenseDescriptionEl.value.trim(),
      amount,
      paymentMethodId: expensePaymentMethodEl.value,
      driverId: expenseDriverEl.value || null,
    });
    renderSupplierSelect();
    newSupplierInlineNameEl.value = '';
    expenseDescriptionEl.value = '';
    expenseAmountEl.value = '';
    expenseDriverEl.value = '';
    addExpenseStatusEl.textContent = 'Gasto agregado.';
    addExpenseStatusEl.className = 'status ok';
  });

  const onExpensesSnapshot = (e) => {
    expenses = e.detail || [];
    renderExpenses();
    renderSupplierList();
  };
  const onSuppliersSnapshot = () => {
    renderSupplierSelect();
    renderSupplierList();
  };
  const onFormConfigSnapshot = (e) => {
    formConfig = e.detail || { paymentMethods: [] };
    if (!Array.isArray(formConfig.paymentMethods)) formConfig.paymentMethods = [];
    renderPaymentMethodSelect();
  };
  const onDayStatus = (e) => {
    dayOpen = !!e.detail.day;
    applyDayGate();
  };
  const onDriversSnapshot = () => renderDriverSelect();
  const onDriverUpdate = () => renderDriverSelect();
  const onDriverRemove = () => renderDriverSelect();

  Store.on('expenses:snapshot', onExpensesSnapshot);
  Store.on('suppliers:snapshot', onSuppliersSnapshot);
  Store.on('form-config:snapshot', onFormConfigSnapshot);
  Store.on('business-day:status', onDayStatus);
  Store.on('drivers:snapshot', onDriversSnapshot);
  Store.on('driver:update', onDriverUpdate);
  Store.on('driver:remove', onDriverRemove);

  applyDayGate();
  renderPaymentMethodSelect();
  renderDriverSelect();
  renderSupplierSelect();
  renderExpenses();
  renderSupplierList();

  unsubscribe = () => {
    Store.off('expenses:snapshot', onExpensesSnapshot);
    Store.off('suppliers:snapshot', onSuppliersSnapshot);
    Store.off('form-config:snapshot', onFormConfigSnapshot);
    Store.off('business-day:status', onDayStatus);
    Store.off('drivers:snapshot', onDriversSnapshot);
    Store.off('driver:update', onDriverUpdate);
    Store.off('driver:remove', onDriverRemove);
    teardownDriverLabel();
  };
}

export function unmount() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

// La pestaña propia se sacó del <nav> (a pedido del usuario, se fusionó
// adentro de Día Comercial -- ver analiticas.js), pero la ruta se deja
// alcanzable por URL directa, mismo criterio que /dashboard.html.
Router.register('/proveedores.html', {
  title: 'Proveedores — Deliverys en vivo',
  wide: true,
  template: `<main class="wide">${template}</main>`,
  mount,
  unmount,
});
