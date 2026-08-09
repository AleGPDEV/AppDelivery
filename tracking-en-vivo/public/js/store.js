// Dueño único de la conexión de Socket.IO y del estado que antes cada
// página admin duplicaba por su cuenta (una conexión por navegación). Bajo
// la SPA hay UNA sola conexión que vive todo lo que dure la pestaña, así
// que acá se resuelven dos problemas que no existían en el modelo viejo:
//
// 1. Una vista que se monta por segunda vez (volver a "Pedidos" después de
//    haber pasado por otra pestaña) NO recibe un snapshot nuevo del
//    servidor — los snapshots solo se mandan una vez, al conectar. Por eso
//    cada vista lee el estado ya cacheado acá (getOrders(), getDrivers(),
//    etc.) en vez de esperar su propio snapshot.
// 2. Reconexión automática de Socket.IO (wifi cortado, laptop dormida): el
//    servidor vuelve a mandar snapshots completos al reconectar. Si solo
//    hiciéramos upsert (como hacía cada página por separado, total
//    conexión nueva en cada navegación) un pedido ya borrado o un delivery
//    ya vencido podría "resucitar" en pantalla y no irse nunca más. Por
//    eso cada handler de snapshot limpia el Map antes de repoblarlo.
//
// Reemite cada evento tal cual lo manda el servidor (mismo nombre, mismo
// payload) — así cada vista porta su lógica de diffing/re-render actual
// sin reescribirla (algunas vistas evitan a propósito re-renderizar en
// cada driver:update para que un <select> abierto no se cierre solo).

const socket = io();

const state = {
  drivers: new Map(),
  orders: new Map(),
  routes: new Map(),
  formConfig: { customFields: [], paymentMethods: [] },
  categories: new Map(),
  products: new Map(),
  suppliers: new Map(),
  expenses: new Map(),
  cashStarts: new Map(),
  businessDay: null,
};

const bus = new EventTarget();

function relay(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

socket.on('drivers:snapshot', (list) => {
  state.drivers.clear();
  (list || []).forEach((d) => state.drivers.set(d.id, d));
  relay('drivers:snapshot', list);
});
socket.on('driver:update', (d) => {
  state.drivers.set(d.id, d);
  relay('driver:update', d);
});
socket.on('driver:remove', (payload) => {
  state.drivers.delete(payload.id);
  relay('driver:remove', payload);
});

socket.on('orders:snapshot', (list) => {
  state.orders.clear();
  (list || []).forEach((o) => state.orders.set(o.id, o));
  relay('orders:snapshot', list);
});
socket.on('order:update', (o) => {
  state.orders.set(o.id, o);
  relay('order:update', o);
});
socket.on('order:remove', (payload) => {
  state.orders.delete(payload.id);
  relay('order:remove', payload);
});

socket.on('routes:snapshot', (list) => {
  state.routes.clear();
  (list || []).forEach((r) => state.routes.set(r.driverId, r));
  relay('routes:snapshot', list);
});
socket.on('driver:route', (r) => {
  state.routes.set(r.driverId, r);
  relay('driver:route', r);
});
socket.on('route:remove', (payload) => {
  state.routes.delete(payload.driverId);
  relay('route:remove', payload);
});

socket.on('form-config:snapshot', (cfg) => {
  state.formConfig = cfg;
  relay('form-config:snapshot', cfg);
});

socket.on('catalog:snapshot', (payload) => {
  state.categories.clear();
  (payload.categories || []).forEach((c) => state.categories.set(c.id, c));
  state.products.clear();
  (payload.products || []).forEach((p) => state.products.set(p.id, p));
  relay('catalog:snapshot', payload);
});

socket.on('suppliers:snapshot', (list) => {
  state.suppliers.clear();
  (list || []).forEach((s) => state.suppliers.set(s.id, s));
  relay('suppliers:snapshot', list);
});

socket.on('expenses:snapshot', (list) => {
  state.expenses.clear();
  (list || []).forEach((e) => state.expenses.set(e.id, e));
  relay('expenses:snapshot', list);
});

socket.on('cash-starts:snapshot', (list) => {
  state.cashStarts.clear();
  (list || []).forEach(({ driverId, amount }) => state.cashStarts.set(driverId, amount));
  relay('cash-starts:snapshot', list);
});
socket.on('driver:cash-start', (payload) => {
  state.cashStarts.set(payload.driverId, payload.amount);
  relay('driver:cash-start', payload);
});

socket.on('business-day:status', (payload) => {
  state.businessDay = payload.day;
  relay('business-day:status', payload);
});

export const Store = {
  socket,
  on(name, cb) { bus.addEventListener(name, cb); },
  off(name, cb) { bus.removeEventListener(name, cb); },
  getDrivers: () => state.drivers,
  getOrders: () => state.orders,
  getRoutes: () => state.routes,
  getFormConfig: () => state.formConfig,
  getCategories: () => state.categories,
  getProducts: () => state.products,
  getSuppliers: () => state.suppliers,
  getExpenses: () => state.expenses,
  getCashStarts: () => state.cashStarts,
  getBusinessDay: () => state.businessDay,
};
