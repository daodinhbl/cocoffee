const express = require('express');
const { adminSecurity, pageRenderer } = require('../middlewares/adminSecurity');
const admin = require('../controllers/adminViewController');

const router = express.Router();

// Server-rendered Web Admin (EJS + Tailwind CDN + vanilla JS). SAMPLE DATA ONLY until admin login exists.
router.use(adminSecurity, pageRenderer);
router.get('/', admin.toDashboard);
router.get('/dashboard', admin.dashboard);
router.get('/bom-recipes', admin.bomRecipes);

module.exports = router;
