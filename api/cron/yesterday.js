const db = require('../../lib/db');
const collector = require('../../lib/collector');
const { formatDate } = require('../../lib/helpers');

// Vercel Cron: 每天凌晨补采前一天最终数据
module.exports = async (req, res) => {
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await db.initDB();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const day = formatDate(yesterday);
    const result = await collector.collectDay(day);
    res.status(200).json({ ...result, cron: 'yesterday' });
  } catch (error) {
    console.error('[Cron /yesterday] Error:', error);
    res.status(500).json({ error: error.message, cron: 'yesterday' });
  }
};
