const { normalize, dice } = require('../../utils/text');

/**
 * Pure functions (no I/O): turn a customer's chat line into command / order items.
 *   "2 cf sua, 1 bac xiu va tra dao x2"  ->  items [{cf sua x2}, {bac xiu x1}, {tra dao x2}]
 */

const MAX_QTY = 50;
const NUMBER_WORDS = { mot: 1, hai: 2, ba: 3, bon: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10 };
const UNITS = new Set(['ly', 'chai', 'bao', 'goi', 'cai', 'lon', 'phan', 'coc']);
const LEADING_FILLER = new Set(['cho', 'lay', 'dat', 'order', 'minh', 'toi', 'em', 'anh', 'chi', 'shop', 'oa', 'xin', 'lam', 'oi']);
const TRAILING_FILLER = new Set(['nhe', 'nha', 'nhen', 'voi', 'nua', 'di', 'a', 'ah']);

// "ok" / "oke" (+ elongations and polite particles). Also "dong y", "xac nhan".
const CONFIRM_RE = /^(o+k+(e+|ie|ay|i)?|dong y|xac nhan)( (nhe|nha|nhen|em|a|ah|ban|shop))?$/;
const CANCEL_RE = /^(huy|huy don|huy het|cancel)( (nhe|nha|em))?$/;
const MENU_RE = /^(menu|thuc don|xem menu)$/;
const ID_RE = /^(id|chat id|ma chat|lay id|lay ma chat)$/;
// "check nợ", "xem công nợ", "mình còn nợ bao nhiêu"... The whole message must be the question, so an order
// such as "ghi nợ giúp mình 1 bạc xỉu" stays an order. A bare "nợ" is not taken: without accents it is "no".
const DEBT_RE = /^(?:check|xem|kiem tra|tra|hoi) ?(?:cong )?no(?: (?:cua )?(?:minh|toi|em|anh|chi))?(?: (?:nhe|nha|voi|a|shop))?$|^(?:cong no|so no)$|^(?:minh|toi|em|anh|chi) (?:con )?no(?: shop)? bao nhieu(?: (?:vay|the|a|nhi))?$/;

/** Questions answered from the shop's settings (services/zalo/chatbotInfo.js). Only used when no item matched. */
const FAQ = [
  { key: 'address', re: / (?:dia chi|o dau|cho nao|duong nao|map|ban do|address) / },
  { key: 'wifi', re: / (?:wifi|wi fi|pass(?:word)? wifi|mat khau wifi|pass wf) / },
  { key: 'bank', re: / (?:stk|so tai khoan|chuyen khoan|ngan hang|bank) / },   // not "ck": in chat it also means "chồng"
  { key: 'hours', re: / (?:may gio|gio mo cua|mo cua|dong cua|open) / },
];

// Drink options, removed from a segment before the product is matched and kept as the line note.
const OPTIONS = [
  { re: / (?:khong|ko|k|0) (?:duong|ngot) /, label: 'không đường' },
  { re: / it (?:duong|ngot) /, label: 'ít đường' },
  { re: / nhieu (?:duong|ngot) /, label: 'nhiều đường' },
  { re: / (?:khong|ko|k) da /, label: 'không đá' },
  { re: / it da /, label: 'ít đá' },
  { re: / (?:nhieu|them) da /, label: 'nhiều đá' },
  { re: / (?:da rieng|tach da) /, label: 'đá riêng' },
  { re: / (?:size|sz) ?(s|m|l) /, label: (m) => `size ${m[1].toUpperCase()}` },
  { re: / (?:ly|coc) (lon|nho) /, label: (m) => (m[1] === 'lon' ? 'size L' : 'size S') },
];

/** Zalo group mentions arrive as "[@id]" tokens. */
const stripMentions = (text) => String(text || '').replace(/\[@[^\]]*\]/g, ' ');

/** True when the message addresses someone ("@Bot ..." or a "[@id]" token): in groups the bot answers questions only then. */
const isMentioned = (text) => /\[@[^\]]*\]|^\s*@\S/.test(String(text || ''));

/** @returns {'identity'|'confirm'|'cancel'|'menu'|'debt'|null} */
function detectCommand(text) {
  const n = normalize(stripMentions(text));
  if (ID_RE.test(n)) return 'identity';
  if (CONFIRM_RE.test(n)) return 'confirm';
  if (CANCEL_RE.test(n)) return 'cancel';
  if (MENU_RE.test(n)) return 'menu';
  if (DEBT_RE.test(n)) return 'debt';
  return null;
}

/** @returns {'address'|'wifi'|'bank'|'hours'|null} */
function detectFaq(text) {
  const padded = ` ${normalize(stripMentions(text))} `;
  return (FAQ.find((f) => f.re.test(padded)) || {}).key || null;
}

