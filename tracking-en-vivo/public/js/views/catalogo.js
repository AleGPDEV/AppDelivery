import { Store } from '/js/store.js';
import { Router } from '/js/router.js';

const template = `
<main class="wide">
  <section class="panel">
    <h2>Categorías</h2>
    <p class="hint">El orden acá es el orden en que aparecen en el pedido online.</p>
    <div id="category-list"></div>
    <div class="field" style="display:flex; gap:8px; align-items:flex-end; margin-top:10px;">
      <div style="flex:1;">
        <label for="new-category-name">Nueva categoría</label>
        <input type="text" id="new-category-name" placeholder="Ej: Rolls">
      </div>
      <button id="add-category-btn" type="button" class="primary small">Agregar categoría</button>
    </div>
  </section>

  <section class="panel">
    <h2>Agregar producto</h2>
    <div class="field">
      <label for="new-product-category">Categoría</label>
      <select id="new-product-category"></select>
    </div>
    <div class="field">
      <label for="new-product-name">Nombre</label>
      <input type="text" id="new-product-name" placeholder="Ej: Roll California">
    </div>
    <div class="field">
      <label for="new-product-description">Descripción</label>
      <input type="text" id="new-product-description" placeholder="Ej: 8 piezas, palta y kanikama">
    </div>
    <div class="field">
      <label for="new-product-price">Precio</label>
      <input type="text" id="new-product-price" placeholder="$ 450,00">
    </div>
    <button id="add-product-btn" type="button" class="primary">Agregar producto</button>
    <p id="add-product-status" class="status"></p>
  </section>

  <section class="panel">
    <h2>Productos</h2>
    <div id="product-groups"></div>
  </section>
</main>

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
    <button id="edit-product-save-btn" type="button" class="primary">Guardar cambios</button>
    <p id="edit-product-status" class="status"></p>
  </div>
</div>
`;

let unsubscribe = null;

