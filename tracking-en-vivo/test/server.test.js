// Smoke tests para las funciones puras de server.js — no levantan el
// servidor real ni pegan a Supabase (ver el guard `require.main === module`
// en server.js, y `module.exports` al final de ese archivo). Correr con
// `npm test` (usa el test runner nativo de Node, node:test — no hay
// dependencia nueva).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeCustom,
  isCashPayment,
  normalizeFormConfig,
  orderRow,
  categoryRow,
  productRow,
  expenseRow,
  csvCell,
  toCsv,
} = require('../server.js');

test('sanitizeCustom', async (t) => {
  await t.test('devuelve objeto vacío para entradas no-objeto', () => {
    assert.deepEqual(sanitizeCustom(null), {});
    assert.deepEqual(sanitizeCustom(undefined), {});
    assert.deepEqual(sanitizeCustom('texto'), {});
    assert.deepEqual(sanitizeCustom(42), {});
  });

  await t.test('acota a 20 claves como máximo', () => {
    const input = {};
    for (let i = 0; i < 30; i++) input[`campo${i}`] = 'valor';
    const out = sanitizeCustom(input);
    assert.equal(Object.keys(out).length, 20);
  });

  await t.test('descarta claves de más de 60 caracteres', () => {
    const longKey = 'x'.repeat(61);
    const out = sanitizeCustom({ [longKey]: 'valor', ok: 'valor' });
    assert.equal(longKey in out, false);
    assert.equal(out.ok, 'valor');
  });

  await t.test('trunca valores a 200 caracteres', () => {
    const longValue = 'y'.repeat(250);
    const out = sanitizeCustom({ campo: longValue });
    assert.equal(out.campo.length, 200);
  });

  await t.test('convierte valores no-string a string', () => {
    const out = sanitizeCustom({ numero: 123, nulo: null });
    assert.equal(out.numero, '123');
    assert.equal(out.nulo, '');
  });
});

test('isCashPayment', async (t) => {
  const paymentMethods = [
    { id: 'efectivo', name: 'Efectivo', isCash: true },
    { id: 'transferencia', name: 'Transferencia', isCash: false },
  ];

  await t.test('true para un método marcado isCash', () => {
    assert.equal(isCashPayment('Efectivo', paymentMethods), true);
  });

  await t.test('false para un método marcado no-cash', () => {
    assert.equal(isCashPayment('Transferencia', paymentMethods), false);
  });

  await t.test('false si el método no existe en la lista (ej. se borró de Ajustes)', () => {
    assert.equal(isCashPayment('Mercado Pago', paymentMethods), false);
  });

  await t.test('false para vacío/undefined — un pedido sin forma de pago asignada no es "efectivo"', () => {
    assert.equal(isCashPayment('', paymentMethods), false);
    assert.equal(isCashPayment(undefined, paymentMethods), false);
    assert.equal(isCashPayment(null, paymentMethods), false);
  });

  await t.test('no explota si la lista de métodos está vacía', () => {
    assert.equal(isCashPayment('Efectivo', []), false);
  });
});

test('normalizeFormConfig', async (t) => {
  await t.test('completa los defaults en un objeto vacío', () => {
    const cfg = normalizeFormConfig({});
    assert.equal(cfg.phone.visible, true);
    assert.equal(cfg.phone.required, true);
    assert.equal(cfg.name.required, false);
    assert.equal(cfg.orderNumber.required, true);
    assert.equal(cfg.amount.required, true);
    assert.deepEqual(cfg.customFields, []);
    assert.equal(cfg.paymentMethods.length, 3);
    assert.equal(cfg.paymentMethods[0].name, 'Efectivo');
    assert.equal(cfg.paymentMethods[0].isCash, true);
  });

  await t.test('respeta valores ya guardados, no los pisa', () => {
    const cfg = normalizeFormConfig({
      phone: { visible: false, required: false },
      paymentMethods: [{ id: 'x', name: 'Mercado Pago', isCash: false }],
    });
    assert.equal(cfg.phone.visible, false);
    assert.equal(cfg.paymentMethods.length, 1);
    assert.equal(cfg.paymentMethods[0].name, 'Mercado Pago');
  });

  await t.test('regresión: una config vieja sin phone/name/orderNumber/amount no deja esos campos ocultos para siempre', () => {
    // Este es exactamente el bug real que hubo en producción: una config
    // guardada de antes de que existiera este mecanismo no tenía estas
    // claves, y sin este backfill quedaban `undefined` (tratado como
    // "oculto" en el resto del código).
    const cfg = normalizeFormConfig({ customFields: [], paymentMethods: [] });
    assert.equal(cfg.phone.visible, true);
    assert.equal(cfg.name.visible, true);
    assert.equal(cfg.orderNumber.visible, true);
    assert.equal(cfg.amount.visible, true);
  });

  await t.test('maneja null/undefined como config vacía, sin explotar', () => {
    assert.doesNotThrow(() => normalizeFormConfig(null));
    assert.doesNotThrow(() => normalizeFormConfig(undefined));
  });

  await t.test('no muta el objeto de entrada', () => {
    const input = {};
    normalizeFormConfig(input);
    assert.deepEqual(input, {});
  });
});

