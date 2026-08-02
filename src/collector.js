'use strict';
// 数据采集模块：登录平台获取 JWT，调用统计 API，解析并入库
// 自动适配 Turso（异步 batch）和本地 SQLite（同步 transaction）两种模式
const axios = require('axios');
const config = require('./config');
const { db, ensureAnnotator, stmtUpsertDaily, stmtUpsertCumulative, logRun, useTurso, ensureInit } = require('./db');

const http = axios.create({
  baseURL: config.platform.baseUrl,
  timeout: config.requestTimeoutMs,
});

let cachedToken = null;
let tokenExpireAt = 0;
let cachedInception = null;
let collecting = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const res = await http.post(config.platform.loginPath, {
    email: config.platform.email,
    password: config.platform.password,
  });
  const data = res.data;
  if (!data || !data.access_token) {
    throw new Error('登录失败：未返回 access_token');
  }
  cachedToken = data.access_token;
  const expiresIn = data.expires_in || 28800;
  tokenExpireAt = Date.now() + expiresIn * 1000 - 5 * 60 * 1000;
  console.log('[collector] 登录成功，token 将在', Math.round(expiresIn / 3600), '小时后过期');
  return cachedToken;
}

async function getToken() {
  if (!cachedToken || Date.now() >= tokenExpireAt) {
    await login();
  }
  return cachedToken;
}

