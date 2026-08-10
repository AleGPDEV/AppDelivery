import { Store } from '/js/store.js';
import { Router } from '/js/router.js';

const template = `
<main>
  <section class="panel">
    <h2>Día comercial</h2>
    <p id="day-status" class="driver-count">Cargando...</p>

    <div class="field">
      <label for="cash-start">Efectivo inicial (con el que arrancó la caja)</label>
      <input type="text" id="cash-start" placeholder="$ 2.000,00">
    </div>

    <div style="display:flex; gap:10px; flex-wrap:wrap;">
      <button id="start-day-btn" type="button" class="primary" style="width:auto;">Iniciar día</button>
      <button id="end-day-btn" type="button" class="danger" style="width:auto;">Finalizar día</button>
    </div>

    <div id="cash-breakdown" style="display:none; margin-top:16px;">
      <h3 style="margin-bottom:10px;">Desglose de caja (en vivo)</h3>
      <div class="driver-card-stats">
        <div class="driver-stat"><label>Efectivo inicial</label><span class="value" id="cb-cash-start">$0.00</span></div>
        <div class="driver-stat"><label>Ventas totales</label><span class="value" id="cb-ventas-totales">$0.00</span></div>
        <div class="driver-stat"><label>Ventas en efectivo</label><span class="value" id="cb-ventas-efectivo">$0.00</span></div>
        <div class="driver-stat"><label>Gastos a proveedores (efvo.)</label><span class="value" id="cb-gastos">$0.00</span></div>
        <div class="driver-stat"><label>Efectivo esperado ahora</label><strong id="cb-esperado">$0.00</strong></div>
      </div>
      <p class="hint">Se va actualizando solo con cada venta y cada gasto — si al cerrar el día no cuadra, comparalo contra este desglose para ver en qué momento se desvió.</p>
    </div>

    <div id="cash-end-field" class="field" style="display:none; margin-top:14px;">
      <label for="cash-end">Efectivo final (contado al cerrar)</label>
      <input type="text" id="cash-end" placeholder="$ 15.000,00">
    </div>

    <p id="day-status-msg" class="status"></p>
  </section>

  <section class="panel">
    <h2>Historial diario</h2>
    <p class="hint">Se guarda al tocar "Finalizar día" — cada fila queda fija, no cambia aunque edites pedidos después. "Diferencia" es efectivo contado menos efectivo esperado (inicial + lo cobrado en efectivo). Tocá una fila para ver los pedidos de ese día.</p>
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
  const dayStatusEl = root.querySelector('#day-status');
  const dayStatusMsgEl = root.querySelector('#day-status-msg');
  const startDayBtn = root.querySelector('#start-day-btn');
  const endDayBtn = root.querySelector('#end-day-btn');
  const cashEndFieldEl = root.querySelector('#cash-end-field');
  const cashStartEl = root.querySelector('#cash-start');
  const cashEndEl = root.querySelector('#cash-end');
  const cashBreakdownEl = root.querySelector('#cash-breakdown');
  const cbCashStartEl = root.querySelector('#cb-cash-start');
  const cbVentasTotalesEl = root.querySelector('#cb-ventas-totales');
  const cbVentasEfectivoEl = root.querySelector('#cb-ventas-efectivo');
  const cbGastosEl = root.querySelector('#cb-gastos');
  const cbEsperadoEl = root.querySelector('#cb-esperado');
  const dailyChartEl = root.querySelector('#daily-chart');
  const dailyTbodyEl = root.querySelector('#daily-tbody');
  const monthlyTbodyEl = root.querySelector('#monthly-tbody');
  const resetTodayBtn = root.querySelector('#reset-today-btn');
  const resetStatusEl = root.querySelector('#reset-status');

  MoneyCounter.attach(cashStartEl);
  MoneyCounter.attach(cashEndEl);

  let currentDay = Store.getBusinessDay();
  let allDays = []; // último historial recibido, solo para el conteo del botón "Borrar TODO"
  let formConfig = Store.getFormConfig();

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

  function isCashPayment(paymentMethod) {
    if (!paymentMethod) return false;
    const method = (formConfig.paymentMethods || []).find((m) => m.name === paymentMethod);
    return !!(method && method.isCash);
  }

  // Mismo espíritu que el desglose por delivery en dashboard.js (Cambio
  // inicial + Ventas + Gastos = Total), pero a nivel de todo el día — para que
  // el admin vea en vivo hacia dónde va la caja, no recién al tocar "Finalizar
  // día". `cashStartOverride` se usa al validar el cierre (compara contra lo
  // que se está por mandar, no contra lo último persistido).
  function computeCashBreakdown(cashStartOverride) {
    const cashStart = cashStartOverride != null ? cashStartOverride : ((currentDay && currentDay.cash_start) || 0);
    let ventasTotales = 0;
    let ventasEfectivo = 0;
    Store.getOrders().forEach((o) => {
      if (o.archivedAt || o.status !== 'entregado' || typeof o.amount !== 'number') return;
      ventasTotales += o.amount;
      if (isCashPayment(o.paymentMethod)) ventasEfectivo += o.amount;
    });
    let gastosEfectivo = 0;
    Store.getExpenses().forEach((e) => {
      if (e.paymentMethodIsCash) gastosEfectivo += e.amount;
    });
    return { cashStart, ventasTotales, ventasEfectivo, gastosEfectivo, cashExpected: cashStart + ventasEfectivo - gastosEfectivo };
  }

  function renderCashBreakdown() {
    if (!currentDay) return;
    const b = computeCashBreakdown();
    cbCashStartEl.textContent = fmtMoney(b.cashStart);
    cbVentasTotalesEl.textContent = fmtMoney(b.ventasTotales);
    cbVentasEfectivoEl.textContent = fmtMoney(b.ventasEfectivo);
    cbGastosEl.textContent = b.gastosEfectivo > 0 ? `-${fmtMoney(b.gastosEfectivo)}` : fmtMoney(0);
    cbEsperadoEl.textContent = fmtMoney(b.cashExpected);
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
      cashEndFieldEl.style.display = '';
      cashBreakdownEl.style.display = '';
      if (document.activeElement !== cashStartEl && currentDay.cash_start != null) {
        cashStartEl.value = currentDay.cash_start.toFixed(2);
      }
      renderCashBreakdown();
    } else {
      dayStatusEl.textContent = 'Ningún día abierto ahora mismo.';
      startDayBtn.disabled = false;
      endDayBtn.disabled = true;
      cashEndFieldEl.style.display = 'none';
      cashBreakdownEl.style.display = 'none';
    }
  }

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
        renderCashBreakdown();
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
    const cashStart = Geo.parseAmount(cashStartEl.value);
    if (cashStart == null) {
      dayStatusMsgEl.textContent = 'Ingresá el efectivo inicial (con el que arranca la caja) para poder iniciar el día.';
      dayStatusMsgEl.className = 'status error';
      cashStartEl.focus();
      return;
    }
    startDayBtn.disabled = true;
    dayStatusMsgEl.textContent = '';
    try {
      const { day } = await api('/api/business-day/start', { method: 'POST', body: JSON.stringify({ cashStart }) });
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

    const active = Array.from(Store.getOrders().values()).filter((o) => !o.archivedAt);
    const notDelivered = active.filter((o) => o.status !== 'entregado');

    let confirmMsg = `¿Finalizar el día? Se van a archivar ${active.length} pedido${active.length === 1 ? '' : 's'} (dejan de verse en "Pedidos") y quedan fijos en el historial.`;
    if (notDelivered.length > 0) {
      confirmMsg = `Hay ${notDelivered.length} pedido${notDelivered.length === 1 ? '' : 's'} sin entregar todavía. ${confirmMsg} ¿Archivar de todas formas?`;
    }

    const { cashExpected } = computeCashBreakdown(cashStart);
    const diff = cashEnd - cashExpected;
    if (Math.abs(diff) >= 0.01) {
      confirmMsg += `\n\n⚠️ El efectivo contado (${fmtMoney(cashEnd)}) no coincide con el esperado según el desglose (${fmtMoney(cashExpected)}) — diferencia de ${diff >= 0 ? '+' : ''}${fmtMoney(diff)}. ¿Cerrar igual?`;
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
      renderDayStatus();
      loadHistory();
    } catch (e) {
      resetStatusEl.textContent = e.message;
      resetStatusEl.className = 'status error';
    }
    resetTodayBtn.disabled = false;
  });

  const onDayStatus = (e) => {
    currentDay = e.detail.day;
    renderDayStatus();
  };
  const onOrdersChange = () => renderCashBreakdown();
  const onExpensesSnapshot = () => renderCashBreakdown();
  const onFormConfigSnapshot = (e) => {
    formConfig = e.detail || { paymentMethods: [] };
    if (!Array.isArray(formConfig.paymentMethods)) formConfig.paymentMethods = [];
    renderCashBreakdown();
  };
  Store.on('business-day:status', onDayStatus);
  Store.on('orders:snapshot', onOrdersChange);
  Store.on('order:update', onOrdersChange);
  Store.on('order:remove', onOrdersChange);
  Store.on('expenses:snapshot', onExpensesSnapshot);
  Store.on('form-config:snapshot', onFormConfigSnapshot);

  unsubscribe = () => {
    Store.off('business-day:status', onDayStatus);
    Store.off('orders:snapshot', onOrdersChange);
    Store.off('order:update', onOrdersChange);
    Store.off('order:remove', onOrdersChange);
    Store.off('expenses:snapshot', onExpensesSnapshot);
    Store.off('form-config:snapshot', onFormConfigSnapshot);
    clearTimeout(cashStartSaveTimer);
  };

  loadCurrentDay();
  loadHistory();
}

function unmount() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

Router.register('/analiticas.html', {
  title: 'Analíticas — Deliverys en vivo',
  wide: false,
  template,
  mount,
  unmount,
});
