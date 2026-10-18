#!/usr/bin/env node
/**
 * Trang cấp phép của nhà cung cấp, chạy TRÊN MÁY CỦA BẠN (chỉ nghe ở 127.0.0.1): nhập mã máy khách gửi, chọn số ngày và tính năng,
 * bấm cấp: ra mã kích hoạt để gửi lại. Lưu danh sách đã cấp để gia hạn / đánh dấu thu hồi. Khóa riêng không rời khỏi máy này.
 *
 *   node scripts/license-server.js [--port 4000] [--dir D:\FNB-secrets]
 *   mở  http://127.0.0.1:4000/   (đăng nhập: tài khoản "admin", mật khẩu in ra khi chạy hoặc đặt LICENSE_ADMIN_PASSWORD)
 *
 * Ghi chú thu hồi: mã kích hoạt kiểm tra offline nên "thu hồi" ở đây là đánh dấu trong sổ + không gia hạn nữa; mã cũ vẫn chạy đến hết hạn.
 * Muốn khóa tức thì cần kiểm tra trực tuyến (bước sau). Hãy cấp hạn ngắn (30-90 ngày) cho khách chưa tin cậy.
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const core = require('./license-core');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dmy = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`; };

function createServer({ dir, privateKeyFile, password, now = () => new Date() }) {
  const dbFile = path.join(dir, 'license-db.json');
  const priv = core.loadPrivate(privateKeyFile);
  const csrf = crypto.randomBytes(18).toString('hex');
  const readDb = () => { try { return JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch (_) { return { licenses: [] }; } };
  const writeDb = (db) => { fs.mkdirSync(dir, { recursive: true }); const tmp = `${dbFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 }); fs.renameSync(tmp, dbFile); };

  function statusOf(l) {
    if (l.status === 'revoked') return ['Đã thu hồi', '#B91C1C'];
    if (l.status === 'replaced') return ['Đã được thay bằng mã mới', '#6B7280'];
    const left = Math.ceil((new Date(l.expires) - now()) / 86400000);
    if (left < 0) return ['Hết hạn', '#B91C1C'];
    if (left <= 14) return [`Sắp hết hạn (còn ${left} ngày)`, '#B45309'];
    return [`Còn hạn (${left} ngày)`, '#047857'];
  }

  function page(message = '', error = '', prefill = {}) {
    const db = readDb();
    const rows = [...db.licenses].reverse().map((l) => {
      const [label, color] = statusOf(l);
      const active = l.status === 'active';
      return `<tr><td><b>${esc(l.customer)}</b><br><small>${esc(l.note || '')}</small></td><td class="mono">${esc(l.machine)}</td><td>${dmy(l.issued)}</td><td>${dmy(l.expires)}</td>
        <td>${esc(l.features.join(', '))}</td><td style="color:${color};font-weight:600">${esc(label)}</td>
        <td><details><summary>Mã</summary><textarea readonly rows="4" onclick="this.select()">${esc(l.code)}</textarea></details>
        ${active ? `<form method="post" action="/renew" class="inline"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${esc(l.id)}"><input name="days" size="4" value="365" aria-label="ngày"> <button>Gia hạn</button></form>
        <form method="post" action="/revoke" class="inline" onsubmit="return confirm('Đánh dấu thu hồi?')"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${esc(l.id)}"><button class="danger">Thu hồi</button></form>` : ''}</td></tr>`;
    }).join('');
    return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cấp phép · POS Tasotek</title>
<style>body{font:15px/1.5 "Times New Roman",serif;background:#FAF8F5;color:#1f1f1f;margin:0}header{background:#172554;color:#fff;padding:14px 20px}main{max-width:1100px;margin:0 auto;padding:18px}
.card{background:#fff;border:1px solid #E8E3DA;border-radius:10px;padding:16px;margin-bottom:16px}label{display:block;font-weight:600;margin:10px 0 3px}input,select{padding:7px 9px;border:1px solid #D6CFC3;border-radius:6px;font:inherit}
input.wide{width:100%;box-sizing:border-box}button{background:#1E3A8A;color:#fff;border:0;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer}button.danger{background:#B91C1C}
.mono{font-family:Consolas,monospace;font-size:13px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #E8E3DA;vertical-align:top}th{font-size:13px;color:#555}
.ok{background:#D1FAE5;padding:10px;border-radius:6px}.err{background:#FEE2E2;color:#B91C1C;padding:10px;border-radius:6px}form.inline{display:inline}textarea{width:420px;max-width:100%;font:12px Consolas,monospace}.row{display:flex;gap:12px;flex-wrap:wrap}.row>div{flex:1;min-width:180px}</style></head>
<body><header><b>Cấp phép POS Tasotek Server</b> · chạy trên máy này, khóa riêng không rời máy</header><main>
${message ? `<p class="ok">${message}</p>` : ''}${error ? `<p class="err">${esc(error)}</p>` : ''}
<section class="card"><h2 style="margin-top:0">Cấp mã mới</h2>
<form method="post" action="/issue" autocomplete="off"><input type="hidden" name="csrf" value="${csrf}">
<label for="machine">Mã máy (khách copy ở tab Giấy phép của chương trình)</label><input class="wide mono" id="machine" name="machine" required value="${esc(prefill.machine || '')}" placeholder="A1B2-C3D4-E5F6-0718-293A-4B5C-6D7E-8F90">
<div class="row"><div><label for="customer">Khách hàng</label><input class="wide" id="customer" name="customer" required maxlength="80" value="${esc(prefill.customer || '')}"></div>
<div><label for="days">Số ngày hiệu lực</label><input class="wide" id="days" name="days" type="number" min="1" max="3660" value="${esc(prefill.days || 365)}"></div></div>
<label>Tính năng</label>${core.FEATURES.map((f) => `<label style="display:inline;font-weight:400;margin-right:14px"><input type="checkbox" name="features" value="${f}" ${f === 'pos' ? 'checked' : ''}> ${f}</label>`).join('')}
<label for="note">Ghi chú nội bộ (không nằm trong mã)</label><input class="wide" id="note" name="note" maxlength="120">
<p><button>Cấp mã</button></p></form></section>
<section class="card"><h2 style="margin-top:0">Đã cấp (${db.licenses.length})</h2>
<table><thead><tr><th>Khách</th><th>Mã máy</th><th>Cấp</th><th>Hết hạn</th><th>Tính năng</th><th>Trạng thái</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7">Chưa cấp mã nào.</td></tr>'}</tbody></table></section>
</main></body></html>`;
  }

  const send = (res, status, body, type = 'text/html; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'" }); res.end(body); };

  const authOk = (req) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return false;
    const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
    const given = Buffer.from(p.join(':'));
    const want = Buffer.from(password);
    return u === 'admin' && given.length === want.length && crypto.timingSafeEqual(given, want);
  };

  async function body(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) { n += c.length; if (n > 20000) throw new core.LicenseError('Dữ liệu gửi lên quá lớn.'); chunks.push(c); }
    const p = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const out = {};
    for (const [k, v] of p) out[k] = k in out ? [].concat(out[k], v) : v;
    return out;
  }

  function issueFor(db, { machine, customer, days, features, note, replaces }) {
    const payload = core.buildPayload({ machine, customer, days, features, now: now() });
    const code = core.sign(payload, priv);
    const rec = { id: crypto.randomBytes(6).toString('hex'), customer: payload.customer, machine: payload.machine, issued: payload.issued, expires: payload.expires, features: payload.features, note: String(note || '').slice(0, 120), status: 'active', code };
    if (replaces) for (const l of db.licenses) if (l.id === replaces) l.status = 'replaced';
    db.licenses.push(rec);
    return rec;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host || '').split(':')[0];
      if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, 'Forbidden', 'text/plain');
      if (!authOk(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Cap phep"' }); return res.end('Can dang nhap'); }
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, page());
      if (req.method !== 'POST') return send(res, 404, 'Not found', 'text/plain');
      const origin = req.headers.origin || req.headers.referer || '';
      if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, 'Forbidden', 'text/plain');
      const b = await body(req);
      if (b.csrf !== csrf) return send(res, 403, page('', 'Phiên không hợp lệ, tải lại trang.'));
      const db = readDb();
      if (url.pathname === '/issue') {
        const rec = issueFor(db, { machine: b.machine, customer: b.customer, days: b.days, features: b.features, note: b.note });
        writeDb(db);
        return send(res, 200, page(`Đã cấp mã cho <b>${esc(rec.customer)}</b> (hết hạn ${dmy(rec.expires)}). Mở "Mã" ở dòng đầu bảng để sao chép.`));
      }
      if (url.pathname === '/renew' || url.pathname === '/revoke') {
        const l = db.licenses.find((x) => x.id === b.id && x.status === 'active');
        if (!l) return send(res, 200, page('', 'Không tìm thấy mã còn hiệu lực.'));
        if (url.pathname === '/revoke') { l.status = 'revoked'; writeDb(db); return send(res, 200, page(`Đã đánh dấu thu hồi mã của <b>${esc(l.customer)}</b>.`)); }
        const rec = issueFor(db, { machine: l.machine, customer: l.customer, days: b.days, features: l.features, note: l.note, replaces: l.id });
        writeDb(db);
        return send(res, 200, page(`Đã gia hạn cho <b>${esc(rec.customer)}</b> đến ${dmy(rec.expires)} (mã mới ở đầu bảng).`));
      }
      return send(res, 404, 'Not found', 'text/plain');
    } catch (err) {
      const known = err instanceof core.LicenseError;
      send(res, known ? 400 : 500, page('', known ? err.message : 'Lỗi không mong muốn, xem cửa sổ dòng lệnh.', {}));
      if (!known) console.error(err);
    }
  });
  return { server, csrf, dbFile };
}

module.exports = { createServer };

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
  const dir = arg('dir', 'D:\\FNB-secrets');
  const keyFile = path.join(dir, 'license-private.pem');
  if (!fs.existsSync(keyFile)) { console.error(`Chưa có khóa riêng ${keyFile}. Chạy trước: node scripts/license-tool.js keygen`); process.exit(1); }
  const password = process.env.LICENSE_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const port = Number(arg('port', '4000'));
  const { server } = createServer({ dir, privateKeyFile: keyFile, password });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Trang cấp phép: http://127.0.0.1:${port}/`);
    console.log(`Đăng nhập: admin / ${password}${process.env.LICENSE_ADMIN_PASSWORD ? '' : '   (mật khẩu tạm, đổi mỗi lần chạy; đặt LICENSE_ADMIN_PASSWORD để cố định)'}`);
    console.log(`Sổ đã cấp: ${path.join(dir, 'license-db.json')}   (Ctrl+C để dừng)`);
  });
}
