const closedMsgEl = document.getElementById('closed-msg');
const categoriesViewEl = document.getElementById('categories-view');
const categoryGridEl = document.getElementById('category-grid');
const productsViewEl = document.getElementById('products-view');
const productsViewTitleEl = document.getElementById('products-view-title');
const productsGridEl = document.getElementById('products-grid');
const backToCategoriesBtn = document.getElementById('back-to-categories-btn');

const cartFabBtn = document.getElementById('cart-fab-btn');
const cartOverlay = document.getElementById('cart-overlay');
const cartCloseBtn = document.getElementById('cart-close-btn');
const cartItemsEl = document.getElementById('cart-items');
const cartTotalEl = document.getElementById('cart-total');
const cartCheckoutBtn = document.getElementById('cart-checkout-btn');

const checkoutOverlay = document.getElementById('checkout-overlay');
const checkoutCloseBtn = document.getElementById('checkout-close-btn');
const checkoutFormEl = document.getElementById('checkout-form');
const checkoutConfirmationEl = document.getElementById('checkout-confirmation');
const checkoutConfirmationMsgEl = document.getElementById('checkout-confirmation-msg');
const checkoutPhoneEl = document.getElementById('checkout-phone');
const checkoutNameEl = document.getElementById('checkout-name');
const checkoutPickupEl = document.getElementById('checkout-pickup');
const checkoutLocationFieldEl = document.getElementById('checkout-location-field');
const checkoutLocationEl = document.getElementById('checkout-location');
const checkoutMapEl = document.getElementById('checkout-map');
const checkoutCustomFieldsEl = document.getElementById('checkout-custom-fields');
const checkoutSubmitBtn = document.getElementById('checkout-submit-btn');
const checkoutStatusEl = document.getElementById('checkout-status');

const socket = io();

// Esta página es pública — a propósito NO escuchamos orders:snapshot ni
// order:update/drivers:snapshot (existen y el socket los recibe igual, pero
// contienen teléfono/nombre/dirección de otros clientes). Ver DOCUMENTACION.md.

const categories = new Map();
const products = new Map();
let formConfig = { customFields: [] };
let dayOpen = false;

// Mapa + buscador de direcciones para "Dirección de entrega", para que el
// cliente no tenga que escribir/pegar un link de Google Maps a mano. Carga
// perezosa (recién al abrir el checkout con "Envío"), y una sola vez por
// sesión de página (mapApi/locationPickerPromise cacheados, mismo patrón que
// loadGoogleMaps() en geo.js). selectedPoint es el punto elegido a través del
// mapa/buscador; si el cliente lo pisa escribiendo texto distinto, el submit
// vuelve a Geo.resolveInput() como siempre (link/dirección/coordenadas).
let mapApi = null;
let locationPickerPromise = null;
let selectedPoint = null;

function initLocationPicker() {
  if (locationPickerPromise) return locationPickerPromise;
  locationPickerPromise = Geo.loadGoogleMaps().then((maps) => {
    const center = { lat: -34.9011, lng: -56.1645 };
    const map = new maps.Map(checkoutMapEl, {
      center,
      zoom: 15,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false,
    });
    const marker = new maps.Marker({ position: center, map, draggable: true });
    const geocoder = new maps.Geocoder();
    mapApi = { map, marker };

    function setPoint(lat, lng, label) {
      selectedPoint = { lat, lng, label: label || `${lat}, ${lng}`, precision: 'exact' };
      checkoutLocationEl.value = selectedPoint.label;
    }

    function reverseGeocode(lat, lng) {
      geocoder.geocode({ location: { lat, lng } }, (results, status) => {
        const label = (status === 'OK' && results && results[0]) ? results[0].formatted_address : null;
        setPoint(lat, lng, label);
      });
    }

    marker.addListener('dragend', () => {
      const pos = marker.getPosition();
      reverseGeocode(pos.lat(), pos.lng());
    });
    map.addListener('click', (e) => {
      marker.setPosition(e.latLng);
      reverseGeocode(e.latLng.lat(), e.latLng.lng());
    });

    const autocomplete = new maps.places.Autocomplete(checkoutLocationEl, {
      componentRestrictions: { country: 'uy' },
      fields: ['geometry', 'formatted_address'],
    });
    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      if (!place.geometry || !place.geometry.location) return;
      const loc = place.geometry.location;
      map.panTo(loc);
      map.setZoom(17);
      marker.setPosition(loc);
      setPoint(loc.lat(), loc.lng(), place.formatted_address);
    });
  }).catch((e) => {
    console.warn('No se pudo cargar el mapa de dirección de entrega:', e);
  });
  return locationPickerPromise;
}

