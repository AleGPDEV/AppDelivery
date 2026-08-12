const closedMsgEl = document.getElementById('closed-msg');
const categoriesViewEl = document.getElementById('categories-view');
const categoryGridEl = document.getElementById('category-grid');
const productsViewEl = document.getElementById('products-view');
const productsViewTitleEl = document.getElementById('products-view-title');
const productsGridEl = document.getElementById('products-grid');
const backToCategoriesBtn = document.getElementById('back-to-categories-btn');

const productDetailOverlay = document.getElementById('product-detail-overlay');
const productDetailCloseBtn = document.getElementById('product-detail-close-btn');
const productDetailImgEl = document.getElementById('product-detail-img');
const productDetailNameEl = document.getElementById('product-detail-name');
const productDetailPriceEl = document.getElementById('product-detail-price');
const productDetailDescriptionEl = document.getElementById('product-detail-description');
const productDetailMinusBtn = document.getElementById('product-detail-minus');
const productDetailQtyEl = document.getElementById('product-detail-qty');
const productDetailPlusBtn = document.getElementById('product-detail-plus');
const productDetailAddBtn = document.getElementById('product-detail-add-btn');

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
const checkoutTrackLinkEl = document.getElementById('checkout-track-link');
const checkoutWhatsappLinkEl = document.getElementById('checkout-whatsapp-link');

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
  card.style.cursor = 'pointer';

  // Foto a pantalla completa con degradé + nombre/precio encima, mismo
  // lenguaje que .category-card -- ver comentario en style.css. Ya no tiene
  // su propio +/- -- tocar la tarjeta abre el popup de detalle (ver
  // openProductDetail), que es donde se elige la cantidad y se agrega al
  // carrito -- a pedido explícito ("que cada item tenga su popup con
  // nombre, precio, descripción, un +/- y un botón agregar al carrito").
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

  // Nombre + precio + descripción, los tres superpuestos sobre la foto (a
  // pedido explícito) -- la tarjeta ya no tiene nada abajo de la foto.
  const info = document.createElement('div');
  info.className = 'product-card-media-info';
  const top = document.createElement('div');
  top.className = 'product-card-media-info-top';
  const name = document.createElement('div');
  name.className = 'product-name';
  name.textContent = p.name;
  top.appendChild(name);
  const price = document.createElement('div');
  price.className = 'product-price';
  price.textContent = `$${Number(p.price || 0).toFixed(2)}`;
  top.appendChild(price);
  info.appendChild(top);
  if (p.description) {
    const desc = document.createElement('div');
    desc.className = 'product-description';
    desc.textContent = p.description;
    info.appendChild(desc);
  }
  media.appendChild(info);

  card.appendChild(media);

  card.addEventListener('click', () => openProductDetail(id, p));

  return card;
}

// Popup de detalle del producto: nombre, precio, descripción, un +/- para
// elegir cuánto llevar y un botón para agregarlo al carrito -- a pedido
// explícito. Arranca en la cantidad que ya tenga en el carrito (para poder
// seguir ajustando desde ahí) o en 1 si todavía no lo agregó; el mínimo acá
// es 1 -- sacarlo del carrito del todo se sigue haciendo con el 🗑 de "Tu
// carrito" (`renderCart()`), este popup es solo para agregar/ajustar.
let detailProductId = null;
let detailQty = 1;

function renderProductDetailQty() {
  productDetailQtyEl.textContent = detailQty;
  productDetailMinusBtn.disabled = detailQty <= 1;
}

function openProductDetail(id, p) {
  detailProductId = id;
  detailQty = cart[id] || 1;

  if (p.imageUrl) {
    productDetailImgEl.src = p.imageUrl;
    productDetailImgEl.style.display = '';
  } else {
    productDetailImgEl.style.display = 'none';
  }
  productDetailNameEl.textContent = p.name;
  productDetailPriceEl.textContent = `$${Number(p.price || 0).toFixed(2)}`;
  productDetailDescriptionEl.textContent = p.description || '';
  productDetailDescriptionEl.style.display = p.description ? '' : 'none';
  renderProductDetailQty();

  productDetailOverlay.style.display = 'flex';
}

function closeProductDetail() {
  productDetailOverlay.style.display = 'none';
  detailProductId = null;
}

productDetailCloseBtn.addEventListener('click', closeProductDetail);
productDetailOverlay.addEventListener('click', (e) => { if (e.target === productDetailOverlay) closeProductDetail(); });
productDetailMinusBtn.addEventListener('click', () => {
  if (detailQty <= 1) return;
  detailQty -= 1;
  renderProductDetailQty();
});
productDetailPlusBtn.addEventListener('click', () => {
  detailQty += 1;
  renderProductDetailQty();
});
productDetailAddBtn.addEventListener('click', () => {
  if (!detailProductId) return;
  setQty(detailProductId, detailQty);
  closeProductDetail();
});

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
    cartItemsEl.appendChild(buildCartItemRow(id, p, qty));
  });
  cartTotalEl.style.display = 'flex';
  cartTotalEl.innerHTML = `<span>Subtotal</span><span>$${cartTotal().toFixed(2)}</span>`;
}

