'use strict';
// /api/snapshot —— 统计监控一体化接口
//   GET  /api/snapshot?start=&end=&search=         汇总（历史 + 新数据两区块）
//   GET  /api/snapshot?mode=detail&label=&start=&end=  某标注员每日明细（历史+新）
//   GET  /api/snapshot?mode=export&start=&end=     导出 CSV
//   POST /api/snapshot?mode=manual                  手动录入/更新快照
//   DELETE /api/snapshot?mode=manual                删除手动快照
const { getDb, ensureInit, upsertSnapshot, deleteSnapshot } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

const SEC_PER_HOUR = 3600;
const s2h = (s) => Math.round((Number(s) || 0) / SEC_PER_HOUR * 100) / 100;

const SNAPSHOT_START = '2026-08-23'; // 新数据起始日
const OLD_END = '2026-08-22';        // 历史数据截止日

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
    start = '2026-08-23';
  }
  return { start, end };
}

// 计算日期范围内的工作日天数（周一至周五）
function countWorkingDays(startStr, endStr) {
  const start = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  let count = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

function getLevel(h) {
  if (h < 3) return 'red';
  if (h <= 5) return 'blue';
  return 'green';
}

// 历史数据汇总（daily_stats，2026-08-22 及之前，原始时长 = 新任务 + 旧任务）
async function queryOldSummary(db, start, end, search) {
  const oldEnd = end < OLD_END ? end : OLD_END;
  if (start > oldEnd) return [];
  const workingDays = countWorkingDays(start, oldEnd);
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
    INNER JOIN daily_stats d ON d.annotator_id = a.id AND d.date >= ? AND d.date <= ?
    LEFT JOIN annotator_cumulative ac ON ac.annotator_id = a.id
    WHERE a.label LIKE ?
    GROUP BY a.id
    ORDER BY raw_seconds DESC`,
    args: [start, oldEnd, search],
  });

  return result.rows.map((r) => {
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
      daily_avg_raw_hours: Math.round(dailyAvgRawHours * 100) / 100,
      active_days: r.active_days,
      level: getLevel(dailyAvgRawHours),
    };
  });
}

// 新数据汇总（daily_snapshots，2026-08-23 起，原始时长 = 新任务之和）
async function querySummary(db, start, end, search) {
  const newStart = start < SNAPSHOT_START ? SNAPSHOT_START : start;
  if (newStart > end) return [];
  const workingDays = countWorkingDays(newStart, end);
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
      COUNT(d.date) AS active_days
    FROM annotators a
    INNER JOIN daily_snapshots d ON d.annotator_id = a.id AND d.date >= ? AND d.date <= ?
    WHERE a.label LIKE ?
    GROUP BY a.id
    ORDER BY raw_seconds DESC`,
    args: [newStart, end, search],
  });

  return result.rows.map((r) => {
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
      daily_avg_raw_hours: Math.round(dailyAvgRawHours * 100) / 100,
      active_days: r.active_days,
      level: getLevel(dailyAvgRawHours),
    };
  });
}

