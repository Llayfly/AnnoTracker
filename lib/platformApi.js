const fetch = require('node-fetch');

function getConfig() {
  return {
    baseUrl: process.env.PLATFORM_BASE_URL || 'https://data-platform.synapath.com',
    email: process.env.PLATFORM_EMAIL || '198176@qq.com',
    password: process.env.PLATFORM_PASSWORD || 'qaz123456',
    organization: process.env.PLATFORM_ORGANIZATION || 'HC',
  };
}

let tokenCache = { token: null, expiresAt: 0 };

async function login() {
  const config = getConfig();
  const url = `${config.baseUrl}/api/v1/annotator-auth/login`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: config.email, password: config.password }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`登录失败 (${response.status}): ${text}`);
    }

    const data = await response.json();
    const expiresIn = data.expires_in || 28800;
    tokenCache.token = data.access_token;
    tokenCache.expiresAt = Date.now() + (expiresIn - 600) * 1000;

    console.log('[PlatformAPI] 登录成功, 用户:', data.email, '组织:', data.organization?.name);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function getToken() {
  if (!tokenCache.token || Date.now() > tokenCache.expiresAt) {
    await login();
  }
  return tokenCache.token;
}

async function fetchDailyStats(day) {
  const config = getConfig();
  const token = await getToken();
  const url = `${config.baseUrl}/api/v1/analytics/annotation-analytics?organization=${config.organization}&day=${day}`;

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

function cleanLabel(label) {
  if (!label) return 'unknown';
  const parts = label.trim().split(/\s+/);
  return parts[0];
}

function parseDailyRows(apiData) {
  const rows = apiData.organization_person_daily_rows || [];
  const factor = apiData.no_clip_equivalent_factor || 0.2;

  return rows.map(row => {
    const rawDuration = row.raw_video_duration_seconds || 0;
    const segmentDuration = row.segment_duration_seconds || 0;
    const noClipDuration = row.no_clip_duration_seconds || 0;
    const noClipEquivalent = noClipDuration * factor;

    return {
      annotator_label: cleanLabel(row.person_label),
      annotator_name: null,
      date: apiData.selected_day,
      organization: apiData.selected_organization || getConfig().organization,
      raw_duration_seconds: rawDuration,
      segment_duration_seconds: segmentDuration,
      no_clip_duration_seconds: noClipDuration,
      no_clip_equivalent_seconds: noClipEquivalent,
      new_task_raw_duration_seconds: row.new_task_raw_video_duration_seconds || 0,
      old_task_raw_duration_seconds: row.old_task_raw_video_duration_seconds || 0,
    };
  });
}

function parseSettlementRows(apiData) {
  const rows = apiData.organization_person_settlement_rows || [];
  const settlementMap = {};

  for (const row of rows) {
    const label = cleanLabel(row.person_label);
    settlementMap[label] = {
      settlement_reference: row.settlement_reference_duration_seconds || 0,
      cumulative_reference: row.cumulative_settlement_reference_duration_seconds || 0,
    };
  }

  return settlementMap;
}

function parseCumulativeSeries(apiData) {
  const series = apiData.organization_cumulative_series || [];
  return series.map(item => ({
    date: item.day || item.date,
    organization: apiData.selected_organization || getConfig().organization,
    cumulative_raw_duration: item.cumulative_raw_video_duration_seconds || 0,
    cumulative_segment_duration: item.cumulative_segment_duration_seconds || 0,
  }));
}

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
