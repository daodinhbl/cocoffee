#!/usr/bin/env node
/**
 * QR codes for inviting people to POS Tasotek on Google Play (CHPlay/invite/), same settings as the login page QR
 * (src/services/appRelease.js qrSvg: error correction M). Called by render.py before it renders the invite card.
 *
 *   node CHPlay/src/make-qr.js
 */
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const OUT = path.join(__dirname, '..', 'invite');
const LINKS = {
  'qr-tham-gia-thu-nghiem': 'https://play.google.com/apps/testing/com.tasotek.fnb', // testers' opt-in page
  'qr-google-play': 'https://play.google.com/store/apps/details?id=com.tasotek.fnb', // the app's store page
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, url] of Object.entries(LINKS)) {
    const opts = { errorCorrectionLevel: 'M', margin: 2, color: { dark: '#0F172A', light: '#FFFFFF' } };
    fs.writeFileSync(path.join(OUT, `${name}.svg`), await QRCode.toString(url, { ...opts, type: 'svg' }));
    await QRCode.toFile(path.join(OUT, `${name}.png`), url, { ...opts, width: 1024 });
    console.log(`invite/${name}.png + .svg  ${url}`);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
