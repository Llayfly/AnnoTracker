require('dotenv').config();

module.exports = {
  platform: {
    baseUrl: process.env.PLATFORM_BASE_URL || 'https://data-platform.synapath.com',
    email: process.env.PLATFORM_EMAIL || '198176@qq.com',
    password: process.env.PLATFORM_PASSWORD || 'qwe123',
    organization: process.env.PLATFORM_ORGANIZATION || 'HC',
  },
  server: {
    port: parseInt(process.env.PORT) || 3000,
    host: process.env.HOST || '0.0.0.0',
  },
  collector: {
    intervalMinutes: parseInt(process.env.COLLECT_INTERVAL_MINUTES) || 30,
    backfillDays: parseInt(process.env.BACKFILL_DAYS) || 30,
  },
  access: {
    password: process.env.ACCESS_PASSWORD || '',
  },
  db: {
    path: process.env.DB_PATH || __dirname + '/../data/stats.db',
  },
};
