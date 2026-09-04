const fs = require('fs');
const path = require('path');
const db = require('./database.js');
const platformApi = require('./platformApi');

const dataDir = path.join(__dirname, '..', 'data');
const files = fs.readdirSync(dataDir).filter(f => f.startsWith('raw_') && f.endsWith('.json'));

console.log('找到原始数据文件:', files.length, '个');

for (const file of files) {
  const content = fs.readFileSync(path.join(dataDir, file), 'utf8');
  let raw;
  try {
    raw = JSON.parse(content);
    if (typeof raw === 'string') {
      raw = JSON.parse(raw);
    }
  } catch (e) {
    console.log(file + ': 解析失败，跳过 - ' + e.message);
    continue;
  }

  const day = raw.selected_day;
  if (!day) {
    console.log(file + ': 跳过（无日期）');
    continue;
  }

  const dailyRows = platformApi.parseDailyRows(raw);
  const settlementMap = platformApi.parseSettlementRows(raw);

  let count = 0;
  for (const row of dailyRows) {
    db.upsertAnnotator(row.annotator_label, row.annotator_name, row.organization);
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
  console.log(day + ': 导入 ' + count + ' 条');
}

// 验证结果
const stats = db.getAggregatedStats('2026-07-26', '2026-08-01');
console.log('\n验证结果:');
for (const s of stats.slice(0, 5)) {
  console.log(s.annotator_label, '- 新任务:', s.total_new_task_duration, '旧任务:', s.total_old_task_duration, '原始:', s.total_raw_duration);
}
console.log('重新导入完成');
