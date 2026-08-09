import { Store } from '/js/store.js';
import { Router } from '/js/router.js';

// Misma grilla de categorías -> productos que ve el cliente en
// pedido-cliente.html (reusa .category-grid/.category-card/.catalog-grid/
// .product-card de style.css tal cual), para que el admin vea el catálogo
// como lo ve un cliente en vez de una tabla de gestión aparte. Encima de esa
// misma estructura se agregan los controles de admin: un ✏️ chico por
// tarjeta (categoría o producto) que abre su modal de edición, y una
// "tarjeta" de borde punteado al final de cada grilla para crear una nueva.
const template = `
<main class="wide">
  <section class="panel" id="categories-view">
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <h2>Categorías</h2>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <a id="download-template-btn" href="/api/catalog/template.xlsx" class="primary" download style="width:auto; padding:6px 14px; border-radius:var(--radius-sm); font-size:0.85rem; font-weight:600;">⬇ Descargar Excel</a>
        <button id="import-catalog-btn" type="button" class="small">⬆ Cargar Excel</button>
        <input type="file" id="import-catalog-input" accept=".xlsx" style="display:none;">
        <button id="reorder-categories-btn" type="button" class="small">↕ Ordenar categorías</button>
      </div>
    </div>
    <p class="hint">Así se ve el pedido online para el cliente — tocá una categoría para ver (y administrar) sus productos. "Descargar Excel" te da una planilla con el catálogo actual (o un ejemplo si todavía está vacío) para editar en lote y volver a subir.</p>
    <p id="import-status" class="status"></p>
    <div id="category-grid" class="category-grid" style="margin-top:16px;"></div>
  </section>

  <section class="panel" id="products-view" hidden>
    <div class="products-view-header">
      <button id="back-to-categories-btn" type="button" class="icon-btn" aria-label="Volver a categorías">←</button>
      <h2 id="products-view-title" class="catalog-view-title"></h2>
    </div>
    <div id="products-grid" class="catalog-grid"></div>
  </section>
</main>

<div id="category-edit-overlay" class="modal-overlay" style="display:none;">
  <div class="modal-box">
    <button id="category-edit-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
    <h2 id="category-edit-title">Editar categoría</h2>
    <div class="field" id="category-edit-photo-field">
      <label for="category-edit-image">Foto</label>
      <img id="category-edit-preview" src="" alt="" style="display:none; max-width:100%; border-radius:8px; margin-bottom:8px;">
      <input type="file" id="category-edit-image" accept="image/*">
      <p id="category-edit-image-status" class="hint"></p>
    </div>
    <div class="field">
      <label for="category-edit-name">Nombre</label>
      <input type="text" id="category-edit-name" placeholder="Ej: Rolls">
    </div>
    <div class="field" id="category-edit-visible-field">
      <label style="display:flex; align-items:center; gap:6px;">
        <input type="checkbox" id="category-edit-visible" style="width:auto;">
        Mostrar en el pedido online
      </label>
    </div>
    <div style="display:flex; gap:10px; flex-wrap:wrap;">
      <button id="category-edit-save-btn" type="button" class="primary">Guardar</button>
      <button id="category-edit-delete-btn" type="button" class="danger">Eliminar categoría</button>
    </div>
    <p id="category-edit-status" class="status"></p>
  </div>
</div>

<div id="category-order-overlay" class="modal-overlay" style="display:none;">
  <div class="modal-box">
    <button id="category-order-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
    <h2>Ordenar categorías</h2>
    <p class="hint">Arrastrá del ⠿ para reordenar — se guarda solo, no hace falta ningún botón aparte.</p>
    <ul id="category-order-list" class="reorder-list"></ul>
  </div>
</div>

<div id="product-add-overlay" class="modal-overlay" style="display:none;">
  <div class="modal-box">
    <button id="product-add-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
    <h2>Nuevo producto</h2>
    <div class="field">
      <label for="add-product-name">Nombre</label>
      <input type="text" id="add-product-name" placeholder="Ej: Roll California">
    </div>
    <div class="field">
      <label for="add-product-description">Descripción</label>
      <input type="text" id="add-product-description" placeholder="Ej: 8 piezas, palta y kanikama">
    </div>
    <div class="field">
      <label for="add-product-price">Precio</label>
      <input type="text" id="add-product-price" placeholder="$ 450,00">
    </div>
    <button id="add-product-btn" type="button" class="primary">Agregar producto</button>
    <p id="add-product-status" class="status"></p>
  </div>
</div>

<div id="product-edit-overlay" class="modal-overlay" style="display:none;">
  <div class="modal-box">
    <button id="product-edit-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
    <h2>Editar producto</h2>
    <div class="field">
      <label for="edit-product-image">Foto</label>
      <img id="edit-product-preview" src="" alt="" style="display:none; max-width:100%; border-radius:8px; margin-bottom:8px;">
      <input type="file" id="edit-product-image" accept="image/*">
      <p id="edit-product-image-status" class="hint"></p>
    </div>
    <div class="field">
      <label for="edit-product-category">Categoría</label>
      <select id="edit-product-category"></select>
    </div>
    <div class="field">
      <label for="edit-product-name">Nombre</label>
      <input type="text" id="edit-product-name">
    </div>
    <div class="field">
      <label for="edit-product-description">Descripción</label>
      <input type="text" id="edit-product-description">
    </div>
    <div class="field">
      <label for="edit-product-price">Precio</label>
      <input type="text" id="edit-product-price">
    </div>
    <div class="field">
      <label style="display:flex; align-items:center; gap:6px;">
        <input type="checkbox" id="edit-product-visible" style="width:auto;">
        Mostrar en el pedido online
      </label>
    </div>
    <div style="display:flex; gap:10px; flex-wrap:wrap;">
      <button id="edit-product-save-btn" type="button" class="primary">Guardar cambios</button>
      <button id="edit-product-delete-btn" type="button" class="danger">Eliminar producto</button>
    </div>
    <p id="edit-product-status" class="status"></p>
  </div>
</div>
`;

