const cron = require('node-cron');
const config = require('./config');
const platformApi = require('./platformApi');
const db = require('./database');

/**
 * 采集单日数据并存入数据库
 */
async function collectDay(day) {
  console.log(`[Collector] 开始采集 ${day} 的数据...`);
  try {
    const apiData = await platformApi.fetchDailyStats(day);

    // 解析每日统计数据
    const dailyRows = platformApi.parseDailyRows(apiData);
    const settlementMap = platformApi.parseSettlementRows(apiData);

    // 保存标注员信息和每日统计
    let count = 0;
    for (const row of dailyRows) {
      // 保存标注员信息
      db.upsertAnnotator(row.annotator_label, row.annotator_name, row.organization);

      // 合并结算数据
      const settlement = settlementMap[row.annotator_label] || {};
      const stat = {
        ...row,
        settlement_reference: settlement.settlement_reference || 0,
        cumulative_reference: settlement.cumulative_reference || 0,
        has_settlement: !!settlement.settlement_reference || !!settlement.cumulative_reference,
      };

      db.upsertDailyStat(stat);
      count++;
    }

    // 保存组织累计数据
    const cumulativeSeries = platformApi.parseCumulativeSeries(apiData);
    for (const item of cumulativeSeries) {
      if (item.date) {
        db.upsertOrgCumulative(item.date, item.organization, item.cumulative_raw_duration, item.cumulative_segment_duration);
      }
    }

    db.logCollect(day, 'success', count, null);
    console.log(`[Collector] ${day} 采集完成, 标注员数: ${count}`);
    return { success: true, count, day };
  } catch (error) {
    console.error(`[Collector] 采集 ${day} 失败:`, error.message);
    db.logCollect(day, 'error', 0, error.message);
    return { success: false, error: error.message, day };
  }
}

/**
 * 采集日期范围内的数据
 */
async function collectRange(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const results = [];

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.toISOString().split('T')[0];
    const result = await collectDay(day);
    results.push(result);
    // 避免请求过于频繁
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return results;
}

/**
 * 回填历史数据
 */
async function backfill() {
  const backfillDays = config.collector.backfillDays;
  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - backfillDays);

  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = today.toISOString().split('T')[0];

  console.log(`[Collector] 开始回填历史数据: ${startDateStr} 至 ${endDateStr}`);

  // 先获取今天的数据以获取可用日期列表
  try {
    const todayData = await platformApi.fetchDailyStats(endDateStr);
    const dateOptions = platformApi.parseDateOptions(todayData);

    // 如果有日期选项，使用平台提供的日期列表回填
    if (dateOptions && dateOptions.length > 0) {
      console.log(`[Collector] 平台提供 ${dateOptions.length} 个可用日期`);
      const datesToBackfill = dateOptions.filter(d => d >= startDateStr && d <= endDateStr);
      for (const day of datesToBackfill) {
        await collectDay(day);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } else {
      // 否则按天回填
      await collectRange(startDateStr, endDateStr);
    }

    console.log('[Collector] 历史数据回填完成');
  } catch (error) {
    console.error('[Collector] 回填失败:', error.message);
  }
}

/**
 * 启动定时采集
 */
function startScheduledCollection() {
  const intervalMinutes = config.collector.intervalMinutes;

  // 采集今天的最新数据
  async function collectToday() {
    const today = new Date().toISOString().split('T')[0];
    await collectDay(today);
  }

  // 每 intervalMinutes 分钟采集一次当天数据
  const cronExpression = `*/${intervalMinutes} * * * *`;
  console.log(`[Collector] 定时采集已启动, 每 ${intervalMinutes} 分钟执行一次`);

  cron.schedule(cronExpression, async () => {
    console.log('[Collector] 定时采集触发');
    await collectToday();
  });

  // 每天凌晨 00:05 采集昨天的最终数据
  cron.schedule('5 0 * * *', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const day = yesterday.toISOString().split('T')[0];
    console.log('[Collector] 补采昨日最终数据:', day);
    await collectDay(day);
  });

  // 启动时立即采集今天的数据
  collectToday();
}

module.exports = {
  collectDay,
  collectRange,
  backfill,
  startScheduledCollection,
};
