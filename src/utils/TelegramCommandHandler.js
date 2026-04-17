/**
 * TelegramCommandHandler - Handles two-way Telegram communication
 * 
 * Provides remote control of the bot via Telegram commands using long polling.
 * No external dependencies - uses Node.js built-in https module.
 */

const https = require('https');
const logger = require('./logger');

class TelegramCommandHandler {
  constructor(bot, notifications) {
    this.bot = bot;  // TradovateBot or MultiInstrumentBot
    this.notifications = notifications;
    this.isMultiInstrument = bot.runners !== undefined;  // Map exists only in MultiInstrumentBot
    this.pollingInterval = null;
    this.offset = 0;
    this.isRunning = false;
    this.telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    this.authorizedChatId = process.env.TELEGRAM_CHAT_ID;
    
    if (!this.telegramToken || !this.authorizedChatId) {
      logger.warn('TelegramCommandHandler: Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    }
  }

  /**
   * Start polling for Telegram updates
   */
  start() {
    if (this.isRunning) {
      logger.warn('TelegramCommandHandler: Already running');
      return;
    }

    if (!this.telegramToken || !this.authorizedChatId) {
      logger.error('TelegramCommandHandler: Cannot start - missing credentials');
      return;
    }

    this.isRunning = true;
    logger.info('TelegramCommandHandler: Started polling for commands');
    this._poll();
  }

  /**
   * Stop polling for Telegram updates
   */
  stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    if (this.pollingInterval) {
      clearTimeout(this.pollingInterval);
      this.pollingInterval = null;
    }
    logger.info('TelegramCommandHandler: Stopped polling');
  }

  /**
   * Poll for updates using long polling
   * @private
   */
  _poll() {
    if (!this.isRunning) return;

    const url = `https://api.telegram.org/bot${this.telegramToken}/getUpdates?offset=${this.offset}&timeout=30`;
    
    const req = https.request(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            if (data.ok && data.result) {
              this._processUpdates(data.result);
            }
          } catch (err) {
            logger.error(`TelegramCommandHandler: Failed to parse response: ${err.message}`);
          }
        } else {
          logger.error(`TelegramCommandHandler: API error ${res.statusCode}: ${body}`);
        }
        
        // Schedule next poll
        if (this.isRunning) {
          this.pollingInterval = setTimeout(() => this._poll(), 2000);
        }
      });
    });

    req.on('error', (err) => {
      logger.error(`TelegramCommandHandler: Request failed: ${err.message}`);
      if (this.isRunning) {
        this.pollingInterval = setTimeout(() => this._poll(), 5000);
      }
    });

    req.setTimeout(35000, () => {
      req.destroy();
      if (this.isRunning) {
        this.pollingInterval = setTimeout(() => this._poll(), 2000);
      }
    });

    req.end();
  }

  /**
   * Process incoming updates
   * @param {Array} updates - Array of update objects
   * @private
   */
  async _processUpdates(updates) {
    for (const update of updates) {
      this.offset = update.update_id + 1;
      
      if (!update.message || !update.message.text) continue;
      
      const message = update.message;
      
      // Security: Only process messages from authorized chat
      if (message.chat.id.toString() !== this.authorizedChatId.toString()) {
        logger.warn(`TelegramCommandHandler: Unauthorized message from chat ${message.chat.id}`);
        continue;
      }

      // Log command attempt
      logger.info(`TelegramCommandHandler: Received command: ${message.text}`);
      
      // Process command
      try {
        await this._handleCommand(message.text);
      } catch (err) {
        logger.error(`TelegramCommandHandler: Command failed: ${err.message}`);
        await this._reply('❌ Command failed. Please try again.');
      }
    }
  }

  /**
   * Handle a specific command
   * @param {string} text - Command text
   * @private
   */
  async _handleCommand(text) {
    const parts = text.trim().split(' ');
    const command = parts[0].toLowerCase();
    
    // Check if bot is shutting down
    if (this.bot && !this.bot.isRunning && command !== '/start') {
      await this._reply('⚠️ Bot is shutting down. Only basic commands available.');
      return;
    }

    switch (command) {
      case '/start':
        await this._handleStart();
        break;
        
      case '/pause':
        await this._handlePause();
        break;
        
      case '/resume':
        await this._handleResume();
        break;
        
      case '/forceresume':
        await this._handleForceResume();
        break;
        
      case '/status':
        await this._handleStatus();
        break;
        
      case '/positions':
        await this._handlePositions();
        break;
        
      case '/balance':
        await this._handleBalance();
        break;
        
      case '/report':
        await this._handleReport();
        break;
        
      case '/halt':
        await this._handleHalt();
        break;
        
      case '/botperformance':
        await this._handleBotPerformance();
        break;
        
      default:
        await this._reply('❓ Unknown command. Use /start for help.');
    }
  }

  /**
   * Send reply message
   * @param {string} message - Message to send
   * @private
   */
  async _reply(message) {
    if (!this.telegramToken || !this.authorizedChatId) return;
    
    try {
      await this.notifications.send(message);
    } catch (err) {
      logger.error(`TelegramCommandHandler: Failed to send reply: ${err.message}`);
    }
  }

  /**
   * Handle /start command
   * @private
   */
  async _handleStart() {
    const help = `<b>🤖 ClawdTraderBot Commands</b>\n\n` +
                `<b>Control Commands:</b>\n` +
                `/start - Show this help message\n` +
                `/pause - Pause trading (no new positions)\n` +
                `/resume - Resume trading\n` +
                `/forceresume - Force resume from any halt (use with caution)\n` +
                `/halt - Emergency halt (stops trading until tomorrow)\n\n` +
                `<b>Status Commands:</b>\n` +
                `/status - Current trading status\n` +
                `/positions - Open positions\n` +
                `/balance - Account balance\n` +
                `/report - Today's performance report\n` +
                `/botperformance - Algorithm performance stats\n\n` +
                `<i>Commands work in both single and multi-instrument modes</i>`;
    
    await this._reply(help);
  }

  /**
   * Handle /pause command
   * @private
   */
  async _handlePause() {
    if (!this.bot) {
      await this._reply('❌ Bot not available');
      return;
    }

    // Check if already halted by loss limits - pause is redundant
    const haltedInstruments = [];
    if (this.isMultiInstrument) {
      for (const [symbol, runner] of this.bot.runners) {
        const status = runner.lossLimits.getStatus();
        if (status.isHalted) {
          haltedInstruments.push(`${symbol}: ${status.haltReason}`);
        }
      }
    } else {
      const status = this.bot.lossLimits.getStatus();
      if (status.isHalted) {
        haltedInstruments.push(status.haltReason);
      }
    }

    if (haltedInstruments.length > 0) {
      await this._reply(
        `🛑 <b>Trading is already HALTED</b>\n\n` +
        `Halt reason:\n` +
        haltedInstruments.join('\n') + `\n\n` +
        `Trading will resume automatically at next daily reset (6:30 AM PST).`
      );
      return;
    }

    if (this.bot._pausedByUser) {
      await this._reply('⚠️ Trading is already paused.');
      return;
    }

    this.bot._pausedByUser = true;
    logger.info('TelegramCommandHandler: Trading paused via /pause');
    await this._reply('⏸️ Trading paused. No new positions will be opened.\n\n' +
                     'Existing positions will continue to be managed normally.\n' +
                     'Use /resume to continue trading.');
  }

  /**
   * Handle /resume command
   * @private
   */
  async _handleResume() {
    if (!this.bot) {
      await this._reply('❌ Bot not available');
      return;
    }

    // Check if any instrument is halted by loss limits
    const haltedInstruments = [];
    if (this.isMultiInstrument) {
      for (const [symbol, runner] of this.bot.runners) {
        const status = runner.lossLimits.getStatus();
        if (status.isHalted) {
          haltedInstruments.push(`${symbol}: ${status.haltReason}`);
        }
      }
    } else {
      const status = this.bot.lossLimits.getStatus();
      if (status.isHalted) {
        haltedInstruments.push(status.haltReason);
      }
    }

    // If halted by loss limits, cannot resume via this command
    if (haltedInstruments.length > 0) {
      await this._reply(
        `🛑 <b>Trading is HALTED</b>\n\n` +
        `Cannot resume - loss limits triggered:\n` +
        haltedInstruments.join('\n') + `\n\n` +
        `Trading will resume automatically at next daily reset (6:30 AM PST).`
      );
      return;
    }

    // If not paused by user and not halted, nothing to resume
    if (!this.bot._pausedByUser) {
      await this._reply('✅ Trading is already active. No pause or halt to resume from.');
      return;
    }

    // Resume from user pause
    this.bot._pausedByUser = false;
    logger.info('TelegramCommandHandler: Trading resumed via /resume');
    await this._reply('▶️ Trading resumed. Bot will process new signals.');
  }

  /**
   * Handle /forceresume command - force resume from ANY halt including loss limits
   * @private
   */
  async _handleForceResume() {
    if (!this.bot) {
      await this._reply('❌ Bot not available');
      return;
    }

    const resumedInstruments = [];
    
    if (this.isMultiInstrument) {
      for (const [symbol, runner] of this.bot.runners) {
        const status = runner.lossLimits.getStatus();
        if (status.isHalted) {
          runner.lossLimits.resume();
          resumedInstruments.push(`${symbol}: was ${status.haltReason}`);
        }
      }
    } else {
      const status = this.bot.lossLimits.getStatus();
      if (status.isHalted) {
        this.bot.lossLimits.resume();
        resumedInstruments.push(`was ${status.haltReason}`);
      }
    }

    // Also clear user pause
    this.bot._pausedByUser = false;

    if (resumedInstruments.length > 0) {
      logger.warn(`TelegramCommandHandler: FORCE RESUME via /forceresume: ${resumedInstruments.join(', ')}`);
      await this._reply(
        `⚠️ <b>FORCE RESUMED</b>\n\n` +
        `Cleared halts:\n` +
        resumedInstruments.join('\n') + `\n\n` +
        `Trading is now active. Use with caution!`
      );
    } else {
      await this._reply('✅ No halts to clear. Trading is already active.');
    }
  }

  /**
   * Handle /status command
   * @private
   */
  async _handleStatus() {
    if (!this.bot || !this.bot.client || !this.bot.account) {
      await this._reply('❌ Bot not fully initialized');
      return;
    }

    try {
      let status;
      
      if (this.isMultiInstrument) {
        status = await this.bot.getAggregatedStatus();
      } else {
        status = await this.bot.getStatus();
      }

      // Check if any instrument is halted by loss limits
      let isHalted = false;
      if (this.isMultiInstrument && status.instrumentStats) {
        isHalted = status.instrumentStats.some(inst => inst.isHalted);
      } else if (status.isHalted) {
        isHalted = true;
      }

      // Determine trading status text
      let tradingStatusText;
      if (isHalted) {
        tradingStatusText = '🛑 HALTED';
      } else if (status.paused) {
        tradingStatusText = '⏸️ PAUSED';
      } else {
        tradingStatusText = '▶️ ACTIVE';
      }

      const modeText = this.isMultiInstrument ? 'Multi-Instrument' : 'Single Instrument';
      
      let message = `<b>📊 Bot Status</b> - ${modeText}\n\n`;
      message += `Trading: ${tradingStatusText}\n`;
      message += `Account: ${status.account?.name || status.account?.id || 'Unknown'}\n`;
      
      if (status.balance) {
        message += `Equity: $${status.balance.equity?.toFixed(2) || '0.00'}\n`;
      }
      
      if (status.positions) {
        const posCount = Array.isArray(status.positions) ? status.positions.length : 0;
        message += `Positions: ${posCount}\n`;
      }
      
      if (status.totalPnl !== undefined) {
        message += `Today's P&L: $${status.totalPnl.toFixed(2)}\n`;
      }
      
      if (status.totalTrades !== undefined) {
        message += `Today's Trades: ${status.totalTrades}\n`;
      }

      if (this.isMultiInstrument && status.instrumentStats) {
        message += `\n<b>Instruments:</b>\n`;
        for (const inst of status.instrumentStats) {
          const statusIcon = inst.isHalted ? '🛑' : '✅';
          message += `${statusIcon} ${inst.symbol}: P&L $${inst.pnl?.toFixed(2) || '0.00'} | ${inst.trades || 0} trades\n`;
        }
      }
      
      await this._reply(message);
    } catch (err) {
      logger.error(`TelegramCommandHandler: Status command failed: ${err.message}`);
      await this._reply('❌ Failed to get status');
    }
  }

  /**
   * Handle /positions command
   * @private
   */
  async _handlePositions() {
    if (!this.bot || !this.bot.client || !this.bot.account) {
      await this._reply('❌ Bot not fully initialized');
      return;
    }

    try {
      const positions = await this.bot.client.getOpenPositions(this.bot.account.id);
      
      if (!positions || positions.length === 0) {
        await this._reply('📋 No open positions');
        return;
      }

      let message = `<b>📋 Open Positions (${positions.length})</b>\n\n`;
      
      for (const pos of positions) {
        // Tradovate position fields: netPos (positive=long, negative=short), netPrice (avg entry)
        const isLong = pos.netPos > 0;
        const side = isLong ? 'LONG' : 'SHORT';
        const qty = Math.abs(pos.netPos || 0);
        const entryPrice = pos.netPrice || 0;
        
        // Get contract name from the position
        let contractName = 'Unknown';
        if (pos.contractId && this.bot.client) {
          try {
            const contract = await this.bot.client.getContract(pos.contractId);
            contractName = contract?.name || `ID:${pos.contractId}`;
          } catch {
            contractName = `ID:${pos.contractId}`;
          }
        }
        
        message += `<b>${side} ${contractName}</b>\n`;
        message += `Qty: ${qty} | Entry: $${entryPrice.toFixed(2)}\n\n`;
      }
      
      await this._reply(message);
    } catch (err) {
      logger.error(`TelegramCommandHandler: Positions command failed: ${err.message}`);
      await this._reply('❌ Failed to get positions');
    }
  }

  /**
   * Handle /balance command
   * @private
   */
  async _handleBalance() {
    if (!this.bot || !this.bot.client || !this.bot.account) {
      await this._reply('❌ Bot not fully initialized');
      return;
    }

    try {
      // Use getRealTimeBalance for accurate equity (not beginning-of-day cashBalance)
      const balance = await this.bot.client.getRealTimeBalance(this.bot.account.id);
      
      const message = `<b>💰 Account Balance</b>\n\n` +
                     `Equity: $${balance.equity?.toFixed(2) || '0.00'}\n` +
                     `Cash Balance: $${balance.cashBalance?.toFixed(2) || '0.00'}\n` +
                     `Open P&L: $${balance.openPnL?.toFixed(2) || '0.00'}\n` +
                     `Realized P&L: $${balance.realizedPnL?.toFixed(2) || '0.00'}\n` +
                     `Margin Used: $${balance.margin?.toFixed(2) || '0.00'}`;
      
      await this._reply(message);
    } catch (err) {
      logger.error(`TelegramCommandHandler: Balance command failed: ${err.message}`);
      await this._reply('❌ Failed to get balance');
    }
  }

  /**
   * Handle /report command
   * @private
   */
  async _handleReport() {
    if (!this.bot) {
      await this._reply('❌ Bot not available');
      return;
    }

    try {
      let report;
      
      if (this.isMultiInstrument) {
        // Aggregate from all runners
        let totalPnl = 0, totalTrades = 0, totalWins = 0, totalLosses = 0, totalBE = 0;
        const instrumentReports = [];
        
        for (const [symbol, runner] of this.bot.runners) {
          const stats = runner.getTodayStats();
          totalPnl += stats.pnl || 0;
          totalTrades += stats.trades || 0;
          totalWins += stats.wins || 0;
          totalLosses += stats.losses || 0;
          totalBE += stats.breakeven || 0;
          
          instrumentReports.push({
            symbol,
            pnl: stats.pnl || 0,
            trades: stats.trades || 0,
            wins: stats.wins || 0,
            losses: stats.losses || 0,
            breakeven: stats.breakeven || 0,
            winRate: stats.winRate || 0
          });
        }
        
        report = {
          totalPnl,
          totalTrades,
          totalWins,
          totalLosses,
          totalBE,
          winRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
          instrumentReports
        };
      } else {
        // Single instrument
        const stats = this.bot.performance.getTodayStats();
        report = {
          totalPnl: stats.pnl || 0,
          totalTrades: stats.trades || 0,
          totalWins: stats.wins || 0,
          totalLosses: stats.losses || 0,
          totalBE: stats.breakeven || 0,
          winRate: stats.winRate || 0
        };
      }

      const pnlIcon = report.totalPnl >= 0 ? '🟢' : '🔴';
      let message = `<b>📈 Today's Performance Report</b>\n\n`;
      message += `${pnlIcon} Total P&L: $${report.totalPnl.toFixed(2)}\n`;
      message += `Total Trades: ${report.totalTrades}\n`;
      message += `Wins: ${report.totalWins} | Losses: ${report.totalLosses} | BE: ${report.totalBE || 0}\n`;
      message += `Win Rate: ${report.winRate.toFixed(1)}%\n`;
      
      if (this.isMultiInstrument && report.instrumentReports) {
        message += `\n<b>By Instrument:</b>\n`;
        for (const inst of report.instrumentReports) {
          const icon = inst.pnl >= 0 ? '🟢' : '🔴';
          message += `${icon} ${inst.symbol}: $${inst.pnl.toFixed(2)} | ${inst.trades} trades (${inst.winRate.toFixed(1)}%)\n`;
        }
      }
      
      await this._reply(message);
    } catch (err) {
      logger.error(`TelegramCommandHandler: Report command failed: ${err.message}`);
      await this._reply('❌ Failed to generate report');
    }
  }

  /**
   * Handle /halt command
   * @private
   */
  async _handleHalt() {
    if (!this.bot) {
      await this._reply('❌ Bot not available');
      return;
    }

    // Check if already halted
    const haltedInstruments = [];
    if (this.isMultiInstrument) {
      for (const [symbol, runner] of this.bot.runners) {
        const status = runner.lossLimits.getStatus();
        if (status.isHalted) {
          haltedInstruments.push(`${symbol}: ${status.haltReason}`);
        }
      }
    } else {
      const status = this.bot.lossLimits.getStatus();
      if (status.isHalted) {
        haltedInstruments.push(status.haltReason);
      }
    }

    // If already halted, inform user
    if (haltedInstruments.length > 0) {
      await this._reply(
        `🛑 <b>Trading is already HALTED</b>\n\n` +
        `Halt reason:\n` +
        haltedInstruments.join('\n') + `\n\n` +
        `Trading will resume automatically at next daily reset (6:30 AM PST).`
      );
      return;
    }

    logger.warn('TelegramCommandHandler: Emergency halt requested via /halt');
    
    try {
      if (this.isMultiInstrument) {
        // Halt all instruments
        for (const [symbol, runner] of this.bot.runners) {
          runner.lossLimits.halt('MANUAL', `Emergency halt via Telegram for ${symbol}`);
        }
        await this._reply('🛑 Emergency halt triggered for all instruments.\n\n' +
                         'Trading will not resume until tomorrow or manual intervention.');
      } else {
        this.bot.lossLimits.halt('MANUAL', 'Emergency halt via Telegram');
        await this._reply('🛑 Emergency halt triggered.\n\n' +
                         'Trading will not resume until tomorrow or manual intervention.');
      }
    } catch (err) {
      logger.error(`TelegramCommandHandler: Halt command failed: ${err.message}`);
      await this._reply('❌ Failed to trigger halt');
    }
  }

  /**
   * Handle /botperformance command
   * Uses the same TradeAnalyzer data that generates the Algorithm Feedback notifications
   * @private
   */
  async _handleBotPerformance() {
    if (!this.bot) {
      await this._reply('❌ Bot not available');
      return;
    }

    try {
      // Use tradeAnalyzer.getFeedbackSummary() - same data source as Algorithm Feedback notifications
      const tradeAnalyzer = this.bot.tradeAnalyzer;
      
      if (!tradeAnalyzer) {
        await this._reply('❌ Trade analyzer not available');
        return;
      }

      const feedback = tradeAnalyzer.getFeedbackSummary();
      
      let message = `📊 <b>ALGORITHM FEEDBACK</b>\n\n`;
      
      message += `<b>Performance:</b>\n`;
      message += `• Total Trades: ${feedback.totalTrades}\n`;
      message += `• Win Rate: ${feedback.winRate}\n`;
      message += `• Wins: ${feedback.wins} | Losses: ${feedback.losses} | BE: ${feedback.breakeven || 0}\n`;

      if (feedback.bestTimeToTrade) {
        message += `\n<b>Best Conditions:</b>\n`;
        message += `• Best Time: ${feedback.bestTimeToTrade.category} (${feedback.bestTimeToTrade.winRate} win rate)\n`;
      }
      
      if (feedback.bestVolumeCondition) {
        message += `• Best Volume: ${feedback.bestVolumeCondition.category} (${feedback.bestVolumeCondition.winRate} win rate)\n`;
      }
      
      if (feedback.recommendations && feedback.recommendations.length > 0) {
        message += `\n<b>Recommendations:</b>\n`;
        for (const rec of feedback.recommendations.slice(0, 3)) {
          const text = typeof rec === 'string' ? rec : rec.message || rec;
          message += `• ${text}\n`;
        }
      }
      
      if (feedback.lastUpdated) {
        const lastUpdate = new Date(feedback.lastUpdated).toLocaleString();
        message += `\n<i>Last updated: ${lastUpdate}</i>`;
      }
      
      await this._reply(message);
    } catch (err) {
      logger.error(`TelegramCommandHandler: BotPerformance command failed: ${err.message}`);
      await this._reply('❌ Failed to get performance stats');
    }
  }
}

module.exports = TelegramCommandHandler;
