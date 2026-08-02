// PM2 进程管理配置
// 启动: pm2 start ecosystem.config.js
// 保存: pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'annotator-monitor',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
      env_file: '.env',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
