const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const db = require('./database');
const collector = require('./collector');
const platformApi = require('./platformApi');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ========== 工具函数 ==========

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function secondsToHours(seconds) {
  return (seconds / 3600).toFixed(2);
}

// 根据日均时长获取预警级别
function getAlertLevel(avgDailySeconds) {
  const hours = avgDailySeconds / 3600;
  if (hours < 3) return 'red';
  if (hours <= 5) return 'blue';
  return 'green';
}

// ========== API 路由 ==========

// 系统状态
app.get('/api/health', (req, res) => {
  const stats = db.getStats();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    ...stats,
  });
});

// 所有标注员列表
app.get('/api/annotators', (req, res) => {
  const annotators = db.getAllAnnotators();
  res.json(annotators);
});

// 获取统计数据（支持时间范围和搜索）
app.get('/api/stats', (req, res) => {
  const { startDate, endDate, annotator, range } = req.query;

  let start, end;
  const today = new Date();

  if (startDate && endDate) {
    start = startDate;
    end = endDate;
  } else if (range) {
    end = formatDate(today);
    const startDay = new Date(today);
    switch (range) {
      case '1d': startDay.setDate(startDay.getDate() - 0); break;
      case '3d': startDay.setDate(startDay.getDate() - 2); break;
      case '1w': startDay.setDate(startDay.getDate() - 6); break;
      case '15d': startDay.setDate(startDay.getDate() - 14); break;
      case '1m': startDay.setMonth(startDay.getMonth() - 1); break;
      default: startDay.setDate(startDay.getDate() - 6);
    }
    start = formatDate(startDay);
  } else {
    // 默认最近一周
    end = formatDate(today);
    const startDay = new Date(today);
    startDay.setDate(startDay.getDate() - 6);
    start = formatDate(startDay);
  }

  const aggregated = db.getAggregatedStats(start, end);

  // 过滤标注员搜索
  let filtered = aggregated;
  if (annotator) {
    const search = annotator.toLowerCase();
    filtered = aggregated.filter(a =>
      (a.annotator_label || '').toLowerCase().includes(search) ||
      (a.annotator_name || '').toLowerCase().includes(search)
    );
  }

  // 添加预警级别
  const result = filtered.map(a => {
    const avgDailyHours = (a.avg_daily_raw_duration || 0) / 3600;
    return {
      ...a,
      total_raw_hours: secondsToHours(a.total_raw_duration || 0),
      total_segment_hours: secondsToHours(a.total_segment_duration || 0),
      total_no_clip_hours: secondsToHours(a.total_no_clip_duration || 0),
      total_no_clip_equivalent_hours: secondsToHours(a.total_no_clip_equivalent || 0),
      total_new_task_hours: secondsToHours(a.total_new_task_duration || 0),
      total_old_task_hours: secondsToHours(a.total_old_task_duration || 0),
      total_settlement_hours: secondsToHours(a.total_settlement_reference || 0),
      avg_daily_hours: avgDailyHours.toFixed(2),
      alert_level: getAlertLevel(a.avg_daily_raw_duration || 0),
    };
  });

  // 统计预警数量
  const summary = {
    total_annotators: result.length,
    red_count: result.filter(r => r.alert_level === 'red').length,
    blue_count: result.filter(r => r.alert_level === 'blue').length,
    green_count: result.filter(r => r.alert_level === 'green').length,
    date_range: { start, end },
  };

  res.json({ summary, annotators: result });
});

// 获取单个标注员的详细数据
app.get('/api/stats/:label', (req, res) => {
  const { label } = req.params;
  const { startDate, endDate } = req.query;

  let start, end;
  const today = new Date();

  if (startDate && endDate) {
    start = startDate;
    end = endDate;
  } else {
    end = formatDate(today);
    const startDay = new Date(today);
    startDay.setDate(startDay.getDate() - 29);
    start = formatDate(startDay);
  }

  const dailyData = db.getDailyStatsByDateRange(start, end, label);
  const annotator = db.getAnnotatorByLabel(label);

  const formatted = dailyData.map(d => ({
    ...d,
    raw_hours: secondsToHours(d.raw_duration_seconds),
    segment_hours: secondsToHours(d.segment_duration_seconds),
    no_clip_hours: secondsToHours(d.no_clip_duration_seconds),
    no_clip_equivalent_hours: secondsToHours(d.no_clip_equivalent_seconds),
    new_task_hours: secondsToHours(d.new_task_raw_duration_seconds || 0),
    old_task_hours: secondsToHours(d.old_task_raw_duration_seconds || 0),
    settlement_hours: secondsToHours(d.settlement_reference),
    alert_level: getAlertLevel(d.raw_duration_seconds),
  }));

  res.json({
    annotator,
    daily_stats: formatted,
    date_range: { start, end },
  });
});

// 获取组织累计数据
app.get('/api/org-cumulative', (req, res) => {
  const { startDate, endDate } = req.query;
  const today = new Date();
  const end = endDate || formatDate(today);
  const startDay = new Date(today);
  startDay.setDate(startDay.getDate() - 29);
  const start = startDate || formatDate(startDay);

  const data = db.getOrgCumulative(start, end);
  res.json(data);
});

// 获取可用日期列表
app.get('/api/dates', (req, res) => {
  const dates = db.getAvailableDates();
  res.json(dates);
});

// 获取采集日志
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const logs = db.getRecentCollectLogs(limit);
  res.json(logs);
});

// 手动触发采集
app.post('/api/collect', async (req, res) => {
  const { day } = req.body;
  const targetDay = day || formatDate(new Date());
  try {
    const result = await collector.collectDay(targetDay);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 手动触发回填
app.post('/api/backfill', async (req, res) => {
  try {
    await collector.backfill();
    res.json({ success: true, message: '回填完成' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 所有其他路由返回前端页面
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ========== 启动服务器 ==========

async function start() {
  const port = config.server.port;
  const host = config.server.host;

  // 测试登录
  try {
    console.log('[Server] 正在连接数据平台...');
    await platformApi.login();
    console.log('[Server] 平台连接成功');
  } catch (error) {
    console.error('[Server] 平台连接失败:', error.message);
    console.error('[Server] 服务器仍将启动，但数据采集可能不可用');
  }

  // 启动定时采集
  collector.startScheduledCollection();

  app.listen(port, host, () => {
    console.log(`[Server] 标注员统计监控系统已启动`);
    console.log(`[Server] 访问地址: http://${host}:${port}`);
    console.log(`[Server] API 文档: http://${host}:${port}/api/health`);
  });
}

start();
