// driverLabel() vivía duplicado byte a byte en pedidos.js y caja.js porque
// eran páginas separadas — ahora que ambas vistas comparten documento, un
// solo helper alcanza. Cada vista pide su propia instancia (createDriverLabel)
// porque cada una necesita su propio ciclo de vida de suscripción a Store
// (se desuscribe en unmount()), aunque el Map de nombres conocidos podría
// compartirse sin problema si hiciera falta.
import { Store } from '/js/store.js';

export function createDriverLabel() {
  const knownDriverNames = new Map();

  const onSnapshot = (e) => {
    (e.detail || []).forEach((d) => knownDriverNames.set(d.id, d.name));
  };
  const onUpdate = (e) => {
    knownDriverNames.set(e.detail.id, e.detail.name);
  };

  Store.on('drivers:snapshot', onSnapshot);
  Store.on('driver:update', onUpdate);
  Array.from(Store.getDrivers().values()).forEach((d) => knownDriverNames.set(d.id, d.name));

  function driverLabel(id) {
    const d = Store.getDrivers().get(id);
    if (d) return d.name;
    return knownDriverNames.get(id) || 'delivery desconectado';
  }

  function teardown() {
    Store.off('drivers:snapshot', onSnapshot);
    Store.off('driver:update', onUpdate);
  }

  return { driverLabel, teardown };
}
