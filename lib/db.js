'use strict';
// Turso (libSQL) 数据库适配层 —— Vercel serverless 版
// 延迟初始化：避免模块加载时因环境变量缺失而崩溃

const { createClient } = require('@libsql/client');

let _db = null;
let _initialized = false;
let _initPromise = null;

function getDb() {
  if (!_db) {
    if (!process.env.TURSO_DATABASE_URL) {
      throw new Error('[db] 缺少环境变量 TURSO_DATABASE_URL，请在 Vercel 项目设置中配置');
    }
    _db = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    });
    console.log('[db] Turso 客户端已创建');
  }
  return _db;
}

// ===== 建表语句列表（用 batch 一次执行，减少网络往返）=====
const INIT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS annotators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT UNIQUE NOT NULL,
    raw_label TEXT,
    first_seen TEXT,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    annotator_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    raw_seconds REAL NOT NULL DEFAULT 0,
    segment_seconds REAL NOT NULL DEFAULT 0,
    no_clip_seconds REAL NOT NULL DEFAULT 0,
    no_clip_equivalent_seconds REAL NOT NULL DEFAULT 0,
    pass_segment_seconds REAL NOT NULL DEFAULT 0,
    settlement_reference_seconds REAL NOT NULL DEFAULT 0,
    new_task_raw_seconds REAL NOT NULL DEFAULT 0,
    old_task_raw_seconds REAL NOT NULL DEFAULT 0,
    collected_at TEXT,
    UNIQUE(annotator_id, date),
    FOREIGN KEY(annotator_id) REFERENCES annotators(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_stats(date)`,
  `CREATE INDEX IF NOT EXISTS idx_daily_annotator ON daily_stats(annotator_id)`,
  // 新快照系统（2026-08-23 起）：每天 23:59 采集的单日可靠数据，与旧 daily_stats 完全分离
  `CREATE TABLE IF NOT EXISTS daily_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    annotator_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    raw_seconds REAL NOT NULL DEFAULT 0,
    new_task_raw_seconds REAL NOT NULL DEFAULT 0,
    old_task_raw_seconds REAL NOT NULL DEFAULT 0,
    segment_seconds REAL NOT NULL DEFAULT 0,
    no_clip_seconds REAL NOT NULL DEFAULT 0,
    no_clip_equivalent_seconds REAL NOT NULL DEFAULT 0,
    pass_segment_seconds REAL NOT NULL DEFAULT 0,
    settlement_reference_seconds REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'auto',
    collected_at TEXT,
    UNIQUE(annotator_id, date),
    FOREIGN KEY(annotator_id) REFERENCES annotators(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_snap_date ON daily_snapshots(date)`,
  `CREATE INDEX IF NOT EXISTS idx_snap_annotator ON daily_snapshots(annotator_id)`,
  `CREATE TABLE IF NOT EXISTS annotator_cumulative (
    annotator_id INTEGER PRIMARY KEY,
    cumulative_reference_alltime REAL NOT NULL DEFAULT 0,
    cumulative_raw_alltime REAL NOT NULL DEFAULT 0,
    cumulative_segment_alltime REAL NOT NULL DEFAULT 0,
    cumulative_no_clip_alltime REAL NOT NULL DEFAULT 0,
    cumulative_no_clip_equivalent_alltime REAL NOT NULL DEFAULT 0,
    updated_at TEXT,
    FOREIGN KEY(annotator_id) REFERENCES annotators(id)
  )`,
  `CREATE TABLE IF NOT EXISTS collection_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_type TEXT,
    target_date TEXT,
    status TEXT,
    message TEXT,
    records INTEGER DEFAULT 0,
    created_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_log_created ON collection_log(created_at)`,
  `CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT,
    annotator_label TEXT NOT NULL,
    project_type TEXT,
    status TEXT DEFAULT '已分发',
    review_result TEXT,
    reviewer TEXT,
    round INTEGER DEFAULT 0,
    progress_current INTEGER DEFAULT 0,
    progress_total INTEGER DEFAULT 0,
    date TEXT NOT NULL,
    note TEXT,
    created_at TEXT,
    updated_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_batches_date ON batches(date)`,
  `CREATE INDEX IF NOT EXISTS idx_batches_annotator ON batches(annotator_label)`,
];

async function ensureInit() {
  if (_initialized) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const client = getDb();
      await client.batch(INIT_STATEMENTS, 'write');
      _initialized = true;
      console.log('[db] Turso 数据库初始化完成（batch）');
    } catch (e) {
      _initPromise = null;
      throw e;
    }
  })();
  return _initPromise;
}

// 标签别名映射：旧编号 → 新编号（平台改编号后需同步更新）
const LABEL_ALIASES = {
  'HC13': 'C13',
  'HC9': 'C9',
  'HC09': 'C09',
};

// 标签标准化：大写 + 别名映射
function normalizeLabel(label) {
  const upper = label.toUpperCase();
  return LABEL_ALIASES[upper] || upper;
}

// 标注员标签清洗：取第一个空格前的部分，再做大写标准化
function cleanLabel(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  const idx = trimmed.indexOf(' ');
  const lbl = idx > -1 ? trimmed.slice(0, idx) : trimmed;
  return normalizeLabel(lbl);
}

// 批量获取/创建标注员，返回 label -> id 的映射
async function ensureAnnotatorsBatch(rawLabels) {
  const now = new Date().toISOString();
  const labels = [...new Set(rawLabels.map(cleanLabel).filter(Boolean))];

  const upsertStmts = labels.map((label) => ({
    sql: `INSERT INTO annotators (label, raw_label, first_seen, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(label) DO UPDATE SET raw_label = excluded.raw_label, updated_at = excluded.updated_at`,
    args: [label, rawLabels.find((r) => cleanLabel(r) === label) || label, now, now],
  }));
  await getDb().batch(upsertStmts, 'write');

  const placeholders = labels.map(() => '?').join(',');
  const result = await getDb().execute({
    sql: `SELECT id, label FROM annotators WHERE label IN (${placeholders})`,
    args: labels,
  });

  const map = {};
  for (const row of result.rows) {
    map[row.label] = row.id;
  }
  return map;
}

// 单个标注员（保留兼容）
async function ensureAnnotator(rawLabel) {
  const label = cleanLabel(rawLabel);
  const now = new Date().toISOString();
  const client = getDb();
  await client.execute({
    sql: `INSERT INTO annotators (label, raw_label, first_seen, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(label) DO UPDATE SET raw_label = ?, updated_at = ?`,
    args: [label, rawLabel, now, now, rawLabel, now],
  });
  const result = await client.execute('SELECT id FROM annotators WHERE label = ?', [label]);
  return result.rows[0].id;
}

async function logRun(runType, targetDate, status, message, records) {
  await getDb().execute({
    sql: `INSERT INTO collection_log (run_type, target_date, status, message, records, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [runType, targetDate || null, status, message || '', records || 0, new Date().toISOString()],
  });
}

// 手动录入快照：写入 daily_snapshots（source='manual'），覆盖该日期+标注员的任何记录
async function upsertSnapshot({ label, date, newTaskHours, oldTaskHours, segmentHours, noClipHours, passSegmentHours }) {
  const db = getDb();
  const annotatorId = await ensureAnnotator(label);
  const now = new Date().toISOString();
  const noClipEquiv = (Number(noClipHours) || 0) * 3600 * 0.2;
  const settlementRef = (Number(passSegmentHours) || 0) * 3600 + noClipEquiv;
  const newTaskSec = (Number(newTaskHours) || 0) * 3600;
  await db.execute({
    sql: `INSERT INTO daily_snapshots
      (annotator_id, date, raw_seconds, new_task_raw_seconds, old_task_raw_seconds,
       segment_seconds, no_clip_seconds, no_clip_equivalent_seconds,
       pass_segment_seconds, settlement_reference_seconds, source, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)
      ON CONFLICT(annotator_id, date) DO UPDATE SET
        raw_seconds=excluded.raw_seconds, new_task_raw_seconds=excluded.new_task_raw_seconds,
        old_task_raw_seconds=excluded.old_task_raw_seconds,
        segment_seconds=excluded.segment_seconds, no_clip_seconds=excluded.no_clip_seconds,
        no_clip_equivalent_seconds=excluded.no_clip_equivalent_seconds,
        pass_segment_seconds=excluded.pass_segment_seconds,
        settlement_reference_seconds=excluded.settlement_reference_seconds,
        source='manual', collected_at=excluded.collected_at`,
    args: [
      annotatorId, date, newTaskSec, newTaskSec,
      (Number(oldTaskHours) || 0) * 3600,
      (Number(segmentHours) || 0) * 3600,
      (Number(noClipHours) || 0) * 3600,
      noClipEquiv, (Number(passSegmentHours) || 0) * 3600, settlementRef, now,
    ],
  });
  return annotatorId;
}

// 删除快照记录（手动录入的误删/修正）
async function deleteSnapshot({ label, date }) {
  const db = getDb();
  const ann = await db.execute({ sql: 'SELECT id FROM annotators WHERE label = ?', args: [label] });
  if (!ann.rows.length) return 0;
  const res = await db.execute({
    sql: 'DELETE FROM daily_snapshots WHERE annotator_id = ? AND date = ?',
    args: [ann.rows[0].id, date],
  });
  return res.rowsAffected || 0;
}

// 合并两个标注员的 daily_stats 数据
// 注意：不能累加！同一人的数据在平台改标签前后是同一份工作，累加会翻倍。
// 目标(新标签)已有该日期记录时保留目标值，仅当目标无该日期记录时才搬入源(旧标签)的数据。
async function mergeDailyStats(db, fromId, toId) {
  await db.execute({
    sql: `INSERT INTO daily_stats
      (annotator_id, date, raw_seconds, segment_seconds, no_clip_seconds,
       no_clip_equivalent_seconds, pass_segment_seconds, settlement_reference_seconds,
       new_task_raw_seconds, old_task_raw_seconds, collected_at)
      SELECT
        ? AS annotator_id, date, raw_seconds, segment_seconds, no_clip_seconds,
        no_clip_equivalent_seconds, pass_segment_seconds, settlement_reference_seconds,
        new_task_raw_seconds, old_task_raw_seconds, collected_at
      FROM daily_stats WHERE annotator_id = ?
      ON CONFLICT(annotator_id, date) DO NOTHING`,
    args: [toId, fromId],
  });
  // 删除 fromId 的数据
  await db.execute({ sql: 'DELETE FROM daily_stats WHERE annotator_id = ?', args: [fromId] });
  // 新快照表同样合并
  await db.execute({
    sql: `INSERT INTO daily_snapshots
      (annotator_id, date, raw_seconds, new_task_raw_seconds, old_task_raw_seconds,
       segment_seconds, no_clip_seconds, no_clip_equivalent_seconds,
       pass_segment_seconds, settlement_reference_seconds, source, collected_at)
      SELECT
        ? AS annotator_id, date, raw_seconds, new_task_raw_seconds, old_task_raw_seconds,
        segment_seconds, no_clip_seconds, no_clip_equivalent_seconds,
        pass_segment_seconds, settlement_reference_seconds, source, collected_at
      FROM daily_snapshots WHERE annotator_id = ?
      ON CONFLICT(annotator_id, date) DO NOTHING`,
    args: [toId, fromId],
  });
  await db.execute({ sql: 'DELETE FROM daily_snapshots WHERE annotator_id = ?', args: [fromId] });
}

// 合并两个标注员的累计数据
// 注意：不能累加！累计值是平台返回的权威快照，同一人改标签前后是同一份累计，累加会翻倍。
// 目标(新标签)已有累计值时保留目标值，仅当目标无累计时才搬入源(旧标签)的累计。
async function mergeCumulative(db, fromId, toId) {
  const fromRes = await db.execute({
    sql: 'SELECT * FROM annotator_cumulative WHERE annotator_id = ?',
    args: [fromId],
  });
  if (!fromRes.rows.length) return;
  const toRes = await db.execute({
    sql: 'SELECT * FROM annotator_cumulative WHERE annotator_id = ?',
    args: [toId],
  });
  if (toRes.rows.length) {
    // 目标已有累计值（平台权威值），保留目标值，删除源的累计
    await db.execute({ sql: 'DELETE FROM annotator_cumulative WHERE annotator_id = ?', args: [fromId] });
  } else {
    // 目标无累计，直接把源的累计搬过去
    await db.execute({
      sql: 'UPDATE annotator_cumulative SET annotator_id = ? WHERE annotator_id = ?',
      args: [toId, fromId],
    });
  }
}

// 迁移标注员标签：1) 别名映射 2) 大小写统一为大写
async function migrateLabels() {
  const db = getDb();
  const results = [];

  // 1) 别名映射（HC13→C13 等）：一次查询所有别名标签的存在性，减少 DB 往返
  const aliasLabels = [...new Set(Object.values(LABEL_ALIASES).concat(Object.keys(LABEL_ALIASES)))];
  const aliasPh = aliasLabels.map(() => '?').join(',');
  const aliasRes = await db.execute({
    sql: `SELECT id, label FROM annotators WHERE label IN (${aliasPh})`,
    args: aliasLabels,
  });
  const idByLabel = new Map(aliasRes.rows.map((r) => [r.label, r.id]));
  for (const [oldLabel, newLabel] of Object.entries(LABEL_ALIASES)) {
    const oldId = idByLabel.get(oldLabel);
    if (!oldId) { results.push({ old: oldLabel, new: newLabel, status: 'skip', msg: '旧标签不存在' }); continue; }
    const newId = idByLabel.get(newLabel);
    if (newId) {
      await mergeDailyStats(db, oldId, newId);
      await mergeCumulative(db, oldId, newId);
      await db.execute({ sql: 'DELETE FROM annotators WHERE id = ?', args: [oldId] });
      results.push({ old: oldLabel, new: newLabel, status: 'merged', oldId, newId });
    } else {
      await db.execute({ sql: 'UPDATE annotators SET label = ? WHERE id = ?', args: [newLabel, oldId] });
      results.push({ old: oldLabel, new: newLabel, status: 'renamed', oldId });
    }
  }

  // 2) 大小写统一：批量处理，减少 DB 往返（避免逐标签查询拖慢采集导致 504）
  const allLabels = await db.execute({ sql: 'SELECT id, label FROM annotators', args: [] });
  const byUpper = new Map(); // upper -> [{id, label}]
  for (const row of allLabels.rows) {
    const upper = row.label.toUpperCase();
    if (!byUpper.has(upper)) byUpper.set(upper, []);
    byUpper.get(upper).push({ id: row.id, label: row.label });
  }
  for (const [upper, entries] of byUpper) {
    if (entries.length === 1 && entries[0].label === upper) continue; // 已是规范大写
    const canonical = entries.find((e) => e.label === upper);
    if (canonical) {
      for (const e of entries) {
        if (e.id === canonical.id) continue;
        await mergeDailyStats(db, e.id, canonical.id);
        await mergeCumulative(db, e.id, canonical.id);
        await db.execute({ sql: 'DELETE FROM annotators WHERE id = ?', args: [e.id] });
        results.push({ old: e.label, new: upper, status: 'case-merged', oldId: e.id, newId: canonical.id });
      }
    } else {
      const e = entries[0];
      await db.execute({ sql: 'UPDATE annotators SET label = ? WHERE id = ?', args: [upper, e.id] });
      results.push({ old: e.label, new: upper, status: 'case-renamed', oldId: e.id });
      for (let i = 1; i < entries.length; i++) {
        await mergeDailyStats(db, entries[i].id, e.id);
        await mergeCumulative(db, entries[i].id, e.id);
        await db.execute({ sql: 'DELETE FROM annotators WHERE id = ?', args: [entries[i].id] });
        results.push({ old: entries[i].label, new: upper, status: 'case-merged', oldId: entries[i].id, newId: e.id });
      }
    }
  }
  return results;
}

module.exports = {
  getDb,
  ensureInit,
  cleanLabel,
  normalizeLabel,
  LABEL_ALIASES,
  ensureAnnotator,
  ensureAnnotatorsBatch,
  logRun,
  migrateLabels,
  upsertSnapshot,
  deleteSnapshot,
};
