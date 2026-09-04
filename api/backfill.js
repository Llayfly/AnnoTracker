const db = require('../lib/db');
const collector = require('../lib/collector');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await db.initDB();
    const result = await collector.backfill();
    res.status(200).json(result);
  } catch (error) {
    console.error('[API /backfill] Error:', error);
    res.status(500).json({ error: error.message });
  }
};
