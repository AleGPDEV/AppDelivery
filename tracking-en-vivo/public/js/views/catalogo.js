import { Store } from '/js/store.js';
import { Router } from '/js/router.js';
import { initReorderDrag } from '/js/reorder-drag.js';

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
  <div class="modal-box modal-box-media">
    <button id="category-edit-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
    <h2 id="category-edit-title">Editar categoría</h2>
    <div class="modal-image-hero modal-image-hero-8-5" id="category-edit-hero">
      <img id="category-edit-preview" src="" alt="" style="display:none;">
      <div class="modal-image-hero-overlay"></div>
      <label class="modal-image-hero-photo-btn" id="category-edit-photo-btn" title="Cambiar foto">
        📷
        <input type="file" id="category-edit-image" accept="image/*" style="display:none;">
      </label>
      <div class="modal-image-hero-fields">
        <input type="text" id="category-edit-name" class="modal-image-hero-input modal-image-hero-input-title" placeholder="Nombre de la categoría">
      </div>
    </div>
    <p id="category-edit-image-status" class="hint"></p>
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

<div id="image-crop-overlay" class="modal-overlay" style="display:none;">
  <div class="modal-box modal-box-media">
    <button id="image-crop-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
    <h2>Ajustar foto</h2>
    <div id="image-crop-viewport" class="image-crop-viewport">
      <img id="image-crop-img" alt="" draggable="false">
    </div>
    <div class="field">
      <label for="image-crop-zoom">Zoom</label>
      <input type="range" id="image-crop-zoom" min="0" max="100" value="0">
    </div>
    <p class="hint">Arrastrá la foto para moverla, usá el control para acercar o alejar.</p>
    <div style="display:flex; gap:10px; flex-wrap:wrap;">
      <button id="image-crop-confirm-btn" type="button" class="primary">Usar esta foto</button>
      <button id="image-crop-cancel-btn" type="button">Cancelar</button>
    </div>
    <p id="image-crop-status" class="status"></p>
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
  <div class="modal-box modal-box-media">
    <button id="product-edit-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>
    <h2>Editar producto</h2>
    <div class="modal-image-hero modal-image-hero-4-3" id="product-edit-hero">
      <img id="edit-product-preview" src="" alt="" style="display:none;">
      <div class="modal-image-hero-overlay"></div>
      <label class="modal-image-hero-photo-btn" title="Cambiar foto">
        📷
        <input type="file" id="edit-product-image" accept="image/*" style="display:none;">
      </label>
      <div class="modal-image-hero-fields">
        <input type="text" id="edit-product-name" class="modal-image-hero-input modal-image-hero-input-title" placeholder="Nombre del producto">
        <input type="text" id="edit-product-description" class="modal-image-hero-input modal-image-hero-input-desc" placeholder="Descripción">
      </div>
    </div>
    <p id="edit-product-image-status" class="hint"></p>
    <div class="field">
      <label for="edit-product-category">Categoría</label>
      <select id="edit-product-category"></select>
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
  const categoryEditPreviewEl = root.querySelector('#category-edit-preview');
  const categoryEditImageEl = root.querySelector('#category-edit-image');
  const categoryEditPhotoBtnEl = root.querySelector('#category-edit-photo-btn');
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

  const imageCropOverlay = root.querySelector('#image-crop-overlay');
  const imageCropCloseBtn = root.querySelector('#image-crop-close-btn');
  const imageCropViewportEl = root.querySelector('#image-crop-viewport');
  const imageCropImgEl = root.querySelector('#image-crop-img');
  const imageCropZoomEl = root.querySelector('#image-crop-zoom');
  const imageCropConfirmBtn = root.querySelector('#image-crop-confirm-btn');
  const imageCropCancelBtn = root.querySelector('#image-crop-cancel-btn');
  const imageCropStatusEl = root.querySelector('#image-crop-status');

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
    categoryEditPhotoBtnEl.hidden = true; // sin id todavía no se puede subir foto -- se agrega al volver a editar
    categoryEditPreviewEl.style.display = 'none';
    categoryEditImageStatusEl.textContent = '';
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
    categoryEditPhotoBtnEl.hidden = false;
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

  async function uploadCategoryImage(blob) {
    if (!editingCategoryId) return;
    categoryEditImageStatusEl.textContent = 'Subiendo...';
    const formData = new FormData();
    formData.append('image', blob, 'foto.jpg');
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
  }

  categoryEditImageEl.addEventListener('change', () => {
    const file = categoryEditImageEl.files[0];
    categoryEditImageEl.value = '';
    if (!file || !editingCategoryId) return;
    openImageCropper(file, 8 / 5, uploadCategoryImage);
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

  // --- Recortador de imagen compartido (categoría y producto): al elegir un
  // archivo se abre este popup en vez de subir directo -- se puede arrastrar
  // para reposicionar y hay un control de zoom, para elegir qué parte de la
  // foto queda dentro del recuadro fijo (la proporción real de la tarjeta)
  // antes de subirla. `onConfirm(blob)` recibe el resultado ya recortado,
  // como JPEG. Coordenadas en CSS px del viewport; `scale`/`x`/`y` describen
  // la transformación aplicada a la imagen original (tamaño natural). ---

  let cropState = null;
  let cropDrag = null;

  function updateCropTransform() {
    if (!cropState) return;
    imageCropImgEl.style.transform = `translate(-50%, -50%) translate(${cropState.x}px, ${cropState.y}px) scale(${cropState.scale})`;
  }

  function clampCropOffsets() {
    if (!cropState) return;
    const rect = imageCropViewportEl.getBoundingClientRect();
    const dispW = cropState.naturalW * cropState.scale;
    const dispH = cropState.naturalH * cropState.scale;
    const maxX = Math.max(0, (dispW - rect.width) / 2);
    const maxY = Math.max(0, (dispH - rect.height) / 2);
    cropState.x = Math.min(maxX, Math.max(-maxX, cropState.x));
    cropState.y = Math.min(maxY, Math.max(-maxY, cropState.y));
  }

  function closeImageCropper() {
    imageCropOverlay.style.display = 'none';
    if (cropState) URL.revokeObjectURL(cropState.objectUrl);
    cropState = null;
    imageCropImgEl.src = '';
  }

  function openImageCropper(file, aspectRatio, onConfirm) {
    const objectUrl = URL.createObjectURL(file);
    imageCropViewportEl.style.aspectRatio = String(aspectRatio);
    imageCropStatusEl.textContent = '';
    imageCropStatusEl.className = 'status';
    imageCropConfirmBtn.disabled = true;
    imageCropImgEl.src = objectUrl;
    imageCropOverlay.style.display = 'flex';

    imageCropImgEl.onload = () => {
      const rect = imageCropViewportEl.getBoundingClientRect();
      const naturalW = imageCropImgEl.naturalWidth;
      const naturalH = imageCropImgEl.naturalHeight;
      const minScale = Math.max(rect.width / naturalW, rect.height / naturalH);
      cropState = { onConfirm, naturalW, naturalH, scale: minScale, minScale, maxScale: minScale * 4, x: 0, y: 0, objectUrl };
      imageCropZoomEl.value = 0;
      updateCropTransform();
      imageCropConfirmBtn.disabled = false;
    };
  }

  imageCropCloseBtn.addEventListener('click', closeImageCropper);
  imageCropCancelBtn.addEventListener('click', closeImageCropper);
  imageCropOverlay.addEventListener('click', (e) => { if (e.target === imageCropOverlay) closeImageCropper(); });

  imageCropZoomEl.addEventListener('input', () => {
    if (!cropState) return;
    const t = Number(imageCropZoomEl.value) / 100;
    cropState.scale = cropState.minScale + t * (cropState.maxScale - cropState.minScale);
    clampCropOffsets();
    updateCropTransform();
  });

  imageCropViewportEl.addEventListener('pointerdown', (e) => {
    if (!cropState) return;
    cropDrag = { startX: e.clientX, startY: e.clientY, originX: cropState.x, originY: cropState.y };
    try { imageCropViewportEl.setPointerCapture(e.pointerId); } catch { /* algunos navegadores viejos no soportan pointer capture */ }
  });
  imageCropViewportEl.addEventListener('pointermove', (e) => {
    if (!cropDrag || !cropState) return;
    cropState.x = cropDrag.originX + (e.clientX - cropDrag.startX);
    cropState.y = cropDrag.originY + (e.clientY - cropDrag.startY);
    clampCropOffsets();
    updateCropTransform();
  });
  function endCropDrag(e) {
    if (!cropDrag) return;
    try { imageCropViewportEl.releasePointerCapture(e.pointerId); } catch { /* idem */ }
    cropDrag = null;
  }
  imageCropViewportEl.addEventListener('pointerup', endCropDrag);
  imageCropViewportEl.addEventListener('pointercancel', endCropDrag);

  imageCropConfirmBtn.addEventListener('click', () => {
    if (!cropState) return;
    const rect = imageCropViewportEl.getBoundingClientRect();
    const { naturalW, scale, x, y, onConfirm } = cropState;
    const dispW = naturalW * scale;
    const dispH = cropState.naturalH * scale;
    // Región visible del recuadro, en px de la imagen a tamaño original
    // (dividiendo por `scale` se pasa de "px mostrados" a "px de la foto").
    const srcX = ((dispW - rect.width) / 2 - x) / scale;
    const srcY = ((dispH - rect.height) / 2 - y) / scale;
    const srcW = rect.width / scale;
    const srcH = rect.height / scale;

    const outW = 960;
    const outH = Math.round(outW * (rect.height / rect.width));
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    canvas.getContext('2d').drawImage(imageCropImgEl, srcX, srcY, srcW, srcH, 0, 0, outW, outH);

    imageCropConfirmBtn.disabled = true;
    canvas.toBlob((blob) => {
      imageCropConfirmBtn.disabled = false;
      if (blob) onConfirm(blob);
      closeImageCropper();
    }, 'image/jpeg', 0.9);
  });

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

  async function uploadProductImage(blob) {
    if (!editingProductId) return;
    editProductImageStatusEl.textContent = 'Subiendo...';
    const formData = new FormData();
    formData.append('image', blob, 'foto.jpg');
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
  }

  editProductImageEl.addEventListener('change', () => {
    const file = editProductImageEl.files[0];
    editProductImageEl.value = '';
    if (!file || !editingProductId) return;
    openImageCropper(file, 4 / 3, uploadProductImage);
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

function unmount() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

Router.register('/catalogo.html', {
  title: 'Catálogo — Deliverys en vivo',
  wide: true,
  template,
  mount,
  unmount,
});
