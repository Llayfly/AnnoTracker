const db = require('../lib/db');
const collector = require('../lib/collector');
const { formatDate } = require('../lib/helpers');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await db.initDB();

    let body = {};
    try { body = JSON.parse(req.body || '{}'); } catch (e) {}

    const targetDay = body.day || formatDate(new Date());
    const result = await collector.collectDay(targetDay);
    res.status(200).json(result);
  } catch (error) {
    console.error('[API /collect] Error:', error);
    res.status(500).json({ error: error.message });
  }
};
