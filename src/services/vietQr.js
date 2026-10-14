const QRCode = require('qrcode');

/**
 * VietQR bank-transfer codes (NAPAS 247, EMVCo merchant-presented format), built locally: no third-party
 * image service sees the shop's account or the customer's debt.
 *   00 payload format "01" · 01 initiation 11 static / 12 with amount · 38 merchant account
 *   (00 GUID A000000727, 01 = 00 bank BIN + 01 account, 02 service QRIBFTTA = transfer to an account)
 *   · 53 currency 704 · 54 amount · 58 VN · 62/08 transfer content · 63 CRC-16/CCITT-FALSE over all of the above
 *   including "6304". Checked against a published sample (Techcombank 970407 / 9602091996 -> CRC 34A0).
 */

/** Banks offered in the admin (BIN from api.vietqr.io/v2/banks, which the banking apps use). */
const BANKS = [
  { bin: '970436', name: 'Vietcombank' }, { bin: '970415', name: 'VietinBank' }, { bin: '970418', name: 'BIDV' },
  { bin: '970405', name: 'Agribank' }, { bin: '970407', name: 'Techcombank' }, { bin: '970422', name: 'MBBank' },
  { bin: '970416', name: 'ACB' }, { bin: '970432', name: 'VPBank' }, { bin: '970423', name: 'TPBank' },
  { bin: '970403', name: 'Sacombank' }, { bin: '970437', name: 'HDBank' }, { bin: '970441', name: 'VIB' },
  { bin: '970443', name: 'SHB' }, { bin: '970426', name: 'MSB' }, { bin: '970448', name: 'OCB' },
  { bin: '970431', name: 'Eximbank' }, { bin: '970440', name: 'SeABank' }, { bin: '970449', name: 'LPBank' },
  { bin: '970428', name: 'NamABank' }, { bin: '970454', name: 'VietCapitalBank' }, { bin: '970429', name: 'SCB' },
  { bin: '546034', name: 'CAKE by VPBank' }, { bin: '963388', name: 'Timo' },
];
const bankName = (bin) => (BANKS.find((b) => b.bin === bin) || {}).name || '';

const tlv = (id, value) => id + String(value.length).padStart(2, '0') + value;

function crc16(str) {
  let crc = 0xffff;
  for (const byte of Buffer.from(str, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Transfer content as banks accept it: ASCII letters/digits/spaces, at most 25 characters by default. */
function cleanNote(note, max = 25) {
  return String(note || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * @param {{bin:string, account:string, amount?:number, note?:string}} p  amount in VND (integer); no amount = static code
 * @returns {string} the payload a banking app reads
 */
function payload({ bin, account, amount, note }) {
  if (!/^\d{6}$/.test(String(bin))) throw new Error('VietQR: bank BIN must be 6 digits');
  if (!/^[0-9A-Za-z]{4,19}$/.test(String(account))) throw new Error('VietQR: account must be 4-19 letters/digits');
  const value = Math.round(Number(amount) || 0);
  const merchant = tlv('00', 'A000000727') + tlv('01', tlv('00', String(bin)) + tlv('01', String(account))) + tlv('02', 'QRIBFTTA');
  let s = tlv('00', '01') + tlv('01', value > 0 ? '12' : '11') + tlv('38', merchant) + tlv('53', '704');
  if (value > 0) s += tlv('54', String(value));
  s += tlv('58', 'VN');
  const content = cleanNote(note);
  if (content) s += tlv('62', tlv('08', content));
  s += '6304';
  return s + crc16(s);
}

/** PNG of the code, sized for a phone screen. */
function png(text) {
  return QRCode.toBuffer(text, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 480 });
}

module.exports = { BANKS, bankName, payload, png, crc16, cleanNote };
