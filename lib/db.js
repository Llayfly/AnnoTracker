const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL 环境变量未设置，请在 Vercel 中配置 PostgreSQL 数据库');
    }
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

// ========== 初始化表结构 ==========
async function initDB() {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS annotators (
        label TEXT PRIMARY KEY,
        name TEXT,
        organization TEXT,
        first_seen TEXT,
        last_active TEXT,
        created_at TEXT DEFAULT (now()::text),
        updated_at TEXT DEFAULT (now()::text)
      );

      CREATE TABLE IF NOT EXISTS daily_stats (
        id SERIAL PRIMARY KEY,
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
        fetched_at TEXT DEFAULT (now()::text),
        UNIQUE(annotator_label, date)
      );

      CREATE TABLE IF NOT EXISTS org_cumulative (
        id SERIAL PRIMARY KEY,
        date TEXT NOT NULL,
        organization TEXT,
        cumulative_raw_duration REAL DEFAULT 0,
        cumulative_segment_duration REAL DEFAULT 0,
        fetched_at TEXT DEFAULT (now()::text),
        UNIQUE(date, organization)
      );

      CREATE TABLE IF NOT EXISTS collect_log (
        id SERIAL PRIMARY KEY,
        date TEXT NOT NULL,
        status TEXT,
        annotator_count INTEGER DEFAULT 0,
        error_message TEXT,
        created_at TEXT DEFAULT (now()::text)
      );

      CREATE INDEX IF NOT EXISTS idx_daily_stats_label ON daily_stats(annotator_label);
      CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
      CREATE INDEX IF NOT EXISTS idx_daily_stats_label_date ON daily_stats(annotator_label, date);
    `);
    console.log('[DB] 表结构初始化完成');
  } finally {
    client.release();
  }
}

// ========== 标注员操作 ==========
async function upsertAnnotator(label, name, organization) {
  const now = new Date().toISOString();
  const client = await getPool().connect();
  try {
    await client.query(`
      INSERT INTO annotators (label, name, organization, first_seen, last_active, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (label) DO UPDATE SET
        name = COALESCE($2, annotators.name),
        organization = COALESCE($3, annotators.organization),
        last_active = $5,
        updated_at = $6
    `, [label, name || null, organization || null, now, now, now]);
  } finally {
    client.release();
  }
}

// ========== 每日统计操作 ==========
async function upsertDailyStat(stat) {
  const client = await getPool().connect();
  try {
    await client.query(`
      INSERT INTO daily_stats (
        annotator_label, date, organization,
        raw_duration_seconds, segment_duration_seconds,
        no_clip_duration_seconds, no_clip_equivalent_seconds,
        new_task_raw_duration_seconds, old_task_raw_duration_seconds,
        settlement_reference, cumulative_reference, has_settlement,
        fetched_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now()::text)
      ON CONFLICT (annotator_label, date) DO UPDATE SET
        organization = EXCLUDED.organization,
        raw_duration_seconds = EXCLUDED.raw_duration_seconds,
        segment_duration_seconds = EXCLUDED.segment_duration_seconds,
        no_clip_duration_seconds = EXCLUDED.no_clip_duration_seconds,
        no_clip_equivalent_seconds = EXCLUDED.no_clip_equivalent_seconds,
        new_task_raw_duration_seconds = EXCLUDED.new_task_raw_duration_seconds,
        old_task_raw_duration_seconds = EXCLUDED.old_task_raw_duration_seconds,
        settlement_reference = EXCLUDED.settlement_reference,
        cumulative_reference = EXCLUDED.cumulative_reference,
        has_settlement = EXCLUDED.has_settlement,
        fetched_at = now()::text
    `, [
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
      stat.has_settlement ? 1 : 0,
    ]);
  } finally {
    client.release();
  }
}

async function getDailyStatsByDateRange(startDate, endDate, annotatorLabel) {
  const client = await getPool().connect();
  try {
    if (annotatorLabel) {
      const res = await client.query(`
        SELECT * FROM daily_stats
        WHERE annotator_label = $1 AND date >= $2 AND date <= $3
        ORDER BY date
      `, [annotatorLabel, startDate, endDate]);
      return res.rows;
    }
    const res = await client.query(`
      SELECT * FROM daily_stats
      WHERE date >= $1 AND date <= $2
      ORDER BY annotator_label, date
    `, [startDate, endDate]);
    return res.rows;
  } finally {
    client.release();
  }
}

async function getAggregatedStats(startDate, endDate) {
  const client = await getPool().connect();
  try {
    const res = await client.query(`
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
      WHERE d.date >= $1 AND d.date <= $2
      GROUP BY d.annotator_label
      ORDER BY total_raw_duration DESC
    `, [startDate, endDate]);
    return res.rows;
  } finally {
    client.release();
  }
}

async function getAvailableDates() {
  const client = await getPool().connect();
  try {
    const res = await client.query('SELECT DISTINCT date FROM daily_stats ORDER BY date DESC');
    return res.rows.map(r => r.date);
  } finally {
    client.release();
  }
}

// ========== 组织累计 ==========
async function upsertOrgCumulative(date, organization, rawDuration, segmentDuration) {
  const client = await getPool().connect();
  try {
    await client.query(`
      INSERT INTO org_cumulative (date, organization, cumulative_raw_duration, cumulative_segment_duration, fetched_at)
      VALUES ($1, $2, $3, $4, now()::text)
      ON CONFLICT (date, organization) DO UPDATE SET
        cumulative_raw_duration = EXCLUDED.cumulative_raw_duration,
        cumulative_segment_duration = EXCLUDED.cumulative_segment_duration,
        fetched_at = now()::text
    `, [date, organization, rawDuration || 0, segmentDuration || 0]);
  } finally {
    client.release();
  }
}

// ========== 采集日志 ==========
async function logCollect(date, status, annotatorCount, errorMessage) {
  const client = await getPool().connect();
  try {
    await client.query(`
      INSERT INTO collect_log (date, status, annotator_count, error_message)
      VALUES ($1, $2, $3, $4)
    `, [date, status, annotatorCount || 0, errorMessage || null]);
  } finally {
    client.release();
  }
}

async function getRecentCollectLogs(limit) {
  const client = await getPool().connect();
  try {
    const res = await client.query('SELECT * FROM collect_log ORDER BY created_at DESC LIMIT $1', [limit || 20]);
    return res.rows;
  } finally {
    client.release();
  }
}

async function getLatestCollectLog() {
  const client = await getPool().connect();
  try {
    const res = await client.query('SELECT * FROM collect_log ORDER BY created_at DESC LIMIT 1');
    return res.rows[0] || null;
  } finally {
    client.release();
  }
}

async function getStats() {
  const client = await getPool().connect();
  try {
    const annotatorRes = await client.query('SELECT COUNT(*) as count FROM annotators');
    const statRes = await client.query('SELECT COUNT(*) as count FROM daily_stats');
    const latestDateRes = await client.query('SELECT date FROM daily_stats ORDER BY date DESC LIMIT 1');
    const latestLogRes = await client.query('SELECT * FROM collect_log ORDER BY created_at DESC LIMIT 1');

    return {
      annotator_count: parseInt(annotatorRes.rows[0].count),
      stat_count: parseInt(statRes.rows[0].count),
      latest_date: latestDateRes.rows[0]?.date || null,
      latest_collect: latestLogRes.rows[0] || null,
    };
  } finally {
    client.release();
  }
}

module.exports = {
  initDB,
  upsertAnnotator,
  upsertDailyStat,
  getDailyStatsByDateRange,
  getAggregatedStats,
  getAvailableDates,
  upsertOrgCumulative,
  logCollect,
  getRecentCollectLogs,
  getLatestCollectLog,
  getStats,
};
