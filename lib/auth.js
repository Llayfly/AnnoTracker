'use strict';
// JWT 认证中间件 —— Vercel serverless 版
const jwt = require('jsonwebtoken');

const config = {
  username: process.env.AM_AUTH_USERNAME || 'admin',
  password: process.env.AM_AUTH_PASSWORD || 'qaz123456',
  jwtSecret: process.env.AM_JWT_SECRET || 'annotator-monitor-secret-2026',
  tokenExpiresIn: process.env.AM_TOKEN_EXPIRES_IN || '7d',
};

// 从请求中提取并验证 token
function verifyToken(req) {
  const authHeader = req.headers.authorization;
  const token = authHeader
    ? authHeader.replace(/^Bearer\s+/i, '')
    : req.query.token;
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (e) {
    return null;
  }
}

// 认证中间件：验证失败返回 401
function requireAuth(handler) {
  return async (req, res) => {
    const user = verifyToken(req);
    if (!user) {
      return res.status(401).json({ error: '未登录或登录已过期，请重新登录' });
    }
    req.user = user;
    return handler(req, res);
  };
}

// 登录处理
function handleLogin(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }
  if (username !== config.username || password !== config.password) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = jwt.sign({ username }, config.jwtSecret, {
    expiresIn: config.tokenExpiresIn,
  });
  return res.status(200).json({ token, username, expires_in: config.tokenExpiresIn });
}

module.exports = { requireAuth, handleLogin, verifyToken, config };
