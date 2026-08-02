'use strict';
// 定时任务：每 30 分钟采集当天，每天凌晨补采前一天
const cron = require('node-cron');
const collector = require('./collector');
const config = require('./config');

function startScheduler() {
  // 每 30 分钟采集当天最新数据
  cron.schedule('*/30 * * * *', async () => {
    console.log('[scheduler] 触发：每30分钟采集当天数据', new Date().toISOString());
    await collector.collectToday();
  });

  // 每天凌晨 00:10 补采前一天数据
  cron.schedule('10 0 * * *', async () => {
    console.log('[scheduler] 触发：凌晨补采前一天数据', new Date().toISOString());
    await collector.collectYesterday();
  });

  console.log('[scheduler] 定时任务已启动：每30分钟采集当天 / 每天00:10补采前一天');
}

module.exports = { startScheduler };
