import { Store } from '/js/store.js';
import { Router } from '/js/router.js';
import { createMapPanel } from '/js/map-panel.js';
import { createDriverLabel } from '/js/driver-label.js';

// "Rendición de caja" ya no es una pestaña aparte — se fusionó acá, al lado
// del mapa: una tarjeta por delivery con el mismo desglose que tenía
// caja.js (cambio inicial, un total por método de pago, gastos asignados,
// total a entregar) más la lista de sus pedidos todavía sin entregar,
// clickeable para centrar el mapa en ese pedido. El mapa en sí (markers,
// popups, rutas) vive en public/js/map-panel.js, compartido con Pedidos.
const template = `
<main class="wide">
  <div class="dashboard-layout">
    <section class="panel dashboard-map-panel">
      <p id="driver-count" class="driver-count">Esperando deliverys conectados...</p>
      <div id="map"></div>
    </section>
    <section class="dashboard-drivers-panel">
      <h2>Rendición por delivery <span class="info-hint" tabindex="0">!<span class="info-hint-text">Se arma sola con los pedidos que cada delivery entrega (importe + forma de pago elegida al momento de entregar). "Cambio inicial" lo cargás vos acá y se ve en el celular del delivery (de solo lectura ahí). "Gastos asignados" son los pagos a proveedores que cargaste a nombre de este delivery en "Proveedores" — se restan porque salieron de la plata que ya tenía encima. "Total a entregar" = cambio inicial + lo cobrado en efectivo − gastos asignados.</span></span></h2>
      <p id="cash-empty" class="hint" hidden>Todavía no hay entregas registradas.</p>
      <div id="driver-cards"></div>
    </section>
  </div>
</main>
`;

// Helpers de la rendición (portados de caja.js tal cual, son funciones puras).
function sumBy(list, predicate) {
  const filtered = list.filter(predicate);
  return { count: filtered.length, total: filtered.reduce((sum, e) => sum + (e.amount || 0), 0) };
}

function fmtCell({ count, total }) {
  return `${count} — $${total.toFixed(2)}`;
}

// Token de "generación": unmount() lo incrementa, así que si el usuario
// navega a otra pestaña mientras todavía se está esperando a que cargue
// Google Maps (primera vez que se visita esta vista en la sesión), la
// continuación async que sigue después del `await` se da cuenta de que ya
// no es la vista activa y no toca el DOM ni crea nada.
let currentGeneration = 0;
let active = null; // { mapPanel, unsubscribe, teardownDriverLabel } de la instancia montada

function teardownActive() {
  if (!active) return;
  active.mapPanel.teardown();
  active.unsubscribe();
  active.teardownDriverLabel();
  active = null;
}