async function authGet(path, params) {
  const token = await getToken();
  try {
    const res = await http.get(path, {
      params,
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.data;
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 401) {
      console.log('[collector] token 失效，重新登录...');
      cachedToken = null;
      await login();
      const res2 = await http.get(path, {
        params,
        headers: { Authorization: `Bearer ${cachedToken}` },
      });
      return res2.data;
    }
    throw err;
  }
}

// ===== Turso 模式：批量写入辅助函数 =====
async function tursoUpsertDaily(items) {
  const stmts = items.map((it) => ({
    sql: `INSERT INTO daily_stats (annotator_id, date, raw_seconds, segment_seconds, no_clip_seconds, no_clip_equivalent_seconds, pass_segment_seconds, settlement_reference_seconds, new_task_raw_seconds, old_task_raw_seconds, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(annotator_id, date) DO UPDATE SET raw_seconds=excluded.raw_seconds, segment_seconds=excluded.segment_seconds, no_clip_seconds=excluded.no_clip_seconds, no_clip_equivalent_seconds=excluded.no_clip_equivalent_seconds, pass_segment_seconds=excluded.pass_segment_seconds, settlement_reference_seconds=excluded.settlement_reference_seconds, new_task_raw_seconds=excluded.new_task_raw_seconds, old_task_raw_seconds=excluded.old_task_raw_seconds, collected_at=excluded.collected_at`,
    args: [it.annotator_id, it.date, it.raw_seconds, it.segment_seconds, it.no_clip_seconds, it.no_clip_equivalent_seconds, it.pass_segment_seconds, it.settlement_reference_seconds, it.new_task_raw_seconds, it.old_task_raw_seconds, it.collected_at],
  }));
  await db.batch(stmts, 'write');
}

async function tursoUpsertCumulative(items) {
  const stmts = items.map((it) => ({
    sql: `INSERT INTO annotator_cumulative (annotator_id, cumulative_reference_alltime, cumulative_raw_alltime, cumulative_segment_alltime, cumulative_no_clip_alltime, cumulative_no_clip_equivalent_alltime, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(annotator_id) DO UPDATE SET cumulative_reference_alltime=excluded.cumulative_reference_alltime, cumulative_raw_alltime=excluded.cumulative_raw_alltime, cumulative_segment_alltime=excluded.cumulative_segment_alltime, cumulative_no_clip_alltime=excluded.cumulative_no_clip_alltime, cumulative_no_clip_equivalent_alltime=excluded.cumulative_no_clip_equivalent_alltime, updated_at=excluded.updated_at`,
    args: [it.annotator_id, it.cumulative_reference_alltime, it.cumulative_raw_alltime, it.cumulative_segment_alltime, it.cumulative_no_clip_alltime, it.cumulative_no_clip_equivalent_alltime, it.now],
  }));
  await db.batch(stmts, 'write');
}

// 采集单日数据
async function collectDay(dateStr) {
  if (useTurso) await ensureInit();
  const data = await authGet(config.platform.analyticsPath, {
    organization: config.platform.org,
    day: dateStr,
  });
  if (data && Array.isArray(data.date_options) && data.date_options.length && !cachedInception) {
    cachedInception = data.date_options[0];
  }
  const rows = (data && data.organization_person_daily_rows) || [];
  const factor = config.noClipFactor;
  const now = new Date().toISOString();
  let count = 0;

  const items = [];
  for (const row of rows) {
    const annotatorId = useTurso ? await ensureAnnotator(row.person_label) : ensureAnnotator(row.person_label);
    const noClip = Number(row.no_clip_duration_seconds) || 0;
    const noClipEquiv = noClip * factor;
    const passSeg = Number(row.pass_segment_duration_seconds) || 0;
    const settlementRef = passSeg + noClipEquiv;
    items.push({
      annotator_id: annotatorId,
      date: dateStr,
      raw_seconds: Number(row.raw_video_duration_seconds) || 0,
      segment_seconds: Number(row.segment_duration_seconds) || 0,
      no_clip_seconds: noClip,
      no_clip_equivalent_seconds: noClipEquiv,
      pass_segment_seconds: passSeg,
      settlement_reference_seconds: settlementRef,
      new_task_raw_seconds: Number(row.new_task_raw_video_duration_seconds) || 0,
      old_task_raw_seconds: Number(row.old_task_raw_video_duration_seconds) || 0,
      collected_at: now,
    });
    count++;
  }

  if (items.length) {
    if (useTurso) {
      await tursoUpsertDaily(items);
    } else {
      const upsertMany = db.transaction((its) => {
        for (const it of its) stmtUpsertDaily.run(it);
      });
      upsertMany(items);
    }
  }
  console.log(`[collector] ${dateStr} 采集完成，共 ${count} 名标注员`);
  return count;
}

// 采集全量累计快照
async function collectCumulative(endDateStr) {
  if (useTurso) await ensureInit();
  if (!cachedInception) {
    const data = await authGet(config.platform.analyticsPath, {
      organization: config.platform.org,
      day: endDateStr,
    });
    if (data && Array.isArray(data.date_options) && data.date_options.length) {
      cachedInception = data.date_options[0];
    }
  }
  const startDay = cachedInception || endDateStr;
  const data = await authGet(config.platform.analyticsPath, {
    organization: config.platform.org,
    start_day: startDay,
    end_day: endDateStr,
  });
  const rows = (data && data.organization_person_settlement_rows) || [];
  const now = new Date().toISOString();
  let count = 0;
  const items = [];
  for (const row of rows) {
    const annotatorId = useTurso ? await ensureAnnotator(row.person_label) : ensureAnnotator(row.person_label);
    items.push({
      annotator_id: annotatorId,
      cumulative_reference_alltime: Number(row.cumulative_settlement_reference_duration_seconds) || 0,
      cumulative_raw_alltime: Number(row.cumulative_raw_video_duration_seconds) || 0,
      cumulative_segment_alltime: Number(row.cumulative_segment_duration_seconds) || 0,
      cumulative_no_clip_alltime: Number(row.cumulative_no_clip_duration_seconds) || 0,
      cumulative_no_clip_equivalent_alltime: Number(row.cumulative_no_clip_equivalent_duration_seconds) || 0,
      now,
    });
    count++;
  }
  if (items.length) {
    if (useTurso) {
      await tursoUpsertCumulative(items);
    } else {
      const upsertMany = db.transaction((its) => {
        for (const it of its) stmtUpsertCumulative.run(it);
      });
      upsertMany(items);
    }
  }
  console.log(`[collector] 累计快照采集完成，共 ${count} 名标注员`);
  return count;
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 回填最近 N 天历史
async function backfill(days) {
  if (collecting) {
    console.log('[collector] 已有采集任务在运行，跳过本次回填');
    return;
  }
  collecting = true;
  const runType = 'backfill';
  try {
    const today = new Date();
    const targets = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      targets.push(fmtDate(d));
    }
    console.log(`[collector] 开始回填 ${targets.length} 天历史...`);
    let total = 0;
    for (const dateStr of targets) {
      try {
        total += await collectDay(dateStr);
      } catch (e) {
        console.error(`[collector] 回填 ${dateStr} 失败:`, e.message);
        await logRun(runType, dateStr, 'error', e.message, 0);
      }
      await sleep(config.requestDelayMs);
    }
    try {
      await collectCumulative(fmtDate(today));
    } catch (e) {
      console.error('[collector] 累计快照采集失败:', e.message);
    }
    await logRun(runType, null, 'success', `回填 ${targets.length} 天完成`, total);
    console.log('[collector] 回填全部完成');
  } catch (e) {
    await logRun(runType, null, 'error', e.message, 0);
    console.error('[collector] 回填异常:', e.message);
  } finally {
    collecting = false;
  }
}

// 采集当天最新数据
async function collectToday() {
  if (collecting) {
    console.log('[collector] 已有采集任务在运行，跳过本次当天采集');
    return;
  }
  collecting = true;
  const runType = 'today';
  const dateStr = fmtDate(new Date());
  try {
    const count = await collectDay(dateStr);
    try {
      await collectCumulative(dateStr);
    } catch (e) {
      console.error('[collector] 当天累计快照失败:', e.message);
    }
    await logRun(runType, dateStr, 'success', '当天采集完成', count);
  } catch (e) {
    await logRun(runType, dateStr, 'error', e.message, 0);
    console.error('[collector] 当天采集失败:', e.message);
  } finally {
    collecting = false;
  }
}

// 凌晨补采前一天数据
async function collectYesterday() {
  if (collecting) {
    console.log('[collector] 已有采集任务在运行，跳过补采');
    return;
  }
  collecting = true;
  const runType = 'yesterday';
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const dateStr = fmtDate(d);
  try {
    const count = await collectDay(dateStr);
    try {
      await collectCumulative(fmtDate(new Date()));
    } catch (e) {
      console.error('[collector] 补采累计快照失败:', e.message);
    }
    await logRun(runType, dateStr, 'success', '补采前一天完成', count);
  } catch (e) {
    await logRun(runType, dateStr, 'error', e.message, 0);
    console.error('[collector] 补采前一天失败:', e.message);
  } finally {
    collecting = false;
  }
}

// 补采缺失的日期
async function backfillMissing(days) {
  if (useTurso) await ensureInit();
  const today = new Date();
  const targets = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    targets.push(fmtDate(d));
  }
  const placeholders = targets.map(() => '?').join(',');

  let existing;
  if (useTurso) {
    const result = await db.execute({ sql: `SELECT DISTINCT date FROM daily_stats WHERE date IN (${placeholders})`, args: targets });
    existing = result.rows.map((r) => r.date);
  } else {
    existing = db.prepare(`SELECT DISTINCT date FROM daily_stats WHERE date IN (${placeholders})`).all(...targets).map((r) => r.date);
  }

  const missing = targets.filter((t) => !existing.includes(t));
  if (missing.length === 0) {
    console.log('[collector] 最近数据完整，无需补采');
    return;
  }
  console.log(`[collector] 发现 ${missing.length} 天缺失数据，开始补采:`, missing.join(', '));
  if (collecting) return;
  collecting = true;
  try {
    let total = 0;
    for (const dateStr of missing) {
      try {
        total += await collectDay(dateStr);
      } catch (e) {
        console.error(`[collector] 补采 ${dateStr} 失败:`, e.message);
      }
      await sleep(config.requestDelayMs);
    }
    try {
      await collectCumulative(fmtDate(today));
    } catch (e) {
      console.error('[collector] 补采累计快照失败:', e.message);
    }
    await logRun('backfill-missing', null, 'success', `补采 ${missing.length} 天`, total);
  } catch (e) {
    await logRun('backfill-missing', null, 'error', e.message, 0);
  } finally {
    collecting = false;
  }
}

module.exports = {
  login,
  collectDay,
  collectCumulative,
  backfill,
  collectToday,
  collectYesterday,
  backfillMissing,
  fmtDate,
  isCollecting: () => collecting,
};
