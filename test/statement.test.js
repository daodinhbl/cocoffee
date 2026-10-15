/**
 * "Bảng đối chiếu công nợ" over Zalo: a customer asks (private chat, linked account) and gets THEIR statement; the shop
 * owner's chat gets the reconciliation of ALL customers. Text summary + table picture (+ account and VietQR for what is
 * still owed). Bot Client channel (images inline), data layer faked.
 */
process.env.FNB_NO_LISTEN = '1';
process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';
process.env.ZALO_MODE = 'bot';
process.env.BOT_WEBHOOK_SECRET = 'test-bot-secret-0123456789';
process.env.PUBLIC_BASE_URL = 'https://cafe.example.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mock } = test;
const { detectCommand, statementPeriodText } = require('../src/webhooks/zalo/zaloOrderParser');

test('statement commands and periods', () => {
  for (const t of ['đối chiếu công nợ', 'bảng đối chiếu công nợ', 'Sao kê', 'sao kê tháng trước', 'liệt kê công nợ', 'danh sách nợ', 'chi tiết công nợ',
    'gửi mình bảng đối chiếu công nợ tháng 9 nhé', 'công nợ tháng 9', 'bảng công nợ', 'công nợ chi tiết', 'đối chiếu', 'đối chiếu công nợ tất cả', 'xem bảng đối chiếu công nợ năm nay']) {
    assert.equal(detectCommand(t), 'statement', t);
  }
  for (const t of ['check nợ', 'công nợ', 'xem công nợ', 'mình còn nợ bao nhiêu', 'liệt kê', 'danh sách', '2 cf sữa', 'ghi nợ giúp mình 1 bạc xỉu', 'sao kê tài khoản của bạn hôm qua rồi']) {
    assert.notEqual(detectCommand(t), 'statement', t);
  }
  assert.equal(detectCommand('check nợ'), 'debt', 'the balance + QR answer is unchanged');
  assert.deepEqual(['sao kê', 'sao kê tháng trước', 'công nợ tháng 9', 'đối chiếu công nợ tất cả', 'bảng đối chiếu năm nay'].map(statementPeriodText), ['', 'thang truoc', 'thang 9', 'tat ca', 'nam nay']);

  const { periodFromText } = require('../src/services/zalo/statementService');
  const oct14 = new Date('2026-10-14T16:00:00Z');
  const p = (t) => { const r = periodFromText(t, oct14); return [r.from, r.to]; };
  assert.deepEqual(p(''), ['2026-10-01', '2026-10-14']);
  assert.deepEqual(p('thang truoc'), ['2026-09-01', '2026-09-30']);
  assert.deepEqual(p('thang 9'), ['2026-09-01', '2026-09-30']);
  assert.deepEqual(p('thang 11'), ['2025-11-01', '2025-11-30'], 'a later month is last year\'s');
  assert.deepEqual(p('thang 10'), ['2026-10-01', '2026-10-14'], 'the current month stops today');
  assert.deepEqual(p('nam nay'), ['2026-01-01', '2026-10-14']);
  assert.deepEqual(p('tat ca'), ['2000-01-01', '2026-10-14']);
  assert.deepEqual(p('thang 13'), ['2026-10-01', '2026-10-14'], 'nonsense falls back to this month');
  assert.deepEqual(periodFromText('thang truoc', new Date('2026-01-10T05:00:00Z')).from, '2025-12-01', 'January looks back to December');
});

