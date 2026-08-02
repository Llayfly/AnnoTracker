'use strict';
// GET /api/status —— 系统状态
const { db, ensureInit } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

module.exports = requireAuth(async (req, res) => {
  try {
    await ensureInit();
    const annCount = (await db.execute('SELECT COUNT(*) AS c FROM annotators')).rows[0].c;
    const dateRange = (await db.execute('SELECT MIN(date) AS min, MAX(date) AS max FROM daily_stats')).rows[0];
    const lastLog = (await db.execute('SELECT * FROM collection_log ORDER BY created_at DESC LIMIT 10')).rows;

    res.json({
      collecting: false,
      annotator_count: annCount,
      date_range: dateRange,
      recent_logs: lastLog,
      server_time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
