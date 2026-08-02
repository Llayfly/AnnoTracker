'use strict';
// GET /api/detail/:label —— 某标注员每日明细
const { getDb, ensureInit } = require('../../lib/db');
const { requireAuth } = require('../../lib/auth');

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
    const label = req.query.label || (req.params && req.params.label) || '';
    const { start, end } = getRange(req.query);

    const annResult = await db.execute('SELECT id, label, raw_label FROM annotators WHERE label = ?', [label]);
    if (!annResult.rows.length) return res.status(404).json({ error: '标注员不存在' });
    const annotator = annResult.rows[0];

    const allResult = await db.execute({
      sql: `SELECT date, raw_seconds, new_task_raw_seconds, old_task_raw_seconds,
             segment_seconds, pass_segment_seconds,
             no_clip_seconds, no_clip_equivalent_seconds, settlement_reference_seconds
      FROM daily_stats WHERE annotator_id = ? ORDER BY date ASC`,
      args: [annotator.id],
    });

    // 获取累计参考（从 annotator_cumulative 表）
    const cumResult = await db.execute({
      sql: 'SELECT cumulative_reference_alltime FROM annotator_cumulative WHERE annotator_id = ?',
      args: [annotator.id],
    });
    const cumulativeAlltime = cumResult.rows.length ? Number(cumResult.rows[0].cumulative_reference_alltime) : 0;

    let running = 0;
    const fullWithCum = allResult.rows.map((r) => {
      running += Number(r.settlement_reference_seconds);
      return { ...r, running_cumulative_seconds: running };
    });

    const daily = fullWithCum
      .filter((r) => r.date >= start && r.date <= end)
      .map((r) => {
        const passRatio = Number(r.raw_seconds) > 0
          ? Math.round((Number(r.segment_seconds) / Number(r.raw_seconds)) * 1000) / 10
          : 0;
        return {
          date: r.date,
          raw_hours: s2h(r.raw_seconds),
          new_task_hours: s2h(r.new_task_raw_seconds),
          old_task_hours: s2h(r.old_task_raw_seconds),
          segment_hours: s2h(r.segment_seconds),
          pass_segment_hours: s2h(r.pass_segment_seconds),
          no_clip_hours: s2h(r.no_clip_seconds),
          no_clip_equivalent_hours: s2h(r.no_clip_equivalent_seconds),
          settlement_reference_hours: s2h(r.settlement_reference_seconds),
          pass_ratio: passRatio,
          cumulative_reference_hours: s2h(r.running_cumulative_seconds),
        };
      });

    res.json({
      label: annotator.label,
      raw_label: annotator.raw_label,
      range: { start, end },
      cumulative_reference_alltime_hours: s2h(cumulativeAlltime),
      latest_cumulative_reference_hours: fullWithCum.length
        ? s2h(fullWithCum[fullWithCum.length - 1].running_cumulative_seconds) : 0,
      daily,
    });
  } catch (e) {
    console.error('[api] detail error:', e);
    res.status(500).json({ error: e.message });
  }
});