test('debt tables over the Zalo bot', async (t) => {
  const eventModel = require('../src/models/zaloModel').eventModel;
  const customerModel = require('../src/models/customerModel');
  const customerQuery = require('../src/services/customerQueryService');
  const settingsModel = require('../src/models/settingsModel');
  const zaloConfig = require('../src/services/zalo/zaloConfig');
  const billMedia = require('../src/services/zalo/billMedia');
  const vietQr = require('../src/services/vietQr');

  mock.method(eventModel, 'insertIfNew', async () => true);
  mock.method(eventModel, 'mark', async () => {});
  const SETTINGS = new Map([['zalo.debtOwnerChatId', 'owner-1'], ['zalo.debtOwnerChatType', 'user']]);
  mock.method(settingsModel, 'getByPrefix', async (p) => Object.fromEntries([...SETTINGS].filter(([k]) => k.startsWith(p))));
  zaloConfig.invalidate();

  const LAN = { id: 5, name: 'Chị Lan', phone: '0909000111', balance: 166000, zalo_user_id: 'z-lan' };
  const entries = [
    { id: 1, entry_type: 'debt', amount: 225000, method: null, note: 'Nợ đơn CF260924-00006', created_at: new Date('2026-09-24T03:00:00Z'), order_code: 'CF260924-00006', balance: 225000 },
    { id: 2, entry_type: 'debt', amount: 241000, method: null, note: 'Nợ đơn CF261008-00007', created_at: new Date('2026-10-08T03:00:00Z'), order_code: 'CF261008-00007', balance: 466000 },
    { id: 3, entry_type: 'payment', amount: -300000, method: 'transfer', note: 'CK test', created_at: new Date('2026-10-13T03:00:00Z'), order_code: null, balance: 166000 },
  ];
  const stCalls = [];
  mock.method(customerModel, 'findByZaloUser', async (z) => (z === 'z-lan' ? LAN : null));
  mock.method(customerModel, 'getById', async (id) => (id === 5 ? LAN : null));
  mock.method(customerModel, 'statement', async (id, from, to) => { stCalls.push([id, from, to]); return { opening: 0, entries, increase: 466000, decrease: 300000, closing: 166000 }; });
  const ROWS = [
    { id: 5, name: 'Chị Lan', phone: '0909000111', opening: 0, increase: 466000, decrease: 300000, closing: 166000 },
    { id: 6, name: 'Anh Nam', phone: null, opening: 0, increase: 94000, decrease: 0, closing: 94000 },
  ];
  const recCalls = [];
  mock.method(customerQuery, 'reconciliation', async (q) => {
    recCalls.push(q);
    return { rows: ROWS, totals: { opening: 0, increase: 560000, decrease: 300000, closing: 260000 }, period: {} };
  });

  const app = require('../app');
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  const say = async (message, { senderId = 'z-lan', groupId = null } = {}) => (await fetch(`${base}/api/zalo/webhook`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-bot-secret-0123456789', 'Content-Type': 'application/json' },
    body: JSON.stringify({ senderId, groupId, message, messageId: `s-${++n}` }),
  })).json();
  const dims = (b64) => { const b = Buffer.from(b64, 'base64'); return { magic: b.subarray(1, 4).toString(), w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

  await t.test('a linked customer: summary, the table picture (served by its signed link), no QR when no bank account', async () => {
    const r = await say('đối chiếu công nợ');
    assert.equal(r.action, 'statement');
    assert.deepEqual(r.replies.map((x) => x.type), ['text', 'image']);
    assert.match(r.replies[0].text, /BẢNG ĐỐI CHIẾU CÔNG NỢ[\s\S]*Chị Lan[\s\S]*Nợ đầu kỳ: 0đ[\s\S]*Phát sinh nợ: 466\.000đ[\s\S]*Đã thanh toán: 300\.000đ[\s\S]*Nợ cuối kỳ: 166\.000đ/);
    const img = r.replies[1];
    assert.deepEqual([dims(img.base64).magic, dims(img.base64).w], ['PNG', 760]);
    assert.ok(dims(img.base64).h > 300);
    assert.match(img.url, /^https:\/\/cafe\.example\.test\/api\/zalo\/statement\/[\w-]+\.[\w-]{22}\.png$/);
    assert.equal(stCalls.at(-1)[0], 5);

    const served = await fetch(base + new URL(img.url).pathname);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), Buffer.from(img.base64, 'base64'));

    const token = new URL(img.url).pathname.split('/').pop().replace(/\.png$/, '');
    const v = billMedia.verify(token);
    assert.equal(v.kind, 'statement');
    assert.equal(v.customerId, 5);
    assert.equal(billMedia.verify(token, Date.now() + 25 * 3600 * 1000), null, 'a debt table link lives one day');
    assert.equal((await fetch(`${base}/api/zalo/receipt/${token}.png`)).status, 404, 'not a receipt link');
    assert.equal((await fetch(`${base}/api/zalo/reconciliation/${token}.png`)).status, 404, 'not the owner\'s table link');
    const tampered = `${token.slice(0, 12)}${token[12] === 'A' ? 'B' : 'A'}${token.slice(13)}`;
    assert.equal((await fetch(`${base}/api/zalo/statement/${tampered}.png`)).status, 404);
  });

  await t.test('the period asked for reaches the ledger query (sao kê tháng trước)', async () => {
    const { periodFromText } = require('../src/services/zalo/statementService');
    await say('sao kê tháng trước');
    const p = periodFromText('thang truoc');
    assert.deepEqual(stCalls.at(-1).slice(1), [`${p.from} 00:00:00`, `${new Date(Date.parse(`${p.to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)} 00:00:00`]);
  });

  await t.test('something owed + a bank account: account and transfer content, then the VietQR for the balance', async () => {
    SETTINGS.set('chatbot.bankBin', '970436').set('chatbot.bankAccount', '0123456789').set('chatbot.bankAccountName', 'NGUYEN VAN A');
    const r = await say('liệt kê công nợ');
    assert.deepEqual(r.replies.map((x) => x.type), ['text', 'image', 'text', 'image']);
    assert.match(r.replies[2].text, /Vietcombank · 0123456789 · NGUYEN VAN A[\s\S]*Nội dung: NO KH5/);
    const expected = await vietQr.png(vietQr.payload({ bin: '970436', account: '0123456789', amount: 166000, note: 'NO KH5' }));
    assert.deepEqual(Buffer.from(r.replies[3].base64, 'base64'), expected);
  });

  await t.test('nothing owed: no payment request', async () => {
    LAN.balance = 0;
    const r = await say('sao kê');
    assert.deepEqual(r.replies.map((x) => x.type), ['text', 'image']);
    LAN.balance = 166000;
  });

  await t.test('the picture cannot be made: the table goes out as text instead', async () => {
    const spy = mock.method(billMedia, 'statementPicture', async () => null);
    const r = await say('bảng đối chiếu công nợ');
    spy.mock.restore();
    assert.deepEqual(r.replies.slice(0, 2).map((x) => x.type), ['text', 'text']);
    assert.match(r.replies[1].text, /24\/09 Phát sinh nợ đơn CF260924-00006: \+225\.000đ \(còn 225\.000đ\)[\s\S]*13\/10 Thu nợ \(chuyển khoản\) - CK test: -300\.000đ \(còn 166\.000đ\)/);
  });

  await t.test('never in a group, never for an unknown Zalo account', async () => {
    assert.match((await say('đối chiếu công nợ', { groupId: 'g1' })).replies[0].text, /nhắn riêng/);
    const stranger = await say('đối chiếu công nợ', { senderId: 'z-stranger' });
    assert.match(stranger.replies[0].text, /chưa được liên kết/);
    assert.equal(stranger.replies.length, 1);
  });

  await t.test('the shop owner\'s chat gets ALL customers: summary with the debtors, then the reconciliation table', async () => {
    recCalls.length = 0;
    const r = await say('liệt kê công nợ', { senderId: 'owner-1' });
    assert.equal(r.action, 'statement');
    assert.deepEqual(r.replies.map((x) => x.type), ['text', 'image']);
    assert.match(r.replies[0].text, /ĐỐI CHIẾU CÔNG NỢ[\s\S]*Nợ cuối kỳ: 260\.000đ \(2 khách còn nợ\)[\s\S]*1\. Chị Lan: 166\.000đ[\s\S]*2\. Anh Nam: 94\.000đ/);
    assert.equal(dims(r.replies[1].base64).w, 860);
    assert.match(r.replies[1].url, /\/api\/zalo\/reconciliation\/[\w-]+\.[\w-]{22}\.png$/);
    assert.deepEqual(Object.keys(recCalls[0]).sort(), ['from', 'to']);
    const served = await fetch(base + new URL(r.replies[1].url).pathname);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), Buffer.from(r.replies[1].base64, 'base64'));
    assert.equal((await fetch(base + new URL(r.replies[1].url).pathname.replace('/reconciliation/', '/statement/'))).status, 404);

    const other = await say('liệt kê công nợ', { senderId: 'z-lan' });
    assert.match(other.replies[0].text, /Chị Lan/, 'any other chat only ever sees its own customer');
    assert.doesNotMatch(other.replies[0].text, /Anh Nam/);
  });

  await t.test('a plain "công nợ" / "check nợ" now also carries the debt table of the last 3 months', async () => {
    SETTINGS.delete('chatbot.bankBin');
    SETTINGS.delete('chatbot.bankAccount');
    for (const q of ['công nợ', 'check nợ']) {
      const r = await say(q);
      assert.equal(r.action, 'debt');
      assert.deepEqual(r.replies.map((x) => x.type), ['text', 'image'], q);
      assert.match(r.replies[0].text, /CÔNG NỢ[\s\S]*Số dư hiện tại: 166\.000đ/);
      assert.match(r.replies[1].url, /\/api\/zalo\/statement\/[\w-]+\.[\w-]{22}\.png$/);
    }
    const { periodFromText } = require('../src/services/zalo/statementService');
    const p = periodFromText('gan day', new Date('2026-10-14T16:00:00Z'));
    assert.deepEqual([p.from, p.to, p.label.slice(0, 15)], ['2026-08-01', '2026-10-14', '3 tháng gần đây']);
    assert.equal(periodFromText('gan day', new Date('2026-01-10T05:00:00Z')).from, '2025-11-01');
    LAN.balance = 0;
    assert.equal((await say('công nợ')).replies.length, 1, 'nothing owed: just the "không còn nợ" line');
    LAN.balance = 166000;
  });

  await t.test('the owner\'s chat asking a plain "công nợ" gets ALL customers\' table', async () => {
    const r = await say('công nợ', { senderId: 'owner-1' });
    assert.equal(r.action, 'statement');
    assert.match(r.replies[0].text, /ĐỐI CHIẾU CÔNG NỢ[\s\S]*Chị Lan: 166\.000đ/);
    assert.match(r.replies[1].url, /\/api\/zalo\/reconciliation\//);
    const owner2 = await say('check nợ', { senderId: 'owner-1' });
    assert.equal(owner2.action, 'statement');
  });

  await t.test('a long statement keeps the NEWEST lines (and says how many were left out)', async () => {
    const { allPng } = require('../src/services/zalo/statementService');
    const receiptImage = require('../src/services/receiptImage');
    const rows = Array.from({ length: 70 }, (_, i) => ({ cells: [String(i + 1), `d${i}`, `dong ${i + 1}`, '', '', '']}));
    const keep = await receiptImage.renderTable({ columns: [{ label: 'a', w: 1 }, { label: 'b', w: 1 }, { label: 'c', w: 3 }, { label: 'd', w: 1 }, { label: 'e', w: 1 }, { label: 'f', w: 1 }], rows, maxRows: 10, keepLast: true });
    const first = await receiptImage.renderTable({ columns: [{ label: 'a', w: 1 }, { label: 'b', w: 1 }, { label: 'c', w: 3 }, { label: 'd', w: 1 }, { label: 'e', w: 1 }, { label: 'f', w: 1 }], rows, maxRows: 10 });
    assert.equal(Buffer.from(keep).readUInt32BE(16), 720);
    assert.notDeepEqual(keep, first, 'a different picture: last rows vs first rows');
    assert.equal(typeof allPng, 'function');
  });
});
