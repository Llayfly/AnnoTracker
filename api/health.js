'use strict';
// GET /api/health —— 健康检查端点（无需认证）
// GET /api/health?detailed=true —— 详细诊断（检查依赖、数据库连接）
module.exports = async (req, res) => {
  if (req.query && req.query.detailed === 'true') {
    const results = {};
    try { require('@libsql/client'); results.libsql = 'OK'; } catch (e) { results.libsql = `FAIL: ${e.message}`; }
    try { require('jsonwebtoken'); results.jsonwebtoken = 'OK'; } catch (e) { results.jsonwebtoken = `FAIL: ${e.message}`; }
    try { require('axios'); results.axios = 'OK'; } catch (e) { results.axios = `FAIL: ${e.message}`; }
    try { require('../lib/db'); results.lib_db = 'OK'; } catch (e) { results.lib_db = `FAIL: ${e.message}`; }
    try { require('../lib/auth'); results.lib_auth = 'OK'; } catch (e) { results.lib_auth = `FAIL: ${e.message}`; }
    try { require('../lib/collector'); results.lib_collector = 'OK'; } catch (e) { results.lib_collector = `FAIL: ${e.message}`; }
    try {
      const { getDb, ensureInit } = require('../lib/db');
      await ensureInit();
      const db = getDb();
      const r = await db.execute('SELECT 1 AS test');
      results.turso_connection = `OK (rows: ${r.rows.length})`;
    } catch (e) { results.turso_connection = `FAIL: ${e.message}`; }
    results.env = {
      TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL ? 'SET' : 'MISSING',
      TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN ? 'SET' : 'MISSING',
      AM_AUTH_USERNAME: process.env.AM_AUTH_USERNAME ? 'SET' : 'MISSING',
      CRON_SECRET: process.env.CRON_SECRET ? 'SET' : 'MISSING',
      NODE_ENV: process.env.NODE_ENV || 'not set',
    };
    return res.status(200).json(results);
  }
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
