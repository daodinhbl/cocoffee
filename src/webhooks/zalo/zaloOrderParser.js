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
const CONFIRM_RE = /^(o+k+(e+|ie|ay|i)?|dong y|xac nhan|xac nhan don|chot|chot don|dung roi|dung vay|dat luon)( (nhe|nha|nhen|em|a|ah|ban|shop|nhi|luon|di|roi|anh|chi|oi))*$/;
const CANCEL_RE = /^(huy|huy don|huy het|cancel)( (nhe|nha|em))?$/;
// "menu", "xem menu", "cho mình xin menu", "quán có gì uống", "quán bán gì"
const MENU_RE = /^(?:(?:cho|gui|xin|xem|lay)(?: (?:minh|em|toi|anh|chi))?(?: xin)? )?(?:menu|thuc don)(?: (?:di|nhe|nha|voi|a|shop|quan))?$|^(?:quan )?co (?:gi|nhung mon gi)(?: (?:uong|an|ban))?(?: (?:khong|ko|vay|the))?$|^quan ban gi$/;
// "đối chiếu công nợ", "bảng đối chiếu công nợ tháng trước", "sao kê", "liệt kê công nợ", "danh sách nợ", "chi tiết công nợ",
// "công nợ tháng 9", "bảng công nợ": the debt table (reconciliation / statement), not just the balance of "check nợ".
const PERIOD = '(?:thang (?:nay|truoc|\\d{1,2})|tat ca|nam nay)';
const STATEMENT_RE = new RegExp(
  `^(?:(?:gui|cho|xem|lay)(?: (?:minh|em|toi|anh|chi))?(?: xin)? )?(?:(?:bang|file|anh) )?(?:(?:doi chieu|sao ke)(?: (?:cong no|no))?|(?:liet ke|danh sach|chi tiet)(?: cac khoan)? (?:cong no|no))(?: ${PERIOD})?(?: (?:nhe|nha|voi|a|shop|giup))?$` +
  `|^(?:bang |chi tiet )?(?:cong no|so no)(?: chi tiet| ${PERIOD})$|^bang (?:cong no|no)(?: ${PERIOD})?$`
);
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

