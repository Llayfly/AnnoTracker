'use strict';
// 数据采集模块 —— Vercel serverless 版（异步 Turso，batch 优化）
const axios = require('axios');
const { getDb, ensureInit, ensureAnnotatorsBatch, logRun } = require('./db');

const config = {
  baseUrl: process.env.AM_PLATFORM_BASE_URL || 'https://data-platform.synapath.com',
  email: process.env.AM_PLATFORM_EMAIL || '198176@qq.com',
  password: process.env.AM_PLATFORM_PASSWORD || 'qwe123',
  org: process.env.AM_PLATFORM_ORG || 'HC',
  loginPath: '/api/v1/annotator-auth/login',
  analyticsPath: '/api/v1/analytics/annotation-analytics',
  noClipFactor: parseFloat(process.env.AM_NO_CLIP_FACTOR) || 0.2,
  requestTimeoutMs: parseInt(process.env.AM_REQUEST_TIMEOUT_MS, 10) || 30000,
};

const http = axios.create({ baseURL: config.baseUrl, timeout: config.requestTimeoutMs });

let cachedToken = null;
let tokenExpireAt = 0;
let cachedInception = null;

async function login() {
  const res = await http.post(config.loginPath, {
    email: config.email,
    password: config.password,
  });
  const data = res.data;
  if (!data || !data.access_token) throw new Error('登录失败：未返回 access_token');
  cachedToken = data.access_token;
  const expiresIn = data.expires_in || 28800;
  tokenExpireAt = Date.now() + expiresIn * 1000 - 5 * 60 * 1000;
  console.log('[collector] 登录成功');
  return cachedToken;
}

async function getToken() {
  if (!cachedToken || Date.now() >= tokenExpireAt) await login();
  return cachedToken;
}

