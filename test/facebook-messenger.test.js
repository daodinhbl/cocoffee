/** Facebook Messenger consultation bot: webhook handshake, signature check, answers, lead capture. */
process.env.FB_PAGE_ACCESS_TOKEN = 'page-token';
process.env.FB_APP_SECRET = 'app-secret-xyz';
process.env.FB_VERIFY_TOKEN = 'verify-me';
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { start } = require('./helpers/adminFixture');
const consultBot = require('../src/services/facebook/consultBot');

const sign = (body) => `sha256=${crypto.createHmac('sha256', 'app-secret-xyz').update(body).digest('hex')}`;
const event = (message) => JSON.stringify({ object: 'page', entry: [{ messaging: [{ sender: { id: 'psid-1' }, message }] }] });
const until = async (fn) => { for (let i = 0; i < 50 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 20)); };

test('consult bot: topics, no invented prices, phone capture', () => {
  assert.match(consultBot.reply('Bên em lắp camera giám sát được không').text, /camera an ninh/i);
  assert.match(consultBot.reply('báo giá điện mặt trời').text, /báo giá sau khi/);
  assert.doesNotMatch(consultBot.reply('giá bao nhiêu').text, /\d{3}\.?\d{3}\s?(đ|vnđ|k)/i);
  assert.match(consultBot.reply('nhà bị chập điện nhảy aptomat').text, /điện nước/);
  assert.equal(consultBot.reply('gặp nhân viên').wantsHuman, true);
  assert.equal(consultBot.reply('số mình 0912 345 678 nhé').phone, '0912345678');
  assert.equal(consultBot.reply('+84 912-345-678').phone, '0912345678');
  assert.equal(consultBot.reply('12345').phone, undefined);
  assert.ok(consultBot.reply('asdf qwer').quickReplies.length > 0);
});

test('webhook: verify handshake, bad signature rejected, signed message answered and lead saved once', async (t) => {
  const fx = await start();
  t.after(() => fx.stop());
  const axios = require('axios');
  const leadModel = require('../src/models/leadModel');
  const zalo = require('../src/services/zalo/ownerNotice');
  const sent = [];
  const leads = [];
  mock.method(axios, 'post', async (url, body, cfg) => { sent.push({ url, body, cfg }); return { status: 200, data: { message_id: 'm1' } }; });
  mock.method(leadModel, 'recentByPhone', async (p) => (leads.some((l) => l.phone === p) ? { id: 1 } : null));
  mock.method(leadModel, 'create', async (row) => { leads.push(row); return leads.length; });
  mock.method(zalo, 'notifyOwner', async () => 'sent');

  const hook = `${fx.base}/api/facebook/webhook`;
  const ok = await fetch(`${hook}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '12345');
  assert.equal((await fetch(`${hook}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);

  const post = (body, sig) => fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body });

  const body = event({ text: 'tư vấn camera' });
  assert.equal((await post(body, 'sha256=deadbeef')).status, 403);
  assert.equal((await post(body, '')).status, 403);
  assert.equal(sent.length, 0);

  assert.equal((await post(body, sign(body))).status, 200);
  await until(() => sent.length >= 1);
  assert.match(sent[0].url, /graph\.facebook\.com\/v[\d.]+\/me\/messages$/);
  assert.equal(sent[0].body.recipient.id, 'psid-1');
  assert.match(sent[0].body.message.text, /camera/i);
  assert.equal(sent[0].cfg.headers.Authorization, 'Bearer page-token');
  assert.ok(sent[0].body.message.quick_replies.every((q) => q.title.length <= 20));

  const phoneBody = event({ text: 'sdt 0912345678' });
  await post(phoneBody, sign(phoneBody));
  await until(() => sent.length >= 2);
  await post(phoneBody, sign(phoneBody));                     // same number again: no second lead
  await until(() => sent.length >= 3);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].source, 'facebook');
  assert.equal(leads[0].phone, '0912345678');

  const echo = event({ text: 'tin của page', is_echo: true });
  await post(echo, sign(echo));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 3);                               // echoes are ignored
});
