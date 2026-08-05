const dayGateMsgEl = document.getElementById('day-gate-msg');
const expenseDescriptionEl = document.getElementById('expense-description');
const expenseAmountEl = document.getElementById('expense-amount');
const expensePaymentMethodEl = document.getElementById('expense-payment-method');
const addExpenseBtn = document.getElementById('add-expense-btn');
const addExpenseStatusEl = document.getElementById('add-expense-status');
const expenseTotalsEl = document.getElementById('expense-totals');
const expenseTbodyEl = document.getElementById('expense-tbody');

const socket = io();

let formConfig = { paymentMethods: [] };
let expenses = [];
let dayOpen = false;

// Sin un día abierto no hay a qué negocio asociar el gasto (ver el mismo
// chequeo en el servidor) — mismo criterio que "Nuevo pedido".
function applyDayGate() {
  dayGateMsgEl.style.display = dayOpen ? 'none' : '';
  addExpenseBtn.disabled = !dayOpen;
}

socket.on('business-day:status', ({ day }) => {
  dayOpen = !!day;
  applyDayGate();
});

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
    // Sin confirm() a propósito — mismo criterio que el 🗑 de pedidos.js.
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

socket.on('expenses:snapshot', (list) => {
  expenses = list || [];
  renderExpenses();
});

socket.on('form-config:snapshot', (cfg) => {
  formConfig = cfg || { paymentMethods: [] };
  if (!Array.isArray(formConfig.paymentMethods)) formConfig.paymentMethods = [];
  renderPaymentMethodSelect();
});
