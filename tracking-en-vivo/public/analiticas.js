const dayStatusEl = document.getElementById('day-status');
const dayStatusMsgEl = document.getElementById('day-status-msg');
const startDayBtn = document.getElementById('start-day-btn');
const endDayBtn = document.getElementById('end-day-btn');
const cashFieldsEl = document.getElementById('cash-fields');
const cashStartEl = document.getElementById('cash-start');
const cashEndEl = document.getElementById('cash-end');
const dailyChartEl = document.getElementById('daily-chart');
const dailyTbodyEl = document.getElementById('daily-tbody');
const monthlyTbodyEl = document.getElementById('monthly-tbody');
const resetTodayBtn = document.getElementById('reset-today-btn');
const resetStatusEl = document.getElementById('reset-status');

MoneyCounter.attach(cashStartEl);
MoneyCounter.attach(cashEndEl);

const socket = io();
const orders = new Map(); // orderId -> order data, solo para saber cuántos pedidos activos hay al finalizar el día

let currentDay = null;
let allDays = []; // último historial recibido, solo para el conteo del botón "Borrar TODO"

function fmtMoney(n) {
  return `$${(n || 0).toFixed(2)}`;
}

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function fmtDateTime(iso) {
  return new Date(iso).toLocaleString('es-UY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function api(path, options) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de conexión.');
  return data;
}

function renderDayStatus() {
  if (currentDay) {
    dayStatusEl.textContent = `Día abierto desde ${fmtDateTime(currentDay.started_at)} (${fmtDate(currentDay.date)}).`;
    startDayBtn.disabled = true;
    endDayBtn.disabled = false;
    cashFieldsEl.style.display = '';
    // Repuebla el efectivo inicial ya guardado — salvo que el input tenga el
    // foco ahora mismo, para no pisar lo que se está tipeando (mismo guard
    // que usa caja.js con "Efectivo cambio dado").
    if (document.activeElement !== cashStartEl && currentDay.cash_start != null) {
      cashStartEl.value = currentDay.cash_start.toFixed(2);
    }
  } else {
    dayStatusEl.textContent = 'Ningún día abierto ahora mismo.';
    startDayBtn.disabled = false;
    endDayBtn.disabled = true;
    cashFieldsEl.style.display = 'none';
  }
}

// Antes el efectivo inicial solo viajaba al servidor cuando se tocaba
// "Finalizar día" — si se tipeaba y se cambiaba de pantalla antes de eso, se
// perdía. Ahora se guarda solo (con un debounce chico, no hace falta a cada
// tecla) apenas hay un día abierto.
let cashStartSaveTimer = null;
cashStartEl.addEventListener('input', () => {
  if (!currentDay) return;
  clearTimeout(cashStartSaveTimer);
  cashStartSaveTimer = setTimeout(async () => {
    const cashStart = Geo.parseAmount(cashStartEl.value);
    if (cashStart == null) return;
    try {
      const { day } = await api('/api/business-day/cash-start', { method: 'POST', body: JSON.stringify({ cashStart }) });
      currentDay = day;
    } catch (e) {
      dayStatusMsgEl.textContent = e.message;
      dayStatusMsgEl.className = 'status error';
    }
  }, 600);
});

function renderDailyChart(days) {
  dailyChartEl.innerHTML = '';
  const closed = days.filter((d) => d.ended_at).slice(0, 14).reverse();
  if (closed.length === 0) return;
  const max = Math.max(...closed.map((d) => d.total_revenue || 0), 1);
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.alignItems = 'flex-end';
  wrap.style.gap = '6px';
  wrap.style.height = '140px';
  wrap.style.marginBottom = '16px';
  closed.forEach((d) => {
    const col = document.createElement('div');
    col.style.display = 'flex';
    col.style.flexDirection = 'column';
    col.style.alignItems = 'center';
    col.style.flex = '1';
    col.style.height = '100%';
    col.style.justifyContent = 'flex-end';
    col.title = `${fmtDate(d.date)}: ${d.total_orders} pedidos, ${fmtMoney(d.total_revenue)}`;

    const bar = document.createElement('div');
    const heightPct = Math.max(2, ((d.total_revenue || 0) / max) * 100);
    bar.style.width = '100%';
    bar.style.height = `${heightPct}%`;
    bar.style.background = 'var(--primary)';
    bar.style.borderRadius = 'var(--radius-sm) var(--radius-sm) 0 0';

    const label = document.createElement('span');
    label.style.fontSize = '0.7rem';
    label.style.color = 'var(--muted)';
    label.style.marginTop = '4px';
    label.style.whiteSpace = 'nowrap';
    label.textContent = fmtDate(d.date).slice(0, 5);

    col.append(bar, label);
    wrap.appendChild(col);
  });
  dailyChartEl.appendChild(wrap);
}

const DAILY_COLSPAN = 6;
const PAYMENT_LABEL = (p) => p || 'Sin especificar';

