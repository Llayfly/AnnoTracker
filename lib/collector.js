const platformApi = require('./platformApi');
const db = require('./db');

async function collectDay(day) {
  console.log(`[Collector] 开始采集 ${day} 的数据...`);
  try {
    const apiData = await platformApi.fetchDailyStats(day);
    const dailyRows = platformApi.parseDailyRows(apiData);
    const settlementMap = platformApi.parseSettlementRows(apiData);

    let count = 0;
    for (const row of dailyRows) {
      await db.upsertAnnotator(row.annotator_label, row.annotator_name, row.organization);

      const settlement = settlementMap[row.annotator_label] || {};
      const stat = {
        ...row,
        settlement_reference: settlement.settlement_reference || 0,
        cumulative_reference: settlement.cumulative_reference || 0,
        has_settlement: !!settlement.settlement_reference || !!settlement.cumulative_reference,
      };

      await db.upsertDailyStat(stat);
      count++;
    }

    const cumulativeSeries = platformApi.parseCumulativeSeries(apiData);
    for (const item of cumulativeSeries) {
      if (item.date) {
        await db.upsertOrgCumulative(item.date, item.organization, item.cumulative_raw_duration, item.cumulative_segment_duration);
      }
    }

    await db.logCollect(day, 'success', count, null);
    console.log(`[Collector] ${day} 采集完成, 标注员数: ${count}`);
    return { success: true, count, day };
  } catch (error) {
    console.error(`[Collector] 采集 ${day} 失败:`, error.message);
    await db.logCollect(day, 'error', 0, error.message);
    return { success: false, error: error.message, day };
  }
}

async function collectRange(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const results = [];

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.toISOString().split('T')[0];
    const result = await collectDay(day);
    results.push(result);
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return results;
}

async function backfill() {
  const backfillDays = parseInt(process.env.BACKFILL_DAYS) || 30;
  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - backfillDays);

  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = today.toISOString().split('T')[0];

  console.log(`[Collector] 开始回填: ${startDateStr} 至 ${endDateStr}`);

  try {
    const todayData = await platformApi.fetchDailyStats(endDateStr);
    const dateOptions = platformApi.parseDateOptions(todayData);

    if (dateOptions && dateOptions.length > 0) {
      const datesToBackfill = dateOptions.filter(d => d >= startDateStr && d <= endDateStr);
      for (const day of datesToBackfill) {
        await collectDay(day);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } else {
      await collectRange(startDateStr, endDateStr);
    }

    console.log('[Collector] 回填完成');
    return { success: true };
  } catch (error) {
    console.error('[Collector] 回填失败:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = { collectDay, collectRange, backfill };
