'use strict';
// GET /api/detail/:label —— 某标注员每日明细
const { db, ensureInit } = require('../../lib/db');
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
    const label = req.query.label || (req.params && req.params.label) || '';
    const { start, end } = getRange(req.query);

    const annResult = await db.execute('SELECT id, label, raw_label FROM annotators WHERE label = ?', [label]);
    if (!annResult.rows.length) return res.status(404).json({ error: '标注员不存在' });
    const annotator = annResult.rows[0];

    const allResult = await db.execute({
      sql: `SELECT date, raw_seconds, segment_seconds, no_clip_seconds,
             no_clip_equivalent_seconds, settlement_reference_seconds,
             pass_segment_seconds, new_task_raw_seconds, old_task_raw_seconds
      FROM daily_stats WHERE annotator_id = ? ORDER BY date ASC`,
      args: [annotator.id],
    });

    let running = 0;
    const fullWithCum = allResult.rows.map((r) => {
      running += Number(r.settlement_reference_seconds);
      return { ...r, running_cumulative_seconds: running };
    });

    const daily = fullWithCum
      .filter((r) => r.date >= start && r.date <= end)
      .map((r) => ({
        date: r.date,
        raw_hours: s2h(r.raw_seconds),
        segment_hours: s2h(r.segment_seconds),
        no_clip_hours: s2h(r.no_clip_seconds),
        no_clip_equivalent_hours: s2h(r.no_clip_equivalent_seconds),
        settlement_reference_hours: s2h(r.settlement_reference_seconds),
        cumulative_reference_hours: s2h(r.running_cumulative_seconds),
        pass_segment_hours: s2h(r.pass_segment_seconds),
        new_task_raw_hours: s2h(r.new_task_raw_seconds),
        old_task_raw_hours: s2h(r.old_task_raw_seconds),
      }));

    res.json({
      label: annotator.label,
      raw_label: annotator.raw_label,
      range: { start, end },
      latest_cumulative_reference_hours: fullWithCum.length
        ? s2h(fullWithCum[fullWithCum.length - 1].running_cumulative_seconds) : 0,
      daily,
    });
  } catch (e) {
    console.error('[api] detail error:', e);
    res.status(500).json({ error: e.message });
  }
});
