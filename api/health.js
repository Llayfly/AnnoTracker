const db = require('../lib/db');

module.exports = async (req, res) => {
  try {
    const stats = await db.getStats();
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString(), ...stats });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
};
