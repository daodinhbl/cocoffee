const env = require('../../config/env');
const { formatVnd } = require('../../utils/text');
const { shopDay, dayBounds } = require('../../utils/shopTime');
const customerModel = require('../../models/customerModel');
const customerQuery = require('../customerQueryService');
const receiptImage = require('../receiptImage');

/**
 * Debt statements for the chatbot (the "bảng đối chiếu công nợ" of the Web Admin, sent over Zalo):
 *   - a customer, in a private chat, gets THEIR statement: opening balance, every debt / payment of the period, closing balance;
 *   - the shop owner (the chat set as "nhận thông báo công nợ") gets the reconciliation of ALL customers:
 *     opening / increase / decrease / closing per customer.
 * Each is a text summary plus a table picture (receiptImage.renderTable).
 */
const money = (n) => `${formatVnd(Math.round(Number(n) || 0))}đ`;
const dmy = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
const TYPE = { debt: 'Phát sinh nợ', payment: 'Thu nợ', adjust: 'Điều chỉnh' };
const METHOD = { cash: 'tiền mặt', transfer: 'chuyển khoản', card: 'thẻ', other: 'khác' };

/**
 * "tháng trước", "tháng 9", "tất cả", "năm nay", "gan day" (3 months); anything else (and nothing) is this month so far.
 * @param {string} text already normalized (no accents, lower case)
 * @returns {{ from: string, to: string, label: string }} shop days, inclusive
 */
function periodFromText(text = '', now = new Date()) {
  const today = shopDay(now);
  const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const pad = (n) => String(n).padStart(2, '0');
  const monthRange = (y, m) => {
    const from = `${y}-${pad(m)}-01`;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const to = `${y}-${pad(m)}-${pad(last)}`;
    return { from, to: to > today ? today : to };
  };
  const t = String(text);
  let r;
  let name;
  if (/\btat ca\b/.test(t)) { r = { from: '2000-01-01', to: today }; name = 'Tất cả'; }
  else if (/\bgan day\b/.test(t)) {           // what a plain "công nợ" shows: this month and the two before
    const back = new Date(Date.UTC(year, month - 3, 1));
    r = { from: `${back.getUTCFullYear()}-${pad(back.getUTCMonth() + 1)}-01`, to: today };
    name = '3 tháng gần đây';
  }
  else if (/\bnam nay\b/.test(t)) { r = { from: `${year}-01-01`, to: today }; name = `Năm ${year}`; }
  else if (/\bthang truoc\b/.test(t)) {
    const y = month === 1 ? year - 1 : year;
    const m = month === 1 ? 12 : month - 1;
    r = monthRange(y, m);
    name = `Tháng ${m}/${y}`;
  } else {
    const m = /\bthang (\d{1,2})\b/.exec(t);
    const n = m ? Number(m[1]) : 0;
    if (n >= 1 && n <= 12) {
      const y = n > month ? year - 1 : year;           // "tháng 11" asked in October is last year's
      r = monthRange(y, n);
      name = `Tháng ${n}/${y}`;
    } else {
      r = { from: `${today.slice(0, 8)}01`, to: today };
      name = `Tháng ${month}/${year}`;
    }
  }
  return { ...r, label: `${name} (${dmy(r.from)} - ${dmy(r.to)})` };
}

const bounds = (p) => dayBounds(p.from, p.to);

/** Ledger line text: "Nợ đơn CF…" / "Thu nợ (chuyển khoản)". */
function entryText(e) {
  const note = e.note && !/^(Nợ đơn|Thu nợ đơn) /.test(e.note) && e.note !== 'Thu nợ' ? ` - ${e.note}` : '';
  return `${TYPE[e.entry_type] || e.entry_type}${e.order_code ? ` đơn ${e.order_code}` : ''}${e.method ? ` (${METHOD[e.method] || e.method})` : ''}${note}`;
}

const dayOf = (d) => { const t = new Date(new Date(d).getTime() + 7 * 3600 * 1000).toISOString(); return `${t.slice(8, 10)}/${t.slice(5, 7)}`; };

/** Everything for one customer's statement. */
async function loadCustomer(customerId, period) {
  const [customer, st] = await Promise.all([customerModel.getById(customerId), customerModel.statement(customerId, bounds(period).from, bounds(period).to)]);
  return { customer, st };
}

function customerText(customer, period, st) {
  const lines = [
    '📋 BẢNG ĐỐI CHIẾU CÔNG NỢ',
    `Cửa hàng: ${env.business.shopName}`,
    `Khách hàng: ${customer.name}`,
    `Kỳ: ${period.label}`,
    `Nợ đầu kỳ: ${money(st.opening)}`,
    `Phát sinh nợ: ${money(st.increase)}`,
    `Đã thanh toán: ${money(st.decrease)}`,
    `Nợ cuối kỳ: ${money(st.closing)}`,
  ];
  if (!st.entries.length) lines.push('Không có phát sinh trong kỳ.');
  return lines.join('\n');
}

