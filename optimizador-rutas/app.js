const stopsTextEl = document.getElementById('stops-text');
const calculateBtn = document.getElementById('calculate');
const errorEl = document.getElementById('error');
const warningEl = document.getElementById('warning');
const resultsEl = document.getElementById('results');
const routeListEl = document.getElementById('route-list');
const distanceSummaryEl = document.getElementById('distance-summary');
const mapsLinkEl = document.getElementById('maps-link');

let map = null;
let mapLayer = null;
let currentOrderedPoints = [];
let currentRoundtrip = false;

// Parses one line as "<order number><separator><location>", where the separator
// is whitespace (including a pasted-from-spreadsheet tab) and/or a comma. If a
// line doesn't have that shape, the whole line is treated as the location with
// no order number.
function parseStopLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const m = trimmed.match(/^([^\s,]+)[\s,]+(.+)$/);
  if (m) return { order: m[1], raw: m[2].trim() };

  return { order: '', raw: trimmed };
}

function parseStopsText(text) {
  return text.split('\n').map(parseStopLine).filter(Boolean);
}

function parseCoordinates(raw) {
  const text = raw.trim();
  if (!text) return null;

  // Pattern: !3dLAT!4dLNG (Google Maps place pin detail)
  let m = text.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  // Pattern: @LAT,LNG (Google Maps view center)
  m = text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  // Pattern: ?q=LAT,LNG or &q=LAT,LNG
  m = text.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  // Pattern: /maps/search/LAT,+LNG — what a maps.app.goo.gl short link expands
  // to when it points at bare coordinates. The "+" is a literal character in
  // this path (not query-string encoding), used here as a stand-in for a space.
  m = text.match(/\/maps\/search\/(-?\d+\.\d+),\+?(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  // Plain "LAT,LNG" (with optional space)
  m = text.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

  return null;
}

// Extracts a free-text address to geocode, from a "?q=<address>" Google Maps link
// or from raw text that isn't a URL and isn't coordinates.
function extractAddressText(raw) {
  const text = raw.trim();
  const qMatch = text.match(/[?&]q=([^&]+)/);
  if (qMatch) {
    return decodeURIComponent(qMatch[1].replace(/\+/g, ' '));
  }
  if (!/^https?:\/\//i.test(text)) {
    return text;
  }
  return null;
}

const geocodeCache = new Map();

// This key is intentionally visible client-side (there's no build/server step
// on this static site to hide it behind) — it's protected by HTTP referrer
// restriction in Google Cloud Console instead of by secrecy, which is the
// standard model for a browser-side Maps key.
const GOOGLE_MAPS_API_KEY = 'AIzaSyDFkwn0iYF1X3S6Zu3B0XhdI1PrRj2zAvQ';

// The Geocoding REST endpoint blocks direct browser calls (no CORS) — it's
// meant for server-side use. From a static page we load the Maps JavaScript
// API instead, which ships a browser-compatible google.maps.Geocoder.
let googleMapsLoadPromise = null;
function loadGoogleMaps() {
  if (googleMapsLoadPromise) return googleMapsLoadPromise;
  googleMapsLoadPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.maps) { resolve(window.google.maps); return; }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}`;
    script.onload = () => resolve(window.google.maps);
    script.onerror = () => reject(new Error('No se pudo cargar Google Maps (revisá la API key y sus restricciones de sitio en Google Cloud Console).'));
    document.head.appendChild(script);
  });
  return googleMapsLoadPromise;
}

let geocoderInstance = null;
async function getGeocoder() {
  const maps = await loadGoogleMaps();
  if (!geocoderInstance) geocoderInstance = new maps.Geocoder();
  return geocoderInstance;
}

// Google's own precision signal for how the match was found: ROOFTOP is a
// precise building match; RANGE_INTERPOLATED is estimated between two known
// points on the street (no exact house number); GEOMETRIC_CENTER/APPROXIMATE
// mean it only recognized a broader area (a street, neighborhood or city) —
// too coarse to trust as a delivery pin, so treated as "not found".
function classifyGooglePrecision(result) {
  const locationType = result.geometry && result.geometry.location_type;
  if (locationType === 'ROOFTOP') return 'exact';
  if (locationType === 'RANGE_INTERPOLATED') return 'street';
  return null;
}

async function geocodeOnce(query) {
  const geocoder = await getGeocoder();
  const result = await new Promise((resolve, reject) => {
    geocoder.geocode({ address: query }, (results, status) => {
      if (status === 'OK' && results && results[0]) resolve(results[0]);
      else if (status === 'ZERO_RESULTS') resolve(null);
      else reject(new Error(`google-geocode-${status}`));
    });
  });
  if (!result) return null;

  const precision = classifyGooglePrecision(result);
  if (!precision) return null; // too coarse (e.g. matched only the street/area) — keep trying other variants

  const loc = result.geometry.location;
  return { lat: loc.lat(), lng: loc.lng(), precision };
}

// Google's own address parsing is usually robust enough to need no massaging,
// but titles ("Dr."), regional phrasing ("Departamento de X"), or an unmapped
// venue/complex name can still occasionally trip it up — so the same
// progressively-simplified variants from before are kept as a safety net.
function addressVariants(address) {
  const normalized = address
    .replace(/\b(Dr|Dra|Sr|Sra|Lic|Ing|Prof)\.?\s*/gi, '')
    .replace(/\b(Departamento|Provincia|Estado|Municipio) de\s+/gi, '')
    .trim();

  const variants = [address, normalized];

  const withoutHouseNumber = (s) => s.replace(/\b\d+\b,?\s*/, '').trim();
  const noHouseNumber = withoutHouseNumber(normalized);
  if (noHouseNumber && noHouseNumber !== normalized) variants.push(noHouseNumber);

  const segments = normalized.split(',').map(s => s.trim()).filter(Boolean);
  for (let drop = 1; drop <= segments.length - 2; drop++) {
    const dropped = segments.slice(drop).join(', ');
    variants.push(dropped);
    const droppedNoNumber = withoutHouseNumber(dropped);
    if (droppedNoNumber && droppedNoNumber !== dropped) variants.push(droppedNoNumber);
  }

  return [...new Set(variants)].filter(Boolean);
}

async function geocodeAddress(address) {
  if (geocodeCache.has(address)) return geocodeCache.get(address);

  const variants = addressVariants(address);
  let result = null;
  for (let i = 0; i < variants.length; i++) {
    result = await geocodeOnce(variants[i]);
    if (result) break;
  }

  geocodeCache.set(address, result);
  return result;
}

// Resolves a raw input (coordinates, a Maps link, or a free-text address) to {lat, lng, label}.
// Returns { point, needsGeocode } synchronously so the caller can rate-limit only the
// inputs that actually require a network lookup.
function resolveSync(raw) {
  const point = parseCoordinates(raw);
  if (point) return { point: { ...point, label: `${point.lat}, ${point.lng}`, precision: 'input' }, needsGeocode: false };

  const address = extractAddressText(raw);
  if (address) return { point: null, needsGeocode: true, address };

  return { point: null, needsGeocode: false };
}

const SHORT_LINK_PATTERN = /(?:maps\.app\.goo\.gl|goo\.gl\/maps)\/\S+/i;

// A browser can't follow the redirect of a maps.app.goo.gl link itself and read
// where it lands — that's cross-origin, and Google's redirect response doesn't
// grant this page permission to read it (no CORS). corsproxy.io does the actual
// fetch server-side (no CORS restriction there) and reports the resolved URL in
// the `x-final-url` response header.
//
// This is a third-party service, not something we run — it's a pragmatic fix
// for a static site with no backend of its own, not a guaranteed-uptime one.
// If it's ever unreachable, the caller falls back to asking for the expanded
// link or coordinates pasted directly instead.
async function expandShortLink(url) {
  const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxyUrl);
  if (!res.ok) return null;
  return res.headers.get('x-final-url');
}

// Resolves a raw input to a point, expanding a short link first if needed, then
// geocoding through Google Maps when it's a free-text address.
async function resolveInput(raw, label) {
  let text = raw.trim();

  if (SHORT_LINK_PATTERN.test(text)) {
    calculateBtn.textContent = 'Expandiendo link corto de Google Maps...';
    let expanded = null;
    try {
      expanded = await expandShortLink(text);
    } catch (e) {
      // network error reaching the proxy — fall through to the same "couldn't expand" error below
    }
    if (!expanded) {
      throw new Error(`No se pudo expandir el link corto de ${label} ("${text}"). Abrilo en el navegador y pegá el link completo, la dirección o las coordenadas en su lugar.`);
    }
    text = expanded;
  }

  const { point, needsGeocode, address } = resolveSync(text);
  if (point) return point;
  if (!needsGeocode) {
    throw new Error(`No se pudo interpretar ${label}: "${text}". Pegá el link completo de Google Maps, una dirección de texto o coordenadas.`);
  }

  calculateBtn.textContent = `Buscando dirección: "${address.slice(0, 40)}"...`;
  let geocoded;
  try {
    geocoded = await geocodeAddress(address);
  } catch (e) {
    throw new Error(`Falló la búsqueda de la dirección de ${label} ("${address}"). Revisá tu conexión e intentá de nuevo.`);
  }
  if (!geocoded) {
    throw new Error(`No se encontró con suficiente precisión la dirección de ${label}: "${address}". Abrila en Google Maps, tocá y mantené presionado el punto exacto para soltar un pin, y pegá esas coordenadas acá en vez de la dirección de texto.`);
  }
  return { ...geocoded, label: address };
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Public OSRM demo server: free, no API key, but rate-limited and meant for
// light/prototype use. For real production volume it should be self-hosted.
const OSRM_BASE = 'https://router.project-osrm.org';

// Real driving-distance matrix (meters) between every pair of points, so the
// route order is optimized by actual street distance instead of straight lines.
async function fetchDrivingMatrix(points) {
  const coordStr = points.map(p => `${p.lng},${p.lat}`).join(';');
  const res = await fetch(`${OSRM_BASE}/table/v1/driving/${coordStr}?annotations=distance`);
  if (!res.ok) throw new Error('osrm-table-failed');
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('osrm-table-failed');
  return data.distances; // meters, distances[i][j]
}

// Real driving route (geometry + total distance/duration) for the points in
// the given visiting order, following actual streets.
async function fetchDrivingRoute(orderedPoints) {
  const coordStr = orderedPoints.map(p => `${p.lng},${p.lat}`).join(';');
  const res = await fetch(`${OSRM_BASE}/route/v1/driving/${coordStr}?overview=full&geometries=geojson`);
  if (!res.ok) throw new Error('osrm-route-failed');
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('osrm-route-failed');
  const route = data.routes[0];
  return {
    latlngs: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    distanceKm: route.distance / 1000,
    durationMin: route.duration / 60,
  };
}

function tourLength(order, dist, roundtrip) {
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) {
    total += dist(order[i], order[i + 1]);
  }
  if (roundtrip) {
    total += dist(order[order.length - 1], order[0]);
  }
  return total;
}

// Nearest-neighbor heuristic starting at index 0 (the start point), then 2-opt refinement.
// `dist(i, j)` is the cost between point i and point j (real driving km, or haversine km as fallback).
function optimizeOrder(n, dist, roundtrip) {
  const visited = new Array(n).fill(false);
  const order = [0];
  visited[0] = true;

  for (let step = 1; step < n; step++) {
    const last = order[order.length - 1];
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < n; i++) {
      if (!visited[i]) {
        const d = dist(last, i);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
    }
    order.push(best);
    visited[best] = true;
  }

  // 2-opt improvement, keeping the start (index 0 of `order`) fixed in place.
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const candidate = order.slice(0, i).concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
        if (tourLength(candidate, dist, roundtrip) < tourLength(order, dist, roundtrip) - 1e-9) {
          order.splice(0, order.length, ...candidate);
          improved = true;
        }
      }
    }
  }

  return order;
}

function buildGoogleMapsUrl(orderedPoints, roundtrip) {
  const fmt = (p) => `${p.lat},${p.lng}`;
  const origin = orderedPoints[0];
  let destination, waypoints;

  if (roundtrip) {
    destination = origin;
    waypoints = orderedPoints.slice(1);
  } else {
    destination = orderedPoints[orderedPoints.length - 1];
    waypoints = orderedPoints.slice(1, -1);
  }

  const params = new URLSearchParams({
    api: '1',
    origin: fmt(origin),
    destination: fmt(destination),
    travelmode: 'driving',
  });

  let url = `https://www.google.com/maps/dir/?${params.toString()}`;
  if (waypoints.length > 0) {
    url += `&waypoints=${waypoints.map(fmt).join('|')}`;
  }
  return url;
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
  resultsEl.hidden = true;
}

