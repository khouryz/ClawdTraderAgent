/**
 * PM2 Ecosystem Configuration
 * Run with: pm2 start ecosystem.config.js
 */

module.exports = {
  apps: [
    {
      name: 'ClawdTraderAgent',
      script: 'src/index.js',
      cwd: __dirname,
      
      // Auto-restart on crash
      autorestart: true,
      watch: false,
      max_restarts: 5,
      min_uptime: '60s',
      restart_delay: 60000,
      
      // Memory management
      max_memory_restart: '500M',
      
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      
      // Environment
      env: {
        NODE_ENV: 'production'
      },
      
      // Graceful shutdown
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000
    }
  ]
};