function renderOrderDetailTable(orders) {
  if (orders.length === 0) return document.createTextNode('Sin pedidos ese día.');
  const table = document.createElement('table');
  table.className = 'order-table';
  table.style.marginTop = '8px';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Nº pedido</th><th>Teléfono</th><th>Nombre</th><th>Monto</th><th>Método de pago</th><th>Estado</th></tr>';
  const tbody = document.createElement('tbody');
  orders.forEach((o) => {
    const tr = document.createElement('tr');
    const cells = [
      o.order_number || '',
      o.phone || '',
      o.name || '',
      o.amount != null ? fmtMoney(o.amount) : '',
      PAYMENT_LABEL(o.payment_method),
      o.status || '',
    ];
    cells.forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.append(thead, tbody);
  return table;
}

async function toggleDayDetail(day, row) {
  const existing = row.nextElementSibling;
  if (existing && existing.dataset.detailFor === day.id) {
    existing.remove();
    return;
  }
  // Solo una fila expandida a la vez, para no llenar la tabla de sub-tablas.
  dailyTbodyEl.querySelectorAll('tr[data-detail-for]').forEach((tr) => tr.remove());

  const detailRow = document.createElement('tr');
  detailRow.dataset.detailFor = day.id;
  const td = document.createElement('td');
  td.colSpan = DAILY_COLSPAN;
  td.textContent = 'Cargando...';
  td.className = 'hint';
  detailRow.appendChild(td);
  row.after(detailRow);

  try {
    const { orders: dayOrders } = await api(`/api/business-day/${day.id}/orders`);
    td.textContent = '';
    td.className = '';
    td.appendChild(renderOrderDetailTable(dayOrders));
  } catch (e) {
    td.textContent = e.message;
    td.className = 'hint';
  }
}

function renderDailyTable(days) {
  dailyTbodyEl.innerHTML = '';
  days.filter((d) => d.ended_at).forEach((d) => {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.title = 'Ver los pedidos de este día';
    const tdDate = document.createElement('td'); tdDate.textContent = fmtDate(d.date);
    const tdOrders = document.createElement('td'); tdOrders.textContent = d.total_orders || 0;
    const tdRevenue = document.createElement('td'); tdRevenue.textContent = fmtMoney(d.total_revenue);
    const tdCashExpected = document.createElement('td'); tdCashExpected.textContent = d.cash_expected != null ? fmtMoney(d.cash_expected) : '—';
    const tdCashEnd = document.createElement('td'); tdCashEnd.textContent = d.cash_end != null ? fmtMoney(d.cash_end) : '—';
    const tdDiff = document.createElement('td');
    if (d.cash_end != null && d.cash_expected != null) {
      const diff = d.cash_end - d.cash_expected;
      tdDiff.textContent = `${diff >= 0 ? '+' : ''}${fmtMoney(diff)}`;
      tdDiff.style.color = Math.abs(diff) < 0.01 ? 'var(--ok)' : 'var(--danger)';
    } else {
      tdDiff.textContent = '—';
    }
    tr.append(tdDate, tdOrders, tdRevenue, tdCashExpected, tdCashEnd, tdDiff);
    tr.addEventListener('click', () => toggleDayDetail(d, tr));
    dailyTbodyEl.appendChild(tr);
  });
  if (dailyTbodyEl.children.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = DAILY_COLSPAN;
    td.className = 'hint';
    td.textContent = 'Todavía no cerraste ningún día.';
    tr.appendChild(td);
    dailyTbodyEl.appendChild(tr);
  }
}

function renderMonthlyTable(days) {
  monthlyTbodyEl.innerHTML = '';
  const byMonth = new Map(); // "YYYY-MM" -> { orders, revenue }
  days.filter((d) => d.ended_at).forEach((d) => {
    const month = d.date.slice(0, 7);
    const acc = byMonth.get(month) || { orders: 0, revenue: 0 };
    acc.orders += d.total_orders || 0;
    acc.revenue += d.total_revenue || 0;
    byMonth.set(month, acc);
  });
  const months = Array.from(byMonth.keys()).sort().reverse();
  months.forEach((month) => {
    const acc = byMonth.get(month);
    const [y, m] = month.split('-');
    const tr = document.createElement('tr');
    const tdMonth = document.createElement('td'); tdMonth.textContent = `${m}/${y}`;
    const tdOrders = document.createElement('td'); tdOrders.textContent = acc.orders;
    const tdRevenue = document.createElement('td'); tdRevenue.textContent = fmtMoney(acc.revenue);
    tr.append(tdMonth, tdOrders, tdRevenue);
    monthlyTbodyEl.appendChild(tr);
  });
  if (months.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.className = 'hint';
    td.textContent = 'Todavía no hay ningún mes con datos.';
    tr.appendChild(td);
    monthlyTbodyEl.appendChild(tr);
  }
}

async function loadHistory() {
  try {
    const { days } = await api('/api/business-days');
    allDays = days;
    renderDailyChart(days);
    renderDailyTable(days);
    renderMonthlyTable(days);
  } catch (e) {
    dayStatusMsgEl.textContent = e.message;
    dayStatusMsgEl.className = 'status error';
  }
}

async function loadCurrentDay() {
  try {
    const { day } = await api('/api/business-day/current');
    currentDay = day;
    renderDayStatus();
  } catch (e) {
    dayStatusMsgEl.textContent = e.message;
    dayStatusMsgEl.className = 'status error';
  }
}

startDayBtn.addEventListener('click', async () => {
  startDayBtn.disabled = true;
  dayStatusMsgEl.textContent = '';
  try {
    const { day } = await api('/api/business-day/start', { method: 'POST' });
    currentDay = day;
    renderDayStatus();
    dayStatusMsgEl.textContent = 'Día iniciado.';
    dayStatusMsgEl.className = 'status ok';
  } catch (e) {
    dayStatusMsgEl.textContent = e.message;
    dayStatusMsgEl.className = 'status error';
    startDayBtn.disabled = false;
  }
});

endDayBtn.addEventListener('click', async () => {
  const cashStart = Geo.parseAmount(cashStartEl.value);
  const cashEnd = Geo.parseAmount(cashEndEl.value);
  if (cashStart == null || cashEnd == null) {
    dayStatusMsgEl.textContent = 'Completá el efectivo inicial y final antes de finalizar el día.';
    dayStatusMsgEl.className = 'status error';
    return;
  }

  const active = Array.from(orders.values()).filter((o) => !o.archivedAt);
  const notDelivered = active.filter((o) => o.status !== 'entregado');

  let confirmMsg = `¿Finalizar el día? Se van a archivar ${active.length} pedido${active.length === 1 ? '' : 's'} (dejan de verse en "Pedidos") y quedan fijos en el historial.`;
  if (notDelivered.length > 0) {
    confirmMsg = `Hay ${notDelivered.length} pedido${notDelivered.length === 1 ? '' : 's'} sin entregar todavía. ${confirmMsg} ¿Archivar de todas formas?`;
  }
  if (!confirm(confirmMsg)) return;

  endDayBtn.disabled = true;
  dayStatusMsgEl.textContent = '';
  try {
    const { day } = await api('/api/business-day/end', { method: 'POST', body: JSON.stringify({ cashStart, cashEnd }) });
    currentDay = null;
    renderDayStatus();
    const diff = day.cash_end - day.cash_expected;
    const diffText = Math.abs(diff) < 0.01 ? 'cuadra' : `diferencia de ${diff >= 0 ? '+' : ''}${fmtMoney(diff)}`;
    dayStatusMsgEl.textContent = `Día cerrado: ${day.total_orders} pedidos, ${fmtMoney(day.total_revenue)} en total. Efectivo esperado ${fmtMoney(day.cash_expected)}, contado ${fmtMoney(day.cash_end)} (${diffText}).`;
    dayStatusMsgEl.className = 'status ok';
    cashStartEl.value = '';
    cashEndEl.value = '';
    loadHistory();
  } catch (e) {
    dayStatusMsgEl.textContent = e.message;
    dayStatusMsgEl.className = 'status error';
    endDayBtn.disabled = false;
  }
});

resetTodayBtn.addEventListener('click', async () => {
  const closedDaysCount = allDays.filter((d) => d.ended_at).length;
  const msg = `¿BORRAR TODO? Esto incluye:\n- ${orders.size} pedido${orders.size === 1 ? '' : 's'} en total (activos y ya archivados)\n- ${closedDaysCount} día${closedDaysCount === 1 ? '' : 's'} cerrado${closedDaysCount === 1 ? '' : 's'} con su historial${currentDay ? '\n- el día que está abierto ahora' : ''}\n\nNO SE PUEDE DESHACER. Esto es historial real, no solo pedidos de hoy — usalo solo si estás probando la app.`;
  if (!confirm(msg)) return;

  resetTodayBtn.disabled = true;
  resetStatusEl.textContent = '';
  try {
    const { deletedOrders } = await api('/api/admin/reset-today', { method: 'POST' });
    resetStatusEl.textContent = `Se borraron ${deletedOrders} pedido${deletedOrders === 1 ? '' : 's'} y todo el historial de días.`;
    resetStatusEl.className = 'status ok';
    currentDay = null;
    renderDayStatus();
    loadHistory();
  } catch (e) {
    resetStatusEl.textContent = e.message;
    resetStatusEl.className = 'status error';
  }
  resetTodayBtn.disabled = false;
});

socket.on('orders:snapshot', (list) => list.forEach((o) => orders.set(o.id, o)));
socket.on('order:update', (o) => orders.set(o.id, o));
socket.on('order:remove', ({ id }) => orders.delete(id));
socket.on('business-day:status', ({ day }) => { currentDay = day; renderDayStatus(); });

loadCurrentDay();
loadHistory();