function showLocationPicker() {
  // El mapa puede haberse creado mientras #checkout-map estaba oculto (display:none),
  // lo que le deja tiles en blanco -- 'resize' + recentrar arregla eso al mostrarlo.
  initLocationPicker().then(() => {
    if (!mapApi) return;
    google.maps.event.trigger(mapApi.map, 'resize');
    mapApi.map.setCenter(mapApi.marker.getPosition());
  });
}

// 'categories' = grilla de tarjetas con foto (pantalla inicial) — 'products'
// = productos de una sola categoría, con volver. Sin pushState/URL propia a
// propósito, es solo un toggle de qué div se ve — no hace falta más para
// esta pantalla pública.
let view = 'categories';
let activeCategoryId = null;

const CART_KEY = 'tracking.cart';
function loadCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || {}; } catch { return {}; }
}
let cart = loadCart(); // productId -> qty
function saveCart() {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

function setQty(productId, qty) {
  if (qty <= 0) delete cart[productId];
  else cart[productId] = qty;
  saveCart();
  // Los steppers de +/- solo existen en la vista de productos de una
  // categoría (la grilla de categorías no tiene ninguno) — alcanza con
  // rehacer esa grilla, no toda la vista.
  if (view === 'products') renderProductsGrid();
  renderCart();
  updateCartFab();
}

function cartCount() {
  return Object.values(cart).reduce((sum, qty) => sum + qty, 0);
}

function cartTotal() {
  return Object.entries(cart).reduce((sum, [id, qty]) => {
    const p = products.get(id);
    return p ? sum + p.price * qty : sum;
  }, 0);
}

function updateCartFab() {
  const count = cartCount();
  if (count === 0) {
    cartFabBtn.style.display = 'none';
    return;
  }
  cartFabBtn.style.display = '';
  cartFabBtn.textContent = `🛒 Ver carrito (${count}) — $${cartTotal().toFixed(2)}`;
}

function sortedCategories() {
  return Array.from(categories.entries())
    .filter(([, c]) => c.visible !== false)
    .sort((a, b) => a[1].sortOrder - b[1].sortOrder);
}

function categoryHasVisibleProducts(categoryId) {
  return Array.from(products.values()).some((p) => p.categoryId === categoryId && p.visible !== false);
}

function buildProductCard(id, p) {
  const card = document.createElement('div');
  card.className = 'product-card';

  // Foto a pantalla completa con degradé + nombre/precio encima, mismo
  // lenguaje que .category-card -- ver comentario en style.css.
  const media = document.createElement('div');
  media.className = 'product-card-media';

  if (p.imageUrl) {
    const img = document.createElement('img');
    img.src = p.imageUrl;
    img.alt = p.name;
    media.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'no-image';
    placeholder.textContent = '🍣';
    media.appendChild(placeholder);
  }

  const overlay = document.createElement('div');
  overlay.className = 'product-card-media-overlay';
  media.appendChild(overlay);

  const info = document.createElement('div');
  info.className = 'product-card-media-info';
  const name = document.createElement('div');
  name.className = 'product-name';
  name.textContent = p.name;
  info.appendChild(name);
  const price = document.createElement('div');
  price.className = 'product-price';
  price.textContent = `$${Number(p.price || 0).toFixed(2)}`;
  info.appendChild(price);
  media.appendChild(info);

  card.appendChild(media);

  if (p.description) {
    const desc = document.createElement('div');
    desc.className = 'product-description';
    desc.textContent = p.description;
    card.appendChild(desc);
  }

  const stepper = document.createElement('div');
  stepper.className = 'qty-stepper';
  const qty = cart[id] || 0;

  const minusBtn = document.createElement('button');
  minusBtn.type = 'button';
  minusBtn.className = 'small';
  minusBtn.textContent = '−';
  minusBtn.addEventListener('click', () => setQty(id, (cart[id] || 0) - 1));

  const qtySpan = document.createElement('span');
  qtySpan.textContent = qty;

  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.className = 'primary small';
  plusBtn.textContent = '+';
  plusBtn.addEventListener('click', () => setQty(id, (cart[id] || 0) + 1));

  stepper.append(minusBtn, qtySpan, plusBtn);
  card.appendChild(stepper);

  return card;
}

function renderCategoriesGrid() {
  categoryGridEl.innerHTML = '';
  sortedCategories()
    .filter(([id]) => categoryHasVisibleProducts(id))
    .forEach(([id, c]) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'category-card';
      if (c.imageUrl) {
        const img = document.createElement('img');
        img.src = c.imageUrl;
        img.alt = '';
        card.appendChild(img);
      }
      const overlay = document.createElement('div');
      overlay.className = 'category-card-overlay';
      card.appendChild(overlay);
      const label = document.createElement('span');
      label.className = 'category-card-name';
      label.textContent = c.name;
      card.appendChild(label);
      card.addEventListener('click', () => showProductsView(id));
      categoryGridEl.appendChild(card);
    });
}

