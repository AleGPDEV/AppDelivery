import { Store } from '/js/store.js';
import { Router } from '/js/router.js';

const template = `
<main class="wide">
  <section class="panel">
    <h2>Nuevo gasto</h2>
    <p id="day-gate-msg" class="status error" style="display:none;">Iniciá el día desde "Analíticas" antes de cargar gastos.</p>
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
    <button id="add-expense-btn" type="button" class="primary">Agregar gasto</button>
    <p id="add-expense-status" class="status"></p>
  </section>

  <section class="panel">
    <h2>Gastos de hoy</h2>
    <p id="expense-totals" class="hint"></p>
    <div class="table-scroll">
      <table class="order-table">
        <thead>
          <tr><th>Descripción</th><th>Monto</th><th>Método</th><th></th></tr>
        </thead>
        <tbody id="expense-tbody"></tbody>
      </table>
    </div>
  </section>
</main>
`;

let unsubscribe = null;

function mount(root) {
  const dayGateMsgEl = root.querySelector('#day-gate-msg');
  const expenseDescriptionEl = root.querySelector('#expense-description');
  const expenseAmountEl = root.querySelector('#expense-amount');
  const expensePaymentMethodEl = root.querySelector('#expense-payment-method');
  const addExpenseBtn = root.querySelector('#add-expense-btn');
  const addExpenseStatusEl = root.querySelector('#add-expense-status');
  const expenseTotalsEl = root.querySelector('#expense-totals');
  const expenseTbodyEl = root.querySelector('#expense-tbody');

  const socket = Store.socket;
  let formConfig = Store.getFormConfig();
  let expenses = Array.from(Store.getExpenses().values());
  let dayOpen = !!Store.getBusinessDay();

  function applyDayGate() {
    dayGateMsgEl.style.display = dayOpen ? 'none' : '';
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
      const tdActions = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'danger small';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', () => socket.emit('expense:remove', { id: e.id }));
      tdActions.appendChild(delBtn);
      tr.append(tdDesc, tdAmount, tdMethod, tdActions);
      expenseTbodyEl.appendChild(tr);
    });
    expenseTotalsEl.textContent = expenses.length === 0
      ? 'Todavía no cargaste ningún gasto hoy.'
      : `Total gastado: $${total.toFixed(2)} — de eso, efectivo físico: $${cashTotal.toFixed(2)}.`;
  }

  addExpenseBtn.addEventListener('click', () => {
    const description = expenseDescriptionEl.value.trim();
    const amount = Geo.parseAmount(expenseAmountEl.value);
    if (!description || !amount) {
      addExpenseStatusEl.textContent = 'Completá la descripción y el monto.';
      addExpenseStatusEl.className = 'status error';
      return;
    }
    socket.emit('expense:add', { description, amount, paymentMethodId: expensePaymentMethodEl.value });
    expenseDescriptionEl.value = '';
    expenseAmountEl.value = '';
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

  Store.on('expenses:snapshot', onExpensesSnapshot);
  Store.on('form-config:snapshot', onFormConfigSnapshot);
  Store.on('business-day:status', onDayStatus);

  applyDayGate();
  renderPaymentMethodSelect();
  renderExpenses();

  unsubscribe = () => {
    Store.off('expenses:snapshot', onExpensesSnapshot);
    Store.off('form-config:snapshot', onFormConfigSnapshot);
    Store.off('business-day:status', onDayStatus);
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
