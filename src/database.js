const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// 确保数据目录存在
const dbDir = path.dirname(config.db.path);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.db.path);

// 启用 WAL 模式提升并发性能
db.pragma('journal_mode = WAL');

// 初始化表结构
db.exec(`
  -- 标注员表
  CREATE TABLE IF NOT EXISTS annotators (
    label TEXT PRIMARY KEY,
    name TEXT,
    organization TEXT,
    first_seen TEXT,
    last_active TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- 每日统计表
  CREATE TABLE IF NOT EXISTS daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    annotator_label TEXT NOT NULL,
    date TEXT NOT NULL,
    organization TEXT,
    raw_duration_seconds REAL DEFAULT 0,
    segment_duration_seconds REAL DEFAULT 0,
    no_clip_duration_seconds REAL DEFAULT 0,
    no_clip_equivalent_seconds REAL DEFAULT 0,
    new_task_raw_duration_seconds REAL DEFAULT 0,
    old_task_raw_duration_seconds REAL DEFAULT 0,
    settlement_reference REAL DEFAULT 0,
    cumulative_reference REAL DEFAULT 0,
    has_settlement INTEGER DEFAULT 0,
    fetched_at TEXT DEFAULT (datetime('now')),
    UNIQUE(annotator_label, date)
  );

  -- 组织累计统计表
  CREATE TABLE IF NOT EXISTS org_cumulative (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    organization TEXT,
    cumulative_raw_duration REAL DEFAULT 0,
    cumulative_segment_duration REAL DEFAULT 0,
    fetched_at TEXT DEFAULT (datetime('now')),
    UNIQUE(date, organization)
  );

  -- 采集日志表
  CREATE TABLE IF NOT EXISTS collect_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    status TEXT,
    annotator_count INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- 创建索引
  CREATE INDEX IF NOT EXISTS idx_daily_stats_label ON daily_stats(annotator_label);
  CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
  CREATE INDEX IF NOT EXISTS idx_daily_stats_label_date ON daily_stats(annotator_label, date);
`);

// 兼容已有数据库：添加新字段（如果不存在）
try {
  db.prepare("SELECT new_task_raw_duration_seconds FROM daily_stats LIMIT 0").get();
} catch (e) {
  db.exec("ALTER TABLE daily_stats ADD COLUMN new_task_raw_duration_seconds REAL DEFAULT 0");
  console.log('[DB] 已添加 new_task_raw_duration_seconds 列');
}
try {
  db.prepare("SELECT old_task_raw_duration_seconds FROM daily_stats LIMIT 0").get();
} catch (e) {
  db.exec("ALTER TABLE daily_stats ADD COLUMN old_task_raw_duration_seconds REAL DEFAULT 0");
  console.log('[DB] 已添加 old_task_raw_duration_seconds 列');
}

// ========== 标注员操作 ==========

