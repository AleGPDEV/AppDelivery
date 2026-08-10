// Mapa en vivo (deliverys + pedidos + rutas) compartido entre Dashboard
// ("Deliverys y mapa") y Pedidos -- antes vivía duplicado a mano entre las
// dos, ahora es un solo factory que cada vista monta en su propio
// contenedor. `loadGoogleMaps()` sigue cacheado a nivel de módulo (no
// adentro de createMapPanel) para que entrar/salir de cualquiera de las dos
// vistas reuse la misma carga del script en vez de reinyectarlo.
import { Store } from '/js/store.js';
import { recomputeRouteForDriver } from '/js/route-helper.js';
import { createDriverLabel } from '/js/driver-label.js';

const GOOGLE_MAPS_API_KEY = 'AIzaSyDFkwn0iYF1X3S6Zu3B0XhdI1PrRj2zAvQ';
let googleMapsLoadPromise = null;
export function loadGoogleMaps() {
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

// mapEl ya tiene que estar en el DOM (con tamaño real) cuando se llama --
// `new maps.Map(mapEl, ...)` necesita medir el contenedor. `driverCountEl`
// es opcional: si la vista que llama no tiene dónde mostrar "N deliverys en
// línea", simplemente no se actualiza nada ahí.
export async function createMapPanel(mapEl, { driverCountEl } = {}) {
  const maps = await loadGoogleMaps();

  const map = new maps.Map(mapEl, {
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
  let hasFitBounds = false;

  const { driverLabel, teardown: teardownDriverLabel } = createDriverLabel();

  // Asignar directo desde el popup del pin — mismo patrón que assignOrder()
  // en pedidos.js (emitir, actualizar el pin al toque, recalcular la ruta de
  // a quién se le sacó y a quién se le dio el pedido).
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
    if (!driverCountEl) return;
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
    if (onChange) onChange();
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
    if (onChange) onChange();
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
    if (onChange) onChange();
  }

  function removeOrderPin(id) {
    const existing = orders.get(id);
    if (existing) {
      if (existing.marker) existing.marker.setMap(null);
      orders.delete(id);
    }
    if (onChange) onChange();
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

  let onChange = null;

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

  Store.on('drivers:snapshot', onDriversSnapshot);
  Store.on('driver:update', onDriverUpdate);
  Store.on('driver:remove', onDriverRemove);
  Store.on('orders:snapshot', onOrdersSnapshot);
  Store.on('order:update', onOrderUpdate);
  Store.on('order:remove', onOrderRemove);
  Store.on('routes:snapshot', onRoutesSnapshot);
  Store.on('driver:route', onDriverRoute);
  Store.on('route:remove', onRouteRemove);

  // Store ya puede tener snapshots cacheados de antes de que este panel
  // montara (no llega uno nuevo por cada visita, solo al conectar) —
  // hidratar a mano en vez de esperar un evento que no va a volver a llegar.
  Array.from(Store.getDrivers().values()).forEach(upsertDriver);
  Array.from(Store.getOrders().values()).forEach(upsertOrder);
  Array.from(Store.getRoutes().values()).forEach(upsertRoute);
  if (!hasFitBounds) fitBoundsToEverything();

  return {
    map,
    fitBoundsToEverything,
    // La vista que monta este panel puede engancharse acá para enterarse de
    // cualquier cambio de drivers/pedidos/rutas (ej. para refrescar una
    // lista propia que dependa de lo mismo) sin tener que suscribirse a
    // Store por su cuenta.
    onChange(cb) { onChange = cb; },
    focusOrder(orderId) {
      const o = orders.get(orderId);
      if (!o || !o.marker) return;
      map.panTo(o.marker.getPosition());
      o.infoWindow.open({ anchor: o.marker, map });
    },
    teardown() {
      clearInterval(intervalId);
      drivers.forEach((d) => { d.marker.setMap(null); d.infoWindow.close(); });
      orders.forEach((o) => { if (o.marker) o.marker.setMap(null); if (o.infoWindow) o.infoWindow.close(); });
      routeLines.forEach((line) => line.setMap(null));
      Store.off('drivers:snapshot', onDriversSnapshot);
      Store.off('driver:update', onDriverUpdate);
      Store.off('driver:remove', onDriverRemove);
      Store.off('orders:snapshot', onOrdersSnapshot);
      Store.off('order:update', onOrderUpdate);
      Store.off('order:remove', onOrderRemove);
      Store.off('routes:snapshot', onRoutesSnapshot);
      Store.off('driver:route', onDriverRoute);
      Store.off('route:remove', onRouteRemove);
      teardownDriverLabel();
    },
  };
}
