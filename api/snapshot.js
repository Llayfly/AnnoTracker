'use strict';
// /api/snapshot —— 新快照系统（2026-08-23 起）一体化接口
//   GET  /api/snapshot?start=&end=&search=         汇总（原始时长 = 新任务之和）
//   GET  /api/snapshot?mode=detail&label=&start=&end=  某标注员每日明细
//   GET  /api/snapshot?mode=export&start=&end=     导出 CSV
//   POST /api/snapshot?mode=manual                  手动录入/更新快照
//   DELETE /api/snapshot?mode=manual                删除手动快照
const { getDb, ensureInit, upsertSnapshot, deleteSnapshot } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

const SEC_PER_HOUR = 3600;
const s2h = (s) => Math.round((Number(s) || 0) / SEC_PER_HOUR * 100) / 100;

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
    start = '2026-08-23'; // 新系统从 8/23 开始
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

// 汇总查询（原始时长 = 新任务之和）
async function querySummary(db, start, end, search) {
  const workingDays = countWorkingDays(start, end);
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
    args: [start, end, search],
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
        if (date < '2026-08-23') return res.status(400).json({ error: '新系统仅支持 2026-08-23 之后的数据' });
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

    // ===== 明细 =====
    if (mode === 'detail') {
      const label = req.query.label || '';
      if (!label) return res.status(400).json({ error: '缺少 label 参数' });
      const annResult = await db.execute('SELECT id, label, raw_label FROM annotators WHERE label = ?', [label]);
      if (!annResult.rows.length) return res.status(404).json({ error: '标注员不存在' });
      const annotator = annResult.rows[0];
      const allResult = await db.execute({
        sql: `SELECT date, raw_seconds, new_task_raw_seconds, old_task_raw_seconds,
               segment_seconds, pass_segment_seconds, no_clip_seconds,
               no_clip_equivalent_seconds, settlement_reference_seconds, source
        FROM daily_snapshots WHERE annotator_id = ? ORDER BY date ASC`,
        args: [annotator.id],
      });
      const daily = allResult.rows
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
            source: r.source,
          };
        });
      return res.json({ label: annotator.label, raw_label: annotator.raw_label, range: { start, end }, daily });
    }

    // ===== 导出 CSV =====
    if (mode === 'export') {
      const data = await querySummary(db, start, end, search);
      const header = ['标注员', '原始时长(h)', '新任务(h)', '旧任务(h)', '片段时长(h)',
        'PASS片段(h)', '无片段(h)', '无片段等效(h)', '结算参考(h)', 'PASS占比(%)',
        '日均新任务(h)', '活跃天数'];
      const lines = [header.join(',')];
      for (const r of data) {
        lines.push([
          r.label, r.raw_hours, r.new_task_hours, r.old_task_hours, r.segment_hours,
          r.pass_segment_hours, r.no_clip_hours, r.no_clip_equivalent_hours,
          r.settlement_reference_hours, r.pass_ratio, r.daily_avg_raw_hours, r.active_days,
        ].join(','));
      }
      const csv = '\ufeff' + lines.join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="snapshot_${start}_${end}.csv"`);
      return res.send(csv);
    }

    // ===== 汇总（默认）=====
    const data = await querySummary(db, start, end, search);
    res.json({ range: { start, end }, count: data.length, data });
  } catch (e) {
    console.error('[api] snapshot error:', e);
    res.status(500).json({ error: e.message });
  }
});
