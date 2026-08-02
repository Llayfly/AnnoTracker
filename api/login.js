'use strict';
// POST /api/login —— 登录获取 JWT token
const { handleLogin } = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Vercel 自动解析 body
  if (typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); } catch (e) { req.body = {}; }
  }
  return handleLogin(req, res);
};
