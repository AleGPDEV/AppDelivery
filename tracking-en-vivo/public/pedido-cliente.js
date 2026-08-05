const closedMsgEl = document.getElementById('closed-msg');
const catalogContainerEl = document.getElementById('catalog-container');

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
  renderCatalog();
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

function renderCatalog() {
  catalogContainerEl.innerHTML = '';
  sortedCategories().forEach(([categoryId, c]) => {
    const items = Array.from(products.entries())
      .filter(([, p]) => p.categoryId === categoryId && p.visible !== false)
      .sort((a, b) => a[1].sortOrder - b[1].sortOrder);
    if (items.length === 0) return;

    const section = document.createElement('section');
    section.className = 'panel';
    const heading = document.createElement('h2');
    heading.textContent = c.name;
    section.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'catalog-grid';

    items.forEach(([id, p]) => {
      const card = document.createElement('div');
      card.className = 'product-card';

      if (p.imageUrl) {
        const img = document.createElement('img');
        img.src = p.imageUrl;
        img.alt = p.name;
        card.appendChild(img);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'no-image';
        placeholder.textContent = '🍣';
        card.appendChild(placeholder);
      }

      const name = document.createElement('div');
      name.className = 'product-name';
      name.textContent = p.name;
      card.appendChild(name);

      if (p.description) {
        const desc = document.createElement('div');
        desc.className = 'product-description';
        desc.textContent = p.description;
        card.appendChild(desc);
      }

      const price = document.createElement('div');
      price.className = 'product-price';
      price.textContent = `$${Number(p.price || 0).toFixed(2)}`;
      card.appendChild(price);

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

      grid.appendChild(card);
    });

    section.appendChild(grid);
    catalogContainerEl.appendChild(section);
  });
}

function renderCart() {
  cartItemsEl.innerHTML = '';
  const entries = Object.entries(cart).filter(([id]) => products.has(id));
  if (entries.length === 0) {
    cartItemsEl.innerHTML = '<p class="hint">Todavía no agregaste nada.</p>';
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
  const phoneField = document.querySelector('[data-field="phone"]');
  const nameField = document.querySelector('[data-field="name"]');
  const phoneCfg = formConfig.phone || { visible: true };
  const nameCfg = formConfig.name || { visible: true };
  if (phoneField) phoneField.style.display = phoneCfg.visible === false ? 'none' : '';
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
});

cartCheckoutBtn.addEventListener('click', () => {
  cartOverlay.style.display = 'none';
  checkoutFormEl.style.display = '';
  checkoutConfirmationEl.style.display = 'none';
  checkoutStatusEl.textContent = '';
  checkoutStatusEl.className = 'status';
  checkoutOverlay.style.display = 'flex';
});

checkoutCloseBtn.addEventListener('click', () => { checkoutOverlay.style.display = 'none'; });
checkoutOverlay.addEventListener('click', (e) => { if (e.target === checkoutOverlay) checkoutOverlay.style.display = 'none'; });

checkoutSubmitBtn.addEventListener('click', async () => {
  if (!dayOpen) {
    checkoutStatusEl.textContent = 'No estamos aceptando pedidos en este momento.';
    checkoutStatusEl.className = 'status error';
    return;
  }

  const missing = [];
  if (formConfig.phone?.visible !== false && formConfig.phone?.required && !checkoutPhoneEl.value.trim()) missing.push('Celular');
  if (formConfig.name?.visible !== false && formConfig.name?.required && !checkoutNameEl.value.trim()) missing.push('Nombre');
  if (!checkoutPickupEl.checked && formConfig.location?.required && !checkoutLocationEl.value.trim()) missing.push('Dirección de entrega');
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
    renderCatalog();
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
  renderCatalog();
  renderCart();
  updateCartFab();
});

socket.on('form-config:snapshot', (cfg) => {
  formConfig = cfg || {};
  renderCheckoutFields();
});
