'use strict';
// POST /api/collect —— 手动触发采集（新快照系统）
// 支持 body: { start, end } 重新采集指定日期范围（最多7天）；不带参数则采集最新可用数据
const { collectSnapshotLatest, backfillSnapshots, fmtDate } = require('../lib/collector');
const { ensureInit, migrateLabels } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

module.exports = requireAuth(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureInit();
    let migration = null;
    try { migration = await migrateLabels(); } catch (e) { console.error('[api] migrateLabels error:', e.message); }

    let result;
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
      const results = await backfillSnapshots(start, end);
      const count = results.reduce((s, r) => s + r.count, 0);
      const failed = results.filter((r) => r.error);
      message = failed.length
        ? `重新采集 ${start} ~ ${end}：${results.length - failed.length}/${results.length} 天成功，失败: ${failed.map((f) => `${f.date}(${f.error})`).join('; ')}`
        : `重新采集 ${start} ~ ${end} 完成`;
      result = { count, results };
    } else {
      result = await collectSnapshotLatest();
      message = result.mode === 'today'
        ? `已采集当天（${result.date}）${result.count} 人`
        : result.mode === 'backfill'
          ? `已采集 ${result.count} 人（含补采缺失日期，最新 ${result.date}）`
          : '当天及之前数据均未生成，暂无新数据';
    }

    res.json({ message, result, migration });
  } catch (e) {
    console.error('[api] collect error:', e);
    res.status(500).json({ error: e.message });
  }
});
