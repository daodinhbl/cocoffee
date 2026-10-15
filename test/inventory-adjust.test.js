process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';
const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryModel = require('../src/models/inventoryModel');
const inventoryService = require('../src/services/inventoryService');

/** A stock count (inventoryService.adjust) against a faked item row; records what was written. */
function setup(t, quantityOnHand) {
  const writes = { stock: null, movement: null };
  t.mock.method(inventoryModel, 'lockByIds', async () => new Map([[1, { id: 1, quantity_on_hand: quantityOnHand, avg_cost: 100 }]]));
  t.mock.method(inventoryModel, 'setStock', async (_id, qty) => { writes.stock = qty; });
  t.mock.method(inventoryModel, 'addMovement', async (m) => { writes.movement = m; });
  return writes;
}

test('a count with no expected quantity (or the current one) sets the stock to the counted figure', async (t) => {
  const w = setup(t, 25);
  let r = await inventoryService.adjust(null, 1, 20, { userId: 1 });
  assert.deepEqual(r, { quantity_on_hand: 20, delta: -5 });
  assert.equal(w.stock, 20);
  r = await inventoryService.adjust(null, 1, 20, { expectedQuantity: 25 });
  assert.deepEqual(r, { quantity_on_hand: 20, delta: -5 }, 'expected equals current: a plain count');
});

test('a count made against a stock figure that moved since applies the difference it found', async (t) => {
  // Device A counted 20 against 25 at 08:00 (offline); by the replay other sales brought the server to 10.
  const w = setup(t, 10);
  const r = await inventoryService.adjust(null, 1, 20, { expectedQuantity: 25, note: 'kiểm kê sáng' });
  assert.equal(r.quantity_on_hand, 5, '10 + (20 - 25): the sales made meanwhile are kept');
  assert.equal(r.delta, -5);
  assert.equal(r.reconciled, true);
  assert.equal(r.counted, 20);
  assert.equal(w.stock, 5);
  assert.match(w.movement.note, /kiểm kê sáng \(đếm 20 khi máy ghi 25, hệ thống 10\)/);
  assert.equal(w.movement.balanceAfter, 5);
});

test('the reconciled stock never goes below zero', async (t) => {
  setup(t, 2);
  const r = await inventoryService.adjust(null, 1, 0, { expectedQuantity: 25 });
  assert.equal(r.quantity_on_hand, 0);
  assert.equal(r.delta, -2);
});
