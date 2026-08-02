'use strict';
// SQLite 数据库初始化与表结构
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// 确保数据库目录存在
const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ===== 建表 =====
db.exec(`
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
`);

// ===== 预编译语句 =====
const stmtUpsertAnnotator = db.prepare(`
INSERT INTO annotators (label, raw_label, first_seen, updated_at)
VALUES (@label, @raw_label, @now, @now)
ON CONFLICT(label) DO UPDATE SET
  raw_label = @raw_label,
  updated_at = @now
`);
const stmtGetAnnotator = db.prepare('SELECT id FROM annotators WHERE label = ?');
const stmtGetAllAnnotators = db.prepare('SELECT id, label FROM annotators');

const stmtUpsertDaily = db.prepare(`
INSERT INTO daily_stats
  (annotator_id, date, raw_seconds, segment_seconds, no_clip_seconds,
   no_clip_equivalent_seconds, pass_segment_seconds, settlement_reference_seconds,
   new_task_raw_seconds, old_task_raw_seconds, collected_at)
VALUES
  (@annotator_id, @date, @raw_seconds, @segment_seconds, @no_clip_seconds,
   @no_clip_equivalent_seconds, @pass_segment_seconds, @settlement_reference_seconds,
   @new_task_raw_seconds, @old_task_raw_seconds, @collected_at)
ON CONFLICT(annotator_id, date) DO UPDATE SET
  raw_seconds = @raw_seconds,
  segment_seconds = @segment_seconds,
  no_clip_seconds = @no_clip_seconds,
  no_clip_equivalent_seconds = @no_clip_equivalent_seconds,
  pass_segment_seconds = @pass_segment_seconds,
  settlement_reference_seconds = @settlement_reference_seconds,
  new_task_raw_seconds = @new_task_raw_seconds,
  old_task_raw_seconds = @old_task_raw_seconds,
  collected_at = @collected_at
`);

const stmtUpsertCumulative = db.prepare(`
INSERT INTO annotator_cumulative
  (annotator_id, cumulative_reference_alltime, cumulative_raw_alltime,
   cumulative_segment_alltime, cumulative_no_clip_alltime,
   cumulative_no_clip_equivalent_alltime, updated_at)
VALUES
  (@annotator_id, @cumulative_reference_alltime, @cumulative_raw_alltime,
   @cumulative_segment_alltime, @cumulative_no_clip_alltime,
   @cumulative_no_clip_equivalent_alltime, @now)
ON CONFLICT(annotator_id) DO UPDATE SET
  cumulative_reference_alltime = @cumulative_reference_alltime,
  cumulative_raw_alltime = @cumulative_raw_alltime,
  cumulative_segment_alltime = @cumulative_segment_alltime,
  cumulative_no_clip_alltime = @cumulative_no_clip_alltime,
  cumulative_no_clip_equivalent_alltime = @cumulative_no_clip_equivalent_alltime,
  updated_at = @now
`);

const stmtInsertLog = db.prepare(`
INSERT INTO collection_log (run_type, target_date, status, message, records, created_at)
VALUES (@run_type, @target_date, @status, @message, @records, @created_at)
`);

// ===== 辅助函数 =====
// 标注员标签清洗：取第一个空格前的部分，如 "HC8 HC8" -> "HC8"
function cleanLabel(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  const idx = trimmed.indexOf(' ');
  return idx > -1 ? trimmed.slice(0, idx) : trimmed;
}

// 获取/创建标注员，返回 id
function ensureAnnotator(rawLabel) {
  const label = cleanLabel(rawLabel);
  const now = new Date().toISOString();
  stmtUpsertAnnotator.run({ label, raw_label: rawLabel, now });
  return stmtGetAnnotator.get(label).id;
}

function logRun(runType, targetDate, status, message, records) {
  stmtInsertLog.run({
    run_type: runType,
    target_date: targetDate || null,
    status,
    message: message || '',
    records: records || 0,
    created_at: new Date().toISOString(),
  });
}

module.exports = {
  db,
  cleanLabel,
  ensureAnnotator,
  logRun,
  stmtUpsertDaily,
  stmtUpsertCumulative,
  stmtGetAllAnnotators,
};
