// Botón "⚙ Configuración" compartido por las 7 vistas de admin — en vez de
// duplicar el modal en cada una, este script se auto-monta: arma el botón,
// lo mete en el <nav class="tabs"> del shell, e inyecta el modal entero en
// <body>. Reusa el socket único de Store (antes abría su propia conexión
// independiente — con la SPA eso significaba dos sockets por sesión, uno del
// shell/Store y otro acá; ya no hace falta, es un <script type="module">
// como el resto de la infraestructura de la SPA, así que no necesita el IIFE
// manual que usaba antes para no chocar con los `const socket` de cada
// página clásica (ese problema ya no existe: los módulos tienen su propio
// scope real).
import { Store } from '/js/store.js';

const socket = Store.socket;

let formConfig = Store.getFormConfig();

const settingsBtn = document.createElement('button');
settingsBtn.id = 'settings-btn';
settingsBtn.className = 'tab-btn';
settingsBtn.type = 'button';
settingsBtn.textContent = '⚙ Configuración';
const tabsEl = document.querySelector('.tabs');
const themeToggleEl = document.getElementById('theme-toggle-btn');
if (tabsEl) {
  if (themeToggleEl && themeToggleEl.parentElement === tabsEl) {
    tabsEl.insertBefore(settingsBtn, themeToggleEl);
  } else {
    tabsEl.appendChild(settingsBtn);
  }
}

const settingsOverlay = document.createElement('div');
settingsOverlay.id = 'settings-overlay';
settingsOverlay.className = 'modal-overlay';
settingsOverlay.style.display = 'none';
settingsOverlay.innerHTML = `
  <div class="modal-box">
    <button id="settings-close-btn" class="modal-close" type="button" aria-label="Cerrar">&times;</button>

    <div class="settings-tabs" role="tablist" aria-label="Secciones de configuración">
      <button type="button" class="active" data-settings-tab="pedidos">Pedidos</button>
      <button type="button" data-settings-tab="delivery">Delivery</button>
      <button type="button" data-settings-tab="cuenta">Cuenta</button>
    </div>

    <div data-settings-panel="pedidos">
      <section>
        <h2>Reglas fijas</h2>
        <p class="hint">Todo pedido tiene que indicar si se retira o se envía — esto no se puede desactivar. El pedido online (para clientes) siempre pide el celular, sin excepción, porque no hay otra forma de contactar a un cliente anónimo.</p>
      </section>

      <section>
        <h2>Personalizar campos del formulario</h2>
        <p class="hint">Elegí qué mostrar y qué es obligatorio al cargar un pedido a mano o de a muchos (carga masiva). El "Ticket" que distingue cada pedido es siempre automático, no depende de estos campos.</p>
        <div id="builtin-field-config-list"></div>
      </section>

      <section>
        <h2>Campos personalizados</h2>
        <p class="hint">Campos extra que se piden al cargar un pedido (además de teléfono, tipo de envío, nombre, Nº de pedido y monto).</p>
        <div id="field-config-list"></div>
      </section>
    </div>

    <div data-settings-panel="delivery" hidden>
      <section>
        <h2>Métodos de pago</h2>
        <p class="hint">Marcá "Es efectivo físico" en los que salen/entran de la caja en billetes — afecta el cálculo de "Total a entregar" y el cierre de día. Son los mismos botones que usa el delivery al marcar un pedido entregado.</p>
        <div id="payment-method-list"></div>
        <div style="display:flex; gap:8px; margin-top:10px;">
          <input type="text" id="new-payment-method-name" placeholder="Nombre del método (ej: Mercado Pago)" style="flex:1;">
          <label style="display:flex; align-items:center; gap:4px; font-size:0.85rem; white-space:nowrap;">
            <input type="checkbox" id="new-payment-method-cash" style="width:auto;"> Es efectivo físico
          </label>
          <button id="add-payment-method-btn" type="button" class="primary small">Agregar</button>
        </div>
      </section>
    </div>

    <div data-settings-panel="cuenta" hidden>
      <section>
        <h2>Cuenta</h2>
        <div class="field">
          <label for="pw-current">Contraseña actual</label>
          <input type="password" id="pw-current" autocomplete="current-password">
        </div>
        <div class="field">
          <label for="pw-new">Contraseña nueva (mínimo 8 caracteres)</label>
          <input type="password" id="pw-new" autocomplete="new-password">
        </div>
        <button id="pw-btn" type="button" class="primary">Cambiar contraseña</button>
        <p id="pw-status" class="status"></p>
      </section>
    </div>
  </div>
`;
document.body.appendChild(settingsOverlay);

