import { Store } from '/js/store.js';
import { recomputeRouteForDriver } from '/js/route-helper.js';

// Ya no es una vista propia del Router (era la pestaña "Nuevo pedido",
// separada) — ahora pedidos.js importa {template, mount, unmount} de acá y
// los monta dentro de un modal cuando el admin toca "+ Nuevo pedido", así
// no hace falta cambiar de pantalla para cargar un pedido. Por eso no trae
// <main> propio (el modal ya pone su propio contenedor).
export const template = `
  <p id="day-gate-msg" class="status error" style="display:none;">Iniciá el día desde "Día Comercial" antes de cargar pedidos.</p>
  <div class="field" data-field="phone">
    <label for="new-phone">Celular</label>
    <input type="text" id="new-phone" placeholder="Ej: 099 123 456">
  </div>
  <div class="field" data-field="name">
    <label for="new-name">Nombre</label>
    <input type="text" id="new-name" placeholder="Ej: Matias">
  </div>
  <div class="field" data-field="orderNumber">
    <label for="new-ordernum">Nº de pedido</label>
    <input type="text" id="new-ordernum" placeholder="Ej: 13">
    <p id="order-dup-warning" class="hint" style="display:none; color:var(--danger);"></p>
  </div>
  <div class="field">
    <label>Tipo de envío</label>
    <div style="display:flex; gap:8px;">
      <button type="button" id="delivery-type-pickup-btn" class="small">Retira en el local</button>
      <button type="button" id="delivery-type-shipping-btn" class="small">Envío</button>
    </div>
  </div>
  <div class="field" id="new-location-field" style="display:none;">
    <label for="new-location">Ubicación de entrega</label>
    <input type="text" id="new-location" placeholder="Link de Google Maps, dirección o coordenadas">
  </div>
  <div class="field">
    <label>Productos del catálogo (opcional)</label>
    <p class="hint">Para cuando el cliente te pide por teléfono/WhatsApp en vez de la web -- elegí lo mismo que hubiera elegido él, y el pedido queda con el mismo detalle (🧾) que uno de la web. Si no elegís nada, el pedido queda solo con el monto de abajo, como siempre.</p>
    <button id="open-catalog-picker-btn" type="button" class="small">🛒 Elegir productos del catálogo</button>
  </div>
  <div class="field" id="new-item-summary-field" hidden>
    <label>Productos agregados</label>
    <ul id="new-item-summary" class="order-list"></ul>
  </div>
  <div class="field" data-field="amount">
    <label for="new-amount">Monto</label>
    <input type="text" id="new-amount" placeholder="$ 1.630,00">
  </div>
  <div id="custom-fields-container"></div>
  <div class="field">
    <label for="new-assign">Asignar a</label>
    <select id="new-assign"><option value="">Sin asignar</option></select>
  </div>
  <button id="new-order-btn" type="button" class="primary">Agregar pedido</button>
  <p id="new-order-status" class="status"></p>

  <div style="margin-top:24px; padding-top:20px; border-top:1px solid var(--border);">
    <div class="field">
      <label for="stops-text">Carga masiva (una línea por pedido, pegado directo de una planilla)</label>
      <textarea id="stops-text" rows="5"></textarea>
      <p id="bulk-hint" class="hint"></p>
    </div>
    <button id="load-btn" type="button" class="primary">Cargar pedidos</button>
    <p id="load-status" class="status"></p>
  </div>

<div id="catalog-picker-overlay" class="modal-overlay" style="display:none;">
  <div class="modal-box modal-box-wide">
    <button id="catalog-picker-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
    <h2>Elegir productos del catálogo</h2>

    <div id="picker-categories-view">
      <div id="picker-category-grid" class="category-grid" style="margin-top:16px;"></div>
    </div>

    <div id="picker-products-view" hidden>
      <button id="picker-back-btn" type="button" class="small" style="margin-bottom:14px;">← Categorías</button>
      <h3 id="picker-products-title" style="margin:0 0 6px;"></h3>
      <div id="picker-products-grid" class="catalog-grid"></div>
    </div>

    <div id="picker-cart-bar" style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top:20px; padding-top:16px; border-top:1px solid var(--border);">
      <span id="picker-cart-summary" class="hint">Nada elegido todavía.</span>
      <button id="picker-done-btn" type="button" class="primary">Listo</button>
    </div>
  </div>
</div>

<div id="picker-detail-overlay" class="modal-overlay" style="display:none;">
  <div class="modal-box">
    <button id="picker-detail-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
    <img id="picker-detail-img" style="width:100%; border-radius:var(--radius-md); margin-bottom:12px; display:none;">
    <h2 id="picker-detail-name"></h2>
    <p id="picker-detail-price" class="product-price"></p>
    <p id="picker-detail-description" class="hint"></p>
    <div class="qty-stepper" style="margin:16px 0;">
      <button id="picker-detail-minus" type="button" class="small">−</button>
      <span id="picker-detail-qty">1</span>
      <button id="picker-detail-plus" type="button" class="primary small">+</button>
    </div>
    <button id="picker-detail-add-btn" type="button" class="primary">Agregar</button>
  </div>
</div>
`;

