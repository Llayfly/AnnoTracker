'use strict';
// GET /api/backfill?start=YYYY-MM-DD&end=YYYY-MM-DD —— 回填历史数据
const { backfill } = require('../lib/collector');
const { requireAuth } = require('../lib/auth');

module.exports = requireAuth(async (req, res) => {
  const start = req.query.start;
  const end = req.query.end;

  if (!start || !end) {
    return res.status(400).json({ ok: false, error: '请提供 start 和 end 日期参数' });
  }

  // 验证日期格式
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(start) || !dateRegex.test(end)) {
    return res.status(400).json({ ok: false, error: '日期格式应为 YYYY-MM-DD' });
  }

  // 限制最多7天，避免 Vercel 超时
  const diffDays = Math.ceil((new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24)) + 1;
  if (diffDays > 7) {
    return res.status(400).json({ ok: false, error: `日期范围不能超过7天（当前${diffDays}天），请分多次回填` });
  }

  if (new Date(start) > new Date(end)) {
    return res.status(400).json({ ok: false, error: '起始日期不能晚于结束日期' });
  }

  try {
    const results = await backfill(start, end);
    const totalAnnotators = results.reduce((s, r) => s + r.count, 0);
    const successDays = results.filter((r) => !r.error).length;
    res.json({
      ok: true,
      message: `回填完成：${successDays}/${results.length} 天成功，共采集 ${totalAnnotators} 人次`,
      results,
    });
  } catch (e) {
    console.error('[api] backfill error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
