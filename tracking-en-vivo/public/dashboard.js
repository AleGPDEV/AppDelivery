const driverCountEl = document.getElementById('driver-count');
const driverListEl = document.getElementById('driver-list');
const stopsTextEl = document.getElementById('stops-text');
const loadBtn = document.getElementById('load-btn');
const loadStatusEl = document.getElementById('load-status');
const orderListEl = document.getElementById('order-list');
const orderCountEl = document.getElementById('order-count');
const cashListEl = document.getElementById('cash-list');

// Same key as geo.js — protected by HTTP referrer + API restriction in Google
// Cloud Console, not by secrecy (see optimizador-rutas/README.md).
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

// Builds a small colored pin as an inline SVG data URI — a circle for a
// delivery, a rounded square for a pedido, so they never read as
// interchangeable generic markers even before you look at the emoji.
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

function driverPopup(d) {
  return `<strong>${d.name}</strong><br>${timeAgo(d.updatedAt)}`;
}

function orderPopup(drivers, o) {
  const assignedText = o.assignedTo && drivers.has(o.assignedTo)
    ? `Asignado a ${drivers.get(o.assignedTo).name}`
    : 'Sin asignar';
  return `<strong>Pedido #${o.orderNumber || '?'}</strong><br>${o.label}<br>${assignedText}`;
}

function orderColor(drivers, o) {
  return (o.assignedTo && drivers.has(o.assignedTo)) ? drivers.get(o.assignedTo).color : UNASSIGNED_COLOR;
}

function orderPrecisionTag(o) {
  if (o.precision === 'street') return ' (aproximado: a nivel de calle, revisar)';
  if (o.precision === 'exact') return ' (verificar pin en el mapa)';
  return '';
}