/** The same table as text, for channels that cannot send the picture (last `limit` lines). */
function customerTableText(st, limit = 12) {
  const shown = st.entries.slice(-limit);
  const lines = shown.map((e) => `${dayOf(e.created_at)} ${entryText(e)}: ${e.amount > 0 ? '+' : '-'}${money(Math.abs(e.amount))} (còn ${money(e.balance)})`);
  if (st.entries.length > shown.length) lines.unshift(`… ${st.entries.length - shown.length} dòng trước đó`);
  return lines.join('\n');
}

async function customerPng({ customerId, from, to }) {
  const period = { from, to, label: `${dmy(from)} - ${dmy(to)}` };
  const { customer, st } = await loadCustomer(customerId, period);
  if (!customer) return null;
  const rows = [{ cells: ['', '', 'Nợ đầu kỳ', '', '', money(st.opening)], bold: true, shade: '#f3f4f6' }];
  st.entries.forEach((e, i) => rows.push({ cells: [String(i + 1), dayOf(e.created_at), entryText(e), e.amount > 0 ? money(e.amount) : '', e.amount < 0 ? money(-e.amount) : '', money(e.balance)] }));
  if (!st.entries.length) rows.push({ cells: ['', '', 'Không có phát sinh trong kỳ', '', '', ''] });
  rows.push({ cells: ['', '', 'Cộng phát sinh trong kỳ', money(st.increase), money(st.decrease), ''], bold: true, shade: '#f3f4f6' });
  rows.push({ cells: ['', '', 'Nợ cuối kỳ', '', '', money(st.closing)], bold: true, shade: '#e5e7eb' });
  return receiptImage.renderTable({
    width: 760,
    shopName: env.business.shopName,
    title: 'BẢNG ĐỐI CHIẾU CÔNG NỢ',
    lines: [`Khách hàng: ${customer.name}${customer.phone ? ` · ${customer.phone}` : ''}`, `Kỳ: ${dmy(from)} - ${dmy(to)}`],
    columns: [
      { label: 'STT', w: 8, align: 'center' }, { label: 'Ngày', w: 9, align: 'center' }, { label: 'Diễn giải', w: 31 },
      { label: 'Phát sinh nợ', w: 17, align: 'right' }, { label: 'Đã thanh toán', w: 17, align: 'right' }, { label: 'Còn nợ', w: 17, align: 'right' },
    ],
    rows,
    notes: ['Nợ cuối kỳ là số tiền khách còn phải trả cho cửa hàng.'],
    maxRows: 60,
    keepLast: true,
  });
}

/** Reconciliation of all customers for the owner. */
async function loadAll(period) {
  return customerQuery.reconciliation({ from: period.from, to: period.to });
}

function allText(period, data) {
  const debtors = data.rows.filter((r) => r.closing > 0);
  const lines = [
    '📋 ĐỐI CHIẾU CÔNG NỢ',
    `Cửa hàng: ${env.business.shopName}`,
    `Kỳ: ${period.label}`,
    `Nợ đầu kỳ: ${money(data.totals.opening)} · Phát sinh: ${money(data.totals.increase)} · Đã thu: ${money(data.totals.decrease)}`,
    `Nợ cuối kỳ: ${money(data.totals.closing)} (${debtors.length} khách còn nợ)`,
  ];
  debtors.slice(0, 15).forEach((r, i) => lines.push(`${i + 1}. ${r.name}: ${money(r.closing)}`));
  if (debtors.length > 15) lines.push(`… và ${debtors.length - 15} khách nữa (xem bảng)`);
  if (!data.rows.length) lines.push('Không có phát sinh công nợ trong kỳ.');
  return lines.join('\n');
}

async function allPng({ from, to }) {
  const period = { from, to };
  const data = await loadAll(period);
  const rows = data.rows.map((r, i) => ({ cells: [String(i + 1), r.name, money(r.opening), money(r.increase), money(r.decrease), money(r.closing)] }));
  if (!rows.length) rows.push({ cells: ['', 'Không có phát sinh công nợ trong kỳ', '', '', '', ''] });
  rows.push({ cells: ['', 'Tổng cộng', money(data.totals.opening), money(data.totals.increase), money(data.totals.decrease), money(data.totals.closing)], bold: true, shade: '#e5e7eb' });
  return receiptImage.renderTable({
    width: 860,
    shopName: env.business.shopName,
    title: 'BẢNG ĐỐI CHIẾU CÔNG NỢ',
    lines: [`Kỳ: ${dmy(from)} - ${dmy(to)}`],
    columns: [
      { label: 'STT', w: 7, align: 'center' }, { label: 'Khách hàng', w: 25 }, { label: 'Nợ đầu kỳ', w: 17, align: 'right' },
      { label: 'Phát sinh nợ', w: 17, align: 'right' }, { label: 'Đã thanh toán', w: 17, align: 'right' }, { label: 'Nợ cuối kỳ', w: 17, align: 'right' },
    ],
    rows,
    notes: ['Sắp xếp theo nợ cuối kỳ giảm dần.'],
    maxRows: 80,
  });
}

module.exports = { periodFromText, entryText, loadCustomer, customerText, customerTableText, customerPng, loadAll, allText, allPng, bounds, dmy };