test('orderRow', () => {
  const row = orderRow('order-1', {
    seq: 5,
    orderNumber: '12',
    phone: '099123456',
    name: 'Matías',
    lat: -34.9,
    lng: -56.1,
    label: 'Av. Siempreviva 742',
    assignedTo: 'driver-1',
    status: 'pending',
    amount: 100,
    paymentMethod: 'Efectivo',
    reconciledAt: null,
    archivedAt: null,
    updatedAt: 1700000000000,
    custom: { piso: '3' },
    source: 'web',
    items: [{ productId: 'p1', name: 'Roll', price: 100, qty: 1 }],
  });
  assert.equal(row.id, 'order-1');
  assert.equal(row.order_number, '12');
  assert.equal(row.assigned_to, 'driver-1');
  assert.equal(row.payment_method, 'Efectivo');
  assert.equal(row.source, 'web');
  assert.equal(row.items.length, 1);
  assert.equal(row.updated_at, new Date(1700000000000).toISOString());
});

test('orderRow — defaults para pedidos admin sin source/items', () => {
  const row = orderRow('order-2', { updatedAt: Date.now(), custom: {} });
  assert.equal(row.source, 'admin');
  assert.deepEqual(row.items, []);
});

test('categoryRow / productRow / expenseRow — mapeo básico camelCase -> snake_case', () => {
  const cat = categoryRow('cat-1', { name: 'Rolls', sortOrder: 2, visible: true });
  assert.equal(cat.sort_order, 2);

  const prod = productRow('prod-1', { categoryId: 'cat-1', name: 'Roll California', price: 450, imageUrl: null, sortOrder: 0, visible: true });
  assert.equal(prod.category_id, 'cat-1');
  assert.equal(prod.image_url, null);

  const exp = expenseRow('exp-1', {
    description: 'Pescadería',
    amount: 500,
    paymentMethodId: 'efectivo',
    paymentMethodName: 'Efectivo',
    paymentMethodIsCash: true,
    businessDayId: 'day-1',
    createdAt: 1700000000000,
  });
  assert.equal(exp.payment_method_is_cash, true);
  assert.equal(exp.business_day_id, 'day-1');
});

test('csvCell', async (t) => {
  await t.test('deja pasar texto simple sin comillas', () => {
    assert.equal(csvCell('Matías'), 'Matías');
  });

  await t.test('null/undefined se vuelven celda vacía', () => {
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
  });

  await t.test('entre comillas si trae coma', () => {
    assert.equal(csvCell('Av. Italia, esq. Rivera'), '"Av. Italia, esq. Rivera"');
  });

  await t.test('duplica comillas internas', () => {
    assert.equal(csvCell('Pedido "urgente"'), '"Pedido ""urgente"""');
  });

  await t.test('entre comillas si trae salto de línea', () => {
    assert.equal(csvCell('línea1\nlínea2'), '"línea1\nlínea2"');
  });

  await t.test('números se convierten a texto tal cual', () => {
    assert.equal(csvCell(450), '450');
  });
});

test('toCsv', () => {
  const csv = toCsv(['Nombre', 'Monto'], [['Matías', 100], ['Ana, Sofía', 200]]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Nombre,Monto');
  assert.equal(lines[1], 'Matías,100');
  assert.equal(lines[2], '"Ana, Sofía",200');
});
