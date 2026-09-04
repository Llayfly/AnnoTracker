const db = require('../../lib/db');
const collector = require('../../lib/collector');
const { formatDate } = require('../../lib/helpers');

// Vercel Cron: 每30分钟采集当天数据
module.exports = async (req, res) => {
  // 验证 Vercel Cron 请求
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await db.initDB();
    const today = formatDate(new Date());
    const result = await collector.collectDay(today);
    res.status(200).json({ ...result, cron: 'collect' });
  } catch (error) {
    console.error('[Cron /collect] Error:', error);
    res.status(500).json({ error: error.message, cron: 'collect' });
  }
};
