process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';
const test = require('node:test');
const assert = require('node:assert/strict');

const zaloConfig = require('../src/services/zalo/zaloConfig');
const zaloBot = require('../src/services/zalo/zaloBotPlatform');
const orderModel = require('../src/models/orderModel');
const customerModel = require('../src/models/customerModel');
const svc = require('../src/services/zalo/newOrderNotificationService');

const ORDER = { id: 7, order_code: 'CF-7', total: 79000, zalo_chat_id: 'cust-1', zalo_user_id: 'u1', created_at: new Date() };
const ITEMS = [{ product_name: 'Cà phê sữa đá', quantity: 2, note: 'ít đá' }, { product_name: 'Trà đào', quantity: 1, note: null }];

function setup(t, cfg) {
  const sent = [];
  t.mock.method(zaloConfig, 'get', async () => ({ mode: 'platform', debtOwnerChatId: 'owner-1', debtOwnerChatType: 'user', ...cfg }));
  t.mock.method(zaloBot, 'sendText', async (id, text) => { sent.push({ id, text }); return {}; });
  t.mock.method(orderModel, 'getById', async () => ORDER);
  t.mock.method(orderModel, 'getItems', async () => ITEMS);
  t.mock.method(customerModel, 'findByZaloUser', async () => ({ name: 'Chị Lan' }));
  return sent;
}

test('new Zalo order is sent to the owner chat with items and total', async (t) => {
  const sent = setup(t, {});
  assert.equal(await svc.notifyNewOrder(7), 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 'owner-1');
  assert.match(sent[0].text, /CÓ ĐƠN MỚI/);
  assert.match(sent[0].text, /Chị Lan/);
  assert.match(sent[0].text, /2 × Cà phê sữa đá \(ít đá\)/);
  assert.match(sent[0].text, /79\.000đ/);
});

test('no owner chat configured, or the owner is the customer: nothing is sent', async (t) => {
  let sent = setup(t, { debtOwnerChatId: '' });
  assert.equal(await svc.notifyNewOrder(7), 'not_configured');
  assert.equal(sent.length, 0);
  t.mock.restoreAll();
  sent = setup(t, { debtOwnerChatId: 'cust-1' });
  assert.equal(await svc.notifyNewOrder(7), 'same_chat');
  assert.equal(sent.length, 0);
});

test('a delivery error is swallowed', async (t) => {
  setup(t, {});
  t.mock.method(zaloBot, 'sendText', async () => { throw new Error('zalo down'); });
  assert.equal(await svc.notifyNewOrder(7), 'failed');
});