/** @returns {'identity'|'confirm'|'cancel'|'menu'|'statement'|'debt'|null} */
function detectCommand(text) {
  const n = normalize(stripMentions(text));
  if (ID_RE.test(n)) return 'identity';
  if (CONFIRM_RE.test(n)) return 'confirm';
  if (CANCEL_RE.test(n)) return 'cancel';
  if (MENU_RE.test(n)) return 'menu';
  if (STATEMENT_RE.test(n)) return 'statement';
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

// "2", "2x", "x2" (never "0": "0 đường" is an option)
const QTY_TOKEN = /^(?:[1-9]\d?x?|x[1-9]\d?)$/;
// A trailing 1-2 digit number right after one of these is a table, a floor, a time...: not a quantity ("trà đào bàn 5")
const NOT_QTY_AFTER = new Set(['size', 'sz', 'ban', 'phong', 'luc', 'gio', 'phut', 'ngay', 'thang', 'so', 'lop', 'muc', 'level', 'loai', 'lau']);
// Polite words that may stand between the start of a sentence and the quantity: "da cho minh 2 cf sua"
const POLITE = new Set([...LEADING_FILLER, 'da', 'vang', 'uh', 'um', 'ok', 'oke', 'chao', 'alo', 'muon', 'giup', 'luon', 'them', 'nua']);
/** Percentages, times and dates carry no item ("50% đường", "lúc 8:30", "ngày 5/10"); normalize() would leave bare digits behind. */
const stripNoise = (text) => String(text).replace(/\d{1,3}\s*%/g, ' ').replace(/\b\d{1,2}[:h]\d{2}\b/gi, ' ').replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ');
const MAX_TEXT = 800;       // an order is a few lines; longer text is not worth the matching work
const MAX_SPLIT_TOKENS = 40;

/** One normalized segment -> { quantity, name }. */
function extractQuantity(segment) {
  let tokens = normalize(segment).split(' ').filter(Boolean);
  while (tokens.length > 1 && LEADING_FILLER.has(tokens[0])) tokens.shift();
  while (tokens.length > 1 && TRAILING_FILLER.has(tokens[tokens.length - 1])) tokens.pop();
  {                                                      // "da cho minh 2 cf sua": polite words before the quantity
    let k = 0;
    while (k < tokens.length - 1 && k < 5 && POLITE.has(tokens[k])) k++;
    if (k > 0 && k < tokens.length - 1 && (QTY_TOKEN.test(tokens[k]) || NUMBER_WORDS[tokens[k]] !== undefined)) tokens.splice(0, k);
  }

  let qty = 1;
  let explicit = false;
  const isNum = (t) => /^\d{1,2}$/.test(t);
  if (tokens.length > 1 && isNum(tokens[0])) { qty = Number(tokens.shift()); explicit = true; }
  else if (tokens.length > 1 && NUMBER_WORDS[tokens[0]]) { qty = NUMBER_WORDS[tokens.shift()]; explicit = true; }
  else if (tokens.length > 1 && /^x\d{1,2}$/.test(tokens[0])) { qty = Number(tokens.shift().slice(1)); explicit = true; }
  else if (tokens.length > 1 && /^\d{1,2}x$/.test(tokens[0])) { qty = Number(tokens.shift().slice(0, -1)); explicit = true; }
  if (tokens.length > 1 && UNITS.has(tokens[0])) tokens.shift();

  const last = tokens[tokens.length - 1];
  const prev = tokens[tokens.length - 2];
  if (tokens.length > 1 && /^x\d{1,2}$/.test(last)) { qty = Number(last.slice(1)); tokens.pop(); }
  else if (tokens.length > 1 && /^\d{1,2}x$/.test(last)) { qty = Number(last.slice(0, -1)); tokens.pop(); }
  else if (tokens.length > 2 && prev === 'x' && isNum(last)) { qty = Number(last); tokens.splice(-2); }
  else if (tokens.length > 2 && UNITS.has(last) && isNum(prev)) { qty = Number(prev); tokens.splice(-2); }
  else if (!explicit && tokens.length > 1 && isNum(last) && last !== '0' && !NOT_QTY_AFTER.has(prev)) { qty = Number(last); tokens.pop(); }   // "cà phê sữa 2"

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
  // a shortened name: "cf muối" is the start of exactly one product's name ("cf muối kem tươi")
  const toks = name.split(' ');
  if (toks.length >= 2) {
    const owners = new Set();
    for (const e of index) if (e.phrase.startsWith(`${name} `)) owners.add(e.product);
    if (owners.size === 1) return [...owners][0];
    if (owners.size > 1) return null;                 // "sinh tố" starts several products: ask, never guess by spelling
  }
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

// Words too common on a menu to point at a product when suggesting.
const SUGGEST_STOP = new Set(['cho', 'lay', 'dat', 'minh', 'toi', 'ly', 'cai', 'nuoc', 'mon', 'qua', 'xin', 'nhe', 'nha']);

/** Up to `limit` product names sharing a word with what the customer typed, best overlap first (for "chưa tìm thấy"). */
function suggest(text, catalog, limit = 3) {
  const words = normalize(text).split(' ').filter((w) => w.length >= 3 && !SUGGEST_STOP.has(w) && !/^\d+$/.test(w));
  if (!words.length) return [];
  const scored = [];
  for (const p of catalog) {
    const pw = new Set(normalize(p.name).split(' '));
    for (const k of p.keywords) for (const w of k.split(' ')) pw.add(w);
    const score = words.filter((w) => pw.has(w)).length;
    if (score > 0) scored.push({ name: p.name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'vi'));
  return scored.slice(0, limit).map((x) => x.name);
}

/**
 * Several items typed with no separator. Two styles, told apart by the first real word of the message:
 *   "2 cf sữa 1 cf đen"    quantity FIRST  -> cut before each number that starts the next item
 *   "cf sữa 2 bạc xỉu 1"   name first      -> cut AFTER each number (and its unit): the number belongs to the item before it
 * A cut is made only when BOTH sides are products on their own, and never at a digit that sits inside a product
 * keyword ("yaourt 3 tầng"), after "size", or for "0" ("0 đường"). A message that mixes both styles is left whole.
 */
function splitByQuantity(segment, catalog) {
  const tokens = String(segment).trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 4 || tokens.length > MAX_SPLIT_TOKENS) return [segment];
  const n = tokens.map((t) => normalize(t));
  const index = buildIndex(catalog);
  const insideKeyword = (words) => {
    const p = ` ${words.join(' ')} `;
    return index.some((e) => ` ${e.phrase} `.includes(p));
  };
  const isProduct = (toks) => {
    const { rest } = extractOptions(toks.join(' '));
    const { name } = extractQuantity(rest);
    return Boolean(matchProduct(name, catalog) || matchProduct(rest, catalog));
  };
  const first = n.find((t) => !LEADING_FILLER.has(t) && t !== 'them');
  const leading = first !== undefined && (QTY_TOKEN.test(first) || NUMBER_WORDS[first] !== undefined);
  const parts = [];
  let start = 0;
  for (let i = 1; i < tokens.length - 1; i++) {
    if (!QTY_TOKEN.test(n[i]) || n[i - 1] === 'size' || n[i - 1] === 'sz') continue;
    if (insideKeyword([n[i - 1], n[i]]) || insideKeyword([n[i], n[i + 1]])) continue;     // a digit of a product name
    let j = i + 1;
    while (j < tokens.length && UNITS.has(n[j])) j++;
    if (j >= tokens.length) continue;                                                      // trailing quantity of the last item
    const cut = leading ? i : j;
    if (cut <= start || cut >= tokens.length) continue;
    const before = tokens.slice(start, cut);
    if (leading && !n.slice(start, i).some((t) => !LEADING_FILLER.has(t) && t !== 'them' && !QTY_TOKEN.test(t) && !UNITS.has(t))) continue;   // only filler before the number
    if (isProduct(before) && isProduct(tokens.slice(cut))) {
      parts.push(before.join(' '));
      start = cut;
      i = cut - 1;
    }
  }
  parts.push(tokens.slice(start).join(' '));
  return parts;
}

/**
 * @param {string} text     raw customer message
 * @param {Array<{id,name,price,keywords:Set<string>}>} catalog  from productModel.listForMatching()
 * @returns {{ items:Array<{productId,name,quantity,note}>, unmatched:string[], suggestions:string[][], append:boolean }}
 *   suggestions[i]: product names close to unmatched[i]
 *   note: drink options ("ít đường, size L"), '' when none; the same drink with other options is another line
 */
function parseOrder(text, catalog) {
  const segments = splitSegments(stripNoise(String(text || '').slice(0, MAX_TEXT)));
  let append = false;
  if (segments.length) {
    // "thêm 1 trà đào", "cho thêm 1 trà đào", "mình thêm ..." : a "thêm" among the first three words adds to the draft
    const words = segments[0].trim().split(/\s+/);
    const at = words.slice(0, 3).findIndex((w) => normalize(w) === 'them');
    if (at >= 0 && words.slice(0, at).every((w) => POLITE.has(normalize(w)))) {
      append = true;
      segments[0] = words.slice(at + 1).join(' ');          // drops the words up to "thêm" (any unicode form)
    }
  }

  const merged = new Map();
  const unmatched = [];
  const suggestions = [];
  for (const raw of segments.flatMap((seg) => splitByQuantity(seg, catalog))) {
    if (!raw) continue;
    const { rest, note } = extractOptions(raw);
    let { quantity, name } = extractQuantity(rest);
    let product = matchProduct(name, catalog);
    if (!product) {                              // e.g. bare "555": the "quantity" was really the name
      product = matchProduct(rest, catalog);
      if (product) quantity = 1;
    }
    if (!product) { unmatched.push(raw.trim()); suggestions.push(suggest(raw, catalog)); continue; }
    const key = `${product.id}|${note}`;
    const cur = merged.get(key);
    merged.set(key, { productId: product.id, name: product.name, quantity: Math.min(MAX_QTY, (cur?.quantity || 0) + quantity), note });
  }
  return { items: [...merged.values()], unmatched, suggestions, append };
}

/** The plain "menu" forms that are safe to answer in a group; the chatty ones ("quán có gì") only in private or when mentioned. */
const isStrictMenu = (text) => /^(menu|thuc don|xem menu)$/.test(normalize(stripMentions(text)));

/** The period asked for in a statement message, normalized ("thang truoc", "thang 9", "tat ca"...), '' = this month. */
const statementPeriodText = (text) => (new RegExp(PERIOD).exec(normalize(stripMentions(text))) || [''])[0];

module.exports = { statementPeriodText, isStrictMenu, detectCommand, detectFaq, isMentioned, parseOrder, extractQuantity, extractOptions, matchProduct, stripMentions, splitByQuantity, suggest };
