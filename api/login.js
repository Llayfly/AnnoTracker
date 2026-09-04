const { generateToken } = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { username, password } = body;

    const validUser = process.env.LOGIN_USERNAME || 'admin';
    const validPass = process.env.LOGIN_PASSWORD || 'admin123';

    if (!username || !password) {
      return res.status(400).json({ error: '请输入用户名和密码' });
    }

    if (username === validUser && password === validPass) {
      const token = generateToken(username);
      res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${24 * 60 * 60}`);
      return res.status(200).json({ success: true, token, username });
    }

    return res.status(401).json({ error: '用户名或密码错误' });
  } catch (err) {
    return res.status(500).json({ error: '登录失败: ' + err.message });
  }
};