function mount(root) {
  const categoryListEl = root.querySelector('#category-list');
  const newCategoryNameEl = root.querySelector('#new-category-name');
  const addCategoryBtn = root.querySelector('#add-category-btn');

  const newProductCategoryEl = root.querySelector('#new-product-category');
  const newProductNameEl = root.querySelector('#new-product-name');
  const newProductDescriptionEl = root.querySelector('#new-product-description');
  const newProductPriceEl = root.querySelector('#new-product-price');
  const addProductBtn = root.querySelector('#add-product-btn');
  const addProductStatusEl = root.querySelector('#add-product-status');

  const productGroupsEl = root.querySelector('#product-groups');

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
  const editProductStatusEl = root.querySelector('#edit-product-status');

  const socket = Store.socket;
  let editingProductId = null;

  function categories() { return Store.getCategories(); }
  function products() { return Store.getProducts(); }

  function categoryHasProducts(categoryId) {
    return Array.from(products().values()).some((p) => p.categoryId === categoryId);
  }

  function sortedCategories() {
    return Array.from(categories().entries()).sort((a, b) => a[1].sortOrder - b[1].sortOrder);
  }

  function renderCategories() {
    categoryListEl.innerHTML = '';
    sortedCategories().forEach(([id, c]) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '10px';
      row.style.padding = '6px 0';

      const photoLabel = document.createElement('label');
      photoLabel.title = 'Foto de la categoría (se usa como fondo de la tarjeta en el pedido online)';
      photoLabel.style.flexShrink = '0';
      photoLabel.style.cursor = 'pointer';
      photoLabel.style.width = '40px';
      photoLabel.style.height = '40px';
      photoLabel.style.borderRadius = 'var(--radius-sm)';
      photoLabel.style.overflow = 'hidden';
      photoLabel.style.display = 'flex';
      photoLabel.style.alignItems = 'center';
      photoLabel.style.justifyContent = 'center';
      photoLabel.style.background = 'var(--bg)';
      photoLabel.style.border = '1px solid var(--border)';
      if (c.imageUrl) {
        const thumb = document.createElement('img');
        thumb.src = c.imageUrl;
        thumb.alt = '';
        thumb.style.width = '100%';
        thumb.style.height = '100%';
        thumb.style.objectFit = 'cover';
        photoLabel.appendChild(thumb);
      } else {
        photoLabel.textContent = '🖼️';
        photoLabel.style.fontSize = '1.1rem';
      }
      const photoInput = document.createElement('input');
      photoInput.type = 'file';
      photoInput.accept = 'image/*';
      photoInput.style.display = 'none';
      photoInput.addEventListener('change', async () => {
        const file = photoInput.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('image', file);
        try {
          const res = await fetch(`/api/categories/${id}/image`, { method: 'POST', body: formData });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'No se pudo subir la foto.');
        } catch (e) {
          alert(e.message);
        }
      });
      photoLabel.appendChild(photoInput);

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = c.name;
      nameInput.style.flex = '1';
      nameInput.addEventListener('change', () => {
        socket.emit('category:edit', { id, fields: { name: nameInput.value.trim() } });
      });

      const orderInput = document.createElement('input');
      orderInput.type = 'number';
      orderInput.value = c.sortOrder;
      orderInput.style.width = '70px';
      orderInput.addEventListener('change', () => {
        socket.emit('category:edit', { id, fields: { sortOrder: parseInt(orderInput.value, 10) || 0 } });
      });

      const visibleLabel = document.createElement('label');
      visibleLabel.style.display = 'flex';
      visibleLabel.style.alignItems = 'center';
      visibleLabel.style.gap = '4px';
      visibleLabel.style.fontSize = '0.85rem';
      visibleLabel.style.whiteSpace = 'nowrap';
      const visibleCheck = document.createElement('input');
      visibleCheck.type = 'checkbox';
      visibleCheck.style.width = 'auto';
      visibleCheck.checked = c.visible !== false;
      visibleCheck.addEventListener('change', () => {
        socket.emit('category:edit', { id, fields: { visible: visibleCheck.checked } });
      });
      visibleLabel.append(visibleCheck, 'Mostrar');

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'danger small';
      delBtn.textContent = '🗑';
      const hasProducts = categoryHasProducts(id);
      delBtn.disabled = hasProducts;
      delBtn.title = hasProducts ? 'Primero mové o borrá los productos de esta categoría.' : 'Eliminar categoría';
      delBtn.addEventListener('click', () => socket.emit('category:remove', { id }));

      row.append(photoLabel, nameInput, orderInput, visibleLabel, delBtn);
      categoryListEl.appendChild(row);
    });
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

  function renderProductGroups() {
    productGroupsEl.innerHTML = '';
    sortedCategories().forEach(([categoryId, c]) => {
      const items = Array.from(products().entries())
        .filter(([, p]) => p.categoryId === categoryId)
        .sort((a, b) => a[1].sortOrder - b[1].sortOrder);
      if (items.length === 0) return;

      const heading = document.createElement('h3');
      heading.textContent = c.name;
      productGroupsEl.appendChild(heading);

      const wrap = document.createElement('div');
      wrap.className = 'table-scroll';
      const table = document.createElement('table');
      table.className = 'order-table';
      const thead = document.createElement('thead');
      thead.innerHTML = '<tr><th>Foto</th><th>Nombre</th><th>Descripción</th><th>Precio</th><th>Visible</th><th></th></tr>';
      table.appendChild(thead);
      const tbody = document.createElement('tbody');

      items.forEach(([id, p]) => {
        const tr = document.createElement('tr');

        const tdImg = document.createElement('td');
        if (p.imageUrl) {
          const img = document.createElement('img');
          img.src = p.imageUrl;
          img.alt = p.name;
          img.style.width = '40px';
          img.style.height = '40px';
          img.style.objectFit = 'cover';
          img.style.borderRadius = '6px';
          tdImg.appendChild(img);
        } else {
          tdImg.textContent = '—';
        }

        const tdName = document.createElement('td');
        tdName.textContent = p.name;

        const tdDesc = document.createElement('td');
        tdDesc.textContent = p.description || '';

        const tdPrice = document.createElement('td');
        tdPrice.textContent = `$${Number(p.price || 0).toFixed(2)}`;

        const tdVisible = document.createElement('td');
        tdVisible.textContent = p.visible !== false ? 'Sí' : 'No';

        const tdActions = document.createElement('td');
        tdActions.style.display = 'flex';
        tdActions.style.gap = '4px';
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'small';
        editBtn.textContent = '✏️';
        editBtn.addEventListener('click', () => openProductEditModal(id, p));
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'danger small';
        delBtn.textContent = '🗑';
        delBtn.addEventListener('click', () => socket.emit('product:remove', { id }));
        tdActions.append(editBtn, delBtn);

        tr.append(tdImg, tdName, tdDesc, tdPrice, tdVisible, tdActions);
        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      wrap.appendChild(table);
      productGroupsEl.appendChild(wrap);
    });
  }

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

  addCategoryBtn.addEventListener('click', () => {
    const name = newCategoryNameEl.value.trim();
    if (!name) return;
    socket.emit('category:add', { name });
    newCategoryNameEl.value = '';
  });

  addProductBtn.addEventListener('click', () => {
    const categoryId = newProductCategoryEl.value;
    const name = newProductNameEl.value.trim();
    if (!categoryId || !name) {
      addProductStatusEl.textContent = 'Elegí una categoría y un nombre.';
      addProductStatusEl.className = 'status error';
      return;
    }
    socket.emit('product:add', {
      categoryId,
      name,
      description: newProductDescriptionEl.value.trim(),
      price: Geo.parseAmount(newProductPriceEl.value) || 0,
    });
    newProductNameEl.value = '';
    newProductDescriptionEl.value = '';
    newProductPriceEl.value = '';
    addProductStatusEl.textContent = 'Producto agregado. Podés subirle una foto tocando ✏️ en la lista de abajo.';
    addProductStatusEl.className = 'status ok';
  });

  const onCatalogSnapshot = () => {
    renderCategories();
    renderCategorySelect(newProductCategoryEl);
    renderProductGroups();
  };
  Store.on('catalog:snapshot', onCatalogSnapshot);
  unsubscribe = () => Store.off('catalog:snapshot', onCatalogSnapshot);

  renderCategories();
  renderCategorySelect(newProductCategoryEl);
  renderProductGroups();
}

function unmount() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

Router.register('/catalogo.html', {
  title: 'Catálogo — Deliverys en vivo',
  subtitle: 'Armá las categorías y productos que van a ver los clientes en el pedido online.',
  wide: true,
  template,
  mount,
  unmount,
});
