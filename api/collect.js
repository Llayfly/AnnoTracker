const { requireAuth } = require('../lib/auth');

module.exports = requireAuth(async (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Data is fetched on-demand from the platform API. No collection needed.',
  });
});