/** "cf sữa đá ít đường size L" -> { rest: "cf sua da", note: "ít đường, size L" } */
function extractOptions(segment) {
  let rest = ` ${normalize(segment)} `;
  const found = [];
  for (const o of OPTIONS) {
    const m = o.re.exec(rest);
    if (!m) continue;
    found.push(typeof o.label === 'function' ? o.label(m) : o.label);
    rest = rest.replace(m[0], ' ');
  }
  return { rest: rest.replace(/\s+/g, ' ').trim(), note: found.join(', ') };
}

function splitSegments(text) {
  return stripMentions(text)
    .split(/[,;+\n]|\s&\s|\s+(?:và|va|với)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** One normalized segment -> { quantity, name }. */
function extractQuantity(segment) {
  let tokens = normalize(segment).split(' ').filter(Boolean);
  while (tokens.length > 1 && LEADING_FILLER.has(tokens[0])) tokens.shift();
  while (tokens.length > 1 && TRAILING_FILLER.has(tokens[tokens.length - 1])) tokens.pop();

  let qty = 1;
  const isNum = (t) => /^\d{1,2}$/.test(t);
  if (tokens.length > 1 && isNum(tokens[0])) qty = Number(tokens.shift());
  else if (tokens.length > 1 && NUMBER_WORDS[tokens[0]]) qty = NUMBER_WORDS[tokens.shift()];
  else if (tokens.length > 1 && /^x\d{1,2}$/.test(tokens[0])) qty = Number(tokens.shift().slice(1));
  if (tokens.length > 1 && UNITS.has(tokens[0])) tokens.shift();

  const last = tokens[tokens.length - 1];
  const prev = tokens[tokens.length - 2];
  if (tokens.length > 1 && /^x\d{1,2}$/.test(last)) { qty = Number(last.slice(1)); tokens.pop(); }
  else if (tokens.length > 2 && prev === 'x' && isNum(last)) { qty = Number(last); tokens.splice(-2); }
  else if (tokens.length > 2 && UNITS.has(last) && isNum(prev)) { qty = Number(prev); tokens.splice(-2); }

  return { quantity: Math.min(Math.max(qty, 1), MAX_QTY), name: tokens.join(' ') };
}

// keyword index per catalog snapshot: [{ phrase, product }] longest phrase first
const indexCache = new WeakMap();
function buildIndex(catalog) {
  if (indexCache.has(catalog)) return indexCache.get(catalog);
  const index = [];
  for (const product of catalog) for (const phrase of product.keywords) if (phrase) index.push({ phrase, product });
  index.sort((a, b) => b.phrase.length - a.phrase.length);
  indexCache.set(catalog, index);
  return index;
}

/** exact keyword -> whole-word keyword inside the text (longest first) -> fuzzy (typos). */
function matchProduct(name, catalog) {
  if (!name) return null;
  const index = buildIndex(catalog);
  const exact = index.find((e) => e.phrase === name);
  if (exact) return exact.product;
  const padded = ` ${name} `;
  const inside = index.find((e) => padded.includes(` ${e.phrase} `));
  if (inside) return inside.product;
  if (name.length >= 5) {
    // typo tolerance; digits must agree so "555" can never fuzzy-match "556". The customer still
    // sees the matched product name in the draft summary before replying "ok".
    const digits = (s) => s.replace(/\D/g, '');
    let best = null;
    for (const e of index) {
      if (digits(name) !== digits(e.phrase)) continue;
      const score = dice(name, e.phrase);
      if (score >= 0.75 && (!best || score > best.score)) best = { score, product: e.product };
    }
    if (best) return best.product;
  }
  return null;
}

/**
 * @param {string} text     raw customer message
 * @param {Array<{id,name,price,keywords:Set<string>}>} catalog  from productModel.listForMatching()
 * @returns {{ items:Array<{productId,name,quantity,note}>, unmatched:string[], append:boolean }}
 *   note: drink options ("ít đường, size L"), '' when none; the same drink with other options is another line
 */
function parseOrder(text, catalog) {
  const segments = splitSegments(text);
  let append = false;
  if (segments.length && /^them(\s|$)/.test(normalize(segments[0]))) {
    append = true;
    segments[0] = segments[0].trim().replace(/^\S+\s*/, ''); // drop the "thêm" word (any unicode form)
  }

  const merged = new Map();
  const unmatched = [];
  for (const raw of segments) {
    if (!raw) continue;
    const { rest, note } = extractOptions(raw);
    let { quantity, name } = extractQuantity(rest);
    let product = matchProduct(name, catalog);
    if (!product) {                              // e.g. bare "555": the "quantity" was really the name
      product = matchProduct(rest, catalog);
      if (product) quantity = 1;
    }
    if (!product) { unmatched.push(raw.trim()); continue; }
    const key = `${product.id}|${note}`;
    const cur = merged.get(key);
    merged.set(key, { productId: product.id, name: product.name, quantity: Math.min(MAX_QTY, (cur?.quantity || 0) + quantity), note });
  }
  return { items: [...merged.values()], unmatched, append };
}

module.exports = { detectCommand, detectFaq, isMentioned, parseOrder, extractQuantity, extractOptions, matchProduct, stripMentions };
