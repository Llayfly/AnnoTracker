'use strict';
// GET /api/salary —— 薪资计算
// 方式一：按原始时长阶梯计价 0-130h@16, 130-182h@19, >182h@21.8
// 方式二：按结算参考 32/h
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

// 默认当月1号到今天
function getMonthRange(query) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let start, end;
  if (query.start && query.end) {
    start = query.start;
    end = query.end;
  } else {
    // 默认当月
    end = fmtDate(today);
    start = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  }
  return { start, end };
}

// 方式一：按原始时长阶梯累计
function calcRawSalary(rawHours) {
  if (rawHours <= 130) {
    return Math.round(rawHours * 16 * 100) / 100;
  } else if (rawHours <= 182) {
    return Math.round((130 * 16 + (rawHours - 130) * 19) * 100) / 100;
  } else {
    return Math.round((130 * 16 + 52 * 19 + (rawHours - 182) * 21.8) * 100) / 100;
  }
}

// 方式二：按结算参考 32/h
function calcSettlementSalary(settlementHours) {
  return Math.round(settlementHours * 32 * 100) / 100;
}

// 分组：HC / C / HBHC / S / JS / 其他（大小写不敏感）
function getGroup(label) {
  const u = label.toUpperCase();
  if (u.startsWith('HBHC')) return 'HBHC';
  if (u.startsWith('HC')) return 'HC';
  if (u.startsWith('JS')) return 'JS';
  if (u.startsWith('S')) return 'S';
  if (u.startsWith('C')) return 'C';
  return 'OTHER';
}

// 优先标注员
const PRIORITY = ['HC3', 'HC7', 'HC8', 'HC10', 'HC12', 'HC27', 'HC07', 'HC08'];

module.exports = requireAuth(async (req, res) => {
  try {
    await ensureInit();
    const db = getDb();
    const { start, end } = getMonthRange(req.query);

    // 原始时长 = 每天新任务时长的累加（不含旧任务）
    const result = await db.execute({
      sql: `SELECT
        a.id, a.label,
        COALESCE(SUM(d.new_task_raw_seconds), 0) AS raw_seconds,
        COALESCE(SUM(d.settlement_reference_seconds), 0) AS settlement_seconds,
        COALESCE(SUM(d.new_task_raw_seconds), 0) AS new_task_seconds,
        COALESCE(SUM(d.old_task_raw_seconds), 0) AS old_task_seconds,
        COUNT(d.date) AS active_days
      FROM annotators a
      LEFT JOIN daily_stats d ON d.annotator_id = a.id AND d.date >= ? AND d.date <= ?
      GROUP BY a.id
      HAVING active_days > 0
      ORDER BY raw_seconds DESC`,
      args: [start, end],
    });

    const rows = result.rows.map((r) => {
      const rawHours = s2h(r.raw_seconds);
      const settlementHours = s2h(r.settlement_seconds);
      const newTaskHours = s2h(r.new_task_seconds);
      const oldTaskHours = s2h(r.old_task_seconds);
      const salary1 = calcRawSalary(rawHours);
      const salary2 = calcSettlementSalary(settlementHours);
      return {
        label: r.label,
        raw_hours: rawHours,
        settlement_hours: settlementHours,
        new_task_hours: newTaskHours,
        old_task_hours: oldTaskHours,
        active_days: r.active_days,
        salary_raw: salary1,
        salary_settlement: salary2,
        salary_diff: Math.round((salary2 - salary1) * 100) / 100,
        recommended: salary2 >= salary1 ? 'settlement' : 'raw',
        group: getGroup(r.label),
        priority: PRIORITY.includes(r.label),
      };
    });

    // 分组
    const groups = { HC: [], C: [], HBHC: [], S: [], JS: [], OTHER: [] };
    for (const r of rows) {
      groups[r.group].push(r);
    }

    // 每组内：优先标注员排前面，然后按原始时长降序
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority ? -1 : 1;
        return b.raw_hours - a.raw_hours;
      });
    }

    res.json({
      range: { start, end },
      groups,
      count: rows.length,
    });
  } catch (e) {
    console.error('[api] salary error:', e);
    res.status(500).json({ error: e.message });
  }
});
