'use strict';
// GET /api/health —— 健康检查端点（无需认证，不依赖数据库）
// 用于快速验证 Vercel 部署是否成功
module.exports = (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      hasTursoUrl: !!process.env.TURSO_DATABASE_URL,
      hasTursoToken: !!process.env.TURSO_AUTH_TOKEN,
      hasAuthUsername: !!process.env.AM_AUTH_USERNAME,
      hasCronSecret: !!process.env.CRON_SECRET,
    },
  });
};
