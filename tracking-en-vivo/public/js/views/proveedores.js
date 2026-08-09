import { Store } from '/js/store.js';
import { Router } from '/js/router.js';
import { createDriverLabel } from '/js/driver-label.js';

const template = `
<main class="wide">
  <section class="panel">
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <h2>Gastos a proveedores</h2>
      <button id="new-expense-open-btn" type="button" class="primary small">+ Agregar gasto</button>
    </div>
    <p id="day-gate-msg" class="status error" style="display:none;">Iniciá el día desde "Analíticas" antes de cargar gastos.</p>

    <div class="driver-card-stats" style="margin-top:14px;">
      <div class="driver-stat"><label>Gastos hoy</label><span class="value" id="expense-count">0</span></div>
      <div class="driver-stat"><label>Total gastado</label><strong id="expense-total">$0.00</strong></div>
      <div class="driver-stat"><label>De eso, efectivo físico</label><span class="value" id="expense-cash-total">$0.00</span></div>
    </div>

    <div class="table-scroll" style="margin-top:14px;">
      <table class="order-table">
        <thead>
          <tr><th>Descripción</th><th>Monto</th><th>Método</th><th>Asignado a</th><th></th></tr>
        </thead>
        <tbody id="expense-tbody"></tbody>
      </table>
    </div>
  </section>
</main>

<div id="new-expense-overlay" class="modal-overlay" style="display:none;">
  <div class="modal-box">
    <button id="new-expense-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
    <h2>Nuevo gasto</h2>
    <div class="field">
      <label for="expense-description">Descripción (a quién le pagaste)</label>
      <input type="text" id="expense-description" placeholder="Ej: Pescadería López">
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
`;

let unsubscribe = null;

function mount(root) {
  const dayGateMsgEl = root.querySelector('#day-gate-msg');
  const newExpenseOpenBtn = root.querySelector('#new-expense-open-btn');
  const newExpenseOverlay = root.querySelector('#new-expense-overlay');
  const newExpenseCloseBtn = root.querySelector('#new-expense-close-btn');
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

  const socket = Store.socket;
  const { driverLabel, teardown: teardownDriverLabel } = createDriverLabel();
  let formConfig = Store.getFormConfig();
  let expenses = Array.from(Store.getExpenses().values());
  let dayOpen = !!Store.getBusinessDay();

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
      const tdDesc = document.createElement('td');
      tdDesc.textContent = e.description;
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
      tr.append(tdDesc, tdAmount, tdMethod, tdDriver, tdActions);
      expenseTbodyEl.appendChild(tr);
    });
    expenseCountEl.textContent = expenses.length;
    expenseTotalEl.textContent = `$${total.toFixed(2)}`;
    expenseCashTotalEl.textContent = `$${cashTotal.toFixed(2)}`;
  }

  newExpenseOpenBtn.addEventListener('click', () => {
    expenseDescriptionEl.value = '';
    expenseAmountEl.value = '';
    expenseDriverEl.value = '';
    addExpenseStatusEl.textContent = '';
    addExpenseStatusEl.className = 'status';
    newExpenseOverlay.style.display = 'flex';
    expenseDescriptionEl.focus();
  });
  newExpenseCloseBtn.addEventListener('click', () => { newExpenseOverlay.style.display = 'none'; });
  newExpenseOverlay.addEventListener('click', (e) => { if (e.target === newExpenseOverlay) newExpenseOverlay.style.display = 'none'; });

  addExpenseBtn.addEventListener('click', () => {
    const description = expenseDescriptionEl.value.trim();
    const amount = Geo.parseAmount(expenseAmountEl.value);
    if (!description || !amount) {
      addExpenseStatusEl.textContent = 'Completá la descripción y el monto.';
      addExpenseStatusEl.className = 'status error';
      return;
    }
    socket.emit('expense:add', {
      description,
      amount,
      paymentMethodId: expensePaymentMethodEl.value,
      driverId: expenseDriverEl.value || null,
    });
    expenseDescriptionEl.value = '';
    expenseAmountEl.value = '';
    expenseDriverEl.value = '';
    addExpenseStatusEl.textContent = 'Gasto agregado.';
    addExpenseStatusEl.className = 'status ok';
  });

  const onExpensesSnapshot = (e) => {
    expenses = e.detail || [];
    renderExpenses();
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
  Store.on('form-config:snapshot', onFormConfigSnapshot);
  Store.on('business-day:status', onDayStatus);
  Store.on('drivers:snapshot', onDriversSnapshot);
  Store.on('driver:update', onDriverUpdate);
  Store.on('driver:remove', onDriverRemove);

  applyDayGate();
  renderPaymentMethodSelect();
  renderDriverSelect();
  renderExpenses();

  unsubscribe = () => {
    Store.off('expenses:snapshot', onExpensesSnapshot);
    Store.off('form-config:snapshot', onFormConfigSnapshot);
    Store.off('business-day:status', onDayStatus);
    Store.off('drivers:snapshot', onDriversSnapshot);
    Store.off('driver:update', onDriverUpdate);
    Store.off('driver:remove', onDriverRemove);
    teardownDriverLabel();
  };
}

function unmount() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

Router.register('/proveedores.html', {
  title: 'Proveedores — Deliverys en vivo',
  subtitle: 'Registrá los pagos a proveedores que salen de la caja del negocio.',
  wide: true,
  template,
  mount,
  unmount,
});
