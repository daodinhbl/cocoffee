/**
 * DOM-level tests for the Web Admin: real server-rendered HTML (EJS) + the real public/admin/admin.js,
 * driven inside jsdom. No database needed (Zalo is left unconfigured, so the header never queries MySQL).
 * Skips itself when jsdom (a devDependency) is not installed.
 */
process.env.FNB_NO_LISTEN = '1';
process.env.DB_NAME ||= 'x'; process.env.DB_USER ||= 'x'; process.env.DB_PASSWORD ||= 'x';
process.env.ZALO_APP_ID = ''; process.env.ZALO_OA_SECRET_KEY = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (_) { /* devDependency not installed */ }
const suite = JSDOM ? test : test.skip;

const ADMIN_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'admin.js'), 'utf8');

suite('admin UI (jsdom)', async (t) => {
  const app = require('../app');
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  /** Render a page through Express, load it into jsdom and run admin.js against it. */
  async function open(pathname, { width = 1400 } = {}) {
    const res = await fetch(base + pathname);
    const html = await res.text();
    const dom = new JSDOM(html, { url: base + pathname, runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    Object.defineProperty(w, 'innerWidth', { value: width, configurable: true });
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    // jsdom has no layout and no <dialog> modal behaviour: model just enough of both
    Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', { get() { return this.closest('[hidden]') ? null : this.parentNode; } });
    w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    w.eval(ADMIN_JS);
    const $ = (s, r) => (r || w.document).querySelector(s);
    const $$ = (s, r) => Array.from((r || w.document).querySelectorAll(s));
    const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    const type = (el, value) => { el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
    const key = (el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    return { res, html, w, $, $$, click, type, key };
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

  await t.test('layout contract: header/sidebar markup, active item, 12-col grid, partial includes', async () => {
    const { $, $$ } = await open('/admin/bom-recipes');
    assert.equal($('#sidebar a[aria-current="page"]').textContent.trim(), 'Công thức (BOM)');
    assert.ok($('header nav[aria-label="Breadcrumb"] [aria-current="page"]'));
    assert.ok($('header [role="status"]').textContent.includes('Zalo'));
    assert.ok($('#quick-search') && $('#toast-region') && $('main#main'));
    assert.ok($$('.grid-cols-12').length >= 2);
    assert.equal($('#sidebar .w-sidebar, aside#sidebar').className.includes('w-sidebar'), true);
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
    // overlay tap closes too
    click(menu); click($('[data-sidebar-overlay]'));
    assert.equal(sidebar.getAttribute('data-open'), 'false');
  });

  await t.test('device tiers: phone / tablet / laptop / desktop and the saved sidebar preference', async () => {
    const tier = async (width) => { const { w } = await open('/admin/dashboard', { width }); return { dev: w.document.documentElement.dataset.device, sb: w.document.documentElement.dataset.sb, w }; };
    assert.deepEqual([(await tier(375)).dev, (await tier(375)).sb], ['phone', 'collapsed']);
    assert.deepEqual([(await tier(820)).dev, (await tier(820)).sb], ['tablet', 'collapsed']);
    assert.deepEqual([(await tier(1100)).dev, (await tier(1100)).sb], ['desktop', 'collapsed'], 'laptop width: rail by default');
    assert.deepEqual([(await tier(1440)).dev, (await tier(1440)).sb], ['desktop', 'expanded']);

    // collapse toggle persists, and only matters at desktop widths
    const { w, $, click } = await open('/admin/dashboard', { width: 1440 });
    click($('[data-sidebar-collapse]'));
    assert.equal(w.document.documentElement.dataset.sb, 'collapsed');
    assert.equal(w.localStorage.getItem('cocoffee.sidebar'), 'collapsed');
    assert.equal($('[data-sidebar-collapse]').getAttribute('aria-expanded'), 'false');
    click($('[data-sidebar-collapse]'));
    assert.equal(w.document.documentElement.dataset.sb, 'expanded');
    // a saved "expanded" preference must NOT force the wide sidebar onto a tablet
    w.localStorage.setItem('cocoffee.sidebar', 'expanded');
    Object.defineProperty(w, 'innerWidth', { value: 800, configurable: true });
    w.dispatchEvent(new w.Event('resize'));
    await new Promise((r) => w.requestAnimationFrame(r));
    assert.equal(w.document.documentElement.dataset.sb, 'collapsed');
    assert.equal(w.document.documentElement.dataset.device, 'tablet');
  });

  await t.test('tabs: click + arrow keys keep ARIA state and panel visibility in sync', async () => {
    const { $, click, key } = await open('/admin/bom-recipes');
    const [drinks, combo] = [$('#tab-drinks'), $('#tab-combo')];
    assert.equal(drinks.getAttribute('aria-selected'), 'true');
    assert.equal($('#panel-combo').hidden, true);
    click(combo);
    assert.equal(combo.getAttribute('aria-selected'), 'true');
    assert.equal(combo.tabIndex, 0);
    assert.equal(drinks.tabIndex, -1);
    assert.equal($('#panel-drinks').hidden, true);
    assert.equal($('#panel-combo').hidden, false);
    key(combo, 'ArrowLeft');
    assert.equal(drinks.getAttribute('aria-selected'), 'true');
    key(drinks, 'End');
    assert.equal(combo.getAttribute('aria-selected'), 'true');
    key(combo, 'Home');
    assert.equal(drinks.getAttribute('aria-selected'), 'true');
  });

  await t.test('filter: diacritic-insensitive, updates both counters, empty state, header search mirrors', async () => {
    const { w, $, $$, type } = await open('/admin/bom-recipes');
    const panel = $('#panel-drinks');
    const rows = () => $$('tbody tr[data-row]', panel).filter((r) => !r.hidden);
    assert.equal(rows().length, 5);
    type($('#filter-drinks'), 'tra dao');                 // typed without diacritics, data has "Trà đào"
    assert.equal(rows().length, 1);
    assert.match(rows()[0].textContent, /Trà đào/);
    assert.deepEqual($$('[data-count]', panel).map((n) => n.textContent), ['1', '1'], 'desktop + phone counters both update');
    type($('#filter-drinks'), 'sữa đặc');                 // ingredient search
    assert.equal(rows().length, 2);
    type($('#filter-drinks'), 'zzz');
    assert.equal(rows().length, 0);
    assert.equal($('[data-empty]', panel).hidden, false);
    type($('#quick-search'), '');                          // header search mirrors into the page filter and clears it
    assert.equal(rows().length, 5);
    assert.equal($('#filter-drinks').value, '');
    assert.equal($('[data-empty]', panel).hidden, true);
    assert.ok(w.CoCoffee && typeof w.CoCoffee.toast === 'function');
  });

  await t.test('recipe dialog: edit prefills, cost calculator, add/remove lines, validation, submit', async () => {
    const { w, $, $$, click, type } = await open('/admin/bom-recipes');
    const dlg = $('#recipe-dialog');
    click($('#panel-drinks tbody tr[data-row] [data-recipe-open="edit"]'));   // Cà phê đen đá (6.440đ COGS, 20.000đ)
    assert.ok(dlg.hasAttribute('open'));
    assert.equal($('#recipe-title').textContent, 'Sửa công thức');
    assert.equal($('#f-name').value, 'Cà phê đen đá');
    assert.equal($('#f-price').value, '20000');
    assert.equal($$('[data-line]', dlg).length, 4);
    assert.equal($('[data-cogs]', dlg).textContent, '6.440đ');
    assert.equal($('[data-profit]', dlg).textContent, '13.560đ');
    assert.equal($('[data-margin]', dlg).textContent, '67,8%');
    assert.match($('[data-margin]', dlg).className, /text-green-700/);

    type($('#f-price'), '8000');                                              // margin drops below 55% -> red
    assert.match($('[data-margin]', dlg).className, /text-red-700/);
    type($('#f-price'), '20000');

    const qty = $('[data-line-qty]', dlg);                                    // 18g coffee -> 36g = +5.040đ
    type(qty, '36');
    assert.equal($('[data-cogs]', dlg).textContent, '11.480đ');

    click($('[data-line-add]', dlg));
    assert.equal($$('[data-line]', dlg).length, 5);
    click($('[data-line-remove]', $$('[data-line]', dlg)[4]));
    assert.equal($$('[data-line]', dlg).length, 4);

    type($('#f-name'), '');                                                   // required field blocks submit
    $('#recipe-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    assert.ok(dlg.hasAttribute('open'), 'invalid form keeps the dialog open');
    type($('#f-name'), 'Cà phê đen đá');
    $('#recipe-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    assert.ok(!dlg.hasAttribute('open'));
    assert.match($('#toast-region').textContent, /Đã ghi nhận công thức/);

    // "+ Thêm Công thức" on the Combo tab switches the editor to products
    click($('#tab-combo'));
    click($('[data-recipe-open="create"]'));
    assert.equal($('#recipe-title').textContent, 'Thêm combo');
    assert.equal($('[data-lines-title]', dlg).textContent, 'Món trong combo');
    assert.ok([...$('[data-line-ref]', dlg).options].some((o) => o.textContent === 'Bạc xỉu'));
  });

  await t.test('delete: confirm dialog names the recipe; confirming removes the row and refreshes counts', async () => {
    const { $, $$, click } = await open('/admin/bom-recipes');
    const row = $('#panel-drinks tbody tr[data-row]');
    click($('[data-delete]', row));
    assert.ok($('#delete-dialog').hasAttribute('open'));
    assert.equal($('[data-delete-name]').textContent, 'Cà phê đen đá');
    click($('[data-delete-confirm]'));
    assert.ok(!$('#delete-dialog').hasAttribute('open'));
    assert.equal($$('#panel-drinks tbody tr[data-row]').length, 4);
    assert.equal($('#tab-drinks [data-tab-count]').textContent, '4');
    assert.match($('#toast-region').textContent, /Đã xóa công thức/);
  });

  await t.test('import dialog: submit stays disabled until a file is chosen', async () => {
    const { w, $, click } = await open('/admin/bom-recipes');
    click($('[data-modal-open="#import-dialog"]'));
    assert.ok($('#import-dialog').hasAttribute('open'));
    assert.equal($('[data-import-submit]').disabled, true);
    const input = $('#import-file');
    Object.defineProperty(input, 'files', { value: [{ name: 'dinh-muc.xlsx' }], configurable: true });
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal($('[data-file-name]').textContent, 'dinh-muc.xlsx');
    assert.equal($('[data-import-submit]').disabled, false);
  });

  await t.test('notifications dropdown toggles, closes on outside click and Escape', async () => {
    const { w, $, click, key } = await open('/admin/dashboard');
    const bell = $('[data-dropdown="#notif-panel"]');
    const panel = $('#notif-panel');
    click(bell);
    assert.equal(panel.hidden, false);
    assert.equal(bell.getAttribute('aria-expanded'), 'true');
    click(w.document.body);
    assert.equal(panel.hidden, true);
    click(bell); key(w.document.body, 'Escape');
    assert.equal(panel.hidden, true);
  });
});
