// 从 JSON 文件导入数据到数据库
// 用法: node src/import-data.js
const fs = require('fs');
const path = require('path');
const db = require('./database');
const platformApi = require('./platformApi');

async function importData() {
  const dataDir = path.join(__dirname, '..', 'data');
  const files = fs.readdirSync(dataDir).filter(f => f.startsWith('raw_') && f.endsWith('.json'));

  console.log(`[Import] 找到 ${files.length} 个数据文件`);

  for (const file of files) {
    const filePath = path.join(dataDir, file);
    const rawText = fs.readFileSync(filePath, 'utf8');

    // 解析 JSON（数据可能被双重编码为字符串）
    let apiData;
    try {
      // 第一次解析：可能得到一个字符串
      const firstParse = JSON.parse(rawText);

      if (typeof firstParse === 'string') {
        // 如果是字符串，再解析一次得到对象
        // 可能有 "Result: " 前缀
        const cleaned = firstParse.replace(/^Result:\s*/, '');
        apiData = JSON.parse(cleaned);
      } else if (typeof firstParse === 'object') {
        apiData = firstParse;
      }
    } catch (e) {
      // 尝试提取 JSON 对象
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          apiData = JSON.parse(match[0]);
        } catch (e2) {
          // 可能是双重转义的字符串
          try {
            const unescaped = match[0].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            apiData = JSON.parse(unescaped);
          } catch (e3) {
            console.error(`[Import] 无法解析 ${file}: ${e3.message}`);
            continue;
          }
        }
      } else {
        console.error(`[Import] 无法解析 ${file}: ${e.message}`);
        continue;
      }
    }

    if (!apiData || !apiData.selected_day) {
      console.error(`[Import] ${file} 数据格式不正确，跳过`);
      continue;
    }

    const day = apiData.selected_day;
    console.log(`[Import] 导入 ${day} 的数据...`);

    // 解析数据
    const dailyRows = platformApi.parseDailyRows(apiData);
    const settlementMap = platformApi.parseSettlementRows(apiData);

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
    console.log(`[Import] ${day} 导入完成, 标注员数: ${count}`);
  }

  // 显示统计
  const stats = db.getStats();
  console.log('\n[Import] 导入完成!');
  console.log(`  标注员总数: ${stats.annotator_count}`);
  console.log(`  统计记录数: ${stats.stat_count}`);
  console.log(`  最新数据日期: ${stats.latest_date || '无'}`);
}

importData().catch(err => {
  console.error('导入失败:', err);
  process.exit(1);
});
