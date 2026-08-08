import { Store } from '/js/store.js';
import { Router } from '/js/router.js';

const template = `
<main>
  <section class="panel">
    <h2>Deliverys conectados</h2>
    <ul id="driver-list" class="driver-list"></ul>
  </section>

  <section class="panel">
    <p id="driver-count" class="driver-count">Esperando deliverys conectados...</p>
    <div id="map"></div>
  </section>
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

function orderPopup(drivers, o) {
  const assignedText = o.assignedTo && drivers.has(o.assignedTo)
    ? `Asignado a ${drivers.get(o.assignedTo).name}`
    : 'Sin asignar';
  const who = o.name ? `${o.name}${o.phone ? ` (${o.phone})` : ''}<br>` : '';
  return popupWrap(`<strong>Pedido #${o.orderNumber || '?'}</strong><br>${who}${o.label}<br>${assignedText}`);
}

function orderColor(drivers, o) {
  return (o.assignedTo && drivers.has(o.assignedTo)) ? drivers.get(o.assignedTo).color : UNASSIGNED_COLOR;
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
  active = null;
}

async function mount(root) {
  const myGeneration = ++currentGeneration;
  const driverCountEl = root.querySelector('#driver-count');
  const driverListEl = root.querySelector('#driver-list');

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
  let hasFitBounds = false;

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

  function refreshOrderColorsFor(driverId) {
    orders.forEach((o) => {
      if (o.assignedTo === driverId && o.marker) {
        o.marker.setIcon(orderIcon(orderColor(drivers, o)));
        o.infoWindow.setContent(orderPopup(drivers, o));
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
    renderDrivers();
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
        infoWindow.setContent(orderPopup(drivers, existing));
      } else if (!hasLocation && marker) {
        marker.setMap(null);
        existing.marker = null;
        existing.infoWindow = null;
      }
    } else if (hasLocation) {
      const position = { lat: o.lat, lng: o.lng };
      const marker = new maps.Marker({ position, map, icon: orderIcon(color) });
      const infoWindow = new maps.InfoWindow({ content: orderPopup(drivers, o) });
      marker.addListener('click', () => infoWindow.open({ anchor: marker, map }));
      orders.set(o.id, { ...o, marker, infoWindow });
      fitBoundsToEverything();
    } else {
      orders.set(o.id, { ...o, marker: null, infoWindow: null });
    }
  }

  function removeOrderPin(id) {
    const existing = orders.get(id);
    if (existing) {
      if (existing.marker) existing.marker.setMap(null);
      orders.delete(id);
    }
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
  };

  active = { intervalId, drivers, orders, routeLines, unsubscribe };

  // Store ya puede tener snapshots cacheados de antes de que esta vista
  // montara (no llega uno nuevo por cada visita, solo al conectar) —
  // hidratar a mano en vez de esperar un evento que no va a volver a llegar.
  Array.from(Store.getDrivers().values()).forEach(upsertDriver);
  Array.from(Store.getOrders().values()).forEach(upsertOrder);
  Array.from(Store.getRoutes().values()).forEach(upsertRoute);
  if (!hasFitBounds) fitBoundsToEverything();
}

function unmount() {
  currentGeneration++;
  teardownActive();
}

Router.register('/dashboard.html', {
  title: 'Deliverys y mapa — Deliverys en vivo',
  subtitle: 'Cargá pedidos, asignalos, y mirá cómo se mueven tus deliverys en el mapa.',
  wide: false,
  template,
  mount,
  unmount,
});
