const reportService = require('../../services/reportService');
const { shopDay } = require('../../utils/shopTime');
const { render } = require('./common');

const { readRange, presets, MAX_DAYS } = reportService;

async function page(req, res) {
  const report = await reportService.build(req.query, shopDay());
  await render(res, 'reports', {
    title: 'Báo cáo', activeMenu: 'reports', breadcrumbs: [{ label: 'Phân tích', href: '#' }, { label: 'Báo cáo' }],
  }, report);
}

module.exports = { page, readRange, presets, MAX_DAYS };
