'use strict';
// GET /api/export —— 导出 CSV
const { getDb, ensureInit } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

const SEC_PER_HOUR = 3600;
const s2h = (s) => Math.round((Number(s) || 0) / SEC_PER_HOUR * 1000) / 1000;

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getRange(query) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let start, end;
  if (query.start && query.end) {
    start = query.start; end = query.end;
  } else {
    end = fmtDate(today);
    const range = query.range || '1w';
    const days = { '1d': 1, '3d': 3, '1w': 7, '15d': 15, '1m': 30 }[range] || 7;
    const sd = new Date(today);
    sd.setDate(sd.getDate() - (days - 1));
    start = fmtDate(sd);
  }
  return { start, end };
}

module.exports = requireAuth(async (req, res) => {
  try {
    await ensureInit();
    const db = getDb();
    const { start, end } = getRange(req.query);
    const search = req.query.search ? `%${req.query.search.trim()}%` : '%';

    const result = await db.execute({
      sql: `SELECT
        a.label,
        COALESCE(SUM(d.raw_seconds),0) AS raw_seconds,
        COALESCE(SUM(d.new_task_raw_seconds),0) AS new_task_raw_seconds,
        COALESCE(SUM(d.old_task_raw_seconds),0) AS old_task_raw_seconds,
        COALESCE(SUM(d.segment_seconds),0) AS segment_seconds,
        COALESCE(SUM(d.pass_segment_seconds),0) AS pass_segment_seconds,
        COALESCE(SUM(d.no_clip_seconds),0) AS no_clip_seconds,
        COALESCE(SUM(d.no_clip_equivalent_seconds),0) AS no_clip_equivalent_seconds,
        COALESCE(SUM(d.settlement_reference_seconds),0) AS settlement_reference_seconds,
        COALESCE(ac.cumulative_reference_alltime, 0) AS cumulative_reference_seconds,
        COUNT(d.date) AS active_days
      FROM annotators a
      LEFT JOIN daily_stats d ON d.annotator_id = a.id AND d.date >= ? AND d.date <= ?
      LEFT JOIN annotator_cumulative ac ON ac.annotator_id = a.id
      WHERE a.label LIKE ?
      GROUP BY a.id
      HAVING active_days > 0
      ORDER BY raw_seconds DESC`,
      args: [start, end, search],
    });

    const levelText = (h) => (h < 3 ? '红色预警' : h <= 5 ? '蓝色正常' : '绿色活跃');
    const header = ['标注员', '原始时长(h)', '新任务(h)', '旧任务(h)', '片段时长(h)', 'PASS片段(h)',
      '无片段时长(h)', '无片段等效(h)', '结算参考(h)', 'PASS占比(%)', '累计参考(h)',
      '日均原始时长(h)', '活跃天数', '预警等级'];
    const lines = [header.join(',')];
    for (const r of result.rows) {
      const avg = r.active_days > 0 ? Number(r.raw_seconds) / r.active_days / SEC_PER_HOUR : 0;
      const passRatio = Number(r.raw_seconds) > 0
        ? Math.round((Number(r.segment_seconds) / Number(r.raw_seconds)) * 1000) / 10
        : 0;
      lines.push([
        r.label, s2h(r.raw_seconds), s2h(r.new_task_raw_seconds), s2h(r.old_task_raw_seconds),
        s2h(r.segment_seconds), s2h(r.pass_segment_seconds),
        s2h(r.no_clip_seconds), s2h(r.no_clip_equivalent_seconds),
        s2h(r.settlement_reference_seconds), passRatio,
        s2h(r.cumulative_reference_seconds), Math.round(avg * 1000) / 1000,
        r.active_days, levelText(avg),
      ].join(','));
    }
    const csv = '\ufeff' + lines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="annotator_stats_${start}_${end}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('[api] export error:', e);
    res.status(500).json({ error: e.message });
  }
});
