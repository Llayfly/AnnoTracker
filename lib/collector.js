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
  dispatchBatchesPath: '/api/v1/dispatch/batches',
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

// ===== 批次自动采集 =====
// 从平台 /api/v1/dispatch/batches 拉取所有批次，映射到 batches 表

// 平台 status → 中文状态
// 规则（用户确认）：
//   needs_changes 状态 = 需修改（状态和审核结果都是 needs_changes）
//   预审核通过 + needs_changes decision = 需修改
//   ready_for_review = 待审核（无论 decision 是什么）
//   approved = 已通过
//   dispatched = 已分发
function mapBatchStatus(status, decision) {
  // 需修改：status 本身就是 needs_changes
  if (status === 'needs_changes') return '需修改';
  // 需修改：预审核通过 + decision 是 needs_changes
  if ((status === 'pre_approved' || status === 'pre_review_approved') && decision === 'needs_changes') return '需修改';
  // 已通过
  if (status === 'approved') return '已通过';
  // 待审核：ready_for_review（无论 decision 是什么）
  if (status === 'ready_for_review' || status === 'pending_review' || status === 'waiting_review') return '待审核';
  // 已废弃
  if (status === 'abandoned') return '已废弃';
  // 默认：已分发
  return '已分发';
}

// 平台 decision → 中文审核结果
function mapReviewResult(decision) {
  if (!decision) return null;
  if (decision === 'approve') return '通过';
  if (decision === 'needs_changes') return '需修改';
  if (decision === 'reject' || decision === 'rejected') return '驳回';
  return decision;
}

// 从 ISO 时间字符串提取 YYYY-MM-DD
function extractDate(isoStr) {
  if (!isoStr) return fmtDate(new Date());
  try {
    return isoStr.substring(0, 10);
  } catch {
    return fmtDate(new Date());
  }
}

async function collectBatches() {
  await ensureInit();
  const db = getDb();
  const now = new Date().toISOString();

  // 1. 分页拉取所有批次（平台使用 offset/limit，不是 page/page_size）
  const allBatches = [];
  const seenIds = new Set(); // 去重：防止 API 返回重复数据
  const limit = 50;
  const maxRequests = 25; // 安全上限：最多25次请求 = 1250条
  let offset = 0;
  let total = 0;

  for (let i = 0; i < maxRequests; i++) {
    const data = await authGet(config.dispatchBatchesPath, {
      organization: config.org,
      offset,
      limit,
    });
    const batches = (data && data.batches) || [];
    const pagination = (data && data.pagination) || {};
    total = pagination.total || 0;

    // 去重：只添加未见过的 batch_id
    let newCount = 0;
    for (const b of batches) {
      const bid = String(b.id || '');
      if (!seenIds.has(bid)) {
        seenIds.add(bid);
        allBatches.push(b);
        newCount++;
      }
    }

    console.log(`[collector] 批次采集 offset=${offset}: ${batches.length} 条, 新增 ${newCount}, total=${total}`);
    if (batches.length === 0 || allBatches.length >= total || newCount === 0) break;
    offset += limit;
  }

  if (!allBatches.length) {
    console.log('[collector] 平台无批次数据');
    await logRun('batches', '-', 'success', '平台无批次数据', 0);
    return { count: 0, message: '平台无批次数据' };
  }

  // 2. 删除旧的自动采集记录（同时清理 [AUTO] 和 [自动] 两种前缀，避免重复）
  await db.batch([
    { sql: "DELETE FROM batches WHERE note LIKE '[AUTO]%'", args: [] },
    { sql: "DELETE FROM batches WHERE note LIKE '[自动]%'", args: [] },
  ], 'write');
  console.log(`[collector] 已清空旧自动采集记录`);

  // 3. 映射并批量插入
  const insertStmts = allBatches.map((b) => {
    const status = mapBatchStatus(b.status, b.decision);
    const reviewResult = mapReviewResult(b.decision);
    const date = extractDate(b.created_at);
    // 备注只保留中文内容，去掉英文 assignment_note
    const decisionNote = (b.decision_note || '').trim();
    const note = decisionNote ? `[自动] ${decisionNote}` : '[自动]';

    return {
      sql: `INSERT INTO batches
        (batch_id, annotator_label, project_type, status, review_result, reviewer,
         round, progress_current, progress_total, date, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        String(b.id || ''),
        b.annotator_name || b.created_by_name || '',
        b.label_project_name || '',
        status,
        reviewResult,
        b.reviewed_by_name || b.reviewer_name || null,
        parseInt(b.review_round) || 0,
        parseInt(b.results_synced_count) || 0,
        parseInt(b.task_count) || 0,
        date,
        note,
        now, now,
      ],
    };
  });

  // 分批执行（每批 50 条，避免单次 batch 过大）
  const BATCH_SIZE = 50;
  for (let i = 0; i < insertStmts.length; i += BATCH_SIZE) {
    const chunk = insertStmts.slice(i, i + BATCH_SIZE);
    await db.batch(chunk, 'write');
  }

  // 4. 统计结果
  const statusCount = {};
  for (const b of allBatches) {
    const s = mapBatchStatus(b.status, b.decision);
    statusCount[s] = (statusCount[s] || 0) + 1;
  }

  const annotators = new Set(allBatches.map((b) => b.annotator_name || b.created_by_name));
  const summary = Object.entries(statusCount).map(([k, v]) => `${k}: ${v}`).join('，');

  console.log(`[collector] 批次采集完成: ${allBatches.length} 条, ${summary}`);
  await logRun('batches', '-', 'success',
    `批次采集完成: ${allBatches.length} 条（${annotators.size} 人）`, allBatches.length);

  return {
    count: allBatches.length,
    annotator_count: annotators.size,
    status_summary: statusCount,
    message: `采集完成: ${allBatches.length} 条批次，${annotators.size} 名标注员`,
  };
}

module.exports = {
  collectDay, collectCumulative, collectToday, collectYesterday, backfill,
  collectBatches, ensureInit, fmtDate,
};
