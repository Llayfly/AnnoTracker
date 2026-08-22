'use strict';
// POST /api/collect —— 手动触发采集（含标签迁移）
// 支持 body: { start, end } 重新采集指定日期范围（最多7天）；不带参数则采集当天
const { collectToday, backfill, fmtDate } = require('../lib/collector');
const { ensureInit, migrateLabels } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

module.exports = requireAuth(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureInit();
    // 标签迁移失败不应阻塞刷新（每日 cron 会重试），这里仅尽力而为
    let migration = null;
    try {
      migration = await migrateLabels();
    } catch (e) {
      console.error('[api] migrateLabels error:', e.message);
    }

    let count;
    let message;
    if (req.body && req.body.start && req.body.end) {
      let start = req.body.start;
      let end = req.body.end;
      // 限制最多7天，超出则只重采最后7天
      const diffDays = Math.ceil((new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24)) + 1;
      if (diffDays > 7) {
        const sd = new Date(end + 'T00:00:00');
        sd.setDate(sd.getDate() - 6);
        start = fmtDate(sd);
      }
      const results = await backfill(start, end);
      count = results.reduce((s, r) => s + r.count, 0);
      const failed = results.filter((r) => r.error);
      message = failed.length
        ? `重新采集 ${start} ~ ${end}：${results.length - failed.length}/${results.length} 天成功，失败: ${failed.map((f) => `${f.date}(${f.error})`).join('; ')}`
        : `重新采集 ${start} ~ ${end} 完成`;
    } else {
      count = await collectToday();
      message = '采集完成';
    }

    res.json({ message, count, migration });
  } catch (e) {
    console.error('[api] collect error:', e);
    res.status(500).json({ error: e.message });
  }
});