async function mount(root) {
  const myGeneration = ++currentGeneration;
  const driverCountEl = root.querySelector('#driver-count');
  const driverCardsEl = root.querySelector('#driver-cards');
  const cashEmptyEl = root.querySelector('#cash-empty');

  const mapPanel = await createMapPanel(root.querySelector('#map'), { driverCountEl });
  if (myGeneration !== currentGeneration) { mapPanel.teardown(); return; } // se navegó a otra vista mientras cargaba

  const driverCards = new Map(); // driverId -> refs de la tarjeta de rendición
  let formConfig = Store.getFormConfig();

  const { driverLabel, teardown: teardownDriverLabel } = createDriverLabel();

  // ---------- Rendición por delivery (portado de caja.js) ----------

  function pendingDeliveries(driverId) {
    return Array.from(Store.getOrders().values()).filter((o) => o.assignedTo === driverId && o.status === 'entregado' && !o.reconciledAt);
  }

  function assignedActiveOrders(driverId) {
    return Array.from(Store.getOrders().values()).filter((o) => o.assignedTo === driverId && o.status !== 'entregado' && !o.archivedAt);
  }

  function cashExpensesForDriver(driverId) {
    return Array.from(Store.getExpenses().values())
      .filter((e) => e.driverId === driverId)
      .reduce((sum, e) => sum + (e.amount || 0), 0);
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

  // Arma (o rearma, si cambió la lista de métodos de pago en Ajustes) las
  // celdas de la tarjeta — separado de ensureDriverCard porque hay que poder
  // rehacer esto solo para todas las tarjetas ya existentes sin recrearlas.
  function buildStatCells(driverId, refs) {
    refs.statsEl.innerHTML = '';
    refs.methodCells.clear();

    const cambioWrap = statCell(refs.statsEl, 'Cambio inicial');
    const cambioInput = document.createElement('input');
    cambioInput.type = 'text';
    cambioInput.placeholder = '$ 0,00';
    cambioInput.addEventListener('input', () => {
      const amount = Geo.parseAmount(cambioInput.value) || 0;
      Store.socket.emit('driver:cash-start', { driverId, amount });
      updateDriverCard(driverId);
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

  function ensureDriverCard(driverId) {
    const existing = driverCards.get(driverId);
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
      Store.socket.emit('driver:clear-log', { driverId });
      Store.socket.emit('driver:cash-start', { driverId, amount: 0 });
      updateDriverCard(driverId);
    });
    header.appendChild(clearBtn);
    card.appendChild(header);

    const statsEl = document.createElement('div');
    statsEl.className = 'driver-card-stats';
    card.appendChild(statsEl);

    const ordersSection = document.createElement('div');
    ordersSection.className = 'driver-card-orders';
    const ordersTitle = document.createElement('h4');
    ordersTitle.textContent = 'Pedidos asignados';
    ordersSection.appendChild(ordersTitle);
    const ordersList = document.createElement('ul');
    ordersSection.appendChild(ordersList);
    card.appendChild(ordersSection);

    driverCardsEl.appendChild(card);

    const refs = { card, nameEl, statsEl, ordersList, methodCells: new Map() };
    driverCards.set(driverId, refs);
    buildStatCells(driverId, refs);
    return refs;
  }

  function updateDriverCard(driverId) {
    const refs = ensureDriverCard(driverId);
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

    refs.ordersList.innerHTML = '';
    const pending = assignedActiveOrders(driverId);
    if (pending.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Ningún pedido asignado todavía.';
      refs.ordersList.appendChild(li);
    } else {
      pending.forEach((o) => {
        const li = document.createElement('li');
        li.textContent = `Pedido #${o.orderNumber || o.seq}`;
        if (o.lat != null) {
          li.classList.add('clickable');
          li.title = 'Ver en el mapa';
          li.addEventListener('click', () => mapPanel.focusOrder(o.id));
        }
        refs.ordersList.appendChild(li);
      });
    }
  }

  function renderDriverCards() {
    // Un pedido entregado y ya rendido ("Cerrar rendición") no cuenta para
    // mantener la tarjeta -- si no, un delivery desconectado con historial
    // viejo (entregas de hace rato, ya rendidas) queda pegado en pantalla
    // para siempre, aunque ya se le haya cerrado la rendición.
    const assignedDriverIds = new Set(
      Array.from(Store.getOrders().values())
        .filter((o) => o.assignedTo && (o.status !== 'entregado' || !o.reconciledAt) && !o.archivedAt)
        .map((o) => o.assignedTo)
    );
    const driverIds = new Set([...assignedDriverIds, ...Store.getDrivers().keys()]);

    cashEmptyEl.hidden = driverIds.size > 0;
    if (driverIds.size === 0) {
      driverCards.forEach((refs) => refs.card.remove());
      driverCards.clear();
      return;
    }

    driverCards.forEach((refs, driverId) => {
      if (!driverIds.has(driverId)) {
        refs.card.remove();
        driverCards.delete(driverId);
      }
    });

    driverIds.forEach((driverId) => {
      const refs = ensureDriverCard(driverId);
      if (!refs.card.isConnected) driverCardsEl.appendChild(refs.card);
      updateDriverCard(driverId);
    });
  }

  function rebuildDriverCardsForNewFormConfig() {
    driverCards.forEach((refs, driverId) => buildStatCells(driverId, refs));
    renderDriverCards();
  }

  mapPanel.onChange(renderDriverCards);

  const onCashStartsSnapshot = () => renderDriverCards();
  const onDriverCashStart = (e) => {
    if (driverCards.has(e.detail.driverId)) updateDriverCard(e.detail.driverId);
  };
  const onExpensesSnapshot = () => renderDriverCards();
  const onFormConfigSnapshot = (e) => {
    formConfig = e.detail || { paymentMethods: [] };
    if (!Array.isArray(formConfig.paymentMethods)) formConfig.paymentMethods = [];
    rebuildDriverCardsForNewFormConfig();
  };

  Store.on('cash-starts:snapshot', onCashStartsSnapshot);
  Store.on('driver:cash-start', onDriverCashStart);
  Store.on('expenses:snapshot', onExpensesSnapshot);
  Store.on('form-config:snapshot', onFormConfigSnapshot);

  const unsubscribe = () => {
    Store.off('cash-starts:snapshot', onCashStartsSnapshot);
    Store.off('driver:cash-start', onDriverCashStart);
    Store.off('expenses:snapshot', onExpensesSnapshot);
    Store.off('form-config:snapshot', onFormConfigSnapshot);
  };

  active = { mapPanel, unsubscribe, teardownDriverLabel };
  renderDriverCards();
}

function unmount() {
  currentGeneration++;
  teardownActive();
}

Router.register('/dashboard.html', {
  title: 'Deliverys y mapa — Deliverys en vivo',
  wide: true,
  template,
  mount,
  unmount,
});
