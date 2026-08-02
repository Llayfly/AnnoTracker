'use strict';
// GET /api/diag —— 诊断端点（无需认证），逐项检查依赖和数据库连接
module.exports = async (req, res) => {
  const results = {};

  // 1. 测试 @libsql/client
  try {
    const { createClient } = require('@libsql/client');
    results.libsql = 'OK';
  } catch (e) {
    results.libsql = `FAIL: ${e.message}`;
  }

  // 2. 测试 jsonwebtoken
  try {
    const jwt = require('jsonwebtoken');
    results.jsonwebtoken = 'OK';
  } catch (e) {
    results.jsonwebtoken = `FAIL: ${e.message}`;
  }

  // 3. 测试 axios
  try {
    const axios = require('axios');
    results.axios = 'OK';
  } catch (e) {
    results.axios = `FAIL: ${e.message}`;
  }

  // 4. 测试 lib/db 加载
  try {
    const dbModule = require('../lib/db');
    results.lib_db = 'OK';
  } catch (e) {
    results.lib_db = `FAIL: ${e.message}`;
  }

  // 5. 测试 lib/auth 加载
  try {
    const authModule = require('../lib/auth');
    results.lib_auth = 'OK';
  } catch (e) {
    results.lib_auth = `FAIL: ${e.message}`;
  }

  // 6. 测试 lib/collector 加载
  try {
    const collectorModule = require('../lib/collector');
    results.lib_collector = 'OK';
  } catch (e) {
    results.lib_collector = `FAIL: ${e.message}`;
  }

  // 7. 测试 Turso 连接
  try {
    const { getDb, ensureInit } = require('../lib/db');
    await ensureInit();
    const db = getDb();
    const r = await db.execute('SELECT 1 AS test');
    results.turso_connection = `OK (rows: ${r.rows.length})`;
  } catch (e) {
    results.turso_connection = `FAIL: ${e.message}`;
  }

  // 8. 环境变量检查
  results.env = {
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL ? 'SET' : 'MISSING',
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN ? 'SET' : 'MISSING',
    AM_AUTH_USERNAME: process.env.AM_AUTH_USERNAME ? 'SET' : 'MISSING',
    CRON_SECRET: process.env.CRON_SECRET ? 'SET' : 'MISSING',
    NODE_ENV: process.env.NODE_ENV || 'not set',
  };

  res.status(200).json(results);
};
