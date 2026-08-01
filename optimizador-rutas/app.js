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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const geocodeCache = new Map();
const NOMINATIM_DELAY_MS = 1000; // Nominatim's usage policy caps public requests at ~1/sec.

// Nominatim's structured search often fails on titles/abbreviations (e.g. "Dr."),
// on administrative-division phrasing (e.g. "Departamento de Canelones" instead of
// just "Canelones"), and on private venue/complex names that simply aren't mapped
// in OpenStreetMap (e.g. "Complejo Palmas del Norte"). Try the address as-is, then
// progressively simplified variants, from most to least specific:
//   1. as typed
//   2. with titles/region-prefixes stripped
//   3. same, but without the house number (in case only the street is mapped)
//   4. with the leading segment dropped (handles an unmapped venue/complex name),
//      also tried without its house number
// A later, more aggressive variant is only used if every earlier (more specific)
// one truly finds nothing — see geocodeAddress's specificity check below, which
// keeps searching rather than accepting an overly broad match (e.g. a whole city).
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

// Nominatim place types that are too broad to use as a delivery location —
// a match at this level means it only recognized the city/region, not the
// actual street or address, and silently using it would drop the pin far
// from the real destination.
const TOO_COARSE_TYPES = new Set([
  'city', 'town', 'village', 'suburb', 'municipality', 'county', 'state',
  'country', 'administrative', 'state_district', 'region',
]);

function bboxDiagonalKm(boundingbox) {
  const [south, north, west, east] = boundingbox.map(parseFloat);
  return haversineKm({ lat: south, lng: west }, { lat: north, lng: east });
}

// Classifies how much to trust a match: 'exact' for a specific building/house,
// 'street' for a road-level match (no house-number precision, but still a
// specific street), or null if the match is too coarse (city/region level or
// an unexpectedly large bounding box) to safely use.
function classifyPrecision(result) {
  if (result.class === 'boundary' || TOO_COARSE_TYPES.has(result.type)) return null;
  if (result.boundingbox && bboxDiagonalKm(result.boundingbox) > 3) return null;
  if (result.class === 'building' || result.type === 'house') return 'exact';
  return 'street';
}

async function geocodeOnce(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'es' } });
  if (!res.ok) throw new Error('geocode-request-failed');
  const data = await res.json();
  if (!data || data.length === 0) return null;

  const result = data[0];
  const precision = classifyPrecision(result);
  if (!precision) return null; // too coarse (e.g. matched only the city) — keep trying other variants

  return { lat: parseFloat(result.lat), lng: parseFloat(result.lon), precision };
}

async function geocodeAddress(address) {
  if (geocodeCache.has(address)) return geocodeCache.get(address);

  const variants = addressVariants(address);
  let result = null;
  for (let i = 0; i < variants.length; i++) {
    if (i > 0) await sleep(NOMINATIM_DELAY_MS);
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
  if (point) return { point: { ...point, label: `${point.lat}, ${point.lng}`, precision: 'exact' }, needsGeocode: false };

  const address = extractAddressText(raw);
  if (address) return { point: null, needsGeocode: true, address };

  return { point: null, needsGeocode: false };
}

// Resolves a raw input to a point, geocoding through Nominatim when needed.
// Nominatim's usage policy caps public requests at ~1/sec, so callers must
// await this one at a time (never in parallel) for inputs that need geocoding.
async function resolveInput(raw, label) {
  const { point, needsGeocode, address } = resolveSync(raw);
  if (point) return point;
  if (!needsGeocode) {
    throw new Error(`No se pudo interpretar ${label}: "${raw}". Los links cortos (maps.app.goo.gl) no se pueden leer directamente; abrilos y copiá el link completo, la dirección de texto o las coordenadas.`);
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

function routeLineText(p, i) {
  const orderTag = p.order ? `Pedido #${p.order} — ` : '';
  const precisionTag = p.precision === 'street' ? ' (aproximado: solo se encontró a nivel de calle, revisar)' : '';
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
  p.precision = 'exact';
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
    // Resolved sequentially (not in parallel) to respect Nominatim's rate limit
    // for the inputs that need geocoding; a short delay follows each lookup.
    const start = await resolveInput(startRaw, 'el punto de partida');
    await sleep(NOMINATIM_DELAY_MS);

    const stops = [];
    for (let i = 0; i < stopRows.length; i++) {
      const { order, raw } = stopRows[i];
      const label = order ? `el pedido #${order} (línea ${i + 1})` : `la línea ${i + 1}`;
      const stop = await resolveInput(raw, label);
      stop.order = order;
      stops.push(stop);
      await sleep(NOMINATIM_DELAY_MS);
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