async function main() {
  const maps = await loadGoogleMaps();
  const socket = io();

  const map = new maps.Map(document.getElementById('map'), {
    center: { lat: -34.9011, lng: -56.1645 },
    zoom: 12,
    mapTypeControl: false,
    streetViewControl: false,
  });

  const driverIcon = (color) => svgIcon(maps, color, '🛵', 46, 'circle');
  const orderIcon = (color) => svgIcon(maps, color, '📦', 38, 'square');

  // id -> { marker, infoWindow, name/label, ... }
  const drivers = new Map();
  const orders = new Map();
  const routeLines = new Map(); // driverId -> google.maps.Polyline
  const knownDriverNames = new Map(); // survives a driver going offline, so old assignments still show a name
  const deliveredLogs = new Map(); // driverId -> [{orderNumber, amount, paymentMethod, deliveredAt}]
  const cashInputs = new Map(); // driverId -> { cambio: number, gastos: number } — local only, not synced
  let hasFitBounds = false;

  function driverLabel(id) {
    const d = drivers.get(id);
    if (d) return d.name;
    return knownDriverNames.get(id) || 'delivery desconectado';
  }

  function isCash(paymentMethod) {
    const p = (paymentMethod || '').toLowerCase();
    return p === '' || p.includes('efectivo') || p === 'retira';
  }

  function renderCashList() {
    cashListEl.innerHTML = '';
    const driverIds = new Set([...deliveredLogs.keys(), ...drivers.keys()]);
    if (driverIds.size === 0) {
      cashListEl.innerHTML = '<p class="hint">Todavía no hay entregas registradas.</p>';
      return;
    }

    driverIds.forEach((driverId) => {
      const log = deliveredLogs.get(driverId) || [];
      const cashTotal = log.filter((e) => isCash(e.paymentMethod)).reduce((sum, e) => sum + (e.amount || 0), 0);
      const otherTotal = log.filter((e) => !isCash(e.paymentMethod)).reduce((sum, e) => sum + (e.amount || 0), 0);
      const state = cashInputs.get(driverId) || { cambio: 0, gastos: 0 };
      const debe = cashTotal + state.cambio - state.gastos;

      const box = document.createElement('div');
      box.className = 'field';
      box.style.borderBottom = '1px solid var(--border)';
      box.style.paddingBottom = '12px';
      box.style.marginBottom = '12px';

      const title = document.createElement('label');
      title.textContent = `${driverLabel(driverId)} — ${log.length} entregado${log.length === 1 ? '' : 's'}`;
      box.appendChild(title);

      const summary = document.createElement('p');
      summary.className = 'hint';
      summary.textContent = `Efectivo cobrado: $${cashTotal.toFixed(2)} — Otros medios: $${otherTotal.toFixed(2)}`;
      box.appendChild(summary);

      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '8px';
      row.style.alignItems = 'center';
      row.style.flexWrap = 'wrap';

      const cambioInput = document.createElement('input');
      cambioInput.type = 'text';
      cambioInput.placeholder = 'Cambio inicial';
      cambioInput.value = state.cambio || '';
      cambioInput.style.width = '140px';
      cambioInput.addEventListener('input', () => {
        state.cambio = Geo.parseAmount(cambioInput.value) || 0;
        cashInputs.set(driverId, state);
        renderCashList();
      });

      const gastosInput = document.createElement('input');
      gastosInput.type = 'text';
      gastosInput.placeholder = 'Gastos';
      gastosInput.value = state.gastos || '';
      gastosInput.style.width = '140px';
      gastosInput.addEventListener('input', () => {
        state.gastos = Geo.parseAmount(gastosInput.value) || 0;
        cashInputs.set(driverId, state);
        renderCashList();
      });

      const debeText = document.createElement('strong');
      debeText.textContent = `Debe entregar: $${debe.toFixed(2)}`;

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'danger small';
      clearBtn.textContent = 'Cerrar rendición';
      clearBtn.addEventListener('click', () => {
        socket.emit('driver:clear-log', { driverId });
        cashInputs.delete(driverId);
      });

      row.appendChild(cambioInput);
      row.appendChild(gastosInput);
      row.appendChild(debeText);
      row.appendChild(clearBtn);
      box.appendChild(row);

      cashListEl.appendChild(box);
    });
  }

  function fitBoundsToEverything() {
    const points = [
      ...Array.from(drivers.values()).map((d) => ({ lat: d.lat, lng: d.lng })),
      ...Array.from(orders.values()).map((o) => ({ lat: o.lat, lng: o.lng })),
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

  function renderDrivers() {
    driverListEl.innerHTML = '';
    if (drivers.size === 0) {
      driverListEl.innerHTML = '<li class="empty">Ningún delivery está compartiendo su ubicación ahora mismo.</li>';
      return;
    }
    drivers.forEach((d) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="swatch" style="background:${d.color}"></span> ${d.name}`;
      driverListEl.appendChild(li);
    });
  }

  function renderOrders() {
    orderListEl.innerHTML = '';
    orderCountEl.textContent = orders.size === 0
      ? 'Todavía no cargaste ningún pedido.'
      : `${orders.size} pedido${orders.size === 1 ? '' : 's'} pendiente${orders.size === 1 ? '' : 's'}.`;

    const sorted = Array.from(orders.entries()).sort((a, b) => (a[1].orderNumber || '').localeCompare(b[1].orderNumber || '', undefined, { numeric: true }));

    sorted.forEach(([id, o]) => {
      const li = document.createElement('li');

      const info = document.createElement('span');
      info.className = 'order-info';
      info.textContent = `#${o.orderNumber || '?'} — ${o.label}${orderPrecisionTag(o)}`;

      const select = document.createElement('select');
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
      select.addEventListener('change', () => assignOrder(id, select.value || null));

      li.appendChild(info);
      li.appendChild(select);
      orderListEl.appendChild(li);
    });
  }

  function assignOrder(orderId, driverId) {
    const order = orders.get(orderId);
    const previousDriverId = order ? order.assignedTo : null;
    socket.emit('order:assign', { id: orderId, driverId });
    if (order) order.assignedTo = driverId;
    renderOrders();
    recomputeRouteForDriver(previousDriverId);
    recomputeRouteForDriver(driverId);
  }

  // Recomputes and broadcasts the optimal route for everything currently
  // assigned to this driver, starting from their last known live position.
  async function recomputeRouteForDriver(driverId) {
    if (!driverId) return;
    const driver = drivers.get(driverId);
    if (!driver) return;

    const assigned = Array.from(orders.entries())
      .filter(([, o]) => o.assignedTo === driverId)
      .map(([id, o]) => ({ id, lat: o.lat, lng: o.lng, label: o.label, orderNumber: o.orderNumber }));

    if (assigned.length === 0) {
      socket.emit('driver:route', { driverId, stops: [], latlngs: [] });
      return;
    }

    try {
      const result = await Geo.computeRoute({ lat: driver.lat, lng: driver.lng }, assigned);
      const stops = result.orderedPoints.slice(1).map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, label: p.label, orderNumber: p.orderNumber }));
      socket.emit('driver:route', {
        driverId,
        stops,
        latlngs: result.latlngs,
        distanceKm: result.distanceKm,
        durationMin: result.durationMin,
      });
    } catch (e) {
      // Best-effort: if OSRM is briefly unreachable, the previous route stays displayed.
    }
  }

  function refreshOrderColorsFor(driverId) {
    orders.forEach((o) => {
      if (o.assignedTo === driverId) {
        o.marker.setIcon(orderIcon(orderColor(drivers, o)));
        o.infoWindow.setContent(orderPopup(drivers, o));
      }
    });
  }

  function upsertDriver(d) {
    knownDriverNames.set(d.id, d.name);
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
    renderDrivers();
    renderOrders();
    renderCashList();
    refreshOrderColorsFor(d.id);
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
    renderDrivers();
    renderOrders();
    renderCashList();
  }

  function upsertOrder(o) {
    const existing = orders.get(o.id);
    const color = orderColor(drivers, o);
    if (existing) {
      Object.assign(existing, o);
      existing.marker.setPosition({ lat: o.lat, lng: o.lng });
      existing.marker.setIcon(orderIcon(color));
      existing.infoWindow.setContent(orderPopup(drivers, existing));
    } else {
      const position = { lat: o.lat, lng: o.lng };
      const marker = new maps.Marker({ position, map, icon: orderIcon(color) });
      const infoWindow = new maps.InfoWindow({ content: orderPopup(drivers, o) });
      marker.addListener('click', () => infoWindow.open({ anchor: marker, map }));
      orders.set(o.id, { ...o, marker, infoWindow });
      fitBoundsToEverything();
    }
    renderOrders();
  }

  function removeOrderPin(id) {
    const existing = orders.get(id);
    if (existing) {
      existing.marker.setMap(null);
      orders.delete(id);
    }
    renderOrders();
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

  setInterval(() => {
    drivers.forEach((d) => d.infoWindow.setContent(driverPopup(d)));
  }, 5000);

  socket.on('drivers:snapshot', (list) => { list.forEach(upsertDriver); if (!hasFitBounds) fitBoundsToEverything(); });
  socket.on('driver:update', upsertDriver);
  socket.on('driver:remove', ({ id }) => removeDriver(id));

  socket.on('orders:snapshot', (list) => { list.forEach(upsertOrder); if (!hasFitBounds) fitBoundsToEverything(); });
  socket.on('order:update', upsertOrder);
  socket.on('order:remove', ({ id }) => removeOrderPin(id));

  socket.on('routes:snapshot', (list) => list.forEach(upsertRoute));
  socket.on('driver:route', upsertRoute);
  socket.on('route:remove', ({ driverId }) => removeRoute(driverId));

  socket.on('deliveredLogs:snapshot', (list) => {
    list.forEach(({ driverId, log }) => deliveredLogs.set(driverId, log));
    renderCashList();
  });
  socket.on('driver:delivered-log', ({ driverId, log }) => {
    deliveredLogs.set(driverId, log);
    renderCashList();
  });

  loadBtn.addEventListener('click', async () => {
    const rows = Geo.parseStopsText(stopsTextEl.value);
    if (rows.length === 0) {
      loadStatusEl.textContent = 'Pegá al menos un pedido (número de pedido + ubicación).';
      loadStatusEl.className = 'status error';
      return;
    }

    loadBtn.disabled = true;
    let okCount = 0;
    const failed = [];

    for (let i = 0; i < rows.length; i++) {
      const { order, raw, amount, paymentMethod } = rows[i];
      const label = order ? `el pedido #${order} (línea ${i + 1})` : `la línea ${i + 1}`;
      try {
        const point = await Geo.resolveInput(raw, label, (msg) => {
          loadStatusEl.textContent = msg;
          loadStatusEl.className = 'status';
        });
        socket.emit('order:add', { orderNumber: order, lat: point.lat, lng: point.lng, label: point.label, amount, paymentMethod });
        okCount++;
      } catch (e) {
        failed.push(`${order ? `#${order}` : `línea ${i + 1}`}: ${e.message}`);
      }
    }

    loadBtn.disabled = false;
    if (failed.length === 0) {
      loadStatusEl.textContent = `Se cargaron ${okCount} pedido${okCount === 1 ? '' : 's'} correctamente.`;
      loadStatusEl.className = 'status ok';
      stopsTextEl.value = '';
    } else {
      loadStatusEl.textContent = `${okCount} cargados. ${failed.length} con problemas:\n${failed.join('\n')}`;
      loadStatusEl.className = 'status error';
    }
  });
}

main();