const settingsCloseBtn = document.getElementById('settings-close-btn');
const builtinFieldConfigListEl = document.getElementById('builtin-field-config-list');
const paymentMethodListEl = document.getElementById('payment-method-list');
const newPaymentMethodNameEl = document.getElementById('new-payment-method-name');
const newPaymentMethodCashEl = document.getElementById('new-payment-method-cash');
const addPaymentMethodBtn = document.getElementById('add-payment-method-btn');
const fieldConfigListEl = document.getElementById('field-config-list');
const pwCurrentEl = document.getElementById('pw-current');
const pwNewEl = document.getElementById('pw-new');
const pwBtnEl = document.getElementById('pw-btn');
const pwStatusEl = document.getElementById('pw-status');

settingsBtn.addEventListener('click', () => { settingsOverlay.style.display = 'flex'; });
settingsCloseBtn.addEventListener('click', () => { settingsOverlay.style.display = 'none'; });

settingsOverlay.querySelectorAll('.settings-tabs button').forEach((tabBtn) => {
  tabBtn.addEventListener('click', () => {
    settingsOverlay.querySelectorAll('.settings-tabs button').forEach((b) => b.classList.toggle('active', b === tabBtn));
    settingsOverlay.querySelectorAll('[data-settings-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.settingsPanel !== tabBtn.dataset.settingsTab;
    });
  });
});
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) settingsOverlay.style.display = 'none'; });

function paymentMethods() {
  return formConfig.paymentMethods || [];
}

function customFields() {
  return formConfig.customFields || [];
}

function renderPaymentMethods() {
  paymentMethodListEl.innerHTML = '';
  paymentMethods().forEach((m) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '10px';
    row.style.padding = '6px 0';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = m.name;
    nameInput.style.flex = '1';
    nameInput.addEventListener('change', () => {
      formConfig = { ...formConfig, paymentMethods: paymentMethods().map((x) => (x.id === m.id ? { ...x, name: nameInput.value.trim() } : x)) };
      socket.emit('form-config:update', formConfig);
    });

    const cashLabel = document.createElement('label');
    cashLabel.style.display = 'flex';
    cashLabel.style.alignItems = 'center';
    cashLabel.style.gap = '4px';
    cashLabel.style.fontSize = '0.85rem';
    cashLabel.style.whiteSpace = 'nowrap';
    const cashCheck = document.createElement('input');
    cashCheck.type = 'checkbox';
    cashCheck.style.width = 'auto';
    cashCheck.checked = !!m.isCash;
    cashCheck.addEventListener('change', () => {
      formConfig = { ...formConfig, paymentMethods: paymentMethods().map((x) => (x.id === m.id ? { ...x, isCash: cashCheck.checked } : x)) };
      socket.emit('form-config:update', formConfig);
    });
    cashLabel.append(cashCheck, 'Es efectivo físico');

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger small';
    delBtn.textContent = 'Eliminar';
    delBtn.addEventListener('click', () => {
      formConfig = { ...formConfig, paymentMethods: paymentMethods().filter((x) => x.id !== m.id) };
      socket.emit('form-config:update', formConfig);
    });

    row.append(nameInput, cashLabel, delBtn);
    paymentMethodListEl.appendChild(row);
  });
}

