import { Store } from '/js/store.js';
import { Router } from '/js/router.js';
import { recomputeRouteForDriver } from '/js/route-helper.js';
import { createDriverLabel } from '/js/driver-label.js';

// "Rendición de caja" ya no es una pestaña aparte — se fusionó acá, al lado
// del mapa: una tarjeta por delivery con el mismo desglose que tenía
// caja.js (cambio inicial, un total por método de pago, gastos asignados,
// total a entregar) más la lista de sus pedidos todavía sin entregar,
// clickeable para centrar el mapa en ese pedido.
const template = `
<main class="wide">
  <div class="dashboard-layout">
    <section class="panel dashboard-map-panel">
      <p id="driver-count" class="driver-count">Esperando deliverys conectados...</p>
      <div id="map"></div>
    </section>
    <section class="dashboard-drivers-panel">
      <h2>Rendición por delivery</h2>
      <p class="hint">Se arma sola con los pedidos que cada delivery entrega (importe + forma de pago elegida al momento de entregar). "Cambio inicial" lo cargás vos acá y se ve en el celular del delivery (de solo lectura ahí). "Gastos asignados" son los pagos a proveedores que cargaste a nombre de este delivery en "Proveedores" — se restan porque salieron de la plata que ya tenía encima. "Total a entregar" = cambio inicial + lo cobrado en efectivo − gastos asignados.</p>
      <p id="cash-empty" class="hint" hidden>Todavía no hay entregas registradas.</p>
      <div id="driver-cards"></div>
    </section>
  </div>
</main>
`;

// Cacheado a nivel de módulo (no adentro de mount()) para que entrar/salir
// de esta vista varias veces reuse la misma carga del script de Google Maps
// en vez de reinyectarlo — reinyectarlo tira el warning/rotura de "incluiste
// la API de Maps más de una vez".
const GOOGLE_MAPS_API_KEY = 'AIzaSyDFkwn0iYF1X3S6Zu3B0XhdI1PrRj2zAvQ';
let googleMapsLoadPromise = null;
function loadGoogleMaps() {
  if (googleMapsLoadPromise) return googleMapsLoadPromise;
  googleMapsLoadPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.maps) { resolve(window.google.maps); return; }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}`;
    script.onload = () => resolve(window.google.maps);
    script.onerror = () => reject(new Error('No se pudo cargar Google Maps.'));
    document.head.appendChild(script);
  });
  return googleMapsLoadPromise;
}

const UNASSIGNED_COLOR = '#9aa1ac';

function svgIcon(maps, color, emoji, size, shape) {
  const half = size / 2;
  const shapeSvg = shape === 'circle'
    ? `<circle cx="${half}" cy="${half}" r="${half - 2}" fill="${color}" stroke="white" stroke-width="2"/>`
    : `<rect x="2" y="2" width="${size - 4}" height="${size - 4}" rx="6" fill="${color}" stroke="white" stroke-width="2"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${shapeSvg}<text x="${half}" y="${half + 5}" font-size="${Math.round(size * 0.5)}" text-anchor="middle">${emoji}</text></svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new maps.Size(size, size),
    anchor: new maps.Point(half, half),
  };
}

function timeAgo(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `hace ${seconds}s`;
  return `hace ${Math.round(seconds / 60)} min`;
}

function popupWrap(html) {
  return `<div style="color:#1c1e21; font-size:0.9rem; line-height:1.5;">${html}</div>`;
}

function driverPopup(d) {
  return popupWrap(`<strong>${d.name}</strong><br>${timeAgo(d.updatedAt)}`);
}