async function authGet(path, params) {
  const token = await getToken();
  try {
    const res = await http.get(path, { params, headers: { Authorization: `Bearer ${token}` } });
    return res.data;
  } catch (err) {
    if (err.response && err.response.status === 401) {
      cachedToken = null;
      await login();
      const res2 = await http.get(path, { params, headers: { Authorization: `Bearer ${cachedToken}` } });
      return res2.data;
    }
    throw err;
  }
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 采集单日数据 —— 使用 batch 批量写入，大幅减少网络往返
async function collectDay(dateStr) {
  await ensureInit();
  const data = await authGet(config.analyticsPath, { organization: config.org, day: dateStr });
  if (data && Array.isArray(data.date_options) && data.date_options.length && !cachedInception) {
    cachedInception = data.date_options[0];
  }
  const rows = (data && data.organization_person_daily_rows) || [];
  if (!rows.length) {
    console.log(`[collector] ${dateStr} 无数据`);
    return 0;
  }

  const factor = config.noClipFactor;
  const now = new Date().toISOString();

  // 第一步：批量 upsert 标注员，获取 label -> id 映射
  const rawLabels = rows.map((r) => r.person_label);
  const idMap = await ensureAnnotatorsBatch(rawLabels);

  // 第二步：构建所有 INSERT 语句，一次 batch 执行
  const insertStmts = rows.map((row) => {
    // 用 cleanLabel 逻辑找到对应的 id
    const trimmed = String(row.person_label || '').trim();
    const idx = trimmed.indexOf(' ');
    const cleanLbl = idx > -1 ? trimmed.slice(0, idx) : trimmed;
    const annotatorId = idMap[cleanLbl];

    const noClip = Number(row.no_clip_duration_seconds) || 0;
    const noClipEquiv = noClip * factor;
    const passSeg = Number(row.pass_segment_duration_seconds) || 0;
    const settlementRef = passSeg + noClipEquiv;

    return {
      sql: `INSERT INTO daily_stats
        (annotator_id, date, raw_seconds, segment_seconds, no_clip_seconds,
         no_clip_equivalent_seconds, pass_segment_seconds, settlement_reference_seconds,
         new_task_raw_seconds, old_task_raw_seconds, collected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(annotator_id, date) DO UPDATE SET
          raw_seconds=excluded.raw_seconds, segment_seconds=excluded.segment_seconds,
          no_clip_seconds=excluded.no_clip_seconds, no_clip_equivalent_seconds=excluded.no_clip_equivalent_seconds,
          pass_segment_seconds=excluded.pass_segment_seconds, settlement_reference_seconds=excluded.settlement_reference_seconds,
          new_task_raw_seconds=excluded.new_task_raw_seconds, old_task_raw_seconds=excluded.old_task_raw_seconds,
          collected_at=excluded.collected_at`,
      args: [
        annotatorId, dateStr,
        Number(row.raw_video_duration_seconds) || 0,
        Number(row.segment_duration_seconds) || 0,
        noClip, noClipEquiv, passSeg, settlementRef,
        Number(row.new_task_raw_video_duration_seconds) || 0,
        Number(row.old_task_raw_video_duration_seconds) || 0,
        now,
      ],
    };
  });

  await getDb().batch(insertStmts, 'write');
  console.log(`[collector] ${dateStr} 采集完成，${rows.length} 名标注员（batch）`);
  return rows.length;
}

// 采集累计快照 —— 同样使用 batch
async function collectCumulative(endDateStr) {
  await ensureInit();
  if (!cachedInception) {
    const data = await authGet(config.analyticsPath, { organization: config.org, day: endDateStr });
    if (data && Array.isArray(data.date_options) && data.date_options.length) {
      cachedInception = data.date_options[0];
    }
  }
  const startDay = cachedInception || endDateStr;
  const data = await authGet(config.analyticsPath, {
    organization: config.org, start_day: startDay, end_day: endDateStr,
  });
  const rows = (data && data.organization_person_settlement_rows) || [];
  if (!rows.length) return 0;

  const now = new Date().toISOString();
  const rawLabels = rows.map((r) => r.person_label);
  const idMap = await ensureAnnotatorsBatch(rawLabels);

  const insertStmts = rows.map((row) => {
    const trimmed = String(row.person_label || '').trim();
    const idx = trimmed.indexOf(' ');
    const cleanLbl = idx > -1 ? trimmed.slice(0, idx) : trimmed;
    const annotatorId = idMap[cleanLbl];

    return {
      sql: `INSERT INTO annotator_cumulative
        (annotator_id, cumulative_reference_alltime, cumulative_raw_alltime,
         cumulative_segment_alltime, cumulative_no_clip_alltime,
         cumulative_no_clip_equivalent_alltime, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(annotator_id) DO UPDATE SET
          cumulative_reference_alltime=excluded.cumulative_reference_alltime,
          cumulative_raw_alltime=excluded.cumulative_raw_alltime,
          cumulative_segment_alltime=excluded.cumulative_segment_alltime,
          cumulative_no_clip_alltime=excluded.cumulative_no_clip_alltime,
          cumulative_no_clip_equivalent_alltime=excluded.cumulative_no_clip_equivalent_alltime,
          updated_at=excluded.updated_at`,
      args: [
        annotatorId,
        Number(row.cumulative_settlement_reference_duration_seconds) || 0,
        Number(row.cumulative_raw_video_duration_seconds) || 0,
        Number(row.cumulative_segment_duration_seconds) || 0,
        Number(row.cumulative_no_clip_duration_seconds) || 0,
        Number(row.cumulative_no_clip_equivalent_duration_seconds) || 0,
        now,
      ],
    };
  });

  await getDb().batch(insertStmts, 'write');
  console.log(`[collector] 累计快照采集完成，${rows.length} 名标注员（batch）`);
  return rows.length;
}

// 采集当天
async function collectToday() {
  const dateStr = fmtDate(new Date());
  try {
    const count = await collectDay(dateStr);
    try { await collectCumulative(dateStr); } catch (e) { console.error('[collector] 累计快照失败:', e.message); }
    await logRun('today', dateStr, 'success', '当天采集完成', count);
    return count;
  } catch (e) {
    await logRun('today', dateStr, 'error', e.message, 0);
    throw e;
  }
}

// 采集前一天
async function collectYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const dateStr = fmtDate(d);
  try {
    const count = await collectDay(dateStr);
    try { await collectCumulative(fmtDate(new Date())); } catch (e) { console.error('[collector] 累计快照失败:', e.message); }
    await logRun('yesterday', dateStr, 'success', '补采前一天完成', count);
    return count;
  } catch (e) {
    await logRun('yesterday', dateStr, 'error', e.message, 0);
    throw e;
  }
}

// 回填历史数据：逐日采集指定日期范围
async function backfill(startDateStr, endDateStr) {
  await ensureInit();
  const results = [];
  const sd = new Date(startDateStr + 'T00:00:00');
  const ed = new Date(endDateStr + 'T00:00:00');

  for (let d = new Date(sd); d <= ed; d.setDate(d.getDate() + 1)) {
    const dateStr = fmtDate(d);
    try {
      const count = await collectDay(dateStr);
      results.push({ date: dateStr, count, error: null });
      console.log(`[collector] 回填 ${dateStr}: ${count} 人`);
    } catch (e) {
      results.push({ date: dateStr, count: 0, error: e.message });
      console.error(`[collector] 回填 ${dateStr} 失败:`, e.message);
    }
  }

  // 最后采集一次累计快照
  try {
    await collectCumulative(endDateStr);
    console.log('[collector] 回填累计快照完成');
  } catch (e) {
    console.error('[collector] 回填累计快照失败:', e.message);
  }

  await logRun('backfill', `${startDateStr}~${endDateStr}`, 'success',
    `回填完成，共 ${results.length} 天`, results.reduce((s, r) => s + r.count, 0));

  return results;
}

module.exports = {
  collectDay, collectCumulative, collectToday, collectYesterday, backfill,
  ensureInit, fmtDate,
};
