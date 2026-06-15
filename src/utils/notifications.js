/**
 * Telegram Notifications
 * Send trade alerts via Telegram with AI-powered explanations
 */

const https = require('https');

class Notifications {
  constructor(config = {}) {
    this.telegramToken = config.telegramToken || process.env.TELEGRAM_BOT_TOKEN;
    this.telegramChatId = config.telegramChatId || process.env.TELEGRAM_CHAT_ID;
    this.enabled = !!(this.telegramToken && this.telegramChatId);
    this.botName = config.botName || 'TradovateBot';
    // accountId is used to prefix every message in multi-account mode so each
    // Telegram channel's traffic is unambiguously attributable. Null in legacy
    // single-account mode for backwards-compatible message format.
    this.accountId = config.accountId || null;
    this.tradeAnalyzer = config.tradeAnalyzer || null;
    // Observability: track last send failure (used by AccountManager + /status command)
    this.lastSendError = null;
    this.lastSendErrorAt = null;
    this.totalSent = 0;
    this.totalFailed = 0;

    if (!this.enabled) {
      const who = this.accountId ? `[${this.accountId}] ` : '';
      console.log(`[Notifications] ${who}Telegram not configured - notifications disabled`);
    }
  }

  /**
   * Set trade analyzer reference for detailed explanations
   */
  setTradeAnalyzer(analyzer) {
    this.tradeAnalyzer = analyzer;
  }