// A diferencia de driverPopup (string, sin interacción), acá hace falta un
// elemento DOM de verdad para poder colgarle un listener al <select> de
// "Asignar a" — mismo patrón que ya usa driver.js para su popup con el botón
// "Entregado" (buildOrderPopup() devuelve un nodo, no un string).
function buildOrderPopupContent(drivers, o, driverLabel, onAssignChange) {
  const wrap = document.createElement('div');
  wrap.style.color = '#1c1e21';
  wrap.style.fontSize = '0.9rem';
  wrap.style.lineHeight = '1.5';

  const title = document.createElement('strong');
  title.textContent = `Pedido #${o.orderNumber || '?'}`;
  wrap.appendChild(title);
  wrap.appendChild(document.createElement('br'));

  if (o.name) {
    wrap.appendChild(document.createTextNode(`${o.name}${o.phone ? ` (${o.phone})` : ''}`));
    wrap.appendChild(document.createElement('br'));
  }
  wrap.appendChild(document.createTextNode(o.label || ''));

  const assignLabel = document.createElement('label');
  assignLabel.style.display = 'block';
  assignLabel.style.marginTop = '8px';
  assignLabel.style.fontSize = '0.8rem';
  assignLabel.style.fontWeight = '600';
  assignLabel.textContent = 'Asignar a';

  const select = document.createElement('select');
  select.style.marginTop = '4px';
  select.style.width = '100%';
  select.style.fontSize = '0.85rem';
  select.style.padding = '4px 6px';
  select.style.background = '#fff';
  select.style.color = '#1c1e21';
  select.style.border = '1px solid #d7dee3';
  select.style.borderRadius = '6px';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = 'Sin asignar';
  select.appendChild(noneOpt);
  drivers.forEach((d, driverId) => {
    const opt = document.createElement('option');
    opt.value = driverId;
    opt.textContent = d.name;
    select.appendChild(opt);
  });
  if (o.assignedTo && !drivers.has(o.assignedTo)) {
    const opt = document.createElement('option');
    opt.value = o.assignedTo;
    opt.textContent = `${driverLabel(o.assignedTo)} (desconectado)`;
    select.appendChild(opt);
  }
  select.value = o.assignedTo || '';
  select.addEventListener('click', (e) => e.stopPropagation());
  select.addEventListener('change', () => onAssignChange(o.id, select.value || null));

  assignLabel.appendChild(select);
  wrap.appendChild(assignLabel);

  return wrap;
}

function orderColor(drivers, o) {
  return (o.assignedTo && drivers.has(o.assignedTo)) ? drivers.get(o.assignedTo).color : UNASSIGNED_COLOR;
}

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
let active = null; // { intervalId, drivers, orders, routeLines, unsubscribe } de la instancia montada

function teardownActive() {
  if (!active) return;
  clearInterval(active.intervalId);
  active.drivers.forEach((d) => { d.marker.setMap(null); d.infoWindow.close(); });
  active.orders.forEach((o) => { if (o.marker) o.marker.setMap(null); if (o.infoWindow) o.infoWindow.close(); });
  active.routeLines.forEach((line) => line.setMap(null));
  active.unsubscribe();
  active.teardownDriverLabel();
  active = null;
}

