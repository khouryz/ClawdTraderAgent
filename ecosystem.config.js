/**
 * PM2 Ecosystem Configuration
 * Run with: pm2 start ecosystem.config.js
 *
 * Tuned for multi-account mode (MULTI_ACCOUNT=true in .env, accounts read
 * from accounts/*.env). Single fork process — we never want parallel copies
 * of a trading bot (cluster mode would cause Telegram 409 conflicts and
 * double-fills via duplicate order WebSocket connections).
 */

module.exports = {
  apps: [
    {
      name: 'ClawdTraderAgent',
      script: 'src/index.js',
      cwd: __dirname,

      // Single fork process — never run parallel copies of a trading bot.
      instances: 1,
      exec_mode: 'fork',

      // Auto-restart policy.
      // min_uptime gives the bot enough runtime to "count" as a successful
      // start before max_restarts is exhausted; restart_delay spaces retries
      // so transient network/auth issues don't burn the restart budget in
      // seconds.
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '5m',
      restart_delay: 60000,

      // Memory cap. Multi-account + SharedPriceProvider + per-account order
      // WebSockets use materially more memory than the single-instrument bot.
      // 2 accounts x 3 instruments (6 runners) + cold-start seeding fetches peak
      // ~2.5-3.7G during startup; server has ~8G. 5G leaves ample OS headroom.
      max_memory_restart: '5G',

      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,

      // Environment. The actual config is loaded by dotenv inside src/index.js
      // from .env (root) and accounts/*.env (per-account).
      env: {
        NODE_ENV: 'production'
      },

      // Graceful shutdown window. After SIGTERM the bot needs to:
      //   - stop the Telegram long-poll
      //   - cancel pending OCO orders (Tradovate REST)
      //   - disconnect the order WebSocket cleanly
      //   - kill the Databento Python subprocess
      //   - flush loss-limits state files to disk
      //   - send the "bot stopped" Telegram alert
      // 5s was too short; 15s gives all of that room without delaying
      // operator restarts noticeably.
      kill_timeout: 15000

      // NOTE: wait_ready/listen_timeout intentionally NOT set. The app does
      // not call process.send('ready'); enabling wait_ready caused PM2 to
      // mark the app not-ready and (on some PM2 versions) restart it
      // prematurely during the first 10s of startup.
    }
  ]
};
