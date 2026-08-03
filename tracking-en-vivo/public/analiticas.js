const dayStatusEl = document.getElementById('day-status');
const dayStatusMsgEl = document.getElementById('day-status-msg');
const startDayBtn = document.getElementById('start-day-btn');
const endDayBtn = document.getElementById('end-day-btn');
const dailyChartEl = document.getElementById('daily-chart');
const dailyTbodyEl = document.getElementById('daily-tbody');
const monthlyTbodyEl = document.getElementById('monthly-tbody');

const socket = io();
const orders = new Map(); // orderId -> order data, solo para saber cuántos pedidos activos hay al finalizar el día

let currentDay = null;

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
  } else {
    dayStatusEl.textContent = 'Ningún día abierto ahora mismo.';
    startDayBtn.disabled = false;
    endDayBtn.disabled = true;
  }
}

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
    bar.style.borderRadius = '4px 4px 0 0';

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

function renderDailyTable(days) {
  dailyTbodyEl.innerHTML = '';
  days.filter((d) => d.ended_at).forEach((d) => {
    const tr = document.createElement('tr');
    const tdDate = document.createElement('td'); tdDate.textContent = fmtDate(d.date);
    const tdOrders = document.createElement('td'); tdOrders.textContent = d.total_orders || 0;
    const tdRevenue = document.createElement('td'); tdRevenue.textContent = fmtMoney(d.total_revenue);
    tr.append(tdDate, tdOrders, tdRevenue);
    dailyTbodyEl.appendChild(tr);
  });
  if (dailyTbodyEl.children.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
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
    const { day } = await api('/api/business-day/end', { method: 'POST' });
    currentDay = null;
    renderDayStatus();
    dayStatusMsgEl.textContent = `Día cerrado: ${day.total_orders} pedidos, ${fmtMoney(day.total_revenue)}.`;
    dayStatusMsgEl.className = 'status ok';
    loadHistory();
  } catch (e) {
    dayStatusMsgEl.textContent = e.message;
    dayStatusMsgEl.className = 'status error';
    endDayBtn.disabled = false;
  }
});

socket.on('orders:snapshot', (list) => list.forEach((o) => orders.set(o.id, o)));
socket.on('order:update', (o) => orders.set(o.id, o));
socket.on('order:remove', ({ id }) => orders.delete(id));

loadCurrentDay();
loadHistory();
