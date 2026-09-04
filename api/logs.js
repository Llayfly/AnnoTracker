const db = require('../lib/db');

module.exports = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const logs = await db.getRecentCollectLogs(limit);
    res.status(200).json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
