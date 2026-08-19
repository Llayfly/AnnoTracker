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

// 标签标准化：先取第一个空格前的部分，再应用别名映射
function normalizeLabel(label) {
  return LABEL_ALIASES[label] || label;
}

// 标注员标签清洗：取第一个空格前的部分，再做标准化
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

// 迁移标注员标签：将旧编号合并到新编号
async function migrateLabels() {
  const db = getDb();
  const results = [];
  for (const [oldLabel, newLabel] of Object.entries(LABEL_ALIASES)) {
    const oldRes = await db.execute({ sql: 'SELECT id FROM annotators WHERE label = ?', args: [oldLabel] });
    if (!oldRes.rows.length) { results.push({ old: oldLabel, new: newLabel, status: 'skip', msg: '旧标签不存在' }); continue; }
    const oldId = oldRes.rows[0].id;
    const newRes = await db.execute({ sql: 'SELECT id FROM annotators WHERE label = ?', args: [newLabel] });
    if (newRes.rows.length) {
      const newId = newRes.rows[0].id;
      await db.batch([
        { sql: 'UPDATE daily_stats SET annotator_id = ? WHERE annotator_id = ?', args: [newId, oldId] },
        { sql: 'UPDATE annotator_cumulative SET annotator_id = ? WHERE annotator_id = ?', args: [newId, oldId] },
        { sql: 'DELETE FROM annotators WHERE id = ?', args: [oldId] },
      ], 'write');
      results.push({ old: oldLabel, new: newLabel, status: 'merged', oldId, newId });
    } else {
      await db.execute({ sql: 'UPDATE annotators SET label = ? WHERE id = ?', args: [newLabel, oldId] });
      results.push({ old: oldLabel, new: newLabel, status: 'renamed', oldId });
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
};