function renderProductsGrid() {
  const c = categories.get(activeCategoryId);
  productsViewTitleEl.textContent = c ? c.name : '';
  productsGridEl.innerHTML = '';
  Array.from(products.entries())
    .filter(([, p]) => p.categoryId === activeCategoryId && p.visible !== false)
    .sort((a, b) => a[1].sortOrder - b[1].sortOrder)
    .forEach(([id, p]) => productsGridEl.appendChild(buildProductCard(id, p)));
}

function render() {
  if (view === 'products') {
    categoriesViewEl.hidden = true;
    productsViewEl.hidden = false;
    renderProductsGrid();
  } else {
    productsViewEl.hidden = true;
    categoriesViewEl.hidden = false;
    renderCategoriesGrid();
  }
}

function showCategoriesView() {
  view = 'categories';
  activeCategoryId = null;
  render();
}

function showProductsView(categoryId) {
  view = 'products';
  activeCategoryId = categoryId;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

backToCategoriesBtn.addEventListener('click', showCategoriesView);

function renderCart() {
  cartItemsEl.innerHTML = '';
  const entries = Object.entries(cart).filter(([id]) => products.has(id));
  if (entries.length === 0) {
    cartItemsEl.innerHTML = '<div class="empty-cart"><span class="empty-cart-icon">🛍️</span><p class="hint">Todavía no agregaste nada.</p></div>';
    cartTotalEl.style.display = 'none';
    cartCheckoutBtn.disabled = true;
    return;
  }
  cartCheckoutBtn.disabled = false;
  entries.forEach(([id, qty]) => {
    const p = products.get(id);
    const row = document.createElement('div');
    row.className = 'cart-item';
    const label = document.createElement('span');
    label.textContent = `${qty} × ${p.name}`;
    const right = document.createElement('span');
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '10px';
    const amount = document.createElement('span');
    amount.textContent = `$${(p.price * qty).toFixed(2)}`;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'danger small';
    removeBtn.textContent = '🗑';
    removeBtn.addEventListener('click', () => setQty(id, 0));
    right.append(amount, removeBtn);
    row.append(label, right);
    cartItemsEl.appendChild(row);
  });
  cartTotalEl.style.display = 'flex';
  cartTotalEl.innerHTML = `<span>Total</span><span>$${cartTotal().toFixed(2)}</span>`;
}

cartFabBtn.addEventListener('click', () => { renderCart(); cartOverlay.style.display = 'flex'; });
cartCloseBtn.addEventListener('click', () => { cartOverlay.style.display = 'none'; });
cartOverlay.addEventListener('click', (e) => { if (e.target === cartOverlay) cartOverlay.style.display = 'none'; });

function customFieldInputId(key) {
  return `checkout-custom-${key}`;
}

function renderCheckoutFields() {
  // El celular siempre se pide acá (no hay otra forma de contactar a un
  // cliente anónimo) — a diferencia de nuevo-pedido.js, donde el admin sí
  // puede relajarlo. Nombre vuelve a ser configurable desde Ajustes.
  const nameField = document.querySelector('[data-field="name"]');
  const nameCfg = formConfig.name || { visible: true };
  if (nameField) nameField.style.display = nameCfg.visible === false ? 'none' : '';

  checkoutCustomFieldsEl.innerHTML = '';
  (formConfig.customFields || []).forEach((f) => {
    if (f.visible === false) return;
    const div = document.createElement('div');
    div.className = 'field';
    const label = document.createElement('label');
    label.textContent = f.label;
    label.htmlFor = customFieldInputId(f.key);
    const input = document.createElement('input');
    input.type = 'text';
    input.id = customFieldInputId(f.key);
    div.append(label, input);
    checkoutCustomFieldsEl.appendChild(div);
  });
}

checkoutPickupEl.addEventListener('change', () => {
  checkoutLocationFieldEl.style.display = checkoutPickupEl.checked ? 'none' : '';
  if (!checkoutPickupEl.checked) showLocationPicker();
});

cartCheckoutBtn.addEventListener('click', () => {
  cartOverlay.style.display = 'none';
  checkoutFormEl.style.display = '';
  checkoutConfirmationEl.style.display = 'none';
  checkoutStatusEl.textContent = '';
  checkoutStatusEl.className = 'status';
  checkoutOverlay.style.display = 'flex';
  if (!checkoutPickupEl.checked) showLocationPicker();
});

checkoutCloseBtn.addEventListener('click', () => { checkoutOverlay.style.display = 'none'; });
checkoutOverlay.addEventListener('click', (e) => { if (e.target === checkoutOverlay) checkoutOverlay.style.display = 'none'; });

checkoutSubmitBtn.addEventListener('click', async () => {
  if (!dayOpen) {
    checkoutStatusEl.textContent = 'No estamos aceptando pedidos en este momento.';
    checkoutStatusEl.className = 'status error';
    return;
  }

  // Celular y tipo de envío (retira/envía) son siempre obligatorios — ya no
  // dependen de formConfig.
  const missing = [];
  if (!checkoutPhoneEl.value.trim()) missing.push('Celular');
  if (formConfig.name?.required && !checkoutNameEl.value.trim()) missing.push('Nombre');
  if (!checkoutPickupEl.checked && !checkoutLocationEl.value.trim()) missing.push('Dirección de entrega');
  const custom = {};
  (formConfig.customFields || []).forEach((f) => {
    if (f.visible === false) return;
    const input = document.getElementById(customFieldInputId(f.key));
    const value = input ? input.value.trim() : '';
    custom[f.key] = value;
    if (f.required && !value) missing.push(f.label);
  });
  if (missing.length > 0) {
    checkoutStatusEl.textContent = `Falta completar: ${missing.join(', ')}.`;
    checkoutStatusEl.className = 'status error';
    return;
  }

  checkoutSubmitBtn.disabled = true;
  let point = null;
  if (!checkoutPickupEl.checked) {
    const locationRaw = checkoutLocationEl.value.trim();
    if (locationRaw) {
      if (selectedPoint && selectedPoint.label === locationRaw) {
        // El texto no cambió desde que se eligió en el mapa/buscador -- usamos
        // ese punto directo, sin volver a geocodificar.
        point = selectedPoint;
      } else {
        try {
          point = await Geo.resolveInput(locationRaw, 'tu pedido', (msg) => {
            checkoutStatusEl.textContent = msg;
            checkoutStatusEl.className = 'status';
          });
        } catch (e) {
          checkoutStatusEl.textContent = e.message;
          checkoutStatusEl.className = 'status error';
          checkoutSubmitBtn.disabled = false;
          return;
        }
      }
    }
  }

  const items = Object.entries(cart)
    .filter(([id]) => products.has(id))
    .map(([productId, qty]) => ({ productId, qty }));

  const payload = {
    items,
    phone: checkoutPhoneEl.value.trim(),
    name: checkoutNameEl.value.trim(),
    pickup: checkoutPickupEl.checked,
    lat: point ? point.lat : null,
    lng: point ? point.lng : null,
    label: point ? point.label : '',
    custom,
  };

  socket.emit('order:web-add', payload, (res) => {
    checkoutSubmitBtn.disabled = false;
    if (!res || !res.ok) {
      checkoutStatusEl.textContent = (res && res.error) || 'No se pudo enviar el pedido.';
      checkoutStatusEl.className = 'status error';
      return;
    }
    cart = {};
    saveCart();
    if (view === 'products') renderProductsGrid();
    updateCartFab();
    checkoutFormEl.style.display = 'none';
    checkoutConfirmationEl.style.display = '';
    checkoutConfirmationMsgEl.textContent = `Tu pedido #${res.orderNumber} fue enviado. En breve nos contactamos para coordinar la entrega.`;
  });
});

function applyDayGate() {
  closedMsgEl.style.display = dayOpen ? 'none' : '';
}

socket.on('business-day:status', ({ day }) => {
  dayOpen = !!day;
  applyDayGate();
});

socket.on('catalog:snapshot', ({ categories: catList, products: prodList }) => {
  categories.clear();
  (catList || []).forEach((c) => categories.set(c.id, c));
  products.clear();
  (prodList || []).forEach((p) => products.set(p.id, p));
  // Un producto que se sacó del catálogo (o se ocultó) no puede seguir en un
  // carrito viejo guardado en localStorage.
  Object.keys(cart).forEach((id) => {
    const p = products.get(id);
    if (!p || p.visible === false) delete cart[id];
  });
  saveCart();
  // Si estabas viendo una categoría que un admin acaba de vaciar/ocultar/
  // borrar mientras tenías la página abierta, no te deja mirando una
  // pantalla de productos rota — vuelve sola a la grilla de categorías.
  if (view === 'products' && !categoryHasVisibleProducts(activeCategoryId)) {
    showCategoriesView();
  } else {
    render();
  }
  renderCart();
  updateCartFab();
});

socket.on('form-config:snapshot', (cfg) => {
  formConfig = cfg || {};
  renderCheckoutFields();
  if (window.applyBranding && formConfig.branding) window.applyBranding(formConfig.branding);
});
