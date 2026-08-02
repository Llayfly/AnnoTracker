'use strict';
// Turso (libSQL) 数据库适配层 —— 替代本地 SQLite
// 使用 @libsql/client 远程连接 Turso 云数据库
const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ===== 建表（幂等执行）=====
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS annotators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT UNIQUE NOT NULL,
  raw_label TEXT,
  first_seen TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS daily_stats (
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
);
CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_stats(date);
CREATE INDEX IF NOT EXISTS idx_daily_annotator ON daily_stats(annotator_id);

CREATE TABLE IF NOT EXISTS annotator_cumulative (
  annotator_id INTEGER PRIMARY KEY,
  cumulative_reference_alltime REAL NOT NULL DEFAULT 0,
  cumulative_raw_alltime REAL NOT NULL DEFAULT 0,
  cumulative_segment_alltime REAL NOT NULL DEFAULT 0,
  cumulative_no_clip_alltime REAL NOT NULL DEFAULT 0,
  cumulative_no_clip_equivalent_alltime REAL NOT NULL DEFAULT 0,
  updated_at TEXT,
  FOREIGN KEY(annotator_id) REFERENCES annotators(id)
);

CREATE TABLE IF NOT EXISTS collection_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT,
  target_date TEXT,
  status TEXT,
  message TEXT,
  records INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_created ON collection_log(created_at);
`;

let initialized = false;

async function ensureInit() {
  if (initialized) return;
  // 逐条执行建表语句（Turso 不支持批量多语句）
  const statements = INIT_SQL.split(';').filter((s) => s.trim());
  for (const stmt of statements) {
    await db.execute(stmt);
  }
  initialized = true;
  console.log('[db] Turso 数据库初始化完成');
}

// 标注员标签清洗：取第一个空格前的部分
function cleanLabel(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  const idx = trimmed.indexOf(' ');
  return idx > -1 ? trimmed.slice(0, idx) : trimmed;
}

// 获取/创建标注员，返回 id
async function ensureAnnotator(rawLabel) {
  const label = cleanLabel(rawLabel);
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO annotators (label, raw_label, first_seen, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(label) DO UPDATE SET raw_label = ?, updated_at = ?`,
    args: [label, rawLabel, now, now, rawLabel, now],
  });
  const result = await db.execute('SELECT id FROM annotators WHERE label = ?', [label]);
  return result.rows[0].id;
}

async function logRun(runType, targetDate, status, message, records) {
  await db.execute({
    sql: `INSERT INTO collection_log (run_type, target_date, status, message, records, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [runType, targetDate || null, status, message || '', records || 0, new Date().toISOString()],
  });
}

module.exports = {
  db,
  ensureInit,
  cleanLabel,
  ensureAnnotator,
  logRun,
};
