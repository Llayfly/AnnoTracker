// 独立回填历史数据脚本
// 用法: node src/backfill.js [天数]
const collector = require('./collector');
const platformApi = require('./platformApi');

async function main() {
  const days = parseInt(process.argv[2]) || 30;
  console.log(`开始回填最近 ${days} 天的历史数据...`);

  try {
    await platformApi.login();
    console.log('登录成功');

    // 修改回填天数
    process.env.BACKFILL_DAYS = days.toString();

    await collector.backfill();
    console.log('回填完成！');
    process.exit(0);
  } catch (error) {
    console.error('回填失败:', error.message);
    process.exit(1);
  }
}

main();
