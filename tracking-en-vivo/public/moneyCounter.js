// Alternativa a tipear el monto total a mano: un desglose de billetes y
// monedas (cantidad de cada uno) que suma sola. Las denominaciones son
// "personalizadas" — se guardan en localStorage (por navegador, no por
// servidor) y se pueden agregar/sacar; arranca con los billetes/monedas
// uruguayos más comunes.
const MoneyCounter = (() => {
  const KEY = 'tracking.moneyDenominations';
  const DEFAULT_DENOMINATIONS = [2000, 1000, 500, 200, 100, 50, 10, 5, 2, 1];

  function getDenominations() {
    try {
      const stored = JSON.parse(localStorage.getItem(KEY));
      if (Array.isArray(stored) && stored.length > 0) return stored.slice().sort((a, b) => b - a);
    } catch (e) { /* usar el default */ }
    return DEFAULT_DENOMINATIONS.slice();
  }

  function setDenominations(list) {
    localStorage.setItem(KEY, JSON.stringify(list));
  }

  // Engancha un botón "🧮 Contar" al lado de `input`. Al tocarlo se abre un
  // desglose debajo; cada cambio de cantidad recalcula el total y lo pisa en
  // `input.value` (disparando 'input' ahí, para que el resto del código —
  // que ya escucha ese evento — se entere sin saber nada de este contador).
  function attach(input) {
    const qty = {};

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'small';
    toggleBtn.textContent = '🧮 Contar billetes y monedas';
    toggleBtn.style.marginTop = '6px';
    input.insertAdjacentElement('afterend', toggleBtn);

    const panel = document.createElement('div');
    panel.style.display = 'none';
    panel.style.marginTop = '8px';
    panel.style.padding = '10px';
    panel.style.border = '1px solid var(--border)';
    panel.style.borderRadius = 'var(--radius-md)';
    toggleBtn.insertAdjacentElement('afterend', panel);

    function updateTotal() {
      let total = 0;
      getDenominations().forEach((value) => {
        const count = qty[value] || 0;
        total += count * value;
        const subEl = panel.querySelector(`[data-subtotal="${value}"]`);
        if (subEl) subEl.textContent = count ? `= $${(count * value).toFixed(2)}` : '';
      });
      const totalEl = panel.querySelector('[data-total]');
      if (totalEl) totalEl.textContent = `Total: $${total.toFixed(2)}`;
      input.value = total ? total.toFixed(2) : '';
      input.dispatchEvent(new Event('input'));
    }

    function render() {
      panel.innerHTML = '';
      getDenominations().forEach((value) => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '8px';
        row.style.marginBottom = '4px';

        const label = document.createElement('span');
        label.style.width = '64px';
        label.style.fontSize = '0.85rem';
        label.textContent = `$${value} ×`;

        const qtyInput = document.createElement('input');
        qtyInput.type = 'text';
        qtyInput.inputMode = 'numeric';
        qtyInput.placeholder = '0';
        qtyInput.style.width = '64px';
        qtyInput.value = qty[value] || '';
        qtyInput.addEventListener('input', () => {
          qty[value] = parseInt(qtyInput.value, 10) || 0;
          updateTotal();
        });

        const subtotal = document.createElement('span');
        subtotal.className = 'hint';
        subtotal.style.flex = '1';
        subtotal.dataset.subtotal = value;

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'danger small';
        delBtn.textContent = '×';
        delBtn.title = 'Sacar esta denominación de la lista';
        delBtn.addEventListener('click', () => {
          setDenominations(getDenominations().filter((v) => v !== value));
          delete qty[value];
          render();
          updateTotal();
        });

        row.append(label, qtyInput, subtotal, delBtn);
        panel.appendChild(row);
      });

      const addRow = document.createElement('div');
      addRow.style.display = 'flex';
      addRow.style.gap = '6px';
      addRow.style.marginTop = '8px';
      const addInput = document.createElement('input');
      addInput.type = 'text';
      addInput.inputMode = 'numeric';
      addInput.placeholder = 'Nueva denominación (ej: 20)';
      addInput.style.width = '180px';
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'small';
      addBtn.textContent = 'Agregar';
      addBtn.addEventListener('click', () => {
        const value = parseInt(addInput.value, 10);
        if (!value || getDenominations().includes(value)) return;
        setDenominations([...getDenominations(), value]);
        addInput.value = '';
        render();
        updateTotal();
      });
      addRow.append(addInput, addBtn);
      panel.appendChild(addRow);

      const totalEl = document.createElement('p');
      totalEl.className = 'hint';
      totalEl.style.marginTop = '8px';
      totalEl.dataset.total = '';
      panel.appendChild(totalEl);

      updateTotal();
    }

    let expanded = false;
    toggleBtn.addEventListener('click', () => {
      expanded = !expanded;
      panel.style.display = expanded ? 'block' : 'none';
      toggleBtn.textContent = expanded ? '🧮 Ocultar contador' : '🧮 Contar billetes y monedas';
      if (expanded) render();
    });
  }

  return { attach, getDenominations, setDenominations };
})();
