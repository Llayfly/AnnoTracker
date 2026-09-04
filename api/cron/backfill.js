const db = require('../../lib/db');
const collector = require('../../lib/collector');

// Vercel Cron: 每天早上回填最近几天缺失的数据
module.exports = async (req, res) => {
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await db.initDB();
    const result = await collector.backfill();
    res.status(200).json({ ...result, cron: 'backfill' });
  } catch (error) {
    console.error('[Cron /backfill] Error:', error);
    res.status(500).json({ error: error.message, cron: 'backfill' });
  }
};
