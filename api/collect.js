'use strict';
// POST /api/collect —— 手动触发当天采集（含标签迁移）
const { collectToday } = require('../lib/collector');
const { ensureInit, migrateLabels } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

module.exports = requireAuth(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureInit();
    const migration = await migrateLabels();
    const count = await collectToday();
    res.json({ message: '采集完成', count, migration });
  } catch (e) {
    console.error('[api] collect error:', e);
    res.status(500).json({ error: e.message });
  }
});
