import { Store } from '/js/store.js';
import { Router } from '/js/router.js';
import { createDriverLabel } from '/js/driver-label.js';
import { template as proveedoresTemplate, mount as mountProveedores, unmount as unmountProveedores } from '/js/views/proveedores.js';

// "Día Comercial" agrupa todo lo administrativo del día: abrir/cerrar caja
// con su desglose en vivo, los gastos a proveedores (antes una pestaña
// aparte, ver proveedores.js -- se embebe tal cual, mount()/unmount()
// reusan el mismo root así no hace falta duplicar su lógica) y el desglose
// de dinero por delivery (antes vivía en Pedidos -- ver pedidos.js, que
// ahora se queda solo con lo operativo: pedidos, asignación, rutas). Las
// estadísticas/historial/exportación viven aparte, en "Análisis de datos"
// (ver analisis-datos.js) -- esta pantalla es para operar el día de hoy,
// no para mirar para atrás.
const template = `
<main class="wide">
  <div class="day-cards-grid">
    <section class="panel">
      <h2>Día comercial</h2>
      <p id="day-status" class="driver-count">Cargando...</p>

      <div class="field">
        <label for="cash-start">Efectivo inicial (con el que arrancó la caja)</label>
        <input type="text" id="cash-start" placeholder="$ 2.000,00">
      </div>

      <button id="start-day-btn" type="button" class="primary" style="width:auto;">Iniciar día</button>
    </section>

    <section class="panel" id="cash-breakdown" style="display:none;">
      <h3 style="margin-top:0;">Desglose de caja (en vivo) <span class="info-hint" tabindex="0">!<span class="info-hint-text">Se va actualizando solo con cada venta y cada gasto — si al cerrar el día no cuadra, comparalo contra este desglose para ver en qué momento se desvió.</span></span></h3>
      <div class="driver-card-stats">
        <div class="driver-stat"><label>Efectivo inicial</label><span class="value" id="cb-cash-start">$0.00</span></div>
        <div class="driver-stat"><label>Ventas totales</label><span class="value" id="cb-ventas-totales">$0.00</span></div>
        <div class="driver-stat"><label>Ventas en efectivo</label><span class="value" id="cb-ventas-efectivo">$0.00</span></div>
        <div class="driver-stat"><label>Gastos a proveedores (efvo.)</label><span class="value" id="cb-gastos">$0.00</span></div>
        <div class="driver-stat"><label>Efectivo esperado ahora</label><strong id="cb-esperado">$0.00</strong></div>
      </div>
    </section>

    <section class="panel">
      <div id="cash-end-field" class="field" style="display:none;">
        <label for="cash-end">Efectivo final (contado al cerrar)</label>
        <input type="text" id="cash-end" placeholder="$ 15.000,00">
      </div>
      <button id="end-day-btn" type="button" class="danger" style="width:auto;">Finalizar día</button>
    </section>
  </div>

  <p id="day-status-msg" class="status"></p>

  <div class="day-cards-grid">
    ${proveedoresTemplate}
  </div>

  <section class="panel collapsible-panel" id="cash-panel">
    <div class="collapsible-header">
      <h2 style="margin:0;">Desglose de dinero</h2>
      <button id="cash-toggle-btn" type="button" class="small" title="Minimizar">▾</button>
    </div>
    <div class="collapsible-body">
      <p id="cash-empty" class="hint" hidden>Todavía no hay entregas registradas.</p>
      <div id="cash-cards"></div>
    </div>
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
  const cashPanelEl = root.querySelector('#cash-panel');
  const cashToggleBtn = root.querySelector('#cash-toggle-btn');
  const cashCardsEl = root.querySelector('#cash-cards');
  const cashEmptyEl = root.querySelector('#cash-empty');

  mountProveedores(root);

  let cashCollapsed = false;
  cashToggleBtn.addEventListener('click', () => {
    cashCollapsed = !cashCollapsed;
    cashPanelEl.classList.toggle('collapsed', cashCollapsed);
    cashToggleBtn.textContent = cashCollapsed ? '▸' : '▾';
    cashToggleBtn.title = cashCollapsed ? 'Mostrar desglose de dinero' : 'Minimizar';
  });

  MoneyCounter.attach(cashStartEl);
  MoneyCounter.attach(cashEndEl);

  let currentDay = Store.getBusinessDay();
  let formConfig = Store.getFormConfig();
  if (!Array.isArray(formConfig.paymentMethods)) formConfig.paymentMethods = [];

  const socket = Store.socket;
  const { driverLabel, teardown: teardownDriverLabel } = createDriverLabel();

  function fmtMoney(n) {
    return `$${(n || 0).toFixed(2)}`;
  }

  function fmtDateTime(iso) {
    return new Date(iso).toLocaleString('es-UY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function fmtDate(dateStr) {
    const [y, m, d] = dateStr.split('-');
    return `${d}/${m}/${y}`;
  }

  function isCashPayment(paymentMethod) {
    if (!paymentMethod) return false;
    const method = (formConfig.paymentMethods || []).find((m) => m.name === paymentMethod);
    return !!(method && method.isCash);
  }

  // Mismo espíritu que el desglose por delivery de más abajo (Cambio
  // inicial + Ventas + Gastos = Total), pero a nivel de todo el día — para
  // que el admin vea en vivo hacia dónde va la caja, no recién al tocar
  // "Finalizar día". `cashStartOverride` se usa al validar el cierre
  // (compara contra lo que se está por mandar, no contra lo último
  // persistido).
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
    } catch (e) {
      dayStatusMsgEl.textContent = e.message;
      dayStatusMsgEl.className = 'status error';
      endDayBtn.disabled = false;
    }
  });

  // ---------- Desglose de dinero por delivery ----------
  // Portado tal cual desde pedidos.js (donde vivía junto con "Deliverys
  // activos y pedidos asignados", que se queda allá) — cambio inicial
  // editable, total por método de pago, ventas totales, gastos asignados,
  // total a entregar, "Cerrar rendición". Acá no hay un mapa cuyo
  // onChange() reusar, así que reacciona directo a orders:snapshot/
  // drivers:snapshot y sus variantes puntuales.
  const cashCards = new Map(); // driverId -> refs

  function sumBy(list, predicate) {
    const filtered = list.filter(predicate);
    return { count: filtered.length, total: filtered.reduce((sum, e) => sum + (e.amount || 0), 0) };
  }
  function fmtCell({ count, total }) {
    return `${count} — $${total.toFixed(2)}`;
  }
  function pendingDeliveries(driverId) {
    return Array.from(Store.getOrders().values()).filter((o) => o.assignedTo === driverId && o.status === 'entregado' && !o.reconciledAt);
  }
  function cashExpensesForDriver(driverId) {
    return Array.from(Store.getExpenses().values()).filter((e) => e.driverId === driverId).reduce((sum, e) => sum + (e.amount || 0), 0);
  }

  function statCell(container, labelText) {
    const wrap = document.createElement('div');
    wrap.className = 'driver-stat';
    const label = document.createElement('label');
    label.textContent = labelText;
    wrap.appendChild(label);
    container.appendChild(wrap);
    return wrap;
  }

  function buildCashStatCells(driverId, refs) {
    refs.statsEl.innerHTML = '';
    refs.methodCells.clear();

    const cambioWrap = statCell(refs.statsEl, 'Cambio inicial');
    const cambioInput = document.createElement('input');
    cambioInput.type = 'text';
    cambioInput.placeholder = '$ 0,00';
    cambioInput.addEventListener('input', () => {
      const amount = Geo.parseAmount(cambioInput.value) || 0;
      socket.emit('driver:cash-start', { driverId, amount });
      updateCashCard(driverId);
    });
    cambioWrap.appendChild(cambioInput);
    MoneyCounter.attach(cambioInput);
    refs.cambioInput = cambioInput;

    formConfig.paymentMethods.forEach((m) => {
      const wrap = statCell(refs.statsEl, m.name);
      const valueEl = document.createElement('span');
      valueEl.className = 'value';
      wrap.appendChild(valueEl);
      refs.methodCells.set(m.id, valueEl);
    });

    const ventasWrap = statCell(refs.statsEl, 'Ventas totales');
    const ventasValueEl = document.createElement('span');
    ventasValueEl.className = 'value';
    ventasWrap.appendChild(ventasValueEl);
    refs.ventasValueEl = ventasValueEl;

    const gastosWrap = statCell(refs.statsEl, 'Gastos asignados');
    const gastosValueEl = document.createElement('span');
    gastosValueEl.className = 'value';
    gastosWrap.appendChild(gastosValueEl);
    refs.gastosValueEl = gastosValueEl;

    const totalWrap = statCell(refs.statsEl, 'Total a entregar');
    const totalValueEl = document.createElement('strong');
    totalWrap.appendChild(totalValueEl);
    refs.totalValueEl = totalValueEl;
  }

  function ensureCashCard(driverId) {
    const existing = cashCards.get(driverId);
    if (existing) return existing;
    const card = document.createElement('div');
    card.className = 'panel driver-card';
    const header = document.createElement('div');
    header.className = 'driver-card-header';
    const nameEl = document.createElement('strong');
    header.appendChild(nameEl);
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'danger small';
    clearBtn.textContent = 'Cerrar rendición';
    clearBtn.addEventListener('click', () => {
      socket.emit('driver:clear-log', { driverId });
      socket.emit('driver:cash-start', { driverId, amount: 0 });
      updateCashCard(driverId);
    });
    header.appendChild(clearBtn);
    card.appendChild(header);
    const statsEl = document.createElement('div');
    statsEl.className = 'driver-card-stats';
    card.appendChild(statsEl);
    cashCardsEl.appendChild(card);
    const refs = { card, nameEl, statsEl, methodCells: new Map() };
    cashCards.set(driverId, refs);
    buildCashStatCells(driverId, refs);
    return refs;
  }

  function updateCashCard(driverId) {
    const refs = ensureCashCard(driverId);
    const log = pendingDeliveries(driverId);
    const cashStart = Store.getCashStarts().get(driverId) || 0;
    const gastos = cashExpensesForDriver(driverId);
    let cashMethodsTotal = 0;

    refs.nameEl.textContent = `${driverLabel(driverId)} (${log.length} sin rendir)`;
    let ventasTotal = 0;
    formConfig.paymentMethods.forEach((m) => {
      const cell = sumBy(log, (e) => e.paymentMethod === m.name);
      const el = refs.methodCells.get(m.id);
      if (el) el.textContent = fmtCell(cell);
      if (m.isCash) cashMethodsTotal += cell.total;
      ventasTotal += cell.total;
    });
    if (refs.ventasValueEl) refs.ventasValueEl.textContent = `$${ventasTotal.toFixed(2)}`;
    if (refs.gastosValueEl) refs.gastosValueEl.textContent = gastos > 0 ? `-$${gastos.toFixed(2)}` : '$0.00';

    const debe = cashMethodsTotal + cashStart - gastos;
    if (refs.totalValueEl) refs.totalValueEl.textContent = `$${debe.toFixed(2)}`;
    if (refs.cambioInput && document.activeElement !== refs.cambioInput) refs.cambioInput.value = cashStart || '';
  }

  function renderCashCards() {
    const assignedDriverIds = new Set(Array.from(Store.getOrders().values()).map((o) => o.assignedTo).filter(Boolean));
    const driverIds = new Set([...assignedDriverIds, ...Store.getDrivers().keys()]);

    cashEmptyEl.hidden = driverIds.size > 0;

    if (driverIds.size === 0) {
      cashCards.forEach((refs) => refs.card.remove());
      cashCards.clear();
      return;
    }

    cashCards.forEach((refs, driverId) => {
      if (!driverIds.has(driverId)) { refs.card.remove(); cashCards.delete(driverId); }
    });

    driverIds.forEach((driverId) => {
      const refs = ensureCashCard(driverId);
      if (!refs.card.isConnected) cashCardsEl.appendChild(refs.card);
      updateCashCard(driverId);
    });
  }

  function rebuildCashCardsForNewFormConfig() {
    cashCards.forEach((refs, driverId) => buildCashStatCells(driverId, refs));
    renderCashCards();
  }

  const onDayStatus = (e) => {
    currentDay = e.detail.day;
    renderDayStatus();
  };
  const onOrdersChange = () => { renderCashBreakdown(); renderCashCards(); };
  const onExpensesSnapshot = () => { renderCashBreakdown(); renderCashCards(); };
  const onFormConfigSnapshot = (e) => {
    formConfig = e.detail || { paymentMethods: [] };
    if (!Array.isArray(formConfig.paymentMethods)) formConfig.paymentMethods = [];
    renderCashBreakdown();
    rebuildCashCardsForNewFormConfig();
  };
  const onDriversSnapshot = () => renderCashCards();
  const onDriverUpdate = () => renderCashCards();
  const onDriverRemove = () => renderCashCards();
  const onCashStartsSnapshot = () => renderCashCards();
  const onDriverCashStart = (e) => {
    if (cashCards.has(e.detail.driverId)) updateCashCard(e.detail.driverId);
  };

  Store.on('business-day:status', onDayStatus);
  Store.on('orders:snapshot', onOrdersChange);
  Store.on('order:update', onOrdersChange);
  Store.on('order:remove', onOrdersChange);
  Store.on('expenses:snapshot', onExpensesSnapshot);
  Store.on('form-config:snapshot', onFormConfigSnapshot);
  Store.on('drivers:snapshot', onDriversSnapshot);
  Store.on('driver:update', onDriverUpdate);
  Store.on('driver:remove', onDriverRemove);
  Store.on('cash-starts:snapshot', onCashStartsSnapshot);
  Store.on('driver:cash-start', onDriverCashStart);

  unsubscribe = () => {
    Store.off('business-day:status', onDayStatus);
    Store.off('orders:snapshot', onOrdersChange);
    Store.off('order:update', onOrdersChange);
    Store.off('order:remove', onOrdersChange);
    Store.off('expenses:snapshot', onExpensesSnapshot);
    Store.off('form-config:snapshot', onFormConfigSnapshot);
    Store.off('drivers:snapshot', onDriversSnapshot);
    Store.off('driver:update', onDriverUpdate);
    Store.off('driver:remove', onDriverRemove);
    Store.off('cash-starts:snapshot', onCashStartsSnapshot);
    Store.off('driver:cash-start', onDriverCashStart);
    clearTimeout(cashStartSaveTimer);
    teardownDriverLabel();
    unmountProveedores();
  };

  loadCurrentDay();
  renderCashCards();
}

function unmount() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

Router.register('/analiticas.html', {
  title: 'Día Comercial — Deliverys en vivo',
  wide: true,
  template,
  mount,
  unmount,
});
