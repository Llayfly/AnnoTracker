// 立即采集今天的数据
// 用法: node src/collect-now.js [YYYY-MM-DD]
const collector = require('./collector');
const platformApi = require('./platformApi');

async function main() {
  const day = process.argv[2] || new Date().toISOString().split('T')[0];
  console.log(`开始采集 ${day} 的数据...`);

  try {
    await platformApi.login();
    console.log('登录成功');

    const result = await collector.collectDay(day);
    if (result.success) {
      console.log(`采集成功！标注员数: ${result.count}`);
    } else {
      console.error(`采集失败: ${result.error}`);
    }
    process.exit(0);
  } catch (error) {
    console.error('执行失败:', error.message);
    process.exit(1);
  }
}

main();
