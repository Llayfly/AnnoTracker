'use strict';
// GET /api/cron —— 定时采集端点
// 供 Vercel Cron 或外部 cron-job.org 调用，通过 CRON_SECRET 密钥验证，无需 JWT 登录
const { collectToday } = require('../lib/collector');

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(500).json({ error: '未配置 CRON_SECRET 环境变量' });
  }
  // Vercel Cron 自动带 Authorization: Bearer <CRON_SECRET>；
  // 外部 cron 用 ?secret=<CRON_SECRET>
  const provided =
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    req.query.secret;
  if (provided !== secret) {
    return res.status(401).json({ error: '密钥无效' });
  }
  try {
    const count = await collectToday();
    res.json({
      ok: true,
      message: '定时采集完成',
      count,
      time: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[api] cron error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};