  /**
   * Validate the Telegram bot token by calling /getMe. Returns true on 200/OK.
   * Used at startup by AccountManager so we can warn early on a bad token without
   * crashing the account (trading should continue even if Telegram is down).
   */
  async test() {
    if (!this.enabled) return false;
    return new Promise((resolve) => {
      const url = `https://api.telegram.org/bot${this.telegramToken}/getMe`;
      const req = https.request(url, { method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(res.statusCode === 200 && parsed.ok === true);
          } catch (_) {
            resolve(false);
          }
        });
      });
      req.on('error', () => resolve(false));
      req.setTimeout(5000, () => { try { req.destroy(); } catch (_) {} resolve(false); });
      req.end();
    });
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

    // Multi-account: prefix every message with [accountId] so the Telegram channel
    // is unambiguous (since multiple accounts may share a chat in some setups).
    // Single-account mode (accountId=null) preserves the legacy format exactly.
    const acctTag = this.accountId ? `[${this.accountId}] ` : '';
    const formattedMsg = `${emoji[type] || ''} ${acctTag}[${this.botName}] ${message}`;

    try {
      await this._sendTelegram(formattedMsg);
      this.totalSent++;
    } catch (error) {
      this.totalFailed++;
      this.lastSendError = error.message;
      this.lastSendErrorAt = new Date().toISOString();
      const who = this.accountId ? `[${this.accountId}] ` : '';
      console.error(`[Notifications] ${who}Failed to send:`, error.message);
    }
  }

  /**
   * Escape special HTML characters in dynamic text for Telegram
   */
  _escapeHtml(text) {
    if (typeof text !== 'string') return String(text);
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Sanitize a message that may contain intentional HTML tags (<b>, <i>, etc.)
   * but also unsafe dynamic content. Preserves allowed Telegram HTML tags.
   */
  _sanitizeHtml(message) {
    if (typeof message !== 'string') return String(message);
    // Temporarily replace allowed Telegram HTML tags with placeholders
    const allowed = ['b', 'i', 'u', 's', 'code', 'pre', 'a'];
    let safe = message;
    const placeholders = [];
    for (const tag of allowed) {
      // Opening tags (with optional attributes for <a>)
      safe = safe.replace(new RegExp(`<(${tag})(\\s[^>]*)?>`, 'gi'), (m) => {
        placeholders.push(m);
        return `\x00TAG${placeholders.length - 1}\x00`;
      });
      // Closing tags
      safe = safe.replace(new RegExp(`</${tag}>`, 'gi'), (m) => {
        placeholders.push(m);
        return `\x00TAG${placeholders.length - 1}\x00`;
      });
    }
    // Escape remaining < > &
    safe = safe.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Restore allowed tags
    safe = safe.replace(/\x00TAG(\d+)\x00/g, (_, idx) => placeholders[parseInt(idx)]);
    return safe;
  }

  /**
   * Send message via Telegram Bot API
   */
  async _sendTelegram(message) {
    const url = `https://api.telegram.org/bot${this.telegramToken}/sendMessage`;
    
    const payload = {
      chat_id: this.telegramChatId,
      text: this._sanitizeHtml(message),
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
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Telegram API returned ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  /**
   * Send trade entry notification with full AI explanation
   */
  async tradeEntry(trade) {
    // If we have a detailed explanation from trade analyzer, use it
    if (trade.explanation) {
      await this._sendTelegram(trade.explanation);
      return;
    }

    // Fallback to basic notification
    const msg = `<b>📈 ENTRY</b> ${trade.side} ${trade.quantity} contracts @ $${trade.price.toFixed(2)}\n` +
                `Stop: $${trade.stopLoss.toFixed(2)} | Target: $${trade.target.toFixed(2)}\n` +
                `Risk: $${trade.risk.toFixed(2)}`;
    await this._sendTelegram(msg);
  }

  /**
   * Send detailed trade entry with market structure analysis
   */
  async tradeEntryDetailed(tradeData) {
    if (!this.enabled) return;

    const { signal, position, marketStructure, filterResults, aiDecision, slippage, signalPrice } = tradeData;
    const side = signal.type === 'buy' ? 'LONG' : 'SHORT';
    const emoji = signal.type === 'buy' ? '🟢' : '🔴';
    const strat = signal.strategy || 'TRADE';
    const stopDist = Math.abs(signal.price - position.stopPrice).toFixed(1);
    const tgtDist = Math.abs(signal.price - position.targetPrice).toFixed(1);
    const instLabel = signal.instrument ? `${signal.instrument} · ` : '';

    let msg = `${emoji} <b>${instLabel}${strat} ${side}</b>\n\n`;
    
    msg += `Entry: $${signal.price.toFixed(2)}`;
    // Show slippage note if fill price differs from signal
    if (slippage && signalPrice) {
      const slipDir = slippage >= 0 ? '+' : '';
      msg += ` (signal: $${signalPrice.toFixed(2)}, slip: ${slipDir}${slippage.toFixed(2)}pt)`;
    }
    msg += `\n`;
    msg += `Stop: $${position.stopPrice.toFixed(2)} (${stopDist}pt)\n`;
    msg += `Target: $${position.targetPrice.toFixed(2)} (${tgtDist}pt)\n`;
    msg += `R:R 1:${position.riskRewardRatio} | Risk: $${position.totalRisk.toFixed(2)} | Reward: $${(position.totalRisk * position.riskRewardRatio).toFixed(2)}\n`;
    
    // Strategy-specific filter results (from signal)
    if (signal.filterResults && Array.isArray(signal.filterResults)) {
      msg += `\n<b>Filters:</b>\n`;
      for (const f of signal.filterResults) {
        if (f.passed) {
          msg += `✅ ${f.name}: ${f.reason}\n`;
        }
      }
    }
    
    // VWAP context (if available from V2 strategy)
    if (signal.vwapState && signal.vwapState.vwap) {
      const vs = signal.vwapState;
      const aboveBelow = signal.price > vs.vwap ? 'above' : 'below';
      msg += `\nVWAP: $${vs.vwap.toFixed(2)} (${aboveBelow})`;
      if (vs.sigmaDistance) msg += ` | ${vs.sigmaDistance.toFixed(1)}σ`;
      msg += `\n`;
    }
    
    // AI Confirmation (if enabled)
    if (aiDecision) {
      msg += `\n🤖 AI: ${aiDecision.action} (${aiDecision.score}/10, ${aiDecision.confidence}%)\n`;
      msg += `${aiDecision.reasoning}\n`;
    }
    
    // Trade number context
    if (signal.tradeNumToday !== undefined) {
      msg += `\n<i>Trade #${signal.tradeNumToday} today</i>`;
    }
    
    await this._sendTelegram(msg);
  }

  /**
   * Send trade exit notification with analysis
   */
  async tradeExit(trade) {
    const type = trade.pnl >= 0 ? 'profit' : 'loss';
    const emoji = trade.pnl >= 0 ? '✅' : '❌';
    const outcome = trade.pnl >= 0 ? 'WIN' : 'LOSS';
    
    let msg = `${emoji} <b>TRADE ${outcome}</b>\n\n`;
    msg += `<b>📍 Exit Details:</b>\n`;
    msg += `• Side: ${trade.side}\n`;
    msg += `• Quantity: ${trade.quantity} contracts\n`;
    msg += `• Exit Price: $${trade.exitPrice.toFixed(2)}\n`;
    msg += `• P&L: ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}\n`;
    msg += `• R-Multiple: ${trade.rMultiple.toFixed(2)}R\n`;
    
    if (trade.exitReason) {
      msg += `• Reason: ${trade.exitReason}\n`;
    }
    
    if (trade.holdingTime) {
      msg += `\n<i>Holding time: ${trade.holdingTime}</i>`;
    }
    
    await this._sendTelegram(msg);
  }

  /**
   * Send detailed exit with post-trade analysis
   */
  async tradeExitDetailed(exitData) {
    if (!this.enabled) return;

    const { trade, pnl, rMultiple, exitPrice, exitReason, postAnalysis } = exitData;
    // Three-way outcome: use ±2pt BE threshold consistent with PositionHandler
    const isBreakeven = exitReason === 'Breakeven Stop' || (Math.abs(pnl) <= 4 && Math.abs(rMultiple) < 0.5);
    const emoji = isBreakeven ? '🔒' : pnl >= 0 ? '💰' : '❌';
    const outcome = isBreakeven ? 'BREAKEVEN' : pnl >= 0 ? 'WIN' : 'LOSS';
    const strat = trade.strategyName || '';
    const instLabel = trade.instrument ? `${trade.instrument} · ` : '';

    let msg = `${emoji} <b>${instLabel}${strat} ${outcome}</b>\n\n`;
    
    msg += `${trade.side} $${trade.entryPrice?.toFixed(2) || '?'} → $${exitPrice != null ? exitPrice.toFixed(2) : '?'}\n`;
    msg += `P&L: ${pnl >= 0 ? '+' : ''}$${(pnl != null ? pnl : 0).toFixed(2)} (${(rMultiple != null ? rMultiple : 0).toFixed(1)}R)\n`;
    msg += `Exit: ${exitReason}\n`;
    
    // Holding time
    if (trade.entryTime) {
      const holdMs = Date.now() - new Date(trade.entryTime).getTime();
      const holdMin = Math.round(holdMs / 60000);
      msg += `Duration: ${holdMin < 1 ? '< 1' : holdMin} min\n`;
    }
    
    await this._sendTelegram(msg);
  }

  /**
   * Send single contract profit lock notification
   */
  async singleContractProfitLock(data) {
    const msg = `🔒 <b>PROFIT LOCKED</b>\n\n` +
                `Single contract position reached ${data.rMultiple?.toFixed(1) || '1'}R profit.\n` +
                `Stop moved to $${data.newStop.toFixed(2)} to lock in gains.\n\n` +
                `<i>Trade will continue to run toward full target.</i>`;
    await this._sendTelegram(msg);
  }

  /**
   * Send algorithm feedback summary
   */
  async feedbackSummary(feedback) {
    if (!this.enabled) return;

    let msg = `📊 <b>ALGORITHM FEEDBACK</b>\n\n`;
    msg += `<b>Performance:</b>\n`;
    msg += `• Total Trades: ${feedback.totalTrades}\n`;
    msg += `• Win Rate: ${feedback.winRate}\n`;
    msg += `• Wins: ${feedback.wins} | Losses: ${feedback.losses} | BE: ${feedback.breakeven || 0}\n`;

    // Exit reason breakdown
    if (feedback.exitReasons && Object.keys(feedback.exitReasons).length > 0) {
      msg += `\n<b>Exit Reasons:</b>\n`;
      for (const [reason, stats] of Object.entries(feedback.exitReasons)) {
        msg += `• ${reason}: ${stats.trades} (P&L: $${stats.totalPnL.toFixed(2)})\n`;
      }
    }
    
    if (feedback.bestTimeToTrade) {
      msg += `\n<b>Best Conditions:</b>\n`;
      msg += `• Best Time: ${feedback.bestTimeToTrade.category} (${feedback.bestTimeToTrade.winRate} win rate)\n`;
    }
    
    if (feedback.recommendations && feedback.recommendations.length > 0) {
      msg += `\n<b>🎯 Recommendations:</b>\n`;
      for (const rec of feedback.recommendations.slice(0, 3)) {
        const icon = rec.priority === 'critical' ? '🚨' : rec.priority === 'high' ? '⚠️' : '💡';
        msg += `${icon} ${rec.message}\n`;
      }
    }
    
    await this._sendTelegram(msg);
  }

  /**
   * Send daily summary
   */
  async dailySummary(stats) {
    const type = stats.pnl >= 0 ? 'success' : 'warning';
    const msg = `<b>DAILY SUMMARY</b>\n` +
                `Trades: ${stats.trades} | Win Rate: ${(stats.winRate * 100).toFixed(0)}%\n` +
                `P&L: ${stats.pnl >= 0 ? '+' : ''}$${stats.pnl.toFixed(2)}`;
    await this.send(msg, type);
  }

  /**
   * Send error alert
   */
  async error(errorMsg) {
    await this.send(`<b>ERROR</b> ${errorMsg}`, 'error');
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

  /**
   * Send daily performance report when bot stops for the day
   * @param {Object} todayStats - Today's stats from PerformanceTracker.getTodayStats()
   * @param {string} haltReason - Why trading was halted
   * @param {Array} todayTrades - Array of today's trade records
   */
  async dailyPerformanceReport(todayStats, haltReason, todayTrades = []) {
    if (!this.enabled) return;

    const emoji = todayStats.pnl >= 0 ? '💰' : '📉';
    const wr = todayStats.trades > 0 ? (todayStats.wins / todayStats.trades * 100).toFixed(0) : '0';

    let msg = `${emoji} <b>DAILY REPORT — ${todayStats.date || new Date().toISOString().slice(0, 10)}</b>\n\n`;

    msg += `<b>⛔ Stopped:</b> ${haltReason}\n\n`;

    msg += `<b>📊 Summary:</b>\n`;
    const be = todayStats.breakeven || 0;
    msg += `• Trades: ${todayStats.trades} (${todayStats.wins}W / ${todayStats.losses}L / ${be}BE)\n`;
    msg += `• Win Rate: ${wr}%\n`;
    msg += `• P&L: ${todayStats.pnl >= 0 ? '+' : ''}$${todayStats.pnl.toFixed(2)}\n`;
    if (todayStats.profitFactor && todayStats.profitFactor !== Infinity) {
      msg += `• PF: ${todayStats.profitFactor.toFixed(2)}\n`;
    }

    // List each trade briefly
    if (todayTrades.length > 0) {
      msg += `\n<b>📋 Trades:</b>\n`;
      for (let i = 0; i < todayTrades.length; i++) {
        const t = todayTrades[i];
        const icon = t.pnl > 0 ? '✅' : t.pnl === 0 ? '🔒' : '❌';
        const side = (t.side || '').toUpperCase().slice(0, 1);
        msg += `${icon} #${i + 1} ${side} $${(t.entryPrice || 0).toFixed(0)}→$${(t.exitPrice || 0).toFixed(0)} ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)} (${t.exitReason || '?'})\n`;
      }
    }

    msg += `\n<i>Bot off for the day. Resumes tomorrow 6:30 AM PST.</i>`;

    await this._sendTelegram(msg);
  }

  /**
   * Send AI trade rejection notification
   */
  async aiTradeRejected(data) {
    if (!this.enabled) return;

    const { signal, aiDecision, position, marketStructure } = data;
    const side = signal.type === 'buy' ? 'LONG' : 'SHORT';
    
    let msg = `🤖 <b>AI REJECTED ${side} TRADE</b>\n\n`;
    
    msg += `<b>📍 Signal Details:</b>\n`;
    msg += `• Entry: $${signal.price.toFixed(2)}\n`;
    msg += `• Stop Loss: $${signal.stopLoss.toFixed(2)}\n`;
    msg += `• Contracts: ${position.contracts}\n`;
    msg += `• Risk: $${position.totalRisk.toFixed(2)}\n\n`;
    
    msg += `<b>🤖 AI Analysis:</b>\n`;
    msg += `• Decision: <b>REJECT</b>\n`;
    msg += `• Confidence: ${aiDecision.confidence}%\n`;
    msg += `• Risk Assessment: ${aiDecision.riskAssessment}\n\n`;
    
    msg += `<b>📝 Reasoning:</b>\n`;
    msg += `${aiDecision.reasoning}\n\n`;
    
    if (aiDecision.keyFactors && aiDecision.keyFactors.length > 0) {
      msg += `<b>🔑 Key Factors:</b>\n`;
      for (const factor of aiDecision.keyFactors) {
        msg += `• ${factor}\n`;
      }
    }
    
    msg += `\n<i>Latency: ${aiDecision.latency}ms</i>`;
    
    await this._sendTelegram(msg);
  }

  /**
   * Send AI trade confirmation notification (included in entry)
   */
  async aiTradeConfirmed(data) {
    if (!this.enabled) return;

    const { signal, aiDecision } = data;
    const side = signal.type === 'buy' ? 'LONG' : 'SHORT';
    
    let msg = `🤖 <b>AI CONFIRMED ${side} TRADE</b>\n\n`;
    msg += `• Confidence: ${aiDecision.confidence}%\n`;
    msg += `• Risk Assessment: ${aiDecision.riskAssessment}\n`;
    msg += `• Reasoning: ${aiDecision.reasoning}\n`;
    
    if (aiDecision.keyFactors && aiDecision.keyFactors.length > 0) {
      msg += `\n<b>Key Factors:</b>\n`;
      for (const factor of aiDecision.keyFactors) {
        msg += `• ${factor}\n`;
      }
    }
    
    await this._sendTelegram(msg);
  }
}

module.exports = Notifications;
