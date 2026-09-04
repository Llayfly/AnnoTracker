const { requireAuth } = require('../lib/auth');

module.exports = requireAuth(async (req, res) => {
  res.status(200).json([]);
});
