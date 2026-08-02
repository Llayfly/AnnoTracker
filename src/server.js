'use strict';
// Express 服务：提供查询 API + 托管前端静态文件 + 启动定时任务
// 自动适配 Turso（异步）和本地 SQLite（同步）两种模式
const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { db, useTurso, ensureInit } = require('./db');
const collector = require('./collector');
const { startScheduler } = require('./scheduler');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// ===== 数据库查询适配层 =====
// 统一异步接口，底层自动分派 Turso 或 SQLite
async function dbAll(sql, params = []) {
  if (useTurso) {
    const result = await db.execute({ sql, args: Array.isArray(params) ? params : [params] });
    return result.rows;
  }
  // SQLite: 把 ? 占位符转为 better-sqlite3 的 .all(...params)
  return db.prepare(sql).all(...params);
}

async function dbGet(sql, params = []) {
  if (useTurso) {
    const result = await db.execute({ sql, args: Array.isArray(params) ? params : [params] });
    return result.rows[0];
  }
  return db.prepare(sql).get(...params);
}

// ===== 认证中间件 =====
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : req.query.token;
  if (!token) return res.status(401).json({ error: '未登录，请先登录' });
  try {
    req.user = jwt.verify(token, config.auth.jwtSecret);
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// ===== API: 登录 =====
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  if (username !== config.auth.username || password !== config.auth.password) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = jwt.sign({ username }, config.auth.jwtSecret, { expiresIn: config.auth.tokenExpiresIn });
  res.json({ token, username, expires_in: config.auth.tokenExpiresIn });
});

app.use('/api', (req, res, next) => {
  if (req.path === '/login') return next();
  return requireAuth(req, res, next);
});

// ===== 工具函数 =====
const SEC_PER_HOUR = 3600;
const s2h = (s) => Math.round((Number(s) || 0) / SEC_PER_HOUR * 1000) / 1000;

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
    start = query.start; end = query.end;
  } else {
    end = fmtDate(today);
    const range = query.range || '1w';
    const days = { '1d': 1, '3d': 3, '1w': 7, '15d': 15, '1m': 30 }[range] || 7;
    const sd = new Date(today);
    sd.setDate(sd.getDate() - (days - 1));
    start = fmtDate(sd);
  }
  return { start, end };
}

function getLevel(h) {
  if (h < 3) return 'red';
  if (h <= 5) return 'blue';
  return 'green';
}

