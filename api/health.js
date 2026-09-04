const platformApi = require('../lib/platformApi');

module.exports = async (req, res) => {
  try {
    await platformApi.getToken();
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      platform: 'connected',
      latest_collect: null,
    });
  } catch (error) {
    res.status(200).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      platform: 'disconnected',
      error: error.message,
      latest_collect: null,
    });
  }
};
