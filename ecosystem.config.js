module.exports = {
  apps: [{
    name: 'annotator-stats',
    script: 'src/server.js',
    cwd: '/workspace/annotator-stats',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    error_file: '/workspace/annotator-stats/logs/error.log',
    out_file: '/workspace/annotator-stats/logs/output.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