// ===== API: 汇总数据 =====
app.get('/api/summary', async (req, res) => {
  try {
    if (useTurso) await ensureInit();
    const { start, end } = getRange(req.query);
    const search = req.query.search ? `%${req.query.search.trim()}%` : '%';

    const rows = await dbAll(
      `SELECT a.id, a.label, a.raw_label,
        COALESCE(SUM(d.raw_seconds),0) AS raw_seconds,
        COALESCE(SUM(d.segment_seconds),0) AS segment_seconds,
        COALESCE(SUM(d.no_clip_seconds),0) AS no_clip_seconds,
        COALESCE(SUM(d.no_clip_equivalent_seconds),0) AS no_clip_equivalent_seconds,
        COALESCE(SUM(d.settlement_reference_seconds),0) AS settlement_reference_seconds,
        COUNT(d.date) AS active_days,
        (SELECT COALESCE(SUM(d2.settlement_reference_seconds),0) FROM daily_stats d2 WHERE d2.annotator_id = a.id AND d2.date <= ?) AS cumulative_reference_seconds
      FROM annotators a
      LEFT JOIN daily_stats d ON d.annotator_id = a.id AND d.date >= ? AND d.date <= ?
      WHERE a.label LIKE ?
      GROUP BY a.id
      HAVING active_days > 0
      ORDER BY raw_seconds DESC`,
      [end, start, end, search]
    );

    const data = rows.map((r) => {
      const dailyAvgRawHours = r.active_days > 0 ? Number(r.raw_seconds) / r.active_days / SEC_PER_HOUR : 0;
      return {
        label: r.label, raw_label: r.raw_label,
        raw_hours: s2h(r.raw_seconds), segment_hours: s2h(r.segment_seconds),
        no_clip_hours: s2h(r.no_clip_seconds), no_clip_equivalent_hours: s2h(r.no_clip_equivalent_seconds),
        settlement_reference_hours: s2h(r.settlement_reference_seconds),
        cumulative_reference_hours: s2h(r.cumulative_reference_seconds),
        daily_avg_raw_hours: Math.round(dailyAvgRawHours * 1000) / 1000,
        active_days: r.active_days, level: getLevel(dailyAvgRawHours),
      };
    });
    res.json({ range: { start, end }, count: data.length, data });
  } catch (e) {
    console.error('[api] summary error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== API: 某标注员每日明细 =====
app.get('/api/detail/:label', async (req, res) => {
  try {
    if (useTurso) await ensureInit();
    const { start, end } = getRange(req.query);
    const label = req.params.label;

    const annotator = await dbGet('SELECT id, label, raw_label FROM annotators WHERE label = ?', [label]);
    if (!annotator) return res.status(404).json({ error: '标注员不存在' });

    const allRows = await dbAll(
      `SELECT date, raw_seconds, segment_seconds, no_clip_seconds,
             no_clip_equivalent_seconds, settlement_reference_seconds,
             pass_segment_seconds, new_task_raw_seconds, old_task_raw_seconds
      FROM daily_stats WHERE annotator_id = ? ORDER BY date ASC`,
      [annotator.id]
    );

    let running = 0;
    const fullWithCum = allRows.map((r) => {
      running += Number(r.settlement_reference_seconds);
      return { ...r, running_cumulative_seconds: running };
    });
    const daily = fullWithCum.filter((r) => r.date >= start && r.date <= end).map((r) => ({
      date: r.date,
      raw_hours: s2h(r.raw_seconds), segment_hours: s2h(r.segment_seconds),
      no_clip_hours: s2h(r.no_clip_seconds), no_clip_equivalent_hours: s2h(r.no_clip_equivalent_seconds),
      settlement_reference_hours: s2h(r.settlement_reference_seconds),
      cumulative_reference_hours: s2h(r.running_cumulative_seconds),
      pass_segment_hours: s2h(r.pass_segment_seconds),
      new_task_raw_hours: s2h(r.new_task_raw_seconds),
      old_task_raw_hours: s2h(r.old_task_raw_seconds),
    }));

    res.json({
      label: annotator.label, raw_label: annotator.raw_label,
      range: { start, end },
      latest_cumulative_reference_hours: fullWithCum.length ? s2h(fullWithCum[fullWithCum.length - 1].running_cumulative_seconds) : 0,
      daily,
    });
  } catch (e) {
    console.error('[api] detail error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== API: 导出 CSV =====
app.get('/api/export', async (req, res) => {
  try {
    if (useTurso) await ensureInit();
    const { start, end } = getRange(req.query);
    const search = req.query.search ? `%${req.query.search.trim()}%` : '%';

    const rows = await dbAll(
      `SELECT a.label,
        COALESCE(SUM(d.raw_seconds),0) AS raw_seconds,
        COALESCE(SUM(d.segment_seconds),0) AS segment_seconds,
        COALESCE(SUM(d.no_clip_seconds),0) AS no_clip_seconds,
        COALESCE(SUM(d.no_clip_equivalent_seconds),0) AS no_clip_equivalent_seconds,
        COALESCE(SUM(d.settlement_reference_seconds),0) AS settlement_reference_seconds,
        (SELECT COALESCE(SUM(d2.settlement_reference_seconds),0) FROM daily_stats d2 WHERE d2.annotator_id = a.id AND d2.date <= ?) AS cumulative_reference_seconds,
        COUNT(d.date) AS active_days
      FROM annotators a
      LEFT JOIN daily_stats d ON d.annotator_id = a.id AND d.date >= ? AND d.date <= ?
      WHERE a.label LIKE ?
      GROUP BY a.id HAVING active_days > 0 ORDER BY raw_seconds DESC`,
      [end, start, end, search]
    );

    const levelText = (h) => (h < 3 ? '红色预警' : h <= 5 ? '蓝色正常' : '绿色活跃');
    const header = ['标注员', '原始时长(小时)', '片段时长(小时)', '无片段时长(小时)', '无片段等效(小时)', '结算参考(小时)', '累计参考(小时)', '日均原始时长(小时)', '活跃天数', '预警等级'];
    const lines = [header.join(',')];
    for (const r of rows) {
      const avg = r.active_days > 0 ? Number(r.raw_seconds) / r.active_days / SEC_PER_HOUR : 0;
      lines.push([r.label, s2h(r.raw_seconds), s2h(r.segment_seconds), s2h(r.no_clip_seconds), s2h(r.no_clip_equivalent_seconds), s2h(r.settlement_reference_seconds), s2h(r.cumulative_reference_seconds), Math.round(avg * 1000) / 1000, r.active_days, levelText(avg)].join(','));
    }
    const csv = '\ufeff' + lines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="annotator_stats_${start}_${end}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('[api] export error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== API: 系统状态 =====
app.get('/api/status', async (req, res) => {
  try {
    if (useTurso) await ensureInit();
    let annCount, dateRange, lastLog;

    if (useTurso) {
      const results = await db.batch([
        'SELECT COUNT(*) AS c FROM annotators',
        'SELECT MIN(date) AS min, MAX(date) AS max FROM daily_stats',
        'SELECT * FROM collection_log ORDER BY created_at DESC LIMIT 10',
      ], 'read');
      annCount = results[0].rows[0].c;
      dateRange = results[1].rows[0];
      lastLog = results[2].rows;
    } else {
      annCount = db.prepare('SELECT COUNT(*) AS c FROM annotators').get().c;
      dateRange = db.prepare('SELECT MIN(date) AS min, MAX(date) AS max FROM daily_stats').get();
      lastLog = db.prepare('SELECT * FROM collection_log ORDER BY created_at DESC LIMIT 10').all();
    }

    res.json({
      collecting: collector.isCollecting(),
      annotator_count: annCount,
      date_range: dateRange,
      recent_logs: lastLog,
      server_time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== API: 手动触发采集 =====
app.post('/api/collect', async (req, res) => {
  if (collector.isCollecting()) return res.status(409).json({ error: '已有采集任务在运行' });
  collector.collectToday();
  res.json({ message: '已触发当天数据采集' });
});

// ===== 启动 =====
async function start() {
  const args = process.argv.slice(2);
  if (args.includes('--backfill-only')) {
    console.log('[启动] 仅回填模式');
    if (useTurso) await ensureInit();
    await collector.backfill(config.backfillDays);
    process.exit(0);
  }
  if (args.includes('--collect-once')) {
    console.log('[启动] 单次采集模式');
    if (useTurso) await ensureInit();
    await collector.collectToday();
    process.exit(0);
  }

  if (useTurso) await ensureInit();
  collector.backfillMissing(config.backfillDays).catch((e) => console.error('[启动] 补采异常:', e.message));
  startScheduler();

  app.listen(config.port, () => {
    console.log(`[启动] 服务已启动: http://localhost:${config.port}`);
    console.log(`[启动] 数据库: ${useTurso ? 'Turso 云数据库' : config.dbPath}`);
  });
}

start();
