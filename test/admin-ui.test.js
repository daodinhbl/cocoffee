/**
 * DOM-level tests for the Web Admin: real server-rendered HTML (EJS, signed-in session, faked data layer) +
 * the real public/admin/admin.js, driven inside jsdom. No database needed.
 * Skips itself when jsdom (a devDependency) is not installed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('./helpers/adminFixture');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (_) { /* devDependency not installed */ }
const suite = JSDOM ? test : test.skip;

const ADMIN_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'admin.js'), 'utf8');

suite('admin UI (jsdom)', async (t) => {
  const fx = await start();
  t.after(fx.stop);
  const { c: session } = await fx.login();

  /** Render a page through Express (signed in), load it into jsdom and run admin.js against it. */
  async function open(pathname, { width = 1400 } = {}) {
    const res = await session.get(pathname);
    const html = await res.text();
    const dom = new JSDOM(html, { url: fx.base + pathname, runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    Object.defineProperty(w, 'innerWidth', { value: width, configurable: true });
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    // jsdom has no layout and no <dialog> modal behaviour: model just enough of both
    Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', { get() { return this.closest('[hidden]') ? null : this.parentNode; } });
    w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    // real form submission would navigate; record it instead
    w.__submitted = [];
    w.HTMLFormElement.prototype.requestSubmit = function () {
      const ev = new w.Event('submit', { bubbles: true, cancelable: true });
      if (this.dispatchEvent(ev)) w.__submitted.push(this.getAttribute('action'));
    };
    w.eval(ADMIN_JS);
    const $ = (s, r) => (r || w.document).querySelector(s);
    const $$ = (s, r) => Array.from((r || w.document).querySelectorAll(s));
    const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    const type = (el, value) => { el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
    const key = (el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const submit = (form) => form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    return { res, html, w, $, $$, click, type, key, submit };
  }

  await t.test('pages render with a matching CSP nonce, no inline handlers, and versioned script URL', async () => {
    for (const p of ['/admin/dashboard', '/admin/bom-recipes']) {
      const { res, html, $$ } = await open(p);
      assert.equal(res.status, 200);
      const csp = res.headers.get('content-security-policy');
      const nonce = /'nonce-([^']+)'/.exec(csp)[1];
      assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), 'scripts never get unsafe-inline');
      assert.ok(!/fonts\.googleapis/.test(csp), 'system font only: no font CDN allowed');
      const inline = $$('script:not([src])').filter((s) => s.type !== 'application/json');
      assert.ok(inline.length >= 2 && inline.every((s) => s.getAttribute('nonce') === nonce), 'every inline script carries the nonce');
      assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline event handlers (would be blocked by CSP)');
      assert.match(html, /\/admin\/admin\.js\?v=[0-9a-f]{10}/);
      assert.match(html, /Times New Roman/);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.match(res.headers.get('x-robots-tag'), /noindex/);
    }
  });

  await t.test('layout contract: header/sidebar markup, active item, every module linked, sign-out form', async () => {
    const { $, $$ } = await open('/admin/bom-recipes');
    assert.equal($('#sidebar a[aria-current="page"]').textContent.trim(), 'Công thức (BOM)');
    assert.ok($('header nav[aria-label="Breadcrumb"] [aria-current="page"]'));
    assert.ok($('header [role="status"]').textContent.includes('Zalo'));
    assert.ok($('#quick-search') && $('#toast-region') && $('main#main'));
    assert.ok($$('.grid-cols-12').length >= 2);
    assert.equal($('aside#sidebar').className.includes('w-sidebar'), true);
    const hrefs = $$('#sidebar nav a').map((a) => a.getAttribute('href'));
    assert.deepEqual(hrefs, ['/admin/dashboard', '/admin/pos', '/admin/tables', '/admin/orders', '/admin/customers', '/admin/menu', '/admin/inventory', '/admin/bom-recipes', '/admin/receiving', '/admin/receipts', '/admin/suppliers', '/admin/expenses', '/admin/reports', '/admin/tax', '/admin/zalo', '/admin/settings', '/admin/backup']);
    assert.equal($$('#sidebar [aria-disabled]').length, 0, 'no "coming soon" placeholders left');
    const logout = $('#sidebar form[action="/admin/logout"]');
    assert.equal(logout.method, 'post');
    assert.ok($('input[name="_csrf"]', logout).value.length >= 16);
  });

  await t.test('mobile drawer: open -> page inert + aria-expanded + focus; Escape closes and restores', async () => {
    const { w, $, click, key } = await open('/admin/dashboard', { width: 390 });
    const menu = $('nav[aria-label="Điều hướng nhanh"] button[data-sidebar-toggle]');
    const sidebar = $('#sidebar');
    click(menu);
    assert.equal(sidebar.getAttribute('data-open'), 'true');
    assert.ok(sidebar.nextElementSibling.hasAttribute('inert'), 'content is inert while the drawer is open');
    assert.ok($('nav[aria-label="Điều hướng nhanh"]').hasAttribute('inert'));
    assert.equal(menu.getAttribute('aria-expanded'), 'true');
    assert.equal($('[data-sidebar-overlay]').hidden, false);
    assert.equal(w.document.activeElement.tagName, 'A');
    key(w.document.body, 'Escape');
    assert.equal(sidebar.getAttribute('data-open'), 'false');
    assert.ok(!sidebar.nextElementSibling.hasAttribute('inert'));
    assert.equal(menu.getAttribute('aria-expanded'), 'false');
    assert.equal(w.document.activeElement, menu, 'focus returns to the trigger');
    click(menu); click($('[data-sidebar-overlay]'));
    assert.equal(sidebar.getAttribute('data-open'), 'false');
  });

  await t.test('phone tab bar: main modules, current page highlighted', async () => {
    const { $, $$ } = await open('/admin/orders', { width: 390 });
    const bar = $('nav[aria-label="Điều hướng nhanh"]');
    assert.deepEqual($$('a', bar).map((a) => a.getAttribute('href')), ['/admin/dashboard', '/admin/orders', '/admin/inventory', '/admin/reports']);
    assert.equal($('a[aria-current="page"]', bar).getAttribute('href'), '/admin/orders');
  });

  await t.test('device tiers: phone / tablet / laptop / desktop and the saved sidebar preference', async () => {
    const tier = async (width) => { const { w } = await open('/admin/dashboard', { width }); return { dev: w.document.documentElement.dataset.device, sb: w.document.documentElement.dataset.sb }; };
    assert.deepEqual(await tier(375), { dev: 'phone', sb: 'collapsed' });
    assert.deepEqual(await tier(820), { dev: 'tablet', sb: 'collapsed' });
    assert.deepEqual(await tier(1100), { dev: 'desktop', sb: 'collapsed' }, 'laptop width: rail by default');
    assert.deepEqual(await tier(1440), { dev: 'desktop', sb: 'expanded' });

    const { w, $, click } = await open('/admin/dashboard', { width: 1440 });
    click($('[data-sidebar-collapse]'));
    assert.equal(w.document.documentElement.dataset.sb, 'collapsed');
    assert.equal(w.localStorage.getItem('cocoffee.sidebar'), 'collapsed');
    assert.equal($('[data-sidebar-collapse]').getAttribute('aria-expanded'), 'false');
    click($('[data-sidebar-collapse]'));
    assert.equal(w.document.documentElement.dataset.sb, 'expanded');
    w.localStorage.setItem('cocoffee.sidebar', 'expanded');
    Object.defineProperty(w, 'innerWidth', { value: 800, configurable: true });
    w.dispatchEvent(new w.Event('resize'));
    await new Promise((r) => w.requestAnimationFrame(r));
    assert.equal(w.document.documentElement.dataset.sb, 'collapsed');
    assert.equal(w.document.documentElement.dataset.device, 'tablet');
  });

  await t.test('BOM tabs are server-side links: drinks by default, retail on ?tab=retail', async () => {
    const { $, $$ } = await open('/admin/bom-recipes');
    const group = $('[aria-label="Loại món"]');
    const [drinks, retail] = $$('a', group);
    assert.equal(drinks.getAttribute('aria-current'), 'page');
    assert.equal(retail.getAttribute('aria-current'), null);
    assert.equal(retail.getAttribute('href'), '/admin/bom-recipes?tab=retail');
    const page = await open('/admin/bom-recipes?tab=retail');
    const tabs = page.$$('a', page.$('[aria-label="Loại món"]'));
    assert.equal(tabs[1].getAttribute('aria-current'), 'page');
    assert.equal(page.$$('tbody tr[data-row]').length, 1);
  });

  await t.test('BOM page shows real counts: drinks vs retail, and the missing-recipe warning', async () => {
    const { $, $$ } = await open('/admin/bom-recipes');
    assert.equal($$('tbody tr[data-row]').length, 2);
    assert.match($('tbody').textContent, /Chưa có định mức/);
    const group = $('[aria-label="Loại món"]');
    assert.match($$('a', group)[0].textContent, /Đồ uống pha chế\s*2/);
    assert.match($$('a', group)[1].textContent, /Hàng bán lẻ\s*1/);
    const retail = await open('/admin/bom-recipes?tab=retail');
    assert.ok(!retail.$('[data-recipe-open="edit"]'), 'retail rows are not editable here');
    assert.equal(retail.$$('tbody tr[data-row] td')[0].textContent.trim(), '1', 'STT column');
  });

  await t.test('search is server-side and diacritic-insensitive (names and ingredients); missing-only filter', async () => {
    const { $, $$ } = await open('/admin/bom-recipes?q=ca%20phe%20sua');       // typed without diacritics, data has "Cà phê sữa đá"
    assert.equal($$('tbody tr[data-row]').length, 1);
    assert.match($('tbody').textContent, /Cà phê sữa đá/);
    assert.equal($('#bom-q').value, 'ca phe sua');
    assert.equal((await open('/admin/bom-recipes?q=ly%20nhua')).$$('tbody tr[data-row]').length, 1, 'ingredient search');
    const none = await open('/admin/bom-recipes?q=zzz');
    assert.equal(none.$$('tbody tr[data-row]').length, 0);
    assert.ok(none.$('tr[data-empty]'));
    const missing = await open('/admin/bom-recipes?missing=1');
    assert.equal(missing.$$('tbody tr[data-row]').length, 1);
    assert.match(missing.$('tbody').textContent, /Chưa có định mức/);
    const { w } = await open('/admin/bom-recipes');
    assert.ok(w.CoCoffee && typeof w.CoCoffee.toast === 'function');
  });

  await t.test('recipe dialog: edit prefills, cost calculator, add/remove lines, validation, real POST payload', async () => {
    const { w, $, $$, click, type, submit } = await open('/admin/bom-recipes');
    const dlg = $('#recipe-dialog');
    const form = $('#recipe-form');
    click($('tbody tr[data-row] [data-recipe-open="edit"]'));   // Cà phê sữa đá: 18g coffee + 1 cup
    assert.ok(dlg.hasAttribute('open'));
    assert.equal($('#recipe-title').textContent, 'Sửa công thức');
    assert.equal(form.getAttribute('action'), '/admin/bom-recipes/1');
    assert.equal(form.getAttribute('method'), 'post');
    assert.equal($('#f-name').value, 'Cà phê sữa đá');
    assert.equal($('#f-sku').readOnly, true, 'SKU is fixed once created');
    assert.equal($('#f-price').value, '25000');
    assert.equal($('#f-category').value, '1');
    assert.equal($$('[data-line]', dlg).length, 2);
    assert.equal($('[data-cogs]', dlg).textContent, '5.940đ');
    assert.equal($('[data-profit]', dlg).textContent, '19.060đ');
    assert.equal($('[data-margin]', dlg).textContent, '76,2%');
    assert.match($('[data-margin]', dlg).className, /text-green-700/);

    type($('#f-price'), '8000');                                              // margin drops below 55% -> red
    assert.match($('[data-margin]', dlg).className, /text-red-700/);
    type($('#f-price'), '25000');

    type($('[data-line-qty]', dlg), '36');                                    // 36g coffee = 10.080đ + 900đ
    assert.equal($('[data-cogs]', dlg).textContent, '10.980đ');

    click($('[data-line-add]', dlg));
    assert.equal($$('[data-line]', dlg).length, 3);
    click($('[data-line-remove]', $$('[data-line]', dlg)[2]));
    assert.equal($$('[data-line]', dlg).length, 2);

    type($('#f-name'), '');                                                   // required field blocks the POST
    assert.equal(submit(form), false, 'invalid form is cancelled');
    type($('#f-name'), 'Cà phê sữa đá');
    assert.equal(submit(form), true, 'valid form is NOT cancelled: the browser posts it');
    assert.deepEqual(JSON.parse($('#f-recipe').value), [{ inventory_item_id: 1, quantity: 36 }, { inventory_item_id: 3, quantity: 1 }]);

    type($$('[data-line-qty]', dlg)[0], ''); type($$('[data-line-qty]', dlg)[1], '');   // all quantities empty
    assert.equal(submit(form), false);
    assert.match($('#toast-region').textContent, /ít nhất một nguyên liệu/);

    click($('[data-recipe-open="create"]'));                                  // create mode: blank form, collection URL
    assert.equal($('#recipe-title').textContent, 'Thêm công thức');
    assert.equal(form.getAttribute('action'), '/admin/bom-recipes');
    assert.equal($('#f-sku').readOnly, false);
    assert.equal($('#f-name').value, '');
    assert.equal(w.document.activeElement, $('#f-name'));
    assert.ok([...$('[data-line-ref]', dlg).options].some((o) => o.textContent === 'Sữa tươi'), 'ingredients come from the inventory');
  });

  await t.test('destructive forms ask first: confirm dialog names the action, OK submits, Cancel does not', async () => {
    const { w, $, click } = await open('/admin/bom-recipes');
    const form = $('tbody tr[data-row] form[data-confirm]');
    assert.equal(form.getAttribute('action'), '/admin/bom-recipes/1/delete');
    assert.ok($('input[name="_csrf"]', form).value);
    click($('button[type="submit"]', form));
    assert.ok($('#confirm-dialog').hasAttribute('open'));
    assert.match($('[data-confirm-text]').textContent, /Cà phê sữa đá/);
    assert.deepEqual(w.__submitted, [], 'nothing is sent before the user agrees');
    click($('#confirm-dialog [data-modal-close]'));
    assert.deepEqual(w.__submitted, []);
    click($('button[type="submit"]', form));
    click($('[data-confirm-ok]'));
    assert.ok(!$('#confirm-dialog').hasAttribute('open'));
    assert.deepEqual(w.__submitted, ['/admin/bom-recipes/1/delete']);
  });

  await t.test('generic form dialogs: create resets, edit prefills (text, select, checkbox pair) and sets action/title', async () => {
    const { $, $$, click } = await open('/admin/inventory');
    const dlg = $('#item-dialog');
    const form = $('form', dlg);
    const edit = $$('[data-modal-open="#item-dialog"]').find((b) => b.getAttribute('data-action') === '/admin/inventory/2');
    click(edit);
    assert.ok(dlg.hasAttribute('open'));
    assert.equal(form.getAttribute('action'), '/admin/inventory/2');
    assert.equal($('[data-dialog-title]', dlg).textContent, 'Sửa nguyên liệu');
    assert.equal($('#i-name').value, 'Sữa tươi');
    assert.equal($('#i-unit').value, 'ml');
    assert.equal($('#i-min').value, '500');
    assert.equal($('#i-sku').readOnly, true);
    assert.equal($('[data-new-only]', dlg).style.display, 'none', 'opening balance is only for new items');
    assert.equal($('input[type="checkbox"][name="is_active"]', dlg).checked, true);
    click($('[data-modal-close]', dlg));

    click($('[data-modal-open="#item-dialog"][data-action="/admin/inventory"]'));
    assert.equal(form.getAttribute('action'), '/admin/inventory');
    assert.equal($('[data-dialog-title]', dlg).textContent, 'Thêm nguyên liệu');
    assert.equal($('#i-name').value, '', 'reset after a previous edit');
    assert.equal($('#i-sku').readOnly, false);
    assert.notEqual($('[data-new-only]', dlg).style.display, 'none');
  });

  await t.test('inventory page: low-stock link, status badges, and search', async () => {
    const { $, $$, type } = await open('/admin/inventory');
    assert.match($('section[aria-label="Tóm tắt"] a[href="/admin/inventory?low=1"]').textContent, /1/);
    const rows = () => $$('tbody tr[data-row]').filter((r) => !r.hidden);
    assert.equal(rows().length, 3);
    assert.equal($('#inv-filter').form.getAttribute('method'), 'get', 'search is a server-side form (the list is paginated)');
    assert.equal($('#inv-filter').getAttribute('name'), 'q');
    const found = await open('/admin/inventory?q=sua');
    const hits = found.$$('tbody tr[data-row]');
    assert.equal(hits.length, 1);
    assert.match(hits[0].textContent, /Sắp hết/);
    assert.equal(found.$('#inv-filter').value, 'sua');
  });

  await t.test('notifications dropdown lists real alerts with links; toggles, closes on outside click and Escape', async () => {
    const { w, $, $$, click, key } = await open('/admin/dashboard');
    const bell = $('[data-dropdown="#notif-panel"]');
    const panel = $('#notif-panel');
    assert.ok($$('a', panel).some((a) => /Sữa tươi dưới mức tồn tối thiểu/.test(a.textContent) && a.getAttribute('href') === '/admin/inventory?low=1'));
    assert.ok($$('a', panel).some((a) => /Bill Zalo gửi lỗi/.test(a.textContent) && a.getAttribute('href') === '/admin/orders/42'));
    click(bell);
    assert.equal(panel.hidden, false);
    assert.equal(bell.getAttribute('aria-expanded'), 'true');
    click(w.document.body);
    assert.equal(panel.hidden, true);
    click(bell); key(w.document.body, 'Escape');
    assert.equal(panel.hidden, true);
  });
});