function upsertAnnotator(label, name, organization) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO annotators (label, name, organization, first_seen, last_active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(label) DO UPDATE SET
      name = COALESCE(excluded.name, annotators.name),
      organization = COALESCE(excluded.organization, annotators.organization),
      last_active = excluded.last_active,
      updated_at = excluded.updated_at
  `);
  stmt.run(label, name || null, organization || null, now, now, now);
}

function getAllAnnotators() {
  return db.prepare('SELECT * FROM annotators ORDER BY label').all();
}

function getAnnotatorByLabel(label) {
  return db.prepare('SELECT * FROM annotators WHERE label = ?').get(label);
}

// ========== 每日统计操作 ==========

function upsertDailyStat(stat) {
  const stmt = db.prepare(`
    INSERT INTO daily_stats (
      annotator_label, date, organization,
      raw_duration_seconds, segment_duration_seconds,
      no_clip_duration_seconds, no_clip_equivalent_seconds,
      new_task_raw_duration_seconds, old_task_raw_duration_seconds,
      settlement_reference, cumulative_reference, has_settlement,
      fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(annotator_label, date) DO UPDATE SET
      organization = excluded.organization,
      raw_duration_seconds = excluded.raw_duration_seconds,
      segment_duration_seconds = excluded.segment_duration_seconds,
      no_clip_duration_seconds = excluded.no_clip_duration_seconds,
      no_clip_equivalent_seconds = excluded.no_clip_equivalent_seconds,
      new_task_raw_duration_seconds = excluded.new_task_raw_duration_seconds,
      old_task_raw_duration_seconds = excluded.old_task_raw_duration_seconds,
      settlement_reference = excluded.settlement_reference,
      cumulative_reference = excluded.cumulative_reference,
      has_settlement = excluded.has_settlement,
      fetched_at = datetime('now')
  `);
  stmt.run(
    stat.annotator_label,
    stat.date,
    stat.organization,
    stat.raw_duration_seconds || 0,
    stat.segment_duration_seconds || 0,
    stat.no_clip_duration_seconds || 0,
    stat.no_clip_equivalent_seconds || 0,
    stat.new_task_raw_duration_seconds || 0,
    stat.old_task_raw_duration_seconds || 0,
    stat.settlement_reference || 0,
    stat.cumulative_reference || 0,
    stat.has_settlement ? 1 : 0
  );
}

function getDailyStatsByDateRange(startDate, endDate, annotatorLabel) {
  if (annotatorLabel) {
    return db.prepare(`
      SELECT * FROM daily_stats
      WHERE annotator_label = ? AND date >= ? AND date <= ?
      ORDER BY date
    `).all(annotatorLabel, startDate, endDate);
  }
  return db.prepare(`
    SELECT * FROM daily_stats
    WHERE date >= ? AND date <= ?
    ORDER BY annotator_label, date
  `).all(startDate, endDate);
}

function getAggregatedStats(startDate, endDate) {
  return db.prepare(`
    SELECT
      d.annotator_label,
      a.name as annotator_name,
      a.organization,
      COUNT(d.date) as active_days,
      SUM(d.raw_duration_seconds) as total_raw_duration,
      SUM(d.segment_duration_seconds) as total_segment_duration,
      SUM(d.no_clip_duration_seconds) as total_no_clip_duration,
      SUM(d.no_clip_equivalent_seconds) as total_no_clip_equivalent,
      SUM(d.new_task_raw_duration_seconds) as total_new_task_duration,
      SUM(d.old_task_raw_duration_seconds) as total_old_task_duration,
      SUM(d.settlement_reference) as total_settlement_reference,
      MAX(d.cumulative_reference) as latest_cumulative_reference,
      ROUND(AVG(d.raw_duration_seconds), 2) as avg_daily_raw_duration,
      MIN(d.date) as first_active_date,
      MAX(d.date) as last_active_date
    FROM daily_stats d
    LEFT JOIN annotators a ON d.annotator_label = a.label
    WHERE d.date >= ? AND d.date <= ?
    GROUP BY d.annotator_label
    ORDER BY total_raw_duration DESC
  `).all(startDate, endDate);
}

function getAvailableDates() {
  return db.prepare(`
    SELECT DISTINCT date FROM daily_stats ORDER BY date DESC
  `).all().map(r => r.date);
}

function getLatestCollectDate() {
  const row = db.prepare(`
    SELECT date FROM daily_stats ORDER BY date DESC LIMIT 1
  `).get();
  return row ? row.date : null;
}

// ========== 组织累计统计 ==========

function upsertOrgCumulative(date, organization, rawDuration, segmentDuration) {
  const stmt = db.prepare(`
    INSERT INTO org_cumulative (date, organization, cumulative_raw_duration, cumulative_segment_duration, fetched_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(date, organization) DO UPDATE SET
      cumulative_raw_duration = excluded.cumulative_raw_duration,
      cumulative_segment_duration = excluded.cumulative_segment_duration,
      fetched_at = datetime('now')
  `);
  stmt.run(date, organization, rawDuration || 0, segmentDuration || 0);
}

function getOrgCumulative(startDate, endDate) {
  return db.prepare(`
    SELECT * FROM org_cumulative
    WHERE date >= ? AND date <= ?
    ORDER BY date
  `).all(startDate, endDate);
}

// ========== 采集日志 ==========

function logCollect(date, status, annotatorCount, errorMessage) {
  const stmt = db.prepare(`
    INSERT INTO collect_log (date, status, annotator_count, error_message)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(date, status, annotatorCount || 0, errorMessage || null);
}

function getRecentCollectLogs(limit) {
  return db.prepare(`
    SELECT * FROM collect_log ORDER BY created_at DESC LIMIT ?
  `).all(limit || 20);
}

// ========== 统计信息 ==========

function getStats() {
  const annotatorCount = db.prepare('SELECT COUNT(*) as count FROM annotators').get().count;
  const statCount = db.prepare('SELECT COUNT(*) as count FROM daily_stats').get().count;
  const latestDate = getLatestCollectDate();
  const latestLog = db.prepare(`
    SELECT * FROM collect_log ORDER BY created_at DESC LIMIT 1
  `).get();

  return {
    annotator_count: annotatorCount,
    stat_count: statCount,
    latest_date: latestDate,
    latest_collect: latestLog,
  };
}

module.exports = {
  db,
  upsertAnnotator,
  getAllAnnotators,
  getAnnotatorByLabel,
  upsertDailyStat,
  getDailyStatsByDateRange,
  getAggregatedStats,
  getAvailableDates,
  getLatestCollectDate,
  upsertOrgCumulative,
  getOrgCumulative,
  logCollect,
  getRecentCollectLogs,
  getStats,
};
