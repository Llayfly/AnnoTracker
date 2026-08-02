'use strict';
// POST /api/collect —— 手动触发当天采集
const { collectToday } = require('../lib/collector');
const { requireAuth } = require('../lib/auth');

module.exports = requireAuth(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const count = await collectToday();
    res.json({ message: '采集完成', count });
  } catch (e) {
    console.error('[api] collect error:', e);
    res.status(500).json({ error: e.message });
  }
});
