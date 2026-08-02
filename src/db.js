'use strict';
// 数据库适配层 —— 自动检测环境：
// 有 TURSO_DATABASE_URL 时用 Turso 云数据库（Railway/Vercel 生产环境）
// 否则用本地 SQLite（本地开发）
const path = require('path');
const config = require('./config');

const useTurso = !!process.env.TURSO_DATABASE_URL;

let db, ensureAnnotator, logRun, stmtUpsertDaily, stmtUpsertCumulative, stmtGetAllAnnotators, cleanLabel, ensureInit;

if (useTurso) {
  // ===== Turso 云数据库模式 =====
  const { createClient } = require('@libsql/client');
  db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const INIT_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS annotators (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT UNIQUE NOT NULL, raw_label TEXT, first_seen TEXT, updated_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS daily_stats (id INTEGER PRIMARY KEY AUTOINCREMENT, annotator_id INTEGER NOT NULL, date TEXT NOT NULL, raw_seconds REAL NOT NULL DEFAULT 0, segment_seconds REAL NOT NULL DEFAULT 0, no_clip_seconds REAL NOT NULL DEFAULT 0, no_clip_equivalent_seconds REAL NOT NULL DEFAULT 0, pass_segment_seconds REAL NOT NULL DEFAULT 0, settlement_reference_seconds REAL NOT NULL DEFAULT 0, new_task_raw_seconds REAL NOT NULL DEFAULT 0, old_task_raw_seconds REAL NOT NULL DEFAULT 0, collected_at TEXT, UNIQUE(annotator_id, date), FOREIGN KEY(annotator_id) REFERENCES annotators(id))`,
    `CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_stats(date)`,
    `CREATE INDEX IF NOT EXISTS idx_daily_annotator ON daily_stats(annotator_id)`,
    `CREATE TABLE IF NOT EXISTS annotator_cumulative (annotator_id INTEGER PRIMARY KEY, cumulative_reference_alltime REAL NOT NULL DEFAULT 0, cumulative_raw_alltime REAL NOT NULL DEFAULT 0, cumulative_segment_alltime REAL NOT NULL DEFAULT 0, cumulative_no_clip_alltime REAL NOT NULL DEFAULT 0, cumulative_no_clip_equivalent_alltime REAL NOT NULL DEFAULT 0, updated_at TEXT, FOREIGN KEY(annotator_id) REFERENCES annotators(id))`,
    `CREATE TABLE IF NOT EXISTS collection_log (id INTEGER PRIMARY KEY AUTOINCREMENT, run_type TEXT, target_date TEXT, status TEXT, message TEXT, records INTEGER DEFAULT 0, created_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_log_created ON collection_log(created_at)`,
  ];

  let initialized = false;
  let initPromise = null;

  ensureInit = async function () {
    if (initialized) return;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        await db.batch(INIT_STATEMENTS, 'write');
        initialized = true;
        console.log('[db] Turso 数据库初始化完成（batch）');
      } catch (e) {
        initPromise = null;
        throw e;
      }
    })();
    return initPromise;
  };

  cleanLabel = function (raw) {
    if (!raw) return '';
    const trimmed = String(raw).trim();
    const idx = trimmed.indexOf(' ');
    return idx > -1 ? trimmed.slice(0, idx) : trimmed;
  };

  ensureAnnotator = async function (rawLabel) {
    await ensureInit();
    const label = cleanLabel(rawLabel);
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO annotators (label, raw_label, first_seen, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(label) DO UPDATE SET raw_label = ?, updated_at = ?`,
      args: [label, rawLabel, now, now, rawLabel, now],
    });
    const result = await db.execute('SELECT id FROM annotators WHERE label = ?', [label]);
    return result.rows[0].id;
  };

  logRun = async function (runType, targetDate, status, message, records) {
    await db.execute({
      sql: `INSERT INTO collection_log (run_type, target_date, status, message, records, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [runType, targetDate || null, status, message || '', records || 0, new Date().toISOString()],
    });
  };

  // 兼容接口：Turso 模式下 stmtUpsertDaily 等改为异步 batch 操作
  // collector.js 中的 db.transaction 在 Turso 模式不可用，需要适配
  stmtUpsertDaily = null;
  stmtUpsertCumulative = null;
  stmtGetAllAnnotators = null;

  console.log('[db] 使用 Turso 云数据库模式');
} else {
  // ===== 本地 SQLite 模式 =====
  const Database = require('better-sqlite3');
  const fs = require('fs');

  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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

  stmtUpsertDaily = db.prepare(`
    INSERT INTO daily_stats
      (annotator_id, date, raw_seconds, segment_seconds, no_clip_seconds,
       no_clip_equivalent_seconds, pass_segment_seconds, settlement_reference_seconds,
       new_task_raw_seconds, old_task_raw_seconds, collected_at)
    VALUES
      (@annotator_id, @date, @raw_seconds, @segment_seconds, @no_clip_seconds,
       @no_clip_equivalent_seconds, @pass_segment_seconds, @settlement_reference_seconds,
       @new_task_raw_seconds, @old_task_raw_seconds, @collected_at)
    ON CONFLICT(annotator_id, date) DO UPDATE SET
      raw_seconds = @raw_seconds, segment_seconds = @segment_seconds,
      no_clip_seconds = @no_clip_seconds, no_clip_equivalent_seconds = @no_clip_equivalent_seconds,
      pass_segment_seconds = @pass_segment_seconds, settlement_reference_seconds = @settlement_reference_seconds,
      new_task_raw_seconds = @new_task_raw_seconds, old_task_raw_seconds = @old_task_raw_seconds,
      collected_at = @collected_at
  `);

  stmtUpsertCumulative = db.prepare(`
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

  stmtGetAllAnnotators = db.prepare('SELECT id, label FROM annotators');

  cleanLabel = function (raw) {
    if (!raw) return '';
    const trimmed = String(raw).trim();
    const idx = trimmed.indexOf(' ');
    return idx > -1 ? trimmed.slice(0, idx) : trimmed;
  };

  ensureAnnotator = function (rawLabel) {
    const label = cleanLabel(rawLabel);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO annotators (label, raw_label, first_seen, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(label) DO UPDATE SET raw_label = ?, updated_at = ?`).run(label, rawLabel, now, now, rawLabel, now);
    return db.prepare('SELECT id FROM annotators WHERE label = ?').get(label).id;
  };

  logRun = function (runType, targetDate, status, message, records) {
    db.prepare(`INSERT INTO collection_log (run_type, target_date, status, message, records, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(runType, targetDate || null, status, message || '', records || 0, new Date().toISOString());
  };

  ensureInit = async function () {}; // SQLite 已在加载时初始化

  console.log('[db] 使用本地 SQLite 模式:', config.dbPath);
}

module.exports = {
  db,
  cleanLabel,
  ensureAnnotator,
  logRun,
  stmtUpsertDaily,
  stmtUpsertCumulative,
  stmtGetAllAnnotators,
  ensureInit,
  useTurso,
};