function clearError() {
  errorEl.hidden = true;
}

function showWarning(msg) {
  warningEl.textContent = msg;
  warningEl.hidden = false;
}

function clearWarning() {
  warningEl.hidden = true;
}

// `precision` is 'input' for a pasted coordinate/link (always trusted as-is),
// 'exact' for a Google ROOFTOP match (precise building-level geocode), or
// 'street' for a RANGE_INTERPOLATED one (estimated along the street, house
// number not confirmed) — only the latter gets a reminder to double-check.
function routeLineText(p, i) {
  const orderTag = p.order ? `Pedido #${p.order} — ` : '';
  let precisionTag = '';
  if (p.precision === 'street') precisionTag = ' (aproximado: ubicación estimada sobre la calle, revisar en el mapa)';
  return i === 0
    ? `Inicio: ${p.label}${precisionTag}`
    : `Parada ${i}: ${orderTag}${p.label}${precisionTag}`;
}

// After dragging a pin to correct its position, treat the new spot as exact,
// refresh its list label, and regenerate the Google Maps link immediately.
function updatePointPosition(pointIndex, newLatLng, li) {
  const p = currentOrderedPoints[pointIndex];
  p.lat = newLatLng.lat;
  p.lng = newLatLng.lng;
  p.label = `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)} (ajustado a mano)`;
  p.precision = 'input';
  if (li) li.textContent = routeLineText(p, pointIndex);
  mapsLinkEl.href = buildGoogleMapsUrl(currentOrderedPoints, currentRoundtrip);
}

