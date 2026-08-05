const categoryListEl = document.getElementById('category-list');
const newCategoryNameEl = document.getElementById('new-category-name');
const addCategoryBtn = document.getElementById('add-category-btn');

const newProductCategoryEl = document.getElementById('new-product-category');
const newProductNameEl = document.getElementById('new-product-name');
const newProductDescriptionEl = document.getElementById('new-product-description');
const newProductPriceEl = document.getElementById('new-product-price');
const addProductBtn = document.getElementById('add-product-btn');
const addProductStatusEl = document.getElementById('add-product-status');

const productGroupsEl = document.getElementById('product-groups');

const productEditOverlay = document.getElementById('product-edit-overlay');
const productEditCloseBtn = document.getElementById('product-edit-close-btn');
const editProductPreviewEl = document.getElementById('edit-product-preview');
const editProductImageEl = document.getElementById('edit-product-image');
const editProductImageStatusEl = document.getElementById('edit-product-image-status');
const editProductCategoryEl = document.getElementById('edit-product-category');
const editProductNameEl = document.getElementById('edit-product-name');
const editProductDescriptionEl = document.getElementById('edit-product-description');
const editProductPriceEl = document.getElementById('edit-product-price');
const editProductVisibleEl = document.getElementById('edit-product-visible');
const editProductSaveBtn = document.getElementById('edit-product-save-btn');
const editProductStatusEl = document.getElementById('edit-product-status');

const socket = io();

const categories = new Map(); // id -> {name, sortOrder, visible}
const products = new Map(); // id -> {categoryId, name, description, price, imageUrl, sortOrder, visible}
let editingProductId = null;

function categoryHasProducts(categoryId) {
  return Array.from(products.values()).some((p) => p.categoryId === categoryId);
}

function sortedCategories() {
  return Array.from(categories.entries()).sort((a, b) => a[1].sortOrder - b[1].sortOrder);
}

function renderCategories() {
  categoryListEl.innerHTML = '';
  sortedCategories().forEach(([id, c]) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '10px';
    row.style.padding = '6px 0';

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

    row.append(nameInput, orderInput, visibleLabel, delBtn);
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
    const items = Array.from(products.entries())
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

socket.on('catalog:snapshot', ({ categories: catList, products: prodList }) => {
  categories.clear();
  (catList || []).forEach((c) => categories.set(c.id, c));
  products.clear();
  (prodList || []).forEach((p) => products.set(p.id, p));
  renderCategories();
  renderCategorySelect(newProductCategoryEl);
  renderProductGroups();
});