function genId() {
  return `o-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const FIELD_LABELS = {
  phone: 'Celular',
  name: 'Nombre',
  orderNumber: 'Nº de pedido',
  location: 'Ubicación de entrega',
  amount: 'Monto',
};
const FIELD_ORDER = ['phone', 'name', 'orderNumber', 'location', 'amount'];
const FIELD_SAMPLE = {
  phone: '099123456',
  name: 'Matias',
  orderNumber: '3',
  location: 'https://www.google.com/maps?q=-34.7067,-55.9607',
  amount: '$ 1.630,00',
};

let unsubscribe = null;

export function mount(root) {
  const stopsTextEl = root.querySelector('#stops-text');
  const loadBtn = root.querySelector('#load-btn');
  const loadStatusEl = root.querySelector('#load-status');
  const bulkHintEl = root.querySelector('#bulk-hint');
  const newPhoneEl = root.querySelector('#new-phone');
  const newNameEl = root.querySelector('#new-name');
  const newOrderNumEl = root.querySelector('#new-ordernum');
  const newLocationEl = root.querySelector('#new-location');
  const newLocationFieldEl = root.querySelector('#new-location-field');
  const deliveryTypePickupBtn = root.querySelector('#delivery-type-pickup-btn');
  const deliveryTypeShippingBtn = root.querySelector('#delivery-type-shipping-btn');
  const newAmountEl = root.querySelector('#new-amount');
  const newAssignEl = root.querySelector('#new-assign');
  const newOrderBtn = root.querySelector('#new-order-btn');
  const newOrderStatusEl = root.querySelector('#new-order-status');
  const dayGateMsgEl = root.querySelector('#day-gate-msg');
  const orderDupWarningEl = root.querySelector('#order-dup-warning');
  const newItemSummaryFieldEl = root.querySelector('#new-item-summary-field');
  const newItemSummaryEl = root.querySelector('#new-item-summary');
  const openCatalogPickerBtn = root.querySelector('#open-catalog-picker-btn');
  const catalogPickerOverlay = root.querySelector('#catalog-picker-overlay');
  const catalogPickerCloseBtn = root.querySelector('#catalog-picker-close-btn');
  const pickerCategoriesViewEl = root.querySelector('#picker-categories-view');
  const pickerCategoryGridEl = root.querySelector('#picker-category-grid');
  const pickerProductsViewEl = root.querySelector('#picker-products-view');
  const pickerProductsTitleEl = root.querySelector('#picker-products-title');
  const pickerProductsGridEl = root.querySelector('#picker-products-grid');
  const pickerBackBtn = root.querySelector('#picker-back-btn');
  const pickerCartSummaryEl = root.querySelector('#picker-cart-summary');
  const pickerDoneBtn = root.querySelector('#picker-done-btn');
  const pickerDetailOverlay = root.querySelector('#picker-detail-overlay');
  const pickerDetailCloseBtn = root.querySelector('#picker-detail-close-btn');
  const pickerDetailImgEl = root.querySelector('#picker-detail-img');
  const pickerDetailNameEl = root.querySelector('#picker-detail-name');
  const pickerDetailPriceEl = root.querySelector('#picker-detail-price');
  const pickerDetailDescriptionEl = root.querySelector('#picker-detail-description');
  const pickerDetailMinusBtn = root.querySelector('#picker-detail-minus');
  const pickerDetailQtyEl = root.querySelector('#picker-detail-qty');
  const pickerDetailPlusBtn = root.querySelector('#picker-detail-plus');
  const pickerDetailAddBtn = root.querySelector('#picker-detail-add-btn');

  const socket = Store.socket;
  let deliveryType = null;
  let dayOpen = !!Store.getBusinessDay();
  let formConfig = Store.getFormConfig();
  const selectedItems = new Map(); // productId -> qty, para "Productos del catálogo"

  function applyDeliveryTypeButtons() {
    deliveryTypePickupBtn.className = deliveryType === 'retira' ? 'primary small' : 'small';
    deliveryTypeShippingBtn.className = deliveryType === 'envio' ? 'primary small' : 'small';
    newLocationFieldEl.style.display = deliveryType === 'envio' ? '' : 'none';
  }

  deliveryTypePickupBtn.addEventListener('click', () => {
    deliveryType = 'retira';
    newLocationEl.value = '';
    applyDeliveryTypeButtons();
  });
  deliveryTypeShippingBtn.addEventListener('click', () => {
    deliveryType = 'envio';
    applyDeliveryTypeButtons();
  });

  // ---------- Productos del catálogo (opcional) ----------
  // Para cuando el cliente pide por teléfono/WhatsApp en vez de la web --
  // reusa el mismo catálogo (Store.getCategories()/getProducts(), ya
  // cacheado, sin pedir nada nuevo al servidor) para poder armar el mismo
  // detalle de items que ya tiene un pedido web (🧾 en la tabla). Es
  // puramente aditivo: si no se elige nada, el pedido se sigue cargando
  // solo con el monto de siempre.
  function sortedVisibleCategories() {
    return Array.from(Store.getCategories().entries())
      .filter(([, c]) => c.visible !== false)
      .sort((a, b) => a[1].sortOrder - b[1].sortOrder);
  }

  function productsInCategory(categoryId) {
    return Array.from(Store.getProducts().entries())
      .filter(([, p]) => p.categoryId === categoryId && p.visible !== false)
      .sort((a, b) => a[1].sortOrder - b[1].sortOrder);
  }

  function itemsSubtotal() {
    let total = 0;
    selectedItems.forEach((qty, productId) => {
      const p = Store.getProducts().get(productId);
      if (p) total += p.price * qty;
    });
    return total;
  }

  // Autocompleta el Monto a partir de lo elegido -- pero no lo pisa si el
  // admin ya vació la selección de productos después de haber tipeado algo
  // a mano (selectedItems.size === 0 no toca el campo).
  function updateAmountFromItems() {
    if (selectedItems.size === 0) return;
    newAmountEl.value = itemsSubtotal().toFixed(2);
  }

  // Popup "Elegir productos del catálogo": mismo recorrido que ve el
  // cliente en pedido-cliente.js (grilla de categorías -> grilla de
  // productos de una -> popup de detalle con +/- y "Agregar") -- a pedido
  // explícito ("me gustaría que la pantalla del pedido fuera la misma que
  // el ve"), en vez del desplegable + lista con steppers que había antes.
  // El estado elegido sigue viviendo en `selectedItems` (Map productId->qty,
  // compartido con "Productos agregados"/Monto más abajo) -- este popup solo
  // cambia CÓMO se llena ese Map, no la lógica de resumen/autocompletar que
  // ya existía.
  function categoryHasVisibleProducts(categoryId) {
    return productsInCategory(categoryId).length > 0;
  }

  let pickerView = 'categories';
  let pickerActiveCategoryId = null;
  let detailProductId = null;
  let detailQty = 1;

  function pickerCartCount() {
    let count = 0;
    selectedItems.forEach((qty) => { count += qty; });
    return count;
  }

  function renderPickerCartSummary() {
    const count = pickerCartCount();
    pickerCartSummaryEl.textContent = count === 0
      ? 'Nada elegido todavía.'
      : `${count} producto${count === 1 ? '' : 's'} elegido${count === 1 ? '' : 's'} — $${itemsSubtotal().toFixed(2)}`;
  }

  function buildPickerProductCard(productId, p) {
    const card = document.createElement('div');
    card.className = 'product-card';
    card.style.cursor = 'pointer';

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

    if (selectedItems.get(productId)) {
      const badge = document.createElement('div');
      badge.className = 'picker-product-qty-badge';
      badge.textContent = selectedItems.get(productId);
      card.appendChild(badge);
    }

    card.addEventListener('click', () => openPickerDetail(productId, p));
    return card;
  }

  function renderPickerCategoryGrid() {
    pickerCategoryGridEl.innerHTML = '';
    const cats = sortedVisibleCategories().filter(([catId]) => categoryHasVisibleProducts(catId));
    if (cats.length === 0) {
      pickerCategoryGridEl.innerHTML = '<p class="hint">El catálogo todavía no tiene productos visibles.</p>';
      return;
    }
    cats.forEach(([catId, c]) => {
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
      card.addEventListener('click', () => showPickerProducts(catId));
      pickerCategoryGridEl.appendChild(card);
    });
  }

  function renderPickerProductsGrid() {
    const c = Store.getCategories().get(pickerActiveCategoryId);
    pickerProductsTitleEl.textContent = c ? c.name : '';
    pickerProductsGridEl.innerHTML = '';
    productsInCategory(pickerActiveCategoryId).forEach(([productId, p]) => {
      pickerProductsGridEl.appendChild(buildPickerProductCard(productId, p));
    });
  }

  function renderPicker() {
    if (pickerView === 'products') {
      pickerCategoriesViewEl.hidden = true;
      pickerProductsViewEl.hidden = false;
      renderPickerProductsGrid();
    } else {
      pickerProductsViewEl.hidden = true;
      pickerCategoriesViewEl.hidden = false;
      renderPickerCategoryGrid();
    }
    renderPickerCartSummary();
  }

  function showPickerCategories() {
    pickerView = 'categories';
    pickerActiveCategoryId = null;
    renderPicker();
  }

  function showPickerProducts(categoryId) {
    pickerView = 'products';
    pickerActiveCategoryId = categoryId;
    renderPicker();
  }

  function renderPickerDetailQty() {
    pickerDetailQtyEl.textContent = detailQty;
    pickerDetailMinusBtn.disabled = detailQty <= 1;
  }

  function openPickerDetail(productId, p) {
    detailProductId = productId;
    detailQty = selectedItems.get(productId) || 1;
    if (p.imageUrl) {
      pickerDetailImgEl.src = p.imageUrl;
      pickerDetailImgEl.style.display = '';
    } else {
      pickerDetailImgEl.style.display = 'none';
    }
    pickerDetailNameEl.textContent = p.name;
    pickerDetailPriceEl.textContent = `$${Number(p.price || 0).toFixed(2)}`;
    pickerDetailDescriptionEl.textContent = p.description || '';
    pickerDetailDescriptionEl.style.display = p.description ? '' : 'none';
    renderPickerDetailQty();
    pickerDetailOverlay.style.display = 'flex';
  }

  function closePickerDetail() {
    pickerDetailOverlay.style.display = 'none';
    detailProductId = null;
  }

  pickerDetailCloseBtn.addEventListener('click', closePickerDetail);
  pickerDetailOverlay.addEventListener('click', (e) => { if (e.target === pickerDetailOverlay) closePickerDetail(); });
  pickerDetailMinusBtn.addEventListener('click', () => {
    if (detailQty <= 1) return;
    detailQty -= 1;
    renderPickerDetailQty();
  });
  pickerDetailPlusBtn.addEventListener('click', () => {
    detailQty += 1;
    renderPickerDetailQty();
  });
  pickerDetailAddBtn.addEventListener('click', () => {
    if (!detailProductId) return;
    setItemQty(detailProductId, detailQty);
    closePickerDetail();
    if (pickerView === 'products') renderPickerProductsGrid();
    renderPickerCartSummary();
  });

  openCatalogPickerBtn.addEventListener('click', () => {
    showPickerCategories();
    catalogPickerOverlay.style.display = 'flex';
  });
  catalogPickerCloseBtn.addEventListener('click', () => { catalogPickerOverlay.style.display = 'none'; });
  catalogPickerOverlay.addEventListener('click', (e) => { if (e.target === catalogPickerOverlay) catalogPickerOverlay.style.display = 'none'; });
  pickerBackBtn.addEventListener('click', showPickerCategories);
  pickerDoneBtn.addEventListener('click', () => { catalogPickerOverlay.style.display = 'none'; });

  function renderItemSummary() {
    newItemSummaryEl.innerHTML = '';
    newItemSummaryFieldEl.hidden = selectedItems.size === 0;
    selectedItems.forEach((qty, productId) => {
      const p = Store.getProducts().get(productId);
      if (!p) return;
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'order-info';
      label.textContent = `${qty} × ${p.name}`;
      li.appendChild(label);
      const right = document.createElement('span');
      right.style.display = 'flex';
      right.style.alignItems = 'center';
      right.style.gap = '8px';
      const amount = document.createElement('span');
      amount.textContent = `$${(p.price * qty).toFixed(2)}`;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'danger small';
      removeBtn.textContent = '🗑';
      removeBtn.addEventListener('click', () => setItemQty(productId, 0));
      right.append(amount, removeBtn);
      li.appendChild(right);
      newItemSummaryEl.appendChild(li);
    });
  }

  function setItemQty(productId, qty) {
    if (qty <= 0) selectedItems.delete(productId);
    else selectedItems.set(productId, qty);
    renderItemSummary();
    updateAmountFromItems();
  }

  function resetItemPicker() {
    selectedItems.clear();
    renderItemSummary();
  }

  function applyDayGate() {
    dayGateMsgEl.style.display = dayOpen ? 'none' : '';
    newOrderBtn.disabled = !dayOpen;
    loadBtn.disabled = !dayOpen;
  }

  function findActiveOrderByNumber(number) {
    if (!number) return null;
    for (const o of Store.getOrders().values()) {
      if (!o.archivedAt && o.orderNumber === number) return o;
    }
    return null;
  }

  newOrderNumEl.addEventListener('input', () => {
    const match = findActiveOrderByNumber(newOrderNumEl.value.trim());
    orderDupWarningEl.style.display = match ? '' : 'none';
    orderDupWarningEl.textContent = match ? `Ya hay un pedido activo con este número${match.name ? ` (${match.name})` : ''} — se puede cargar igual.` : '';
  });

  function customFields() {
    return formConfig.customFields || [];
  }

  function labelFor(key) {
    return FIELD_LABELS[key] || (customFields().find((f) => f.key === key) || {}).label || key;
  }

  function visibleFieldOrder() {
    const builtins = FIELD_ORDER.filter((key) => key === 'location' || (formConfig[key] || { visible: true }).visible !== false);
    const customs = customFields().filter((f) => f.visible !== false).map((f) => f.key);
    return [...builtins, ...customs];
  }

  function updateBulkHint() {
    const fields = visibleFieldOrder();
    const labels = fields.map(labelFor);
    bulkHintEl.textContent = fields.length > 0
      ? `Formato (separado por tabulación, pegado directo de una planilla): ${labels.join(' · ')}. Si alguno falla, se avisa y el resto sigue cargando igual.`
      : 'Activá al menos un campo en "Personalizar campos del formulario" para poder cargar pedidos.';
    stopsTextEl.placeholder = fields.map((k) => FIELD_SAMPLE[k] || labelFor(k)).join('\t');
  }

  function customFieldInputId(key) {
    return `custom-field-${key}`;
  }

  function renderCustomFieldInputs() {
    const container = root.querySelector('#custom-fields-container');
    container.innerHTML = '';
    customFields().forEach((f) => {
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
      container.appendChild(div);
    });
  }

  function applyFormConfig() {
    ['phone', 'name', 'orderNumber', 'amount'].forEach((key) => {
      const wrapper = root.querySelector(`[data-field="${key}"]`);
      const cfg = formConfig[key] || { visible: true, required: false };
      if (wrapper) wrapper.style.display = cfg.visible === false ? 'none' : '';
    });
    renderCustomFieldInputs();
    updateBulkHint();
  }

  function renderAssignOptions() {
    const previousValue = newAssignEl.value;
    newAssignEl.innerHTML = '<option value="">Sin asignar</option>';
    Store.getDrivers().forEach((d, driverId) => {
      const opt = document.createElement('option');
      opt.value = driverId;
      opt.textContent = d.name;
      newAssignEl.appendChild(opt);
    });
    newAssignEl.value = previousValue;
  }

  loadBtn.addEventListener('click', async () => {
    const fields = visibleFieldOrder();
    const rows = Geo.parseStopsText(stopsTextEl.value, fields);
    if (rows.length === 0) {
      loadStatusEl.textContent = 'Pegá al menos un pedido.';
      loadStatusEl.className = 'status error';
      return;
    }

    loadBtn.disabled = true;
    let okCount = 0;
    const failed = [];
    const duplicates = [];
    const seenInBatch = new Set();

    for (let i = 0; i < rows.length; i++) {
      const { order, raw, amount, phone, name, custom } = rows[i];
      const label = order ? `el pedido #${order} (línea ${i + 1})` : `la línea ${i + 1}`;
      let point = null;
      if (raw) {
        try {
          point = await Geo.resolveInput(raw, label, (msg) => {
            loadStatusEl.textContent = msg;
            loadStatusEl.className = 'status';
          });
        } catch (e) {
          failed.push(`${order ? `#${order}` : `línea ${i + 1}`}: ${e.message}`);
          continue;
        }
      }
      if (order && (findActiveOrderByNumber(order) || seenInBatch.has(order))) duplicates.push(`#${order}`);
      if (order) seenInBatch.add(order);
      socket.emit('order:add', { id: genId(), orderNumber: order, phone, name, lat: point ? point.lat : null, lng: point ? point.lng : null, label: point ? point.label : '', amount, custom, pickup: !raw });
      okCount++;
    }

    loadBtn.disabled = false;
    let msg = failed.length === 0
      ? `Se cargaron ${okCount} pedido${okCount === 1 ? '' : 's'} correctamente.`
      : `${okCount} cargados. ${failed.length} con problemas:\n${failed.join('\n')}`;
    if (duplicates.length > 0) msg += `\nOjo, número de pedido repetido: ${duplicates.join(', ')}.`;
    loadStatusEl.textContent = msg;
    loadStatusEl.className = failed.length === 0 ? 'status ok' : 'status error';
    if (failed.length === 0) stopsTextEl.value = '';
  });

  const FIELD_INPUTS = {
    phone: newPhoneEl,
    name: newNameEl,
    orderNumber: newOrderNumEl,
    amount: newAmountEl,
  };

  newOrderBtn.addEventListener('click', async () => {
    const missing = Object.keys(FIELD_INPUTS).filter((key) => {
      const cfg = formConfig[key];
      return cfg && cfg.visible !== false && cfg.required && !FIELD_INPUTS[key].value.trim();
    }).map(labelFor);
    if (!deliveryType) missing.push('Tipo de envío (Retira/Envío)');
    const missingCustomFields = customFields().filter((f) => {
      if (f.visible === false || !f.required) return false;
      const input = root.querySelector(`#${customFieldInputId(f.key)}`);
      return !input || !input.value.trim();
    });
    if (missing.length > 0 || missingCustomFields.length > 0) {
      const labels = [...missing, ...missingCustomFields.map((f) => f.label)];
      newOrderStatusEl.textContent = `Falta completar: ${labels.join(', ')}.`;
      newOrderStatusEl.className = 'status error';
      return;
    }
    if (deliveryType === 'envio' && !newLocationEl.value.trim()) {
      newOrderStatusEl.textContent = 'Falta completar: Ubicación de entrega.';
      newOrderStatusEl.className = 'status error';
      return;
    }

    const orderNumber = newOrderNumEl.value.trim();
    newOrderBtn.disabled = true;
    const locationRaw = deliveryType === 'envio' ? newLocationEl.value.trim() : '';
    const phone = newPhoneEl.value.trim();
    const name = newNameEl.value.trim();
    const assignTo = newAssignEl.value || null;
    const amount = Geo.parseAmount(newAmountEl.value);
    const custom = {};
    customFields().forEach((f) => {
      if (f.visible === false) return;
      const input = root.querySelector(`#${customFieldInputId(f.key)}`);
      if (input) custom[f.key] = input.value.trim();
    });

    let point = null;
    if (locationRaw) {
      try {
        point = await Geo.resolveInput(locationRaw, `el pedido #${orderNumber}`, (msg) => {
          newOrderStatusEl.textContent = msg;
          newOrderStatusEl.className = 'status';
        });
      } catch (e) {
        newOrderStatusEl.textContent = e.message;
        newOrderStatusEl.className = 'status error';
        newOrderBtn.disabled = false;
        return;
      }
    }

    const id = genId();
    const items = Array.from(selectedItems.entries()).map(([productId, qty]) => ({ productId, qty }));
    socket.emit('order:add', {
      id,
      orderNumber,
      phone,
      name,
      lat: point ? point.lat : null,
      lng: point ? point.lng : null,
      label: point ? point.label : '',
      amount,
      custom,
      pickup: deliveryType === 'retira',
      items: items.length > 0 ? items : undefined,
    });
    if (assignTo) {
      socket.emit('order:assign', { id, driverId: assignTo });
    }

    newOrderStatusEl.textContent = `Pedido #${orderNumber} agregado.`;
    newOrderStatusEl.className = 'status ok';
    newPhoneEl.value = '';
    newNameEl.value = '';
    newOrderNumEl.value = '';
    newLocationEl.value = '';
    newAmountEl.value = '';
    newAssignEl.value = '';
    deliveryType = null;
    applyDeliveryTypeButtons();
    resetItemPicker();
    customFields().forEach((f) => {
      const input = root.querySelector(`#${customFieldInputId(f.key)}`);
      if (input) input.value = '';
    });
    newOrderBtn.disabled = false;
  });

  // El GPS manda `driver:update` cada pocos segundos — redibujar el <select>
  // "Asignar a" en cada uno lo cerraría solo si lo tenías abierto para elegir.
  // Solo hace falta redibujar cuando aparece un delivery nuevo o cambia su
  // nombre. Store ya aplica el update a su Map antes de re-emitir el evento,
  // así que comparar contra Store.getDrivers() no serviría para detectar el
  // cambio — se mantiene una copia propia de "último nombre visto" con el
  // único propósito de esa comparación (igual que hacía la página vieja con
  // su Map local, antes de pisarlo con el valor nuevo).
  const knownDriverNames = new Map();
  Store.getDrivers().forEach((d, id) => knownDriverNames.set(id, d.name));

  const onDayStatus = (e) => {
    dayOpen = !!e.detail.day;
    applyDayGate();
  };
  const onFormConfigSnapshot = (e) => {
    formConfig = e.detail || {};
    applyFormConfig();
  };
  const onDriversSnapshot = (e) => {
    (e.detail || []).forEach((d) => knownDriverNames.set(d.id, d.name));
    renderAssignOptions();
  };
  const onDriverUpdate = (e) => {
    const needsRerender = knownDriverNames.get(e.detail.id) !== e.detail.name;
    knownDriverNames.set(e.detail.id, e.detail.name);
    if (needsRerender) renderAssignOptions();
  };
  const onDriverRemove = (e) => {
    knownDriverNames.delete(e.detail.id);
    renderAssignOptions();
  };
  const onOrderUpdate = (e) => {
    if (e.detail.assignedTo) recomputeRouteForDriver(e.detail.assignedTo);
  };
  const onCatalogSnapshot = () => {
    if (catalogPickerOverlay.style.display === 'none') return;
    if (pickerView === 'products' && !categoryHasVisibleProducts(pickerActiveCategoryId)) {
      showPickerCategories();
    } else {
      renderPicker();
    }
  };

  Store.on('business-day:status', onDayStatus);
  Store.on('form-config:snapshot', onFormConfigSnapshot);
  Store.on('drivers:snapshot', onDriversSnapshot);
  Store.on('driver:update', onDriverUpdate);
  Store.on('driver:remove', onDriverRemove);
  Store.on('order:update', onOrderUpdate);
  Store.on('catalog:snapshot', onCatalogSnapshot);

  unsubscribe = () => {
    Store.off('business-day:status', onDayStatus);
    Store.off('form-config:snapshot', onFormConfigSnapshot);
    Store.off('drivers:snapshot', onDriversSnapshot);
    Store.off('driver:update', onDriverUpdate);
    Store.off('driver:remove', onDriverRemove);
    Store.off('order:update', onOrderUpdate);
    Store.off('catalog:snapshot', onCatalogSnapshot);
  };

  applyDeliveryTypeButtons();
  applyDayGate();
  applyFormConfig();
  renderAssignOptions();
}

export function unmount() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}