let unsubscribe = null;

function mount(root) {
  const categoriesViewEl = root.querySelector('#categories-view');
  const categoryGridEl = root.querySelector('#category-grid');
  const reorderCategoriesBtn = root.querySelector('#reorder-categories-btn');
  const importCatalogBtn = root.querySelector('#import-catalog-btn');
  const importCatalogInputEl = root.querySelector('#import-catalog-input');
  const importStatusEl = root.querySelector('#import-status');

  const productsViewEl = root.querySelector('#products-view');
  const productsViewTitleEl = root.querySelector('#products-view-title');
  const productsGridEl = root.querySelector('#products-grid');
  const backToCategoriesBtn = root.querySelector('#back-to-categories-btn');

  const categoryEditOverlay = root.querySelector('#category-edit-overlay');
  const categoryEditCloseBtn = root.querySelector('#category-edit-close-btn');
  const categoryEditTitleEl = root.querySelector('#category-edit-title');
  const categoryEditPhotoFieldEl = root.querySelector('#category-edit-photo-field');
  const categoryEditPreviewEl = root.querySelector('#category-edit-preview');
  const categoryEditImageEl = root.querySelector('#category-edit-image');
  const categoryEditImageStatusEl = root.querySelector('#category-edit-image-status');
  const categoryEditNameEl = root.querySelector('#category-edit-name');
  const categoryEditVisibleFieldEl = root.querySelector('#category-edit-visible-field');
  const categoryEditVisibleEl = root.querySelector('#category-edit-visible');
  const categoryEditSaveBtn = root.querySelector('#category-edit-save-btn');
  const categoryEditDeleteBtn = root.querySelector('#category-edit-delete-btn');
  const categoryEditStatusEl = root.querySelector('#category-edit-status');

  const categoryOrderOverlay = root.querySelector('#category-order-overlay');
  const categoryOrderCloseBtn = root.querySelector('#category-order-close-btn');
  const categoryOrderListEl = root.querySelector('#category-order-list');

  const productAddOverlay = root.querySelector('#product-add-overlay');
  const productAddCloseBtn = root.querySelector('#product-add-close-btn');
  const addProductNameEl = root.querySelector('#add-product-name');
  const addProductDescriptionEl = root.querySelector('#add-product-description');
  const addProductPriceEl = root.querySelector('#add-product-price');
  const addProductBtn = root.querySelector('#add-product-btn');
  const addProductStatusEl = root.querySelector('#add-product-status');

  const productEditOverlay = root.querySelector('#product-edit-overlay');
  const productEditCloseBtn = root.querySelector('#product-edit-close-btn');
  const editProductPreviewEl = root.querySelector('#edit-product-preview');
  const editProductImageEl = root.querySelector('#edit-product-image');
  const editProductImageStatusEl = root.querySelector('#edit-product-image-status');
  const editProductCategoryEl = root.querySelector('#edit-product-category');
  const editProductNameEl = root.querySelector('#edit-product-name');
  const editProductDescriptionEl = root.querySelector('#edit-product-description');
  const editProductPriceEl = root.querySelector('#edit-product-price');
  const editProductVisibleEl = root.querySelector('#edit-product-visible');
  const editProductSaveBtn = root.querySelector('#edit-product-save-btn');
  const editProductDeleteBtn = root.querySelector('#edit-product-delete-btn');
  const editProductStatusEl = root.querySelector('#edit-product-status');

  const socket = Store.socket;

  let view = 'categories'; // 'categories' | 'products' -- mismo toggle que pedido-cliente.js
  let activeCategoryId = null;
  let editingCategoryId = null; // null = el modal de categoría está en modo "crear"
  let editingProductId = null;

  function categories() { return Store.getCategories(); }
  function products() { return Store.getProducts(); }

  function categoryHasProducts(categoryId) {
    return Array.from(products().values()).some((p) => p.categoryId === categoryId);
  }

  function sortedCategories() {
    return Array.from(categories().entries()).sort((a, b) => a[1].sortOrder - b[1].sortOrder);
  }

  function productsInCategory(categoryId) {
    return Array.from(products().entries())
      .filter(([, p]) => p.categoryId === categoryId)
      .sort((a, b) => a[1].sortOrder - b[1].sortOrder);
  }

  function renderCategorySelect(selectEl, selectedId) {
    const previous = selectedId !== undefined ? selectedId : selectEl.value;
    selectEl.innerHTML = '';
    sortedCategories().forEach(([id, c]) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = c.name;
      selectEl.appendChild(opt);
    });
    if (previous) selectEl.value = previous;
  }

  // --- Grilla de categorías (idéntica a pedido-cliente.js + un ✏️ y una
  // tarjeta "+ Nueva categoría" al final) ---

  function renderCategoryGrid() {
    categoryGridEl.innerHTML = '';
    sortedCategories().forEach(([id, c]) => {
      const card = document.createElement('div');
      card.className = 'category-card';
      card.setAttribute('role', 'button');
      card.tabIndex = 0;

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
      if (c.visible === false) {
        const badge = document.createElement('span');
        badge.className = 'hidden-badge';
        badge.textContent = 'Oculta';
        card.appendChild(badge);
      }
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'category-card-edit-btn';
      editBtn.textContent = '✏️';
      editBtn.setAttribute('aria-label', `Editar ${c.name}`);
      editBtn.addEventListener('click', (e) => { e.stopPropagation(); openCategoryEditModal(id, c); });
      card.appendChild(editBtn);

      const open = () => showProductsView(id);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });

      categoryGridEl.appendChild(card);
    });

    const addTile = document.createElement('div');
    addTile.className = 'category-card add-tile';
    addTile.setAttribute('role', 'button');
    addTile.tabIndex = 0;
    addTile.innerHTML = '<span class="add-tile-icon">+</span><span>Nueva categoría</span>';
    addTile.addEventListener('click', openCategoryCreateModal);
    addTile.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCategoryCreateModal(); }
    });
    categoryGridEl.appendChild(addTile);
  }

  // --- Grilla de productos de una categoría (idéntica a pedido-cliente.js,
  // sin el contador +/- que ahí es del carrito, con un ✏️ y una tarjeta
  // "+ Agregar producto" al final) ---

  function buildAdminProductCard(id, p) {
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

    if (p.visible === false) {
      const badge = document.createElement('span');
      badge.className = 'hidden-badge';
      badge.textContent = 'Oculto';
      card.appendChild(badge);
    }

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'product-card-edit-btn';
    editBtn.textContent = '✏️';
    editBtn.setAttribute('aria-label', `Editar ${p.name}`);
    editBtn.addEventListener('click', () => openProductEditModal(id, p));
    card.appendChild(editBtn);

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

    return card;
  }

  function renderProductGrid() {
    const c = categories().get(activeCategoryId);
    productsViewTitleEl.textContent = c ? c.name : '';
    productsGridEl.innerHTML = '';
    productsInCategory(activeCategoryId).forEach(([id, p]) => productsGridEl.appendChild(buildAdminProductCard(id, p)));

    const addTile = document.createElement('div');
    addTile.className = 'product-card add-tile';
    addTile.setAttribute('role', 'button');
    addTile.tabIndex = 0;
    addTile.innerHTML = '<span class="add-tile-icon">+</span><span>Agregar producto</span>';
    addTile.addEventListener('click', openProductAddModal);
    addTile.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProductAddModal(); }
    });
    productsGridEl.appendChild(addTile);
  }

  function render() {
    if (view === 'products') {
      categoriesViewEl.hidden = true;
      productsViewEl.hidden = false;
      renderProductGrid();
    } else {
      productsViewEl.hidden = true;
      categoriesViewEl.hidden = false;
      renderCategoryGrid();
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

  // --- Carga masiva vía Excel: "Descargar Excel" es un <a href> directo al
  // endpoint (GET /api/catalog/template.xlsx, la sesión de admin ya viaja
  // por la cookie); "Cargar Excel" abre el selector de archivo nativo y
  // sube lo elegido a POST /api/catalog/import por fetch. ---

  importCatalogBtn.addEventListener('click', () => importCatalogInputEl.click());

  importCatalogInputEl.addEventListener('change', async () => {
    const file = importCatalogInputEl.files[0];
    if (!file) return;
    importCatalogBtn.disabled = true;
    importStatusEl.textContent = 'Cargando...';
    importStatusEl.className = 'status';
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/catalog/import', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo cargar el archivo.');
      const parts = [];
      if (data.categoriesCreated) parts.push(`${data.categoriesCreated} categoría${data.categoriesCreated === 1 ? '' : 's'} nueva${data.categoriesCreated === 1 ? '' : 's'}`);
      if (data.productsCreated) parts.push(`${data.productsCreated} producto${data.productsCreated === 1 ? '' : 's'} nuevo${data.productsCreated === 1 ? '' : 's'}`);
      if (data.productsUpdated) parts.push(`${data.productsUpdated} producto${data.productsUpdated === 1 ? '' : 's'} actualizado${data.productsUpdated === 1 ? '' : 's'}`);
      let msg = parts.length > 0 ? `Listo: ${parts.join(', ')}.` : 'El archivo no tenía filas para cargar.';
      if (data.errors && data.errors.length > 0) msg += ` ${data.errors.length} fila${data.errors.length === 1 ? '' : 's'} con problemas: ${data.errors.join(' ')}`;
      importStatusEl.textContent = msg;
      importStatusEl.className = data.errors && data.errors.length > 0 ? 'status error' : 'status ok';
    } catch (e) {
      importStatusEl.textContent = e.message;
      importStatusEl.className = 'status error';
    }
    importCatalogBtn.disabled = false;
    importCatalogInputEl.value = '';
  });

  // --- Modal de categoría: crear (sin foto/borrar) o editar (con foto/borrar) ---

  function openCategoryCreateModal() {
    editingCategoryId = null;
    categoryEditTitleEl.textContent = 'Nueva categoría';
    categoryEditPhotoFieldEl.hidden = true;
    categoryEditVisibleFieldEl.hidden = true;
    categoryEditDeleteBtn.hidden = true;
    categoryEditNameEl.value = '';
    categoryEditStatusEl.textContent = '';
    categoryEditStatusEl.className = 'status';
    categoryEditOverlay.style.display = 'flex';
    categoryEditNameEl.focus();
  }

  function openCategoryEditModal(id, c) {
    editingCategoryId = id;
    categoryEditTitleEl.textContent = 'Editar categoría';
    categoryEditPhotoFieldEl.hidden = false;
    categoryEditVisibleFieldEl.hidden = false;
    categoryEditDeleteBtn.hidden = false;
    const hasProducts = categoryHasProducts(id);
    categoryEditDeleteBtn.disabled = hasProducts;
    categoryEditDeleteBtn.title = hasProducts ? 'Primero mové o borrá los productos de esta categoría.' : '';
    categoryEditNameEl.value = c.name || '';
    categoryEditVisibleEl.checked = c.visible !== false;
    categoryEditImageEl.value = '';
    categoryEditImageStatusEl.textContent = '';
    if (c.imageUrl) {
      categoryEditPreviewEl.src = c.imageUrl;
      categoryEditPreviewEl.style.display = '';
    } else {
      categoryEditPreviewEl.style.display = 'none';
    }
    categoryEditStatusEl.textContent = '';
    categoryEditStatusEl.className = 'status';
    categoryEditOverlay.style.display = 'flex';
  }

  categoryEditCloseBtn.addEventListener('click', () => { categoryEditOverlay.style.display = 'none'; });
  categoryEditOverlay.addEventListener('click', (e) => { if (e.target === categoryEditOverlay) categoryEditOverlay.style.display = 'none'; });

  categoryEditImageEl.addEventListener('change', async () => {
    const file = categoryEditImageEl.files[0];
    if (!file || !editingCategoryId) return;
    categoryEditImageStatusEl.textContent = 'Subiendo...';
    const formData = new FormData();
    formData.append('image', file);
    try {
      const res = await fetch(`/api/categories/${editingCategoryId}/image`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo subir la foto.');
      categoryEditPreviewEl.src = data.imageUrl;
      categoryEditPreviewEl.style.display = '';
      categoryEditImageStatusEl.textContent = 'Foto actualizada.';
    } catch (e) {
      categoryEditImageStatusEl.textContent = e.message;
    }
  });

  categoryEditSaveBtn.addEventListener('click', () => {
    const name = categoryEditNameEl.value.trim();
    if (!name) {
      categoryEditStatusEl.textContent = 'Ingresá un nombre.';
      categoryEditStatusEl.className = 'status error';
      return;
    }
    if (editingCategoryId) {
      socket.emit('category:edit', { id: editingCategoryId, fields: { name, visible: categoryEditVisibleEl.checked } });
    } else {
      socket.emit('category:add', { name });
    }
    categoryEditOverlay.style.display = 'none';
  });

  categoryEditDeleteBtn.addEventListener('click', () => {
    if (!editingCategoryId || categoryEditDeleteBtn.disabled) return;
    socket.emit('category:remove', { id: editingCategoryId });
    categoryEditOverlay.style.display = 'none';
  });

  // --- Popup de reordenar categorías: lista arrastrable con puntero (mouse
  // + touch unificados), sin ningún número que tipear. Cada drop persiste
  // solo (category:edit con el sortOrder nuevo), no hay botón "Guardar". ---

  function openCategoryOrderModal() {
    categoryOrderListEl.innerHTML = '';
    sortedCategories().forEach(([id, c]) => {
      const li = document.createElement('li');
      li.className = 'reorder-item';
      li.dataset.id = id;
      const handle = document.createElement('span');
      handle.className = 'reorder-handle';
      handle.textContent = '⠿';
      const name = document.createElement('span');
      name.className = 'reorder-item-name';
      name.textContent = c.name + (c.visible === false ? ' (oculta)' : '');
      li.append(handle, name);
      categoryOrderListEl.appendChild(li);
    });
    categoryOrderOverlay.style.display = 'flex';
  }

  reorderCategoriesBtn.addEventListener('click', openCategoryOrderModal);
  categoryOrderCloseBtn.addEventListener('click', () => { categoryOrderOverlay.style.display = 'none'; });
  categoryOrderOverlay.addEventListener('click', (e) => { if (e.target === categoryOrderOverlay) categoryOrderOverlay.style.display = 'none'; });

  function persistCategoryOrder(orderedIds) {
    orderedIds.forEach((id, index) => {
      const c = categories().get(id);
      if (c && c.sortOrder !== index) {
        socket.emit('category:edit', { id, fields: { sortOrder: index } });
      }
    });
  }

  initReorderDrag(categoryOrderListEl, persistCategoryOrder);

  // --- Modal "Nuevo producto" (dentro de la categoría que se está viendo) ---

  function openProductAddModal() {
    addProductNameEl.value = '';
    addProductDescriptionEl.value = '';
    addProductPriceEl.value = '';
    addProductStatusEl.textContent = '';
    addProductStatusEl.className = 'status';
    productAddOverlay.style.display = 'flex';
    addProductNameEl.focus();
  }

  productAddCloseBtn.addEventListener('click', () => { productAddOverlay.style.display = 'none'; });
  productAddOverlay.addEventListener('click', (e) => { if (e.target === productAddOverlay) productAddOverlay.style.display = 'none'; });

  addProductBtn.addEventListener('click', () => {
    const name = addProductNameEl.value.trim();
    if (!activeCategoryId || !name) {
      addProductStatusEl.textContent = 'Ingresá un nombre.';
      addProductStatusEl.className = 'status error';
      return;
    }
    socket.emit('product:add', {
      categoryId: activeCategoryId,
      name,
      description: addProductDescriptionEl.value.trim(),
      price: Geo.parseAmount(addProductPriceEl.value) || 0,
    });
    productAddOverlay.style.display = 'none';
  });

  // --- Modal "Editar producto" (sin cambios de fondo respecto de antes) ---

  function openProductEditModal(id, p) {
    editingProductId = id;
    renderCategorySelect(editProductCategoryEl, p.categoryId);
    editProductNameEl.value = p.name || '';
    editProductDescriptionEl.value = p.description || '';
    editProductPriceEl.value = Number(p.price || 0).toFixed(2);
    editProductVisibleEl.checked = p.visible !== false;
    editProductImageEl.value = '';
    editProductImageStatusEl.textContent = '';
    if (p.imageUrl) {
      editProductPreviewEl.src = p.imageUrl;
      editProductPreviewEl.style.display = '';
    } else {
      editProductPreviewEl.style.display = 'none';
    }
    editProductStatusEl.textContent = '';
    editProductStatusEl.className = 'status';
    productEditOverlay.style.display = 'flex';
  }

  productEditCloseBtn.addEventListener('click', () => { productEditOverlay.style.display = 'none'; });
  productEditOverlay.addEventListener('click', (e) => { if (e.target === productEditOverlay) productEditOverlay.style.display = 'none'; });

  editProductImageEl.addEventListener('change', async () => {
    const file = editProductImageEl.files[0];
    if (!file || !editingProductId) return;
    editProductImageStatusEl.textContent = 'Subiendo...';
    const formData = new FormData();
    formData.append('image', file);
    try {
      const res = await fetch(`/api/products/${editingProductId}/image`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo subir la foto.');
      editProductPreviewEl.src = data.imageUrl;
      editProductPreviewEl.style.display = '';
      editProductImageStatusEl.textContent = 'Foto actualizada.';
    } catch (e) {
      editProductImageStatusEl.textContent = e.message;
    }
  });

  editProductSaveBtn.addEventListener('click', () => {
    if (!editingProductId) return;
    socket.emit('product:edit', {
      id: editingProductId,
      fields: {
        categoryId: editProductCategoryEl.value,
        name: editProductNameEl.value.trim(),
        description: editProductDescriptionEl.value.trim(),
        price: Geo.parseAmount(editProductPriceEl.value) || 0,
        visible: editProductVisibleEl.checked,
      },
    });
    productEditOverlay.style.display = 'none';
  });

  editProductDeleteBtn.addEventListener('click', () => {
    if (!editingProductId) return;
    socket.emit('product:remove', { id: editingProductId });
    productEditOverlay.style.display = 'none';
  });

  const onCatalogSnapshot = () => {
    // Si estabas viendo una categoría que se vació/borró desde otra pestaña
    // mientras tenías esta abierta, no te deja mirando una grilla rota.
    if (view === 'products' && !categories().has(activeCategoryId)) {
      showCategoriesView();
    } else {
      render();
    }
  };
  Store.on('catalog:snapshot', onCatalogSnapshot);
  unsubscribe = () => Store.off('catalog:snapshot', onCatalogSnapshot);

  render();
}

// Lista arrastrable genérica (mouse + touch, vía Pointer Events) — se
// engancha una sola vez sobre el <ul> contenedor (delegación por
// e.target.closest), aunque su contenido se rebuild cada vez que se abre el
// popup. Al soltar, `onDrop` recibe el array de ids en el orden final.
function initReorderDrag(listEl, onDrop) {
  let dragEl = null;
  let startClientY = 0;

  function siblings() {
    return Array.from(listEl.children);
  }

  function onPointerMove(e) {
    if (!dragEl) return;
    e.preventDefault();
    const deltaY = e.clientY - startClientY;
    dragEl.style.transform = `translateY(${deltaY}px)`;

    const dragRect = dragEl.getBoundingClientRect();
    const dragCenter = dragRect.top + dragRect.height / 2;

    for (const sib of siblings()) {
      if (sib === dragEl) continue;
      const rect = sib.getBoundingClientRect();
      const sibCenter = rect.top + rect.height / 2;
      const dragIsBeforeSib = !!(dragEl.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (dragIsBeforeSib && dragCenter > sibCenter) {
        listEl.insertBefore(dragEl, sib.nextSibling);
        startClientY = e.clientY;
        dragEl.style.transform = 'translateY(0px)';
        break;
      } else if (!dragIsBeforeSib && dragCenter < sibCenter) {
        listEl.insertBefore(dragEl, sib);
        startClientY = e.clientY;
        dragEl.style.transform = 'translateY(0px)';
        break;
      }
    }
  }

  function onPointerUp(e) {
    if (!dragEl) return;
    dragEl.classList.remove('dragging');
    dragEl.style.transform = '';
    try { dragEl.releasePointerCapture(e.pointerId); } catch { /* algunos navegadores viejos no soportan pointer capture */ }
    const finishedList = siblings().map((el) => el.dataset.id);
    dragEl = null;
    listEl.removeEventListener('pointermove', onPointerMove);
    listEl.removeEventListener('pointerup', onPointerUp);
    listEl.removeEventListener('pointercancel', onPointerUp);
    onDrop(finishedList);
  }

  listEl.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.reorder-handle');
    if (!handle) return;
    const item = handle.closest('.reorder-item');
    if (!item) return;
    e.preventDefault();
    dragEl = item;
    startClientY = e.clientY;
    dragEl.classList.add('dragging');
    dragEl.style.transform = 'translateY(0px)';
    try { dragEl.setPointerCapture(e.pointerId); } catch { /* idem */ }
    listEl.addEventListener('pointermove', onPointerMove);
    listEl.addEventListener('pointerup', onPointerUp);
    listEl.addEventListener('pointercancel', onPointerUp);
  });
}

function unmount() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

Router.register('/catalogo.html', {
  title: 'Catálogo — Deliverys en vivo',
  subtitle: 'Así lo ve el cliente -- tocá una categoría para administrar sus productos.',
  wide: true,
  template,
  mount,
  unmount,
});
