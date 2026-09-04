const { verifyToken } = require('../lib/auth');

module.exports = async (req, res) => {
  let token = null;
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').map(c => c.trim());
    for (const c of cookies) {
      if (c.startsWith('auth_token=')) {
        token = c.substring('auth_token='.length);
        break;
      }
    }
  }

  const result = verifyToken(token);
  if (result.valid) {
    res.status(200).json({ authenticated: true, username: result.username });
  } else {
    res.status(200).json({ authenticated: false });
  }
};
