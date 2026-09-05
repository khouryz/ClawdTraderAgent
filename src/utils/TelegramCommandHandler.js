/**
 * TelegramCommandHandler — execution-only remote control
 *
 * Polls Telegram for commands and dispatches them to the ExecutionBot.
 * No multi-instrument/multi-account support — single bot, single account.
 *
 * Commands:
 *   /start       — show help
 *   /pause       — pause trading (no new entries)
 *   /resume      — resume from /pause
 *   /forceresume — force resume from any halt (loss limits)
 *   /halt        — emergency halt (stops until tomorrow)
 *   /flatten     — close open position immediately
 *   /status      — current bot state
 *   /positions   — open positions + working orders
 *   /balance     — account balance
 *   /report      — today's performance report
 */

const https = require('https');
const logger = require('./logger');

class TelegramCommandHandler {
  /**
   * @param {Object} bot - ExecutionBot instance
   * @param {Object} notifications - Notifications instance
   */
  constructor(bot, notifications) {
    this.bot = bot;
    this.notifications = notifications;
    this.telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    this.authorizedChatId = process.env.TELEGRAM_CHAT_ID;
    this.pollingInterval = null;
    this.offset = 0;
    this.isRunning = false;

    if (!this.telegramToken || !this.authorizedChatId) {
      logger.warn('TelegramCommandHandler: Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    }
  }

  start() {
    if (this.isRunning) return;
    if (!this.telegramToken || !this.authorizedChatId) {
      logger.error('TelegramCommandHandler: Cannot start — missing credentials');
      return;
    }

    // Telegram allows exactly ONE getUpdates poller per bot token. With one
    // process per instrument, the second instance otherwise 409s forever
    // ("terminated by other getUpdates request") and its commands never work.
    // First instance to claim the lock owns commands; the others stay silent
    // but still SEND notifications, which are unaffected by this.
    if (!this._claimPollerLock()) {
      logger.warn(
        'TelegramCommandHandler: another instance owns command polling — ' +
        'not polling here. Notifications still send; /commands are handled by that instance.'
      );
      return;
    }

    this.isRunning = true;
    logger.info('TelegramCommandHandler: Started polling for commands (owns the poller lock)');
    this._poll();
  }

  /**
   * Claim the single-poller lock, or report that someone else holds it.
   * The holder refreshes its mtime while polling, so a crashed owner's lock
   * goes stale and the next instance to start can take over.
   */
  _claimPollerLock() {
    const fs = require('fs');
    const { FILES } = require('../utils/constants');
    const dir = process.env.LOSS_LIMITS_DIR || FILES.DATA_DIR;
    this._pollerLockPath = `${dir}/.telegram_poller.lock`;
    const STALE_MS = 60000;
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        fs.writeFileSync(this._pollerLockPath, String(process.pid), { flag: 'wx' });
        return true;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const age = Date.now() - fs.statSync(this._pollerLockPath).mtimeMs;
        if (age > STALE_MS) {
          // Previous owner died without releasing it.
          fs.writeFileSync(this._pollerLockPath, String(process.pid));
          logger.warn(`TelegramCommandHandler: took over a stale poller lock (${Math.round(age / 1000)}s old)`);
          return true;
        }
        return false;
      }
    } catch (err) {
      // Never let lock trouble disable commands outright on a single-bot setup.
      logger.warn(`TelegramCommandHandler: poller lock unavailable (${err.message}) — polling anyway`);
      return true;
    }
  }

  /** Keep the lock fresh so a live owner is never mistaken for a dead one. */
  _touchPollerLock() {
    if (!this._pollerLockPath) return;
    try {
      const now = new Date();
      require('fs').utimesSync(this._pollerLockPath, now, now);
    } catch (_) { /* lock removed by hand — not worth failing a poll over */ }
  }

  stop() {
    const wasRunning = this.isRunning;
    this.isRunning = false;
    if (this.pollingInterval) {
      clearTimeout(this.pollingInterval);
      this.pollingInterval = null;
    }
    // Release the lock so a sibling can take over commands immediately rather
    // than waiting out the staleness window.
    if (wasRunning && this._pollerLockPath) {
      try { require('fs').unlinkSync(this._pollerLockPath); } catch (_) {}
    }
    logger.info('TelegramCommandHandler: Stopped');
  }

