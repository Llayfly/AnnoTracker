const fetch = require('node-fetch');
const config = require('./config');

let tokenCache = {
  token: null,
  expiresAt: 0,
};

/**
 * 登录平台获取 JWT token
 */
async function login() {
  // 如果设置了跳过平台登录（开发模式），直接返回
  if (process.env.SKIP_PLATFORM_LOGIN === 'true') {
    console.log('[PlatformAPI] 跳过平台登录（开发模式）');
    throw new Error('平台登录已跳过（SKIP_PLATFORM_LOGIN=true）');
  }

  const url = `${config.platform.baseUrl}/api/v1/annotator-auth/login`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: config.platform.email,
        password: config.platform.password,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`登录失败 (${response.status}): ${text}`);
    }

    const data = await response.json();

    // token 有效期 28800 秒（8小时），提前 10 分钟过期
    const expiresIn = data.expires_in || 28800;
    tokenCache.token = data.access_token;
    tokenCache.expiresAt = Date.now() + (expiresIn - 600) * 1000;

    console.log('[PlatformAPI] 登录成功, 用户:', data.email, '组织:', data.organization?.name);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 获取有效 token，过期则自动重新登录
 */
async function getToken() {
  if (!tokenCache.token || Date.now() > tokenCache.expiresAt) {
    await login();
  }
  return tokenCache.token;
}

/**
 * 获取指定日期的统计数据
 * @param {string} day - 日期格式 YYYY-MM-DD
 * @returns {Promise<Object>} 统计数据
 */
async function fetchDailyStats(day) {
  const token = await getToken();
  const url = `${config.platform.baseUrl}/api/v1/analytics/annotation-analytics?organization=${config.platform.organization}&day=${day}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`获取统计数据失败 (${response.status}): ${text}`);
  }

  return response.json();
}

/**
 * 清理标注员标签（去除重复格式如 "HC8 HC8" -> "HC8"）
 */
function cleanLabel(label) {
  if (!label) return 'unknown';
  const parts = label.trim().split(/\s+/);
  return parts[0];
}

/**
 * 解析标注员每日统计数据
 * @param {Object} apiData - API 返回的原始数据
 * @returns {Array} 标注员统计数组
 */
function parseDailyRows(apiData) {
  const rows = apiData.organization_person_daily_rows || [];
  const factor = apiData.no_clip_equivalent_factor || 0.2;

  return rows.map(row => {
    const rawDuration = row.raw_video_duration_seconds || 0;
    const segmentDuration = row.segment_duration_seconds || 0;
    const noClipDuration = row.no_clip_duration_seconds || 0;

    // 无片段等效 = 无片段时长 * 等效系数
    const noClipEquivalent = noClipDuration * factor;

    return {
      annotator_label: cleanLabel(row.person_label),
      annotator_name: null,
      date: apiData.selected_day,
      organization: apiData.selected_organization || config.platform.organization,
      raw_duration_seconds: rawDuration,
      segment_duration_seconds: segmentDuration,
      no_clip_duration_seconds: noClipDuration,
      no_clip_equivalent_seconds: noClipEquivalent,
      pass_segment_duration_seconds: row.pass_segment_duration_seconds || 0,
      new_task_raw_duration_seconds: row.new_task_raw_video_duration_seconds || 0,
      old_task_raw_duration_seconds: row.old_task_raw_video_duration_seconds || 0,
    };
  });
}

/**
 * 解析标注员结算数据
 * @param {Object} apiData - API 返回的原始数据
 * @returns {Object} 以 annotator_label 为 key 的结算数据
 */
function parseSettlementRows(apiData) {
  const rows = apiData.organization_person_settlement_rows || [];
  const settlementMap = {};

  for (const row of rows) {
    const label = cleanLabel(row.person_label);
    settlementMap[label] = {
      settlement_reference: row.settlement_reference_duration_seconds || 0,
      cumulative_reference: row.cumulative_settlement_reference_duration_seconds || 0,
      raw_duration_seconds: row.raw_video_duration_seconds || 0,
      segment_duration_seconds: row.segment_duration_seconds || 0,
      no_clip_duration_seconds: row.no_clip_duration_seconds || 0,
      no_clip_equivalent_seconds: row.no_clip_equivalent_duration_seconds || 0,
      cumulative_raw_duration: row.cumulative_raw_video_duration_seconds || 0,
      cumulative_segment_duration: row.cumulative_segment_duration_seconds || 0,
      cumulative_no_clip_duration: row.cumulative_no_clip_duration_seconds || 0,
      cumulative_no_clip_equivalent: row.cumulative_no_clip_equivalent_duration_seconds || 0,
      pass_ratio: row.pass_ratio || 0,
      cumulative_pass_ratio: row.cumulative_pass_ratio || 0,
    };
  }

  return settlementMap;
}

/**
 * 解析组织累计数据
 * @param {Object} apiData - API 返回的原始数据
 * @returns {Array} 每日累计数据数组
 */
function parseCumulativeSeries(apiData) {
  const series = apiData.organization_cumulative_series || [];
  return series.map(item => ({
    date: item.day || item.date,
    organization: apiData.selected_organization || config.platform.organization,
    cumulative_raw_duration: item.cumulative_raw_video_duration_seconds || item.cumulative_raw_duration || 0,
    cumulative_segment_duration: item.cumulative_segment_duration_seconds || item.cumulative_segment_duration || 0,
  }));
}

/**
 * 获取可用的日期列表
 * @param {Object} apiData - API 返回的原始数据
 * @returns {Array} 日期数组
 */
function parseDateOptions(apiData) {
  return apiData.date_options || [];
}

module.exports = {
  login,
  getToken,
  fetchDailyStats,
  parseDailyRows,
  parseSettlementRows,
  parseCumulativeSeries,
  parseDateOptions,
};
