// recomputeRouteForDriver() vivía duplicado byte a byte en nuevo-pedido.js y
// pedidos.js porque eran páginas separadas ("kept independent since these
// are separate pages", decía el comentario viejo) — ahora que ambas vistas
// comparten documento, un solo helper alcanza. Recalcula y difunde la ruta
// óptima de todo lo que tiene asignado un delivery ahora mismo, arrancando
// desde su última posición GPS conocida.
import { Store } from '/js/store.js';

export async function recomputeRouteForDriver(driverId) {
  if (!driverId) return;
  const driver = Store.getDrivers().get(driverId);
  if (!driver) return;

  const assigned = Array.from(Store.getOrders().entries())
    .filter(([, o]) => o.assignedTo === driverId && o.lat != null && o.status !== 'entregado' && !o.archivedAt)
    .map(([id, o]) => ({ id, lat: o.lat, lng: o.lng, label: o.label, orderNumber: o.orderNumber }));

  if (assigned.length === 0) {
    Store.socket.emit('driver:route', { driverId, stops: [], latlngs: [] });
    return;
  }

  try {
    const result = await Geo.computeRoute({ lat: driver.lat, lng: driver.lng }, assigned);
    const stops = result.orderedPoints.slice(1).map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, label: p.label, orderNumber: p.orderNumber }));
    Store.socket.emit('driver:route', { driverId, stops, latlngs: result.latlngs, distanceKm: result.distanceKm, durationMin: result.durationMin });
  } catch (e) {
    // best-effort — si OSRM está caído un momento, la ruta anterior queda mostrada
  }
}
