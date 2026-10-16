const express = require('express');
const rateLimit = require('../middlewares/rateLimit');
const agent = require('../services/heli/agent');
const openai = require('../services/heli/openai');
const { AppError } = require('../utils/httpError');

const router = express.Router();

// 30 requests a minute per signed-in user (a hands-free session asks, then speaks, then asks again)
router.use(rateLimit({ windowMs: 60 * 1000, max: 30, key: (req) => `heli:${req.user.id}` }));

const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'm4a' };

// Strip what a voice should not read out: links, markdown marks. 1500 characters at most.
function speakable(text) {
  return String(text || '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_`#>|~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);
}

router.post('/chat', async (req, res) => {
  const reply = await agent.chat(req.user, req.body?.message);
  res.json({ reply });
});

router.post('/reset', (req, res) => {
  agent.reset(req.user.id);
  res.json({ ok: true });
});

router.post('/stt', express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new AppError(400, 'EMPTY', 'Chưa có âm thanh');
  const type = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  res.json({ text: await openai.transcribe(req.body, EXT[type] || 'm4a') });
});

router.post('/tts', async (req, res) => {
  const text = speakable(req.body?.text);
  if (!text) throw new AppError(400, 'EMPTY', 'Chưa có nội dung');
  const audio = await openai.speak(text);
  res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }).send(audio);
});

module.exports = router;
module.exports.speakable = speakable;