addPaymentMethodBtn.addEventListener('click', () => {
  const name = newPaymentMethodNameEl.value.trim();
  if (!name) return;
  const id = `pm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  formConfig = { ...formConfig, paymentMethods: [...paymentMethods(), { id, name, isCash: newPaymentMethodCashEl.checked }] };
  socket.emit('form-config:update', formConfig);
  newPaymentMethodNameEl.value = '';
  newPaymentMethodCashEl.checked = false;
});

const BUILTIN_FIELD_LABELS = {
  phone: 'Celular',
  name: 'Nombre',
  orderNumber: 'Nº de pedido',
  amount: 'Monto',
};

function renderBuiltinFieldConfig() {
  builtinFieldConfigListEl.innerHTML = '';

  Object.keys(BUILTIN_FIELD_LABELS).forEach((key) => {
    const cfg = formConfig[key] || { visible: true, required: false };
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '16px';
    row.style.padding = '6px 0';

    const label = document.createElement('span');
    label.style.flex = '1';
    label.textContent = BUILTIN_FIELD_LABELS[key];

    const visibleLabel = document.createElement('label');
    visibleLabel.style.display = 'flex';
    visibleLabel.style.alignItems = 'center';
    visibleLabel.style.gap = '4px';
    visibleLabel.style.fontSize = '0.85rem';
    const visibleCheck = document.createElement('input');
    visibleCheck.type = 'checkbox';
    visibleCheck.checked = cfg.visible !== false;
    visibleLabel.append(visibleCheck, 'Mostrar');

    const requiredLabel = document.createElement('label');
    requiredLabel.style.display = 'flex';
    requiredLabel.style.alignItems = 'center';
    requiredLabel.style.gap = '4px';
    requiredLabel.style.fontSize = '0.85rem';
    const requiredCheck = document.createElement('input');
    requiredCheck.type = 'checkbox';
    requiredCheck.checked = !!cfg.required;
    requiredCheck.disabled = !visibleCheck.checked;
    requiredLabel.append(requiredCheck, 'Obligatorio');

    function emitUpdate() {
      requiredCheck.disabled = !visibleCheck.checked;
      formConfig = { ...formConfig, [key]: { visible: visibleCheck.checked, required: visibleCheck.checked && requiredCheck.checked } };
      socket.emit('form-config:update', formConfig);
    }
    visibleCheck.addEventListener('change', emitUpdate);
    requiredCheck.addEventListener('change', emitUpdate);

    row.append(label, visibleLabel, requiredLabel);
    builtinFieldConfigListEl.appendChild(row);
  });
}

function renderFieldConfig() {
  fieldConfigListEl.innerHTML = '';

  customFields().forEach((f) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '16px';
    row.style.padding = '6px 0';

    const label = document.createElement('span');
    label.style.flex = '1';
    label.textContent = f.label;

    const visibleLabel = document.createElement('label');
    visibleLabel.style.display = 'flex';
    visibleLabel.style.alignItems = 'center';
    visibleLabel.style.gap = '4px';
    visibleLabel.style.fontSize = '0.85rem';
    const visibleCheck = document.createElement('input');
    visibleCheck.type = 'checkbox';
    visibleCheck.checked = f.visible !== false;
    visibleLabel.append(visibleCheck, 'Mostrar');

    const requiredLabel = document.createElement('label');
    requiredLabel.style.display = 'flex';
    requiredLabel.style.alignItems = 'center';
    requiredLabel.style.gap = '4px';
    requiredLabel.style.fontSize = '0.85rem';
    const requiredCheck = document.createElement('input');
    requiredCheck.type = 'checkbox';
    requiredCheck.checked = !!f.required;
    requiredCheck.disabled = !visibleCheck.checked;
    requiredLabel.append(requiredCheck, 'Obligatorio');

    const driverLabel = document.createElement('label');
    driverLabel.style.display = 'flex';
    driverLabel.style.alignItems = 'center';
    driverLabel.style.gap = '4px';
    driverLabel.style.fontSize = '0.85rem';
    const driverCheck = document.createElement('input');
    driverCheck.type = 'checkbox';
    driverCheck.checked = f.showToDriver !== false;
    driverLabel.append(driverCheck, 'Mostrar al delivery');

    function emitUpdate() {
      requiredCheck.disabled = !visibleCheck.checked;
      formConfig = {
        ...formConfig,
        customFields: customFields().map((x) => (x.key === f.key
          ? { ...x, visible: visibleCheck.checked, required: visibleCheck.checked && requiredCheck.checked, showToDriver: driverCheck.checked }
          : x)),
      };
      socket.emit('form-config:update', formConfig);
    }
    visibleCheck.addEventListener('change', emitUpdate);
    requiredCheck.addEventListener('change', emitUpdate);
    driverCheck.addEventListener('change', emitUpdate);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger small';
    delBtn.textContent = 'Eliminar';
    delBtn.addEventListener('click', () => {
      formConfig = { ...formConfig, customFields: customFields().filter((x) => x.key !== f.key) };
      socket.emit('form-config:update', formConfig);
    });

    row.append(label, visibleLabel, requiredLabel, driverLabel, delBtn);
    fieldConfigListEl.appendChild(row);
  });

  const addRow = document.createElement('div');
  addRow.style.display = 'flex';
  addRow.style.gap = '8px';
  addRow.style.marginTop = '10px';
  const newFieldInput = document.createElement('input');
  newFieldInput.type = 'text';
  newFieldInput.placeholder = 'Nombre del campo nuevo (ej: Piso)';
  newFieldInput.style.flex = '1';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'primary small';
  addBtn.textContent = 'Agregar campo';
  addBtn.addEventListener('click', () => {
    const label = newFieldInput.value.trim();
    if (!label) return;
    const key = `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    formConfig = { ...formConfig, customFields: [...customFields(), { key, label, visible: true, required: false, showToDriver: true }] };
    socket.emit('form-config:update', formConfig);
    newFieldInput.value = '';
  });
  addRow.append(newFieldInput, addBtn);
  fieldConfigListEl.appendChild(addRow);
}

Store.on('form-config:snapshot', (e) => {
  formConfig = e.detail || {};
  renderBuiltinFieldConfig();
  renderPaymentMethods();
  renderFieldConfig();
});

renderBuiltinFieldConfig();
renderPaymentMethods();
renderFieldConfig();

pwBtnEl.addEventListener('click', async () => {
  const currentPassword = pwCurrentEl.value;
  const newPassword = pwNewEl.value;
  pwBtnEl.disabled = true;
  pwStatusEl.textContent = '';
  try {
    const res = await fetch('/api/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo cambiar la contraseña.');
    pwStatusEl.textContent = 'Contraseña actualizada.';
    pwStatusEl.className = 'status ok';
    pwCurrentEl.value = '';
    pwNewEl.value = '';
  } catch (e) {
    pwStatusEl.textContent = e.message;
    pwStatusEl.className = 'status error';
  }
  pwBtnEl.disabled = false;
});
