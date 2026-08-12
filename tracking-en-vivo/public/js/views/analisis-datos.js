import { Store } from '/js/store.js';
import { Router } from '/js/router.js';

// Estadísticas e historial, separado de la operación diaria de caja (ver
// "Día Comercial" en analiticas.js) -- acá se mira para atrás (qué pasó
// días/meses anteriores) y se exportan datos, no se opera el día de hoy.
// Arranca con lo que ya existía (historial diario + resumen mensual +
// exportar CSV + "Borrar TODO", todo movido tal cual desde analiticas.js);
// los gráficos/exportaciones nuevas que se vayan necesitando se agregan acá.
const template = `
<main class="wide">
  <section class="panel">
    <h2>Historial diario <span class="info-hint" tabindex="0">!<span class="info-hint-text">Se guarda al tocar "Finalizar día" en Día Comercial — cada fila queda fija, no cambia aunque edites pedidos después. "Diferencia" es efectivo contado menos efectivo esperado (inicial + lo cobrado en efectivo). Tocá una fila para ver los pedidos de ese día.</span></span></h2>
    <div id="daily-chart"></div>
    <div class="table-scroll">
      <table class="order-table">
        <thead>
          <tr><th>Fecha</th><th>Pedidos</th><th>Ingresos</th><th>Efvo. esperado</th><th>Efvo. contado</th><th>Diferencia</th></tr>
        </thead>
        <tbody id="daily-tbody"></tbody>
      </table>
    </div>
  </section>

  <section class="panel">
    <h2>Resumen mensual</h2>
    <div class="table-scroll">
      <table class="order-table">
        <thead>
          <tr><th>Mes</th><th>Pedidos</th><th>Ingresos</th></tr>
        </thead>
        <tbody id="monthly-tbody"></tbody>
      </table>
    </div>
  </section>

  <section class="panel">
    <h2>Exportar</h2>
    <p class="hint">Para contabilidad, o como respaldo manual además de lo que guarda Supabase — ver "Backup y recuperación" en la documentación.</p>
    <div style="display:flex; gap:10px; flex-wrap:wrap;">
      <a href="/api/export/orders.csv" class="primary" style="width:auto; padding:14px 20px; border-radius:var(--radius-md);">Descargar pedidos (CSV)</a>
      <a href="/api/export/business-days.csv" class="primary" style="width:auto; padding:14px 20px; border-radius:var(--radius-md);">Descargar días comerciales (CSV)</a>
    </div>
  </section>

  <section class="panel">
    <h2>Zona de pruebas</h2>
    <p class="hint"><strong>Borra TODO</strong>: todos los pedidos (activos y ya archivados) y todos los días comerciales (abiertos y ya cerrados, con su historial). Preventivo para pruebas — no queda nada, ni siquiera el historial real, así que solo tocalo si estás probando la app y querés arrancar de cero.</p>
    <button id="reset-today-btn" type="button" class="danger" style="width:auto;">Borrar TODO (pedidos y días)</button>
    <p id="reset-status" class="status"></p>
  </section>
</main>
`;

let unsubscribe = null;

function mount(root) {
  const dailyChartEl = root.querySelector('#daily-chart');
  const dailyTbodyEl = root.querySelector('#daily-tbody');
  const monthlyTbodyEl = root.querySelector('#monthly-tbody');
  const resetTodayBtn = root.querySelector('#reset-today-btn');
  const resetStatusEl = root.querySelector('#reset-status');

  let currentDay = Store.getBusinessDay(); // solo para el conteo del mensaje de "Borrar TODO"
  let allDays = []; // último historial recibido, mismo motivo

  function fmtMoney(n) {
    return `$${(n || 0).toFixed(2)}`;
  }

  function fmtDate(dateStr) {
    const [y, m, d] = dateStr.split('-');
    return `${d}/${m}/${y}`;
  }

  async function api(path, options) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Error de conexión.');
    return data;
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

  function renderOrderDetailTable(dayOrders) {
    if (dayOrders.length === 0) return document.createTextNode('Sin pedidos ese día.');
    const table = document.createElement('table');
    table.className = 'order-table';
    table.style.marginTop = '8px';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Nº pedido</th><th>Teléfono</th><th>Nombre</th><th>Monto</th><th>Método de pago</th><th>Estado</th></tr>';
    const tbody = document.createElement('tbody');
    dayOrders.forEach((o) => {
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
      resetStatusEl.textContent = e.message;
      resetStatusEl.className = 'status error';
    }
  }

  resetTodayBtn.addEventListener('click', async () => {
    const orders = Store.getOrders();
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
      loadHistory();
    } catch (e) {
      resetStatusEl.textContent = e.message;
      resetStatusEl.className = 'status error';
    }
    resetTodayBtn.disabled = false;
  });

  const onDayStatus = (e) => { currentDay = e.detail.day; };
  Store.on('business-day:status', onDayStatus);

  unsubscribe = () => {
    Store.off('business-day:status', onDayStatus);
  };

  loadHistory();
}

function unmount() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

Router.register('/analisis-datos.html', {
  title: 'Análisis de datos — Deliverys en vivo',
  wide: true,
  template,
  mount,
  unmount,
});
