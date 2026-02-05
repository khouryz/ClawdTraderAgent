/**
 * Telegram Notifications
 * Send trade alerts via Telegram
 */

const https = require('https');

class Notifications {
  constructor(config = {}) {
    this.telegramToken = config.telegramToken || process.env.TELEGRAM_BOT_TOKEN;
    this.telegramChatId = config.telegramChatId || process.env.TELEGRAM_CHAT_ID;
    this.enabled = !!(this.telegramToken && this.telegramChatId);
    this.botName = config.botName || 'TradovateBot';
    
    if (!this.enabled) {
      console.log('[Notifications] Telegram not configured - notifications disabled');
    }
  }

  /**
   * Send a webhook notification
   */
  async send(message, type = 'info') {
    if (!this.enabled) return;

    const emoji = {
      info: 'ℹ️',
      success: '✅',
      warning: '⚠️',
      error: '❌',
      trade: '📈',
      profit: '💰',
      loss: '📉'
    };

    const formattedMsg = `${emoji[type] || ''} [${this.botName}] ${message}`;

    try {
      await this._sendTelegram(formattedMsg);
    } catch (error) {
      console.error('[Notifications] Failed to send:', error.message);
    }
  }

  /**
   * Send message via Telegram Bot API
   */
  async _sendTelegram(message) {
    const url = `https://api.telegram.org/bot${this.telegramToken}/sendMessage`;
    
    const payload = {
      chat_id: this.telegramChatId,
      text: message,
      parse_mode: 'HTML'
    };

    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      
      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${this.telegramToken}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const req = https.request(options, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Telegram API returned ${res.statusCode}`));
        }
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  /**
   * Send trade entry notification
   */
  async tradeEntry(trade) {
    const msg = `**ENTRY** ${trade.side} ${trade.quantity} contracts @ $${trade.price.toFixed(2)}\n` +
                `Stop: $${trade.stopLoss.toFixed(2)} | Target: $${trade.target.toFixed(2)}\n` +
                `Risk: $${trade.risk.toFixed(2)}`;
    await this.send(msg, 'trade');
  }

  /**
   * Send trade exit notification
   */
  async tradeExit(trade) {
    const type = trade.pnl >= 0 ? 'profit' : 'loss';
    const msg = `**EXIT** ${trade.side} ${trade.quantity} contracts @ $${trade.exitPrice.toFixed(2)}\n` +
                `P&L: ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)} (${trade.rMultiple.toFixed(1)}R)`;
    await this.send(msg, type);
  }

  /**
   * Send daily summary
   */
  async dailySummary(stats) {
    const type = stats.pnl >= 0 ? 'success' : 'warning';
    const msg = `**DAILY SUMMARY**\n` +
                `Trades: ${stats.trades} | Win Rate: ${(stats.winRate * 100).toFixed(0)}%\n` +
                `P&L: ${stats.pnl >= 0 ? '+' : ''}$${stats.pnl.toFixed(2)}`;
    await this.send(msg, type);
  }

  /**
   * Send error alert
   */
  async error(errorMsg) {
    await this.send(`**ERROR** ${errorMsg}`, 'error');
  }

  /**
   * Send bot status
   */
  async status(statusMsg) {
    await this.send(statusMsg, 'info');
  }

  /**
   * Send bot started notification
   */
  async botStarted() {
    await this.send('Bot started and monitoring for signals', 'success');
  }

  /**
   * Send bot stopped notification
   */
  async botStopped(reason = 'Manual stop') {
    await this.send(`Bot stopped: ${reason}`, 'warning');
  }

  /**
   * Send trading halted notification
   */
  async tradingHalted(reason) {
    await this.send(`⛔ TRADING HALTED: ${reason}`, 'error');
  }
}

module.exports = Notifications;