// Una fila por producto en el panel de carrito -- foto + nombre/descripción
// superpuestos (mismo lenguaje que .product-card-media), cantidad y precio
// unitario en columnas aparte, y el 🗑 de siempre para sacarlo. A pedido
// explícito, con un croquis mostrando el carrito como panel lateral con
// foto por ítem en vez de una lista de texto plano.
function buildCartItemRow(id, p, qty) {
  const row = document.createElement('div');
  row.className = 'cart-drawer-item';

  const media = document.createElement('div');
  media.className = 'cart-drawer-item-media';
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
  overlay.className = 'cart-drawer-item-media-overlay';
  media.appendChild(overlay);
  const info = document.createElement('div');
  info.className = 'cart-drawer-item-media-info';
  const name = document.createElement('div');
  name.className = 'product-name';
  name.textContent = p.name;
  info.appendChild(name);
  if (p.description) {
    const desc = document.createElement('div');
    desc.className = 'product-description';
    desc.textContent = p.description;
    info.appendChild(desc);
  }
  media.appendChild(info);
  row.appendChild(media);

  const qtyEl = document.createElement('div');
  qtyEl.className = 'cart-drawer-item-qty';
  qtyEl.textContent = qty;
  row.appendChild(qtyEl);

  const priceEl = document.createElement('div');
  priceEl.className = 'cart-drawer-item-price';
  priceEl.textContent = `$${Number(p.price || 0).toFixed(2)}`;
  row.appendChild(priceEl);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'danger small cart-drawer-item-remove';
  removeBtn.textContent = '🗑';
  removeBtn.title = 'Sacar del carrito';
  removeBtn.addEventListener('click', () => setQty(id, 0));
  row.appendChild(removeBtn);

  return row;
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
  checkoutTrackLinkEl.style.display = 'none';
  checkoutStatusEl.textContent = '';
  checkoutStatusEl.className = 'status';
  checkoutOverlay.style.display = 'flex';
  if (!checkoutPickupEl.checked) showLocationPicker();
});

checkoutCloseBtn.addEventListener('click', () => { checkoutOverlay.style.display = 'none'; });
checkoutOverlay.addEventListener('click', (e) => { if (e.target === checkoutOverlay) checkoutOverlay.style.display = 'none'; });

// Números uruguayos: 09X XXX XXX (9 dígitos, arranca en 0) → +598 sin el 0,
// para armar un link de WhatsApp directo -- mismo criterio que driver.js/pedidos.js.
function whatsappLink(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const intl = digits.startsWith('598') ? digits : (digits.startsWith('0') && digits.length === 9) ? `598${digits.slice(1)}` : `598${digits}`;
  return `https://wa.me/${intl}`;
}

// Aviso de respaldo al WhatsApp del negocio (Ajustes -> Cuenta) con el
// detalle del pedido recién hecho -- a pedido explícito, para que quede un
// registro aunque el cliente haya tipeado mal su propio celular. Arma el
// link con el mensaje ya escrito y lo deja como link real en la pantalla de
// confirmación (el cliente igual tiene que tocar "Enviar" adentro de
// WhatsApp -- no existe una forma de mandar un WhatsApp sin que la persona
// lo confirme) -- además intenta abrirlo solo, como mejor esfuerzo, por si
// el navegador lo deja pasar viniendo de la misma interacción del botón
// "Enviar pedido".
function sendOrderToBusinessWhatsapp(orderNumber, payload, items) {
  const wa = whatsappLink(formConfig.businessWhatsapp);
  if (!wa) { checkoutWhatsappLinkEl.style.display = 'none'; return; }

  const lines = [`🛒 *Pedido #${orderNumber}*`];
  if (payload.name) lines.push(`Nombre: ${payload.name}`);
  lines.push(`Celular: ${payload.phone}`);
  lines.push(payload.pickup ? 'Retira en el local' : `Envío a: ${payload.label || 'dirección a confirmar'}`);
  if (!payload.pickup && typeof payload.lat === 'number' && typeof payload.lng === 'number') {
    lines.push(`📍 https://www.google.com/maps?q=${payload.lat},${payload.lng}`);
  }
  lines.push('');
  lines.push('*Productos:*');
  let total = 0;
  items.forEach(({ productId, qty }) => {
    const p = products.get(productId);
    if (!p) return;
    total += p.price * qty;
    lines.push(`${qty} x ${p.name} — $${(p.price * qty).toFixed(2)}`);
  });
  lines.push('');
  lines.push(`*Total: $${total.toFixed(2)}*`);
  (formConfig.customFields || []).forEach((f) => {
    const value = payload.custom && payload.custom[f.key];
    if (value) lines.push(`${f.label}: ${value}`);
  });

  const link = `${wa}?text=${encodeURIComponent(lines.join('\n'))}`;
  checkoutWhatsappLinkEl.href = link;
  checkoutWhatsappLinkEl.style.display = 'inline-block';
  window.open(link, '_blank', 'noopener');
}

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
    if (res.id) {
      checkoutTrackLinkEl.href = `/seguimiento.html?id=${res.id}`;
      checkoutTrackLinkEl.style.display = 'inline-block';
    }
    sendOrderToBusinessWhatsapp(res.orderNumber, payload, items);
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