module.exports = requireAuth(async (req, res) => {
  try {
    await ensureInit();
    const db = getDb();
    const mode = req.query.mode || 'summary';

    // ===== 手动录入 =====
    if (mode === 'manual') {
      if (req.method === 'POST') {
        const b = req.body || {};
        const label = String(b.label || '').trim();
        const date = String(b.date || '').trim();
        if (!label || !date) return res.status(400).json({ error: '请填写标注员和日期' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
        if (date < SNAPSHOT_START) return res.status(400).json({ error: '新系统仅支持 2026-08-23 之后的数据' });
        await upsertSnapshot({
          label, date,
          newTaskHours: b.newTaskHours, oldTaskHours: b.oldTaskHours,
          segmentHours: b.segmentHours, noClipHours: b.noClipHours,
          passSegmentHours: b.passSegmentHours,
        });
        return res.json({ ok: true, message: `已保存 ${label} ${date} 的快照` });
      }
      if (req.method === 'DELETE') {
        const b = req.body || {};
        const label = String(b.label || '').trim();
        const date = String(b.date || '').trim();
        if (!label || !date) return res.status(400).json({ error: '请填写标注员和日期' });
        const n = await deleteSnapshot({ label, date });
        return res.json({ ok: true, deleted: n, message: n ? `已删除 ${label} ${date}` : '未找到记录' });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { start, end } = getRange(req.query);
    const search = req.query.search ? `%${req.query.search.trim()}%` : '%';
    const period = req.query.period || 'all'; // all | old | new

    // ===== 明细 =====
    if (mode === 'detail') {
      const label = req.query.label || '';
      if (!label) return res.status(400).json({ error: '缺少 label 参数' });
      const annResult = await db.execute('SELECT id, label, raw_label FROM annotators WHERE label = ?', [label]);
      if (!annResult.rows.length) return res.status(404).json({ error: '标注员不存在' });
      const annotator = annResult.rows[0];

      const oldResult = await db.execute({
        sql: `SELECT date, raw_seconds, new_task_raw_seconds, old_task_raw_seconds,
               segment_seconds, pass_segment_seconds, no_clip_seconds,
               no_clip_equivalent_seconds, settlement_reference_seconds
        FROM daily_stats WHERE annotator_id = ? ORDER BY date ASC`,
        args: [annotator.id],
      });
      const newResult = await db.execute({
        sql: `SELECT date, raw_seconds, new_task_raw_seconds, old_task_raw_seconds,
               segment_seconds, pass_segment_seconds, no_clip_seconds,
               no_clip_equivalent_seconds, settlement_reference_seconds, source
        FROM daily_snapshots WHERE annotator_id = ? ORDER BY date ASC`,
        args: [annotator.id],
      });

      const mapRow = (r, source) => {
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
          source,
        };
      };

      const daily = [
        ...(period === 'new' ? [] : oldResult.rows.filter((r) => r.date >= start && r.date <= end).map((r) => mapRow(r, 'old'))),
        ...(period === 'old' ? [] : newResult.rows.filter((r) => r.date >= start && r.date <= end).map((r) => mapRow(r, r.source))),
      ].sort((a, b) => (a.date < b.date ? -1 : 1));

      return res.json({ label: annotator.label, raw_label: annotator.raw_label, range: { start, end }, daily });
    }

    // ===== 导出 CSV =====
    if (mode === 'export') {
      const oldData = period === 'new' ? [] : await queryOldSummary(db, start, end, search);
      const newData = period === 'old' ? [] : await querySummary(db, start, end, search);
      const lines = [];
      if (oldData.length) {
        const oldEnd = end < OLD_END ? end : OLD_END;
        lines.push(`【历史数据 ${start} ~ ${oldEnd}】（原始时长 = 新任务 + 旧任务）`);
        lines.push(['标注员', '原始时长(h)', '新任务(h)', '旧任务(h)', '片段时长(h)', 'PASS占比(%)', '累计参考(h)', '日均新任务(h)'].join(','));
        for (const r of oldData) {
          lines.push([r.label, r.raw_hours, r.new_task_hours, r.old_task_hours, r.segment_hours, r.pass_ratio, r.cumulative_reference_hours, r.daily_avg_raw_hours].join(','));
        }
        lines.push('');
      }
      if (newData.length) {
        const newStart = start < SNAPSHOT_START ? SNAPSHOT_START : start;
        lines.push(`【新数据 ${newStart} ~ ${end}】（原始时长 = 新任务之和）`);
        lines.push(['标注员', '原始时长(h)', '旧任务(h)', '片段时长(h)', 'PASS占比(%)', '结算参考(h)', '日均新任务(h)', '活跃天数'].join(','));
        for (const r of newData) {
          lines.push([r.label, r.raw_hours, r.old_task_hours, r.segment_hours, r.pass_ratio, r.settlement_reference_hours, r.daily_avg_raw_hours, r.active_days].join(','));
        }
      }
      const csv = '\ufeff' + lines.join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="stats_${start}_${end}.csv"`);
      return res.send(csv);
    }

    // ===== 汇总（默认）=====
    const oldData = period === 'new' ? [] : await queryOldSummary(db, start, end, search);
    const newData = period === 'old' ? [] : await querySummary(db, start, end, search);
    res.json({ range: { start, end }, old: oldData, new: newData, count: oldData.length + newData.length });
  } catch (e) {
    console.error('[api] snapshot error:', e);
    res.status(500).json({ error: e.message });
  }
});
