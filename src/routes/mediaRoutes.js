const express = require('express');
const mediaModel = require('../models/mediaModel');
const imageStore = require('../services/imageStore');

// Photos uploaded from the Web Admin, read from MySQL (services/imageStore.js). Public like any menu photo
// (the POS and the admin show them with <img>). Each upload gets a new id, so a URL never changes content.
const router = express.Router();

router.get('/:file', async (req, res, next) => {
  try {
    const id = imageStore.mediaIdOf(`/media/${req.params.file}`);
    const row = id ? await mediaModel.get(id) : null;
    if (!row) return next();                                   // -> 404 handler
    res.set({
      'Content-Type': row.mime,
      'Content-Length': String(row.bytes.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    return res.end(row.bytes);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
