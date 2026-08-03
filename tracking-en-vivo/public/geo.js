// Shared geocoding + route-optimization library, ported from optimizador-rutas/app.js.
// Pure functions plus a couple of network calls — no DOM/UI coupling, so both
// dashboard.js and driver.js can use it directly.
const Geo = (() => {
  // Turns "$ 1.630,00" (or "1630.00", "1630") into a plain number. Uruguayan
  // format uses "." as thousands separator and "," as decimal separator.
  function parseAmount(text) {
    if (!text) return null;
    const cleaned = text.replace(/[^\d,.-]/g, '');
    if (!cleaned) return null;
    const normalized = cleaned.includes(',') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned;
    const n = parseFloat(normalized);
    return isNaN(n) ? null : n;
  }

  // Which columns a pasted line has, and in what order, follows the admin's
  // "personalizar campos" choice (nuevo-pedido.js) — `fieldOrder` is an array
  // of keys among 'phone'|'name'|'orderNumber'|'location'|'amount', e.g.
  // ['orderNumber', 'location', 'amount']. A line pasted straight from a
  // spreadsheet is tab-separated, one column per entry in `fieldOrder`. As a
  // convenience, the plain "<pedido> <ubicación>" (space/comma-separated, no
  // tab) shortcut still works when that's the whole configured format.
  function parseStopLine(line, fieldOrder) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const fields = fieldOrder && fieldOrder.length ? fieldOrder : ['orderNumber', 'location'];

    let parts;
    if (trimmed.includes('\t')) {
      parts = trimmed.split('\t').map((p) => p.trim());
    } else if (fields.length <= 2) {
      const m = trimmed.match(/^([^\s,]+)[\s,]+(.+)$/);
      parts = m ? [m[1], m[2].trim()] : [trimmed];
    } else {
      parts = [trimmed];
    }

    const result = { order: '', raw: '', amount: null, phone: '', name: '', custom: {} };
    fields.forEach((key, i) => {
      const value = (parts[i] || '').trim();
      if (key === 'orderNumber') result.order = value;
      else if (key === 'location') result.raw = value;
      else if (key === 'amount') result.amount = value ? parseAmount(value) : null;
      else if (key === 'phone') result.phone = value;
      else if (key === 'name') result.name = value;
      else result.custom[key] = value; // campo personalizado (ver nuevo-pedido.js)
    });
    return result;
  }

  function parseStopsText(text, fieldOrder) {
    return text.split('\n').map((line) => parseStopLine(line, fieldOrder)).filter(Boolean);
  }

  function parseCoordinates(raw) {
    const text = raw.trim();
    if (!text) return null;

    let m = text.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

    m = text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

    m = text.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

    // /maps/search/LAT,+LNG — what a maps.app.goo.gl short link expands to when
    // it points at bare coordinates. The "+" is a literal character in this
    // path (not query-string encoding), standing in for a space.
    m = text.match(/\/maps\/search\/(-?\d+\.\d+),\+?(-?\d+\.\d+)/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

    m = text.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

    return null;
  }

  function extractAddressText(raw) {
    const text = raw.trim();
    const qMatch = text.match(/[?&]q=([^&]+)/);
    if (qMatch) return decodeURIComponent(qMatch[1].replace(/\+/g, ' '));
    if (!/^https?:\/\//i.test(text)) return text;
    return null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const geocodeCache = new Map();

  // Same key as optimizador-rutas, intentionally visible client-side (no
  // build/server step hides it) — protected by HTTP referrer restriction in
  // Google Cloud Console rather than by secrecy.
  const GOOGLE_MAPS_API_KEY = 'AIzaSyDFkwn0iYF1X3S6Zu3B0XhdI1PrRj2zAvQ';

  // The Geocoding REST endpoint blocks direct browser calls (no CORS) — it's
  // meant for server-side use. From these static pages we load the Maps
  // JavaScript API instead, which ships a browser-compatible google.maps.Geocoder.
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

  // ROOFTOP = precise building match; RANGE_INTERPOLATED = estimated along the
  // street (no exact house number); GEOMETRIC_CENTER/APPROXIMATE = only a
  // broader area was recognized — too coarse to trust, treated as "not found".
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
    if (!precision) return null;

    const loc = result.geometry.location;
    return { lat: loc.lat(), lng: loc.lng(), precision };
  }

  // Google's own address parsing rarely needs help, but titles ("Dr."),
  // regional phrasing ("Departamento de X"), or an unmapped venue/complex name
  // can still trip it up — kept as a safety net of progressively simpler variants.
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

  function resolveSync(raw) {
    const point = parseCoordinates(raw);
    if (point) return { point: { ...point, label: `${point.lat}, ${point.lng}`, precision: 'input' }, needsGeocode: false };

    const address = extractAddressText(raw);
    if (address) return { point: null, needsGeocode: true, address };

    return { point: null, needsGeocode: false };
  }

  const SHORT_LINK_PATTERN = /(?:maps\.app\.goo\.gl|goo\.gl\/maps)\/\S+/i;

  // A browser can't follow the redirect of a maps.app.goo.gl link itself and
  // read where it lands — that's cross-origin, and Google's redirect response
  // doesn't grant this page permission to read it (no CORS). corsproxy.io does
  // the actual fetch server-side (no CORS restriction there) and reports the
  // resolved URL in the `x-final-url` response header. It's a third-party
  // service we don't run — a pragmatic fix, not a guaranteed-uptime one.
  async function expandShortLink(url) {
    const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl);
    if (!res.ok) return null;
    return res.headers.get('x-final-url');
  }

  // `onProgress(message)` is optional — called while a link expansion or geocode lookup is in flight.
  async function resolveInput(raw, label, onProgress) {
    let text = raw.trim();

    if (SHORT_LINK_PATTERN.test(text)) {
      if (onProgress) onProgress('Expandiendo link corto de Google Maps...');
      let expanded = null;
      try {
        expanded = await expandShortLink(text);
      } catch (e) {
        // network error reaching the proxy — falls through to the same "couldn't expand" error below
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

    if (onProgress) onProgress(`Buscando dirección: "${address.slice(0, 40)}"...`);
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

  const OSRM_BASE = 'https://router.project-osrm.org';

  async function fetchDrivingMatrix(points) {
    const coordStr = points.map(p => `${p.lng},${p.lat}`).join(';');
    const res = await fetch(`${OSRM_BASE}/table/v1/driving/${coordStr}?annotations=distance`);
    if (!res.ok) throw new Error('osrm-table-failed');
    const data = await res.json();
    if (data.code !== 'Ok') throw new Error('osrm-table-failed');
    return data.distances;
  }

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
    for (let i = 0; i < order.length - 1; i++) total += dist(order[i], order[i + 1]);
    if (roundtrip) total += dist(order[order.length - 1], order[0]);
    return total;
  }

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
          if (d < bestDist) { bestDist = d; best = i; }
        }
      }
      order.push(best);
      visited[best] = true;
    }

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

    const params = new URLSearchParams({ api: '1', origin: fmt(origin), destination: fmt(destination), travelmode: 'driving' });
    let url = `https://www.google.com/maps/dir/?${params.toString()}`;
    if (waypoints.length > 0) url += `&waypoints=${waypoints.map(fmt).join('|')}`;
    return url;
  }

  // Computes the optimal visiting order (real driving distances when available,
  // straight-line as a fallback) for `start` followed by `stops`, and the real
  // route geometry through OSRM. Returns null latlngs/distanceKm/durationMin
  // when OSRM is unreachable — caller should fall back to a straight polyline.
  async function computeRoute(start, stops) {
    const points = [start, ...stops];
    let distFn;
    let usedRealDistances = true;
    try {
      const matrixMeters = await fetchDrivingMatrix(points);
      distFn = (i, j) => matrixMeters[i][j] / 1000;
    } catch (e) {
      usedRealDistances = false;
      distFn = (i, j) => haversineKm(points[i], points[j]);
    }

    const order = optimizeOrder(points.length, distFn, false);
    const orderedPoints = order.map(i => points[i]);

    let routeInfo = null;
    if (usedRealDistances) {
      try {
        routeInfo = await fetchDrivingRoute(orderedPoints);
      } catch (e) {
        // order is still real-distance-based; only the drawn geometry falls back
      }
    }

    return {
      orderedPoints,
      usedRealDistances,
      latlngs: routeInfo ? routeInfo.latlngs : orderedPoints.map(p => [p.lat, p.lng]),
      distanceKm: routeInfo ? routeInfo.distanceKm : tourLength(order, distFn, false),
      durationMin: routeInfo ? routeInfo.durationMin : null,
      isRealDistance: !!routeInfo,
    };
  }

  return {
    parseStopLine, parseStopsText, parseAmount, parseCoordinates, extractAddressText,
    resolveSync, resolveInput, haversineKm, buildGoogleMapsUrl, computeRoute, sleep,
  };
})();
