const cashListEl = document.getElementById('cash-list');

const socket = io();

const drivers = new Map(); // driverId -> { name, ... }
const knownDriverNames = new Map();
const deliveredLogs = new Map(); // driverId -> [{orderNumber, amount, paymentMethod, deliveredAt}]
const cashInputs = new Map(); // driverId -> { cambio: number, gastos: number } — local only, not synced

function driverLabel(id) {
  const d = drivers.get(id);
  if (d) return d.name;
  return knownDriverNames.get(id) || 'delivery desconectado';
}

function isCash(paymentMethod) {
  const p = (paymentMethod || '').toLowerCase();
  return p === '' || p.includes('efectivo') || p === 'retira';
}

function renderCashList() {
  cashListEl.innerHTML = '';
  const driverIds = new Set([...deliveredLogs.keys(), ...drivers.keys()]);
  if (driverIds.size === 0) {
    cashListEl.innerHTML = '<p class="hint">Todavía no hay entregas registradas.</p>';
    return;
  }

  driverIds.forEach((driverId) => {
    const log = deliveredLogs.get(driverId) || [];
    const cashTotal = log.filter((e) => isCash(e.paymentMethod)).reduce((sum, e) => sum + (e.amount || 0), 0);
    const otherTotal = log.filter((e) => !isCash(e.paymentMethod)).reduce((sum, e) => sum + (e.amount || 0), 0);
    const state = cashInputs.get(driverId) || { cambio: 0, gastos: 0 };
    const debe = cashTotal + state.cambio - state.gastos;

    const box = document.createElement('div');
    box.className = 'field';
    box.style.borderBottom = '1px solid var(--border)';
    box.style.paddingBottom = '12px';
    box.style.marginBottom = '12px';

    const title = document.createElement('label');
    title.textContent = `${driverLabel(driverId)} — ${log.length} entregado${log.length === 1 ? '' : 's'}`;
    box.appendChild(title);

    const summary = document.createElement('p');
    summary.className = 'hint';
    summary.textContent = `Efectivo cobrado: $${cashTotal.toFixed(2)} — Otros medios: $${otherTotal.toFixed(2)}`;
    box.appendChild(summary);

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.alignItems = 'center';
    row.style.flexWrap = 'wrap';

    const cambioInput = document.createElement('input');
    cambioInput.type = 'text';
    cambioInput.placeholder = 'Cambio inicial';
    cambioInput.value = state.cambio || '';
    cambioInput.style.width = '140px';
    cambioInput.addEventListener('input', () => {
      state.cambio = Geo.parseAmount(cambioInput.value) || 0;
      cashInputs.set(driverId, state);
      renderCashList();
    });

    const gastosInput = document.createElement('input');
    gastosInput.type = 'text';
    gastosInput.placeholder = 'Gastos';
    gastosInput.value = state.gastos || '';
    gastosInput.style.width = '140px';
    gastosInput.addEventListener('input', () => {
      state.gastos = Geo.parseAmount(gastosInput.value) || 0;
      cashInputs.set(driverId, state);
      renderCashList();
    });

    const debeText = document.createElement('strong');
    debeText.textContent = `Debe entregar: $${debe.toFixed(2)}`;

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'danger small';
    clearBtn.textContent = 'Cerrar rendición';
    clearBtn.addEventListener('click', () => {
      socket.emit('driver:clear-log', { driverId });
      cashInputs.delete(driverId);
    });

    row.appendChild(cambioInput);
    row.appendChild(gastosInput);
    row.appendChild(debeText);
    row.appendChild(clearBtn);
    box.appendChild(row);

    cashListEl.appendChild(box);
  });
}

socket.on('drivers:snapshot', (list) => { list.forEach((d) => { drivers.set(d.id, d); knownDriverNames.set(d.id, d.name); }); renderCashList(); });
socket.on('driver:update', (d) => { drivers.set(d.id, d); knownDriverNames.set(d.id, d.name); renderCashList(); });
socket.on('driver:remove', ({ id }) => { drivers.delete(id); renderCashList(); });

socket.on('deliveredLogs:snapshot', (list) => {
  list.forEach(({ driverId, log }) => deliveredLogs.set(driverId, log));
  renderCashList();
});
socket.on('driver:delivered-log', ({ driverId, log }) => {
  deliveredLogs.set(driverId, log);
  renderCashList();
});
