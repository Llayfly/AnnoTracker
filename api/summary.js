'use strict';
// GET /api/summary —— 汇总数据
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
    start = query.start;
    end = query.end;
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

function getLevel(h) {
  if (h < 3) return 'red';
  if (h <= 5) return 'blue';
  return 'green';
}

// 计算日期范围内的工作日天数（周一至周五）
function countWorkingDays(startStr, endStr) {
  const start = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  let count = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDay(); // 0=周日, 6=周六
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

module.exports = requireAuth(async (req, res) => {
  try {
    await ensureInit();
    const db = getDb();
    const { start, end } = getRange(req.query);
    const search = req.query.search ? `%${req.query.search.trim()}%` : '%';
    const workingDays = countWorkingDays(start, end);

    // 使用 annotator_cumulative 表获取真实累计值，而非从 daily_stats 累加
    const result = await db.execute({
      sql: `SELECT
        a.id, a.label, a.raw_label,
        COALESCE(SUM(d.raw_seconds),0) AS raw_seconds,
        COALESCE(SUM(d.new_task_raw_seconds),0) AS new_task_raw_seconds,
        COALESCE(SUM(d.old_task_raw_seconds),0) AS old_task_raw_seconds,
        COALESCE(SUM(d.segment_seconds),0) AS segment_seconds,
        COALESCE(SUM(d.pass_segment_seconds),0) AS pass_segment_seconds,
        COALESCE(SUM(d.no_clip_seconds),0) AS no_clip_seconds,
        COALESCE(SUM(d.no_clip_equivalent_seconds),0) AS no_clip_equivalent_seconds,
        COALESCE(SUM(d.settlement_reference_seconds),0) AS settlement_reference_seconds,
        COUNT(d.date) AS active_days,
        COALESCE(ac.cumulative_reference_alltime, 0) AS cumulative_reference_seconds
      FROM annotators a
      LEFT JOIN daily_stats d ON d.annotator_id = a.id AND d.date >= ? AND d.date <= ?
      LEFT JOIN annotator_cumulative ac ON ac.annotator_id = a.id
      WHERE a.label LIKE ?
      GROUP BY a.id
      ORDER BY raw_seconds DESC`,
      args: [start, end, search],
    });

    const data = result.rows.map((r) => {
      // 日均 = 新任务总时长 / 工作日天数（周一至周五）
      const dailyAvgRawHours = workingDays > 0 ? Number(r.new_task_raw_seconds) / workingDays / SEC_PER_HOUR : 0;
      const passRatio = Number(r.raw_seconds) > 0
        ? Math.round((Number(r.segment_seconds) / Number(r.raw_seconds)) * 1000) / 10
        : 0;
      return {
        label: r.label,
        raw_label: r.raw_label,
        raw_hours: s2h(r.raw_seconds),
        new_task_hours: s2h(r.new_task_raw_seconds),
        old_task_hours: s2h(r.old_task_raw_seconds),
        segment_hours: s2h(r.segment_seconds),
        pass_segment_hours: s2h(r.pass_segment_seconds),
        no_clip_hours: s2h(r.no_clip_seconds),
        no_clip_equivalent_hours: s2h(r.no_clip_equivalent_seconds),
        settlement_reference_hours: s2h(r.settlement_reference_seconds),
        pass_ratio: passRatio,
        cumulative_reference_hours: s2h(r.cumulative_reference_seconds),
        daily_avg_raw_hours: Math.round(dailyAvgRawHours * 1000) / 1000,
        active_days: r.active_days,
        level: getLevel(dailyAvgRawHours),
      };
    });

    res.json({ range: { start, end }, count: data.length, data });
  } catch (e) {
    console.error('[api] summary error:', e);
    res.status(500).json({ error: e.message });
  }
});