// Draws the route on the map. `orderedPoints` (the unique visited stops, in
// order) gets one draggable marker each — dragging corrects a wrong geocode
// and updates the Google Maps link instantly. `routeLatLngs`, when available,
// is the real street-following polyline from OSRM; otherwise falls back to
// straight lines between the stops.
function renderMap(orderedPoints, routeLatLngs, liEls) {
  const el = document.getElementById('map');
  if (map) {
    map.remove();
  }
  map = L.map(el);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  orderedPoints.forEach((p, i) => {
    const label = i === 0 ? 'Inicio' : `Parada ${i}${p.order ? ` (Pedido #${p.order})` : ''}`;
    const marker = L.marker([p.lat, p.lng], { draggable: true }).addTo(map).bindPopup(label);
    marker.on('dragend', (e) => updatePointPosition(i, e.target.getLatLng(), liEls[i]));
  });

  const latlngs = routeLatLngs || orderedPoints.map(p => [p.lat, p.lng]);
  mapLayer = L.polyline(latlngs, { color: '#2563eb', weight: 4 }).addTo(map);
  map.fitBounds(mapLayer.getBounds(), { padding: [24, 24] });
}

calculateBtn.addEventListener('click', async () => {
  clearError();
  clearWarning();

  const startRaw = document.getElementById('start').value;
  const roundtrip = document.getElementById('roundtrip').checked;
  const stopRows = parseStopsText(stopsTextEl.value);

  if (stopRows.length === 0) {
    showError('Pegá al menos un pedido (número de pedido + ubicación).');
    return;
  }
  if (stopRows.length > 23) {
    showError('Google Maps admite hasta 23 paradas intermedias en un recorrido. Reducí la cantidad.');
    return;
  }

  calculateBtn.disabled = true;
  const originalBtnText = calculateBtn.textContent;

  try {
    const start = await resolveInput(startRaw, 'el punto de partida');

    const stops = [];
    for (let i = 0; i < stopRows.length; i++) {
      const { order, raw } = stopRows[i];
      const label = order ? `el pedido #${order} (línea ${i + 1})` : `la línea ${i + 1}`;
      const stop = await resolveInput(raw, label);
      stop.order = order;
      stops.push(stop);
    }

    const points = [start, ...stops];

    calculateBtn.textContent = 'Calculando la ruta más eficiente por calles...';

    let distFn;
    let usedRealDistances = true;
    try {
      const matrixMeters = await fetchDrivingMatrix(points);
      distFn = (i, j) => matrixMeters[i][j] / 1000;
    } catch (e) {
      usedRealDistances = false;
      distFn = (i, j) => haversineKm(points[i], points[j]);
    }

    const order = optimizeOrder(points.length, distFn, roundtrip);
    const orderedPoints = order.map(i => points[i]);
    const routeForGeometry = roundtrip ? [...orderedPoints, start] : orderedPoints;

    let routeInfo = null;
    if (usedRealDistances) {
      try {
        routeInfo = await fetchDrivingRoute(routeForGeometry);
      } catch (e) {
        // Order is still based on real distances; only the drawn geometry/summary falls back.
      }
    }

    routeListEl.innerHTML = '';
    const liEls = orderedPoints.map((p, i) => {
      const li = document.createElement('li');
      li.textContent = routeLineText(p, i);
      routeListEl.appendChild(li);
      return li;
    });
    if (roundtrip) {
      const backLi = document.createElement('li');
      backLi.textContent = `Vuelta al inicio: ${start.label}`;
      routeListEl.appendChild(backLi);
    }

    if (routeInfo) {
      const hours = Math.floor(routeInfo.durationMin / 60);
      const mins = Math.round(routeInfo.durationMin % 60);
      const timeStr = hours > 0 ? `${hours} h ${mins} min` : `${mins} min`;
      distanceSummaryEl.textContent = `Distancia real por calles: ${routeInfo.distanceKm.toFixed(1)} km — tiempo estimado de manejo: ${timeStr}.`;
    } else {
      const totalKm = tourLength(order, distFn, roundtrip);
      distanceSummaryEl.textContent = `Distancia aproximada en línea recta: ${totalKm.toFixed(1)} km (no se pudo consultar el servicio de rutas reales; el orden de las paradas puede no ser el óptimo por calle).`;
      if (usedRealDistances) {
        showWarning('El orden de las paradas se calculó con distancias reales, pero no se pudo dibujar el recorrido exacto por calles (servicio de rutas no disponible en este momento).');
      } else {
        showWarning('No se pudo contactar el servicio de rutas reales (OSRM); se usó una estimación en línea recta para ordenar las paradas. El recorrido real puede variar.');
      }
    }

    currentOrderedPoints = orderedPoints;
    currentRoundtrip = roundtrip;
    mapsLinkEl.href = buildGoogleMapsUrl(orderedPoints, roundtrip);

    resultsEl.hidden = false;
    const fallbackLatLngs = routeForGeometry.map(p => [p.lat, p.lng]);
    renderMap(orderedPoints, routeInfo ? routeInfo.latlngs : fallbackLatLngs, liEls);
  } catch (e) {
    showError(e.message);
  } finally {
    calculateBtn.disabled = false;
    calculateBtn.textContent = originalBtnText;
  }
});
