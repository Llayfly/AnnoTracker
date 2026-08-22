'use strict';
// GET /api/status —— 系统状态（新快照系统）
const { getDb, ensureInit } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

module.exports = requireAuth(async (req, res) => {
  try {
    await ensureInit();
    const db = getDb();
    // 用 batch 合并 3 次查询为 1 次网络往返
    const results = await db.batch([
      'SELECT COUNT(*) AS c FROM annotators',
      'SELECT MIN(date) AS min, MAX(date) AS max FROM daily_snapshots',
      'SELECT * FROM collection_log ORDER BY created_at DESC LIMIT 10',
    ], 'read');

    res.json({
      collecting: false,
      annotator_count: results[0].rows[0].c,
      date_range: results[1].rows[0],
      recent_logs: results[2].rows,
      server_time: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[api] status error:', e);
    res.status(500).json({ error: e.message });
  }
});