async function mount(root) {
  const myGeneration = ++currentGeneration;
  const driverCountEl = root.querySelector('#driver-count');
  const driverCardsEl = root.querySelector('#driver-cards');
  const cashEmptyEl = root.querySelector('#cash-empty');

  const maps = await loadGoogleMaps();
  if (myGeneration !== currentGeneration) return; // se navegó a otra vista mientras cargaba

  const map = new maps.Map(root.querySelector('#map'), {
    center: { lat: -34.9011, lng: -56.1645 },
    zoom: 12,
    mapTypeControl: false,
    streetViewControl: false,
  });

  const driverIcon = (color) => svgIcon(maps, color, '🛵', 46, 'circle');
  const orderIcon = (color) => svgIcon(maps, color, '📦', 38, 'square');

  const drivers = new Map();
  const orders = new Map();
  const routeLines = new Map();
  const driverCards = new Map(); // driverId -> refs de la tarjeta de rendición
  let hasFitBounds = false;
  let formConfig = Store.getFormConfig();

  const { driverLabel, teardown: teardownDriverLabel } = createDriverLabel();

  // Asignar directo desde el popup del pin, sin tener que ir a la pestaña
  // Pedidos — mismo patrón que assignOrder() en esa vista (emitir, actualizar
  // el pin al toque, recalcular la ruta de a quién se le sacó y a quién se le
  // dio el pedido).
  function assignOrder(orderId, driverId) {
    const existing = orders.get(orderId);
    const oldDriverId = existing ? existing.assignedTo : null;
    Store.socket.emit('order:assign', { id: orderId, driverId });
    if (existing) upsertOrder({ ...existing, assignedTo: driverId });
    recomputeRouteForDriver(oldDriverId);
    recomputeRouteForDriver(driverId);
  }

  function fitBoundsToEverything() {
    const points = [
      ...Array.from(drivers.values()).map((d) => ({ lat: d.lat, lng: d.lng })),
      ...Array.from(orders.values()).filter((o) => o.lat != null).map((o) => ({ lat: o.lat, lng: o.lng })),
    ];
    if (points.length === 0) return;
    const bounds = new maps.LatLngBounds();
    points.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, 40);
    maps.event.addListenerOnce(map, 'bounds_changed', () => {
      if (map.getZoom() > 15) map.setZoom(15);
    });
    hasFitBounds = true;
  }

  function updateCount() {
    driverCountEl.textContent = drivers.size === 0
      ? 'Ningún delivery está compartiendo su ubicación ahora mismo.'
      : `${drivers.size} delivery${drivers.size === 1 ? '' : 's'} en línea.`;
  }

  function refreshOrderColorsFor(driverId) {
    orders.forEach((o) => {
      if (o.assignedTo === driverId && o.marker) {
        o.marker.setIcon(orderIcon(orderColor(drivers, o)));
        o.infoWindow.setContent(buildOrderPopupContent(drivers, o, driverLabel, assignOrder));
      }
    });
  }

  function upsertDriver(d) {
    const existing = drivers.get(d.id);
    if (existing) {
      Object.assign(existing, d);
      existing.marker.setPosition({ lat: d.lat, lng: d.lng });
      existing.marker.setIcon(driverIcon(d.color));
      existing.infoWindow.setContent(driverPopup(existing));
    } else {
      const position = { lat: d.lat, lng: d.lng };
      const marker = new maps.Marker({ position, map, icon: driverIcon(d.color), title: d.name });
      const infoWindow = new maps.InfoWindow({ content: driverPopup(d) });
      marker.addListener('click', () => infoWindow.open({ anchor: marker, map }));
      drivers.set(d.id, { ...d, marker, infoWindow });
      fitBoundsToEverything();
    }
    updateCount();
    refreshOrderColorsFor(d.id);
    renderDriverCards();
  }

  function removeDriver(id) {
    const existing = drivers.get(id);
    if (existing) {
      existing.marker.setMap(null);
      drivers.delete(id);
    }
    const line = routeLines.get(id);
    if (line) { line.setMap(null); routeLines.delete(id); }
    updateCount();
    renderDriverCards();
  }

  function upsertOrder(o) {
    const existing = orders.get(o.id);
    const color = orderColor(drivers, o);
    const hasLocation = o.lat != null && o.lng != null && o.status !== 'entregado' && !o.archivedAt;
    if (existing) {
      const marker = existing.marker;
      const infoWindow = existing.infoWindow;
      Object.assign(existing, o, { marker, infoWindow });
      if (hasLocation && marker) {
        marker.setPosition({ lat: o.lat, lng: o.lng });
        marker.setIcon(orderIcon(color));
        infoWindow.setContent(buildOrderPopupContent(drivers, existing, driverLabel, assignOrder));
      } else if (!hasLocation && marker) {
        marker.setMap(null);
        existing.marker = null;
        existing.infoWindow = null;
      }
    } else if (hasLocation) {
      const position = { lat: o.lat, lng: o.lng };
      const marker = new maps.Marker({ position, map, icon: orderIcon(color) });
      const infoWindow = new maps.InfoWindow({ content: buildOrderPopupContent(drivers, o, driverLabel, assignOrder) });
      marker.addListener('click', () => infoWindow.open({ anchor: marker, map }));
      orders.set(o.id, { ...o, marker, infoWindow });
      fitBoundsToEverything();
    } else {
      orders.set(o.id, { ...o, marker: null, infoWindow: null });
    }
    renderDriverCards();
  }

  function removeOrderPin(id) {
    const existing = orders.get(id);
    if (existing) {
      if (existing.marker) existing.marker.setMap(null);
      orders.delete(id);
    }
    renderDriverCards();
  }

  function upsertRoute(r) {
    const existing = routeLines.get(r.driverId);
    if (existing) existing.setMap(null);
    if (!r.latlngs || r.latlngs.length < 2) {
      routeLines.delete(r.driverId);
      return;
    }
    const path = r.latlngs.map(([lat, lng]) => ({ lat, lng }));
    const line = new maps.Polyline({ path, strokeColor: r.color, strokeWeight: 4, strokeOpacity: 0.8, map });
    routeLines.set(r.driverId, line);
  }

  function removeRoute(driverId) {
    const line = routeLines.get(driverId);
    if (line) { line.setMap(null); routeLines.delete(driverId); }
  }

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

  function focusOrderOnMap(orderId) {
    const o = orders.get(orderId);
    if (!o || !o.marker) return;
    map.panTo(o.marker.getPosition());
    o.infoWindow.open({ anchor: o.marker, map });
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
          li.addEventListener('click', () => focusOrderOnMap(o.id));
        }
        refs.ordersList.appendChild(li);
      });
    }
  }

  function renderDriverCards() {
    const assignedDriverIds = new Set(Array.from(Store.getOrders().values()).map((o) => o.assignedTo).filter(Boolean));
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

  // ---------- Suscripciones ----------

  const intervalId = setInterval(() => {
    drivers.forEach((d) => d.infoWindow.setContent(driverPopup(d)));
  }, 5000);

  const onDriversSnapshot = (e) => { (e.detail || []).forEach(upsertDriver); if (!hasFitBounds) fitBoundsToEverything(); };
  const onDriverUpdate = (e) => upsertDriver(e.detail);
  const onDriverRemove = (e) => removeDriver(e.detail.id);
  const onOrdersSnapshot = (e) => { (e.detail || []).forEach(upsertOrder); if (!hasFitBounds) fitBoundsToEverything(); };
  const onOrderUpdate = (e) => upsertOrder(e.detail);
  const onOrderRemove = (e) => removeOrderPin(e.detail.id);
  const onRoutesSnapshot = (e) => (e.detail || []).forEach(upsertRoute);
  const onDriverRoute = (e) => upsertRoute(e.detail);
  const onRouteRemove = (e) => removeRoute(e.detail.driverId);
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

  Store.on('drivers:snapshot', onDriversSnapshot);
  Store.on('driver:update', onDriverUpdate);
  Store.on('driver:remove', onDriverRemove);
  Store.on('orders:snapshot', onOrdersSnapshot);
  Store.on('order:update', onOrderUpdate);
  Store.on('order:remove', onOrderRemove);
  Store.on('routes:snapshot', onRoutesSnapshot);
  Store.on('driver:route', onDriverRoute);
  Store.on('route:remove', onRouteRemove);
  Store.on('cash-starts:snapshot', onCashStartsSnapshot);
  Store.on('driver:cash-start', onDriverCashStart);
  Store.on('expenses:snapshot', onExpensesSnapshot);
  Store.on('form-config:snapshot', onFormConfigSnapshot);

  const unsubscribe = () => {
    Store.off('drivers:snapshot', onDriversSnapshot);
    Store.off('driver:update', onDriverUpdate);
    Store.off('driver:remove', onDriverRemove);
    Store.off('orders:snapshot', onOrdersSnapshot);
    Store.off('order:update', onOrderUpdate);
    Store.off('order:remove', onOrderRemove);
    Store.off('routes:snapshot', onRoutesSnapshot);
    Store.off('driver:route', onDriverRoute);
    Store.off('route:remove', onRouteRemove);
    Store.off('cash-starts:snapshot', onCashStartsSnapshot);
    Store.off('driver:cash-start', onDriverCashStart);
    Store.off('expenses:snapshot', onExpensesSnapshot);
    Store.off('form-config:snapshot', onFormConfigSnapshot);
  };

  active = { intervalId, drivers, orders, routeLines, unsubscribe, teardownDriverLabel };

  // Store ya puede tener snapshots cacheados de antes de que esta vista
  // montara (no llega uno nuevo por cada visita, solo al conectar) —
  // hidratar a mano en vez de esperar un evento que no va a volver a llegar.
  Array.from(Store.getDrivers().values()).forEach(upsertDriver);
  Array.from(Store.getOrders().values()).forEach(upsertOrder);
  Array.from(Store.getRoutes().values()).forEach(upsertRoute);
  if (!hasFitBounds) fitBoundsToEverything();
  renderDriverCards();
}

function unmount() {
  currentGeneration++;
  teardownActive();
}

Router.register('/dashboard.html', {
  title: 'Deliverys y mapa — Deliverys en vivo',
  subtitle: 'Mirá dónde están tus deliverys y rendí cuentas con cada uno, todo en la misma pantalla.',
  wide: true,
  template,
  mount,
  unmount,
});
