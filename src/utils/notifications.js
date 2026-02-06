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
    this.tradeAnalyzer = config.tradeAnalyzer || null;
    
    if (!this.enabled) {
      console.log('[Notifications] Telegram not configured - notifications disabled');
    }
  }

  /**
   * Set trade analyzer reference for detailed explanations
   */
  setTradeAnalyzer(analyzer) {
    this.tradeAnalyzer = analyzer;
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

    const { signal, position, marketStructure, filterResults, aiDecision } = tradeData;
    const side = signal.type === 'buy' ? 'LONG' : 'SHORT';
    const emoji = signal.type === 'buy' ? '🟢' : '🔴';
    
    let msg = `${emoji} <b>${side} TRADE ENTERED</b>\n\n`;
    
    // Entry details
    msg += `<b>📍 Entry Details:</b>\n`;
    msg += `• Price: $${signal.price.toFixed(2)}\n`;
    msg += `• Contracts: ${position.contracts}\n`;
    msg += `• Risk: $${position.totalRisk.toFixed(2)}\n\n`;
    
    // Stop Loss & Take Profit
    msg += `<b>🎯 Trade Levels:</b>\n`;
    msg += `• Stop Loss: $${position.stopPrice.toFixed(2)} (${Math.abs(signal.price - position.stopPrice).toFixed(2)} pts)\n`;
    msg += `• Take Profit: $${position.targetPrice.toFixed(2)} (${Math.abs(signal.price - position.targetPrice).toFixed(2)} pts)\n`;
    msg += `• Risk:Reward: 1:${position.riskRewardRatio}\n\n`;
    
    // AI Confirmation (if enabled and available)
    if (aiDecision) {
      const decisionIcon = aiDecision.action === 'CONFIRM' ? '✅' : '⚠️';
      msg += `<b>🤖 AI Confirmation:</b>\n`;
      msg += `• Decision: ${decisionIcon} ${aiDecision.action}\n`;
      msg += `• Confidence: ${aiDecision.confidence}%\n`;
      msg += `• Risk Level: ${aiDecision.riskAssessment}\n`;
      msg += `• Reasoning: ${aiDecision.reasoning}\n`;
      if (aiDecision.keyFactors && aiDecision.keyFactors.length > 0) {
        msg += `• Key Factors: ${aiDecision.keyFactors.slice(0, 2).join(', ')}\n`;
      }
      msg += `\n`;
    }
    
    // Why the trade was taken
    msg += `<b>📊 Trade Reasoning:</b>\n`;
    
    if (signal.type === 'buy') {
      msg += `• Price broke above $${marketStructure?.breakoutHigh?.toFixed(2) || 'N/A'} (20-bar high)\n`;
    } else {
      msg += `• Price broke below $${marketStructure?.breakoutLow?.toFixed(2) || 'N/A'} (20-bar low)\n`;
    }
    
    // Filter confirmations
    msg += `\n<b>✅ Confirmations:</b>\n`;
    
    if (marketStructure) {
      if (marketStructure.priceVsEma !== null && marketStructure.priceVsEma !== undefined) {
        const trendDir = marketStructure.priceVsEma > 0 ? 'above' : 'below';
        msg += `• Trend: Price ${trendDir} 50 EMA (${marketStructure.priceVsEma.toFixed(2)}%)\n`;
      }
      if (marketStructure.rsi !== null && marketStructure.rsi !== undefined) {
        msg += `• RSI: ${marketStructure.rsi.toFixed(1)}\n`;
      }
      if (marketStructure.volumeRatio !== null && marketStructure.volumeRatio !== undefined) {
        msg += `• Volume: ${marketStructure.volumeRatio.toFixed(2)}x average\n`;
      }
      if (marketStructure.atr !== null && marketStructure.atr !== undefined) {
        msg += `• ATR: ${marketStructure.atr.toFixed(2)} (volatility)\n`;
      }
    }
    
    // Market context
    msg += `\n<b>🌍 Context:</b>\n`;
    msg += `• Session: ${marketStructure?.session?.replace(/_/g, ' ') || 'N/A'}\n`;
    msg += `• Recent trend: ${marketStructure?.recentBars?.trend || 'N/A'}\n`;
    
    // Single contract warning
    if (position.contracts === 1) {
      msg += `\n⚠️ <i>Single contract - will lock profit at stop instead of partial exit</i>`;
    }
    
    // AI latency note
    if (aiDecision && aiDecision.latency) {
      msg += `\n<i>AI analysis: ${aiDecision.latency}ms</i>`;
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
    const emoji = pnl >= 0 ? '✅' : '❌';
    const outcome = pnl >= 0 ? 'WIN' : 'LOSS';
    
    let msg = `${emoji} <b>TRADE ${outcome}</b>\n\n`;
    
    msg += `<b>📍 Exit Details:</b>\n`;
    msg += `• Exit Price: $${exitPrice.toFixed(2)}\n`;
    msg += `• Exit Reason: ${exitReason}\n`;
    msg += `• P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n`;
    msg += `• R-Multiple: ${rMultiple.toFixed(2)}R\n`;
    
    if (postAnalysis) {
      if (postAnalysis.positives && postAnalysis.positives.length > 0) {
        msg += `\n<b>✅ What Worked:</b>\n`;
        for (const positive of postAnalysis.positives) {
          msg += `• ${positive}\n`;
        }
      }
      
      if (postAnalysis.improvements && postAnalysis.improvements.length > 0) {
        msg += `\n<b>📝 Lessons:</b>\n`;
        for (const improvement of postAnalysis.improvements) {
          msg += `• ${improvement}\n`;
        }
      }
      
      if (postAnalysis.holdingTime) {
        msg += `\n<i>Holding time: ${postAnalysis.holdingTime}</i>`;
      }
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
    msg += `• Wins: ${feedback.wins} | Losses: ${feedback.losses}\n\n`;
    
    if (feedback.bestTimeToTrade) {
      msg += `<b>Best Conditions:</b>\n`;
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