  _poll() {
    if (!this.isRunning) return;
    this._touchPollerLock();

    const myGen = (this._pollGen = (this._pollGen || 0) + 1);
    let settled = false;
    const scheduleNext = (delayMs) => {
      if (settled) return;
      settled = true;
      if (!this.isRunning || myGen !== this._pollGen) return;
      clearTimeout(this.pollingInterval);
      this.pollingInterval = setTimeout(() => this._poll(), delayMs);
    };

    const url = `https://api.telegram.org/bot${this.telegramToken}/getUpdates?offset=${this.offset}&timeout=30`;

    const req = https.request(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let delay = 2000;
        if (res.statusCode === 200) {
          this._conflictStreak = 0;
          try {
            const data = JSON.parse(body);
            if (data.ok && data.result) this._processUpdates(data.result);
          } catch (err) {
            logger.error(`TelegramCommandHandler: Parse error: ${err.message}`);
          }
        } else if (res.statusCode === 409) {
          this._conflictStreak = (this._conflictStreak || 0) + 1;
          delay = Math.min(60000, 5000 * this._conflictStreak);
          // Surface Telegram's own explanation. This used to log only
          // "409 conflict xN", which hid the actual cause for days: a webhook
          // was registered on the bot, and getUpdates is forbidden while one is
          // active. The description says so in plain words.
          let why = '';
          try {
            const d = JSON.parse(body);
            if (d && d.description) why = ` — ${d.description}`;
          } catch (_) { /* body may not be JSON */ }
          if (why && /webhook/i.test(why) && !this._warnedWebhook) {
            this._warnedWebhook = true;
            logger.error(
              `TelegramCommandHandler: a WEBHOOK is registered on this bot, so polling can never work${why}. ` +
              `Commands will not be received until it is removed (deleteWebhook).`
            );
          } else if (this._conflictStreak === 1 || this._conflictStreak % 20 === 0) {
            logger.warn(`TelegramCommandHandler: 409 conflict x${this._conflictStreak} — backing off ${delay / 1000}s${why}`);
          }
        } else {
          let why = '';
          try {
            const d = JSON.parse(body);
            if (d && d.description) why = ` — ${d.description}`;
          } catch (_) { /* body may not be JSON */ }
          logger.error(`TelegramCommandHandler: API error ${res.statusCode}${why}`);
        }
        scheduleNext(delay);
      });
    });

    req.on('error', (err) => {
      if (!settled) logger.error(`TelegramCommandHandler: Request failed: ${err.message}`);
      scheduleNext(5000);
    });

    req.setTimeout(35000, () => {
      scheduleNext(2000);
      req.destroy();
    });

    req.end();
  }

  async _processUpdates(updates) {
    for (const update of updates) {
      this.offset = update.update_id + 1;
      if (!update.message || !update.message.text) continue;
      const message = update.message;
      if (message.chat.id.toString() !== this.authorizedChatId.toString()) {
        logger.warn(`TelegramCommandHandler: Unauthorized from chat ${message.chat.id}`);
        continue;
      }
      logger.info(`TelegramCommandHandler: Command: ${message.text}`);
      try {
        await this._handleCommand(message.text);
      } catch (err) {
        logger.error(`TelegramCommandHandler: Command failed: ${err.message}`);
        await this._reply('❌ Command failed.').catch(() => {});
      }
    }
  }

  async _handleCommand(text) {
    const command = text.trim().split(' ')[0].toLowerCase();

    if (this.bot && !this.bot.isRunning && command !== '/start') {
      await this._reply('⚠️ Bot is shutting down.');
      return;
    }

    switch (command) {
      case '/start':       await this._handleStart(); break;
      case '/pause':       await this._handlePause(); break;
      case '/resume':      await this._handleResume(); break;
      case '/forceresume': await this._handleForceResume(); break;
      case '/halt':        await this._handleHalt(); break;
      case '/flatten':     await this._handleFlatten(); break;
      case '/status':      await this._handleStatus(); break;
      case '/positions':   await this._handlePositions(); break;
      case '/balance':     await this._handleBalance(); break;
      case '/report':      await this._handleReport(); break;
      default:             await this._reply('❓ Unknown command. /start for help.'); break;
    }
  }

  async _reply(message) {
    if (!this.telegramToken || !this.authorizedChatId) return;
    try {
      await this.notifications.send(message);
    } catch (err) {
      logger.error(`TelegramCommandHandler: Reply failed: ${err.message}`);
    }
  }

  async _handleStart() {
    await this._reply(
      `<b>🤖 Execution Bot Commands</b>\n\n` +
      `<b>Control:</b>\n` +
      `/start — show this help\n` +
      `/pause — pause trading (no new entries)\n` +
      `/resume — resume from /pause\n` +
      `/forceresume — force resume from any halt\n` +
      `/halt — emergency halt (stops until tomorrow)\n` +
      `/flatten — close open position now\n\n` +
      `<b>Status:</b>\n` +
      `/status — current bot state\n` +
      `/positions — open positions + orders\n` +
      `/balance — account balance\n` +
      `/report — today's performance`
    );
  }

  async _handlePause() {
    if (!this.bot) return await this._reply('❌ Bot not available');
    if (this.bot.lossLimits.getStatus().isHalted) {
      return await this._reply('🛑 Trading is already HALTED by loss limits.');
    }
    if (this.bot._pausedByUser) return await this._reply('⚠️ Already paused.');
    this.bot._pausedByUser = true;
    logger.info('Telegram: Trading paused');
    await this._reply('⏸️ Trading paused. No new entries.\nUse /resume to continue.');
  }

  async _handleResume() {
    if (!this.bot) return await this._reply('❌ Bot not available');
    const status = this.bot.lossLimits.getStatus();
    if (!this.bot._pausedByUser) {
      if (status.isHalted) {
        return await this._reply('🛑 Halted by loss limits. Use /forceresume to override.');
      }
      return await this._reply('✅ Already active.');
    }
    this.bot._pausedByUser = false;
    logger.info('Telegram: Trading resumed');
    let msg = '▶️ Trading resumed.';
    if (status.isHalted) msg += '\n\n⚠️ Still halted by loss limits — use /forceresume to clear.';
    await this._reply(msg);
  }

  async _handleForceResume() {
    if (!this.bot) return await this._reply('❌ Bot not available');
    const status = this.bot.lossLimits.getStatus();
    this.bot._pausedByUser = false;
    if (status.isHalted) {
      this.bot.lossLimits.resume();
      logger.warn('Telegram: Force resumed');
      await this._reply(`⚠️ <b>FORCE RESUMED</b>\nCleared: ${status.haltReason}\nTrading is now active. Use with caution!`);
    } else {
      await this._reply('✅ No halts to clear. Already active.');
    }
  }

  async _handleHalt() {
    if (!this.bot) return await this._reply('❌ Bot not available');
    const status = this.bot.lossLimits.getStatus();
    if (status.isHalted) {
      return await this._reply(`🛑 Already halted: ${status.haltReason}\nResumes tomorrow or /forceresume.`);
    }
    this.bot.lossLimits.halt('MANUAL', 'Emergency halt via Telegram');
    logger.warn('Telegram: Emergency halt');
    await this._reply('🛑 <b>Emergency halt triggered.</b>\nNo new positions until tomorrow or /forceresume.');
  }

  async _handleFlatten() {
    if (!this.bot) return await this._reply('❌ Bot not available');
    const result = await this.bot.flattenAll();
    if (result.flattened) {
      await this._reply(`📤 <b>FLATTENED</b>\nPosition closed @ market.\nOrder: ${result.orderId || 'n/a'}`);
    } else {
      await this._reply(`📤 No position to flatten. ${result.reason || result.error || ''}`);
    }
  }

  async _handleStatus() {
    if (!this.bot || !this.bot.client || !this.bot.account) {
      return await this._reply('❌ Bot not initialized');
    }
    try {
      const s = this.bot.getStatus();
      let statusText;
      if (s.halted) statusText = '🛑 HALTED';
      else if (s.paused) statusText = '⏸️ PAUSED';
      else statusText = '▶️ ACTIVE';

      let msg = `<b>📊 Execution Bot Status</b>\n\n`;
      msg += `Trading: ${statusText}\n`;
      msg += `Market: ${s.marketOpen ? 'OPEN' : 'CLOSED'}\n`;
      msg += `Past cutoff: ${s.pastEntryCutoff ? 'YES' : 'NO'}\n`;
      msg += `Trades today: ${s.tradesToday}/${s.maxTrades}\n`;
      msg += `Daily P&L: $${s.dailyPnl.toFixed(2)}\n`;
      msg += `Loss limit remaining: $${s.lossLimitRemaining.toFixed(2)}\n`;
      if (s.haltReason) msg += `Halt reason: ${s.haltReason}\n`;
      if (s.openPositions > 0) {
        msg += `\n<b>Open Position:</b>\n`;
        msg += `Side: ${s.positionSide} | Qty: ${s.positionQty}\n`;
        msg += `Entry: $${s.positionEntry?.toFixed(2) || 'n/a'} | Stop: $${s.positionStop?.toFixed(2) || 'n/a'} | Target: $${s.positionTarget?.toFixed(2) || 'n/a'}\n`;
      } else {
        msg += `\nNo open positions.\n`;
      }
      await this._reply(msg);
    } catch (err) {
      logger.error(`Telegram: Status failed: ${err.message}`);
      await this._reply('❌ Failed to get status');
    }
  }

  async _handlePositions() {
    if (!this.bot || !this.bot.client || !this.bot.account) {
      return await this._reply('❌ Bot not initialized');
    }
    try {
      const data = await this.bot.getOpenPositions();
      if (data.error) return await this._reply(`❌ ${data.error}`);

      const positions = data.positions || [];
      const orders = data.workingOrders || [];

      if (positions.length === 0 && orders.length === 0) {
        return await this._reply('📋 No open positions or working orders');
      }

      let msg = `<b>📋 Positions (${positions.length})</b>\n`;
      for (const pos of positions) {
        const side = pos.netPos > 0 ? 'LONG' : 'SHORT';
        const qty = Math.abs(pos.netPos || 0);
        msg += `${side} ${qty} @ $${(pos.netPrice || 0).toFixed(2)}\n`;
      }

      if (orders.length > 0) {
        msg += `\n<b>Working Orders (${orders.length})</b>\n`;
        for (const o of orders) {
          msg += `${o.action} ${o.ordType} ${o.qty || 1} @ $${(o.price || o.stopPrice || 0).toFixed(2)}\n`;
        }
      }
      await this._reply(msg);
    } catch (err) {
      logger.error(`Telegram: Positions failed: ${err.message}`);
      await this._reply('❌ Failed to get positions');
    }
  }

  async _handleBalance() {
    if (!this.bot || !this.bot.client || !this.bot.account) {
      return await this._reply('❌ Bot not initialized');
    }
    try {
      const balance = await this.bot.client.getRealTimeBalance(this.bot.account.id);
      await this._reply(
        `<b>💰 Account Balance</b>\n\n` +
        `Equity: $${balance.equity?.toFixed(2) || '0.00'}\n` +
        `Cash: $${balance.cashBalance?.toFixed(2) || '0.00'}\n` +
        `Open P&L: $${balance.openPnL?.toFixed(2) || '0.00'}\n` +
        `Realized P&L: $${balance.realizedPnL?.toFixed(2) || '0.00'}\n` +
        `Margin: $${balance.margin?.toFixed(2) || '0.00'}`
      );
    } catch (err) {
      logger.error(`Telegram: Balance failed: ${err.message}`);
      await this._reply('❌ Failed to get balance');
    }
  }

  async _handleReport() {
    if (!this.bot) return await this._reply('❌ Bot not available');
    try {
      const stats = this.bot.performance.getTodayStats();
      const pnlIcon = stats.pnl >= 0 ? '🟢' : '🔴';
      await this._reply(
        `<b>📈 Today's Performance</b>\n\n` +
        `${pnlIcon} P&L: $${(stats.pnl || 0).toFixed(2)}\n` +
        `Trades: ${stats.trades || 0}\n` +
        `Wins: ${stats.wins || 0} | Losses: ${stats.losses || 0} | BE: ${stats.breakeven || 0}\n` +
        `Win Rate: ${(stats.winRate || 0).toFixed(1)}%`
      );
    } catch (err) {
      logger.error(`Telegram: Report failed: ${err.message}`);
      await this._reply('❌ Failed to generate report');
    }
  }
}

module.exports = TelegramCommandHandler;
