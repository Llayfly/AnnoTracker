'use strict';
// 全局配置：从环境变量读取，提供默认值
// 注意：所有自定义变量使用 AM_ 前缀，避免与 TRAE 运行环境的变量(如 DB_PATH)冲突
const path = require('path');
const projectRoot = path.join(__dirname, '..');
// 显式从项目根目录加载 .env，不依赖 cwd
require('dotenv').config({ path: path.join(projectRoot, '.env') });

// 数据库路径：始终解析为相对项目根目录的绝对路径，避免 cwd 不一致问题
const rawDbPath = process.env.AM_DB_PATH || path.join('data', 'stats.db');
const dbPath = path.isAbsolute(rawDbPath) ? rawDbPath : path.resolve(projectRoot, rawDbPath);

const config = {
  platform: {
    baseUrl: process.env.AM_PLATFORM_BASE_URL || 'https://data-platform.synapath.com',
    email: process.env.AM_PLATFORM_EMAIL || '198176@qq.com',
    password: process.env.AM_PLATFORM_PASSWORD || 'qwe123',
    org: process.env.AM_PLATFORM_ORG || 'HC',
    // 登录接口
    loginPath: '/api/v1/annotator-auth/login',
    // 统计接口
    analyticsPath: '/api/v1/analytics/annotation-analytics',
  },
  port: parseInt(process.env.AM_PORT, 10) || 3000,
  dbPath,
  backfillDays: parseInt(process.env.AM_BACKFILL_DAYS, 10) || 30,
  noClipFactor: parseFloat(process.env.AM_NO_CLIP_FACTOR) || 0.2,
  requestDelayMs: parseInt(process.env.AM_REQUEST_DELAY_MS, 10) || 800,
  requestTimeoutMs: parseInt(process.env.AM_REQUEST_TIMEOUT_MS, 10) || 30000,
  auth: {
    username: process.env.AM_AUTH_USERNAME || 'admin',
    password: process.env.AM_AUTH_PASSWORD || 'admin123',
    jwtSecret: process.env.AM_JWT_SECRET || 'annotator-monitor-secret-2026',
    tokenExpiresIn: process.env.AM_TOKEN_EXPIRES_IN || '7d',
  },
};

module.exports = config;
