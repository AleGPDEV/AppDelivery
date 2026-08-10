// Lista arrastrable genérica (mouse + touch, vía Pointer Events) — antes
// vivía solo en catalogo.js (popup "Ordenar categorías"), ahora también la
// usa pedidos.js para reordenar filas/separadores. Se engancha una sola vez
// sobre el contenedor (delegación por e.target.closest), aunque su contenido
// se reconstruya cada vez que se abre el popup o se re-renderiza la tabla.
// Al soltar, `onDrop` recibe el array de ids (`el.dataset.id`) en el orden
// final -- no le importa si `listEl` es un <ul>/<li> o un <tbody>/<tr>, solo
// opera sobre `listEl.children`.
export function initReorderDrag(listEl, onDrop) {
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
    const item = handle.closest('[data-id]');
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
