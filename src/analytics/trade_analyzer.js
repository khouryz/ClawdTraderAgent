/**
 * Trade Analyzer - AI-Powered Trade Analysis & Learning System
 * 
 * Features:
 * - Records detailed market structure at trade entry
 * - Generates human-readable trade explanations
 * - Creates feedback loop for algorithm improvement
 * - Analyzes historical trades to identify patterns
 */

const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');

class TradeAnalyzer extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      dataDir: config.dataDir || './data',
      tradesFile: config.tradesFile || 'trade_analysis.json',
      feedbackFile: config.feedbackFile || 'algorithm_feedback.json',
      minTradesForAnalysis: config.minTradesForAnalysis || 10,
      ...config
    };

    this.trades = [];
    this.feedback = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      filterPerformance: {},
      timeOfDayPerformance: {},
      marketConditionPerformance: {},
      rsiAtEntryPerformance: {},
      volumeAtEntryPerformance: {},
      trendAlignmentPerformance: {},
      atrPerformance: {},
      recommendations: [],
      lastUpdated: null
    };

    this._ensureDataDir();
    this._loadData();
  }

  /**
   * Ensure data directory exists
   */
  async _ensureDataDir() {
    try {
      await fs.mkdir(this.config.dataDir, { recursive: true });
    } catch (error) {
      // Directory exists
    }
  }

  /**
   * Load existing trade data
   */
  async _loadData() {
    try {
      const tradesPath = path.join(this.config.dataDir, this.config.tradesFile);
      const data = await fs.readFile(tradesPath, 'utf8');
      this.trades = JSON.parse(data);
    } catch (error) {
      this.trades = [];
    }

    try {
      const feedbackPath = path.join(this.config.dataDir, this.config.feedbackFile);
      const data = await fs.readFile(feedbackPath, 'utf8');
      this.feedback = { ...this.feedback, ...JSON.parse(data) };
    } catch (error) {
      // Use defaults
    }
  }

  /**
   * Save trade data
   */
  async _saveData() {
    try {
      const tradesPath = path.join(this.config.dataDir, this.config.tradesFile);
      await fs.writeFile(tradesPath, JSON.stringify(this.trades, null, 2));

      const feedbackPath = path.join(this.config.dataDir, this.config.feedbackFile);
      await fs.writeFile(feedbackPath, JSON.stringify(this.feedback, null, 2));
    } catch (error) {
      console.error('[TradeAnalyzer] Failed to save data:', error.message);
    }
  }

  /**
   * Capture market structure at trade entry
   */
  captureMarketStructure(strategyState, quote) {
    return {
      timestamp: new Date().toISOString(),
      
      // Price action
      currentPrice: quote?.last || quote?.bid || strategyState.currentPrice,
      bid: quote?.bid,
      ask: quote?.ask,
      spread: quote?.ask && quote?.bid ? quote.ask - quote.bid : null,
      
      // Breakout levels
      breakoutHigh: strategyState.lastHigh,
      breakoutLow: strategyState.lastLow,
      breakoutDistance: strategyState.currentPrice > strategyState.lastHigh 
        ? strategyState.currentPrice - strategyState.lastHigh
        : strategyState.lastLow - strategyState.currentPrice,
      
      // Technical indicators
      atr: strategyState.atr,
      atrPercent: strategyState.atr && strategyState.currentPrice 
        ? (strategyState.atr / strategyState.currentPrice) * 100 
        : null,
      ema: strategyState.ema,
      priceVsEma: strategyState.currentPrice && strategyState.ema 
        ? ((strategyState.currentPrice - strategyState.ema) / strategyState.ema) * 100 
        : null,
      rsi: strategyState.rsi,
      
      // Volume analysis
      currentVolume: strategyState.currentVolume,
      avgVolume: strategyState.avgVolume,
      volumeRatio: strategyState.currentVolume && strategyState.avgVolume 
        ? strategyState.currentVolume / strategyState.avgVolume 
        : null,
      
      // Bar data
      barsCount: strategyState.barsCount || (strategyState.bars?.length || 0),
      recentBars: this._getRecentBarsSummary(strategyState.bars || []),
      
      // Time context
      timeOfDay: this._getTimeOfDay(),
      dayOfWeek: new Date().getDay(),
      session: this._getCurrentSession()
    };
  }

  /**
   * Get summary of recent bars
   */
  _getRecentBarsSummary(bars) {
    if (!bars || bars.length < 5) return null;
    
    const recent = bars.slice(-5);
    return {
      trend: this._calculateTrend(recent),
      avgRange: recent.reduce((sum, b) => sum + (b.high - b.low), 0) / recent.length,
      bullishBars: recent.filter(b => b.close > b.open).length,
      bearishBars: recent.filter(b => b.close < b.open).length
    };
  }

  /**
   * Calculate short-term trend
   */
  _calculateTrend(bars) {
    if (!bars || bars.length < 2) return 'unknown';
    const first = bars[0].close;
    const last = bars[bars.length - 1].close;
    const change = ((last - first) / first) * 100;
    
    if (change > 0.1) return 'bullish';
    if (change < -0.1) return 'bearish';
    return 'neutral';
  }

  /**
   * Get current PST hour and minute (handles PST/PDT automatically)
   */
  _getPSTTime() {
    const now = new Date();
    const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    return { hour: pst.getHours(), minute: pst.getMinutes() };
  }

  /**
   * Get time of day category (PST)
   */
  _getTimeOfDay() {
    const { hour } = this._getPSTTime();
    if (hour < 7) return 'pre_market';
    if (hour < 8) return 'opening';
    if (hour < 10) return 'morning';
    if (hour < 12) return 'midday';
    if (hour < 13) return 'afternoon';
    return 'closing';
  }

  /**
   * Get current session (PST-based for futures)
   */
  _getCurrentSession() {
    const { hour, minute } = this._getPSTTime();
    const time = hour * 60 + minute;
    
    if (time < 390) return 'pre_market';      // Before 6:30 AM PST
    if (time < 420) return 'opening';         // 6:30-7:00 AM PST
    if (time < 480) return 'early_morning';   // 7:00-8:00 AM PST
    if (time < 600) return 'morning';         // 8:00-10:00 AM PST
    if (time < 720) return 'midday';          // 10:00-12:00 PM PST
    if (time < 780) return 'afternoon';       // 12:00-1:00 PM PST
    return 'closing';                          // After 1:00 PM PST
  }

  /**
   * Generate AI explanation for trade entry
   */
  generateTradeExplanation(signal, marketStructure, position, filterResults) {
    const side = signal.type === 'buy' ? 'LONG' : 'SHORT';
    const emoji = signal.type === 'buy' ? '🟢' : '🔴';
    
    // Build explanation
    let explanation = `${emoji} <b>${side} TRADE ENTERED</b>\n\n`;
    
    // Entry details
    explanation += `<b>📍 Entry Details:</b>\n`;
    explanation += `• Price: $${signal.price.toFixed(2)}\n`;
    explanation += `• Contracts: ${position.contracts}\n`;
    explanation += `• Risk: $${position.totalRisk.toFixed(2)}\n\n`;
    
    // Stop Loss & Take Profit
    explanation += `<b>🎯 Trade Levels:</b>\n`;
    explanation += `• Stop Loss: $${position.stopPrice.toFixed(2)} (${this._formatDistance(signal.price, position.stopPrice)} pts)\n`;
    explanation += `• Take Profit: $${position.targetPrice.toFixed(2)} (${this._formatDistance(signal.price, position.targetPrice)} pts)\n`;
    explanation += `• Risk:Reward: 1:${position.riskRewardRatio}\n\n`;
    
    // Why the trade was taken
    explanation += `<b>📊 Trade Reasoning:</b>\n`;
    
    // Breakout explanation
    if (signal.type === 'buy') {
      explanation += `• Price broke above ${marketStructure.breakoutHigh?.toFixed(2)} (20-bar high)\n`;
      explanation += `• Breakout strength: +${marketStructure.breakoutDistance?.toFixed(2)} pts\n`;
    } else {
      explanation += `• Price broke below ${marketStructure.breakoutLow?.toFixed(2)} (20-bar low)\n`;
      explanation += `• Breakout strength: -${marketStructure.breakoutDistance?.toFixed(2)} pts\n`;
    }
    
    // Filter confirmations
    explanation += `\n<b>✅ Filter Confirmations:</b>\n`;
    
    if (filterResults) {
      for (const filter of filterResults) {
        if (filter.passed) {
          explanation += `• ${filter.name}: ${filter.reason}\n`;
        }
      }
    } else {
      // Reconstruct from market structure
      if (marketStructure.priceVsEma !== null) {
        const trendDir = marketStructure.priceVsEma > 0 ? 'above' : 'below';
        explanation += `• Trend: Price ${trendDir} 50 EMA (${marketStructure.priceVsEma.toFixed(2)}%)\n`;
      }
      if (marketStructure.rsi !== null) {
        explanation += `• RSI: ${marketStructure.rsi.toFixed(1)} (momentum confirmed)\n`;
      }
      if (marketStructure.volumeRatio !== null) {
        explanation += `• Volume: ${marketStructure.volumeRatio.toFixed(2)}x average (spike confirmed)\n`;
      }
    }
    
    // Market context
    explanation += `\n<b>🌍 Market Context:</b>\n`;
    explanation += `• ATR: ${marketStructure.atr?.toFixed(2)} (${marketStructure.atrPercent?.toFixed(3)}% volatility)\n`;
    explanation += `• Session: ${marketStructure.session?.replace('_', ' ')}\n`;
    explanation += `• Recent trend: ${marketStructure.recentBars?.trend || 'N/A'}\n`;
    
    // Risk warning for single contract
    if (position.contracts === 1) {
      explanation += `\n⚠️ <i>Single contract - no partial profits available</i>`;
    }
    
    return explanation;
  }

  /**
   * Format distance between two prices
   */
  _formatDistance(price1, price2) {
    return Math.abs(price1 - price2).toFixed(2);
  }

  /**
   * Record a trade entry with full analysis
   */
  async recordTradeEntry(tradeData) {
    const trade = {
      id: `trade_${Date.now()}`,
      status: 'open',
      entryTime: new Date().toISOString(),
      
      // Trade details
      symbol: tradeData.symbol,
      side: tradeData.side,
      contracts: tradeData.contracts,
      entryPrice: tradeData.entryPrice,
      stopLoss: tradeData.stopLoss,
      takeProfit: tradeData.takeProfit,
      riskAmount: tradeData.riskAmount,
      
      // Market structure at entry
      marketStructure: tradeData.marketStructure,
      
      // Filter results
      filterResults: tradeData.filterResults,
      
      // Explanation
      explanation: tradeData.explanation,
      
      // Exit data (to be filled later)
      exitTime: null,
      exitPrice: null,
      exitReason: null,
      pnl: null,
      rMultiple: null,
      
      // Post-trade analysis (to be filled later)
      postAnalysis: null
    };

    this.trades.push(trade);
    await this._saveData();
    
    this.emit('tradeRecorded', trade);
    return trade;
  }

  /**
   * Record trade exit and perform analysis
   */
  async recordTradeExit(tradeId, exitData) {
    const trade = this.trades.find(t => t.id === tradeId);
    if (!trade) {
      // Find most recent open trade
      const openTrade = this.trades.find(t => t.status === 'open');
      if (openTrade) {
        return this._completeTradeExit(openTrade, exitData);
      }
      return null;
    }
    
    return this._completeTradeExit(trade, exitData);
  }

  /**
   * Complete trade exit and analyze
   */
  async _completeTradeExit(trade, exitData) {
    trade.status = 'closed';
    trade.exitTime = new Date().toISOString();
    trade.exitPrice = exitData.exitPrice;
    trade.exitReason = exitData.exitReason;
    trade.pnl = exitData.pnl;
    trade.rMultiple = exitData.rMultiple;
    
    // Perform post-trade analysis
    trade.postAnalysis = this._analyzeTradeOutcome(trade);
    
    // Update feedback system
    await this._updateFeedback(trade);
    
    await this._saveData();
    
    this.emit('tradeCompleted', trade);
    return trade;
  }

  /**
   * Analyze trade outcome
   */
  _analyzeTradeOutcome(trade) {
    const analysis = {
      outcome: this._classifyOutcome(trade),
      holdingTime: this._calculateHoldingTime(trade.entryTime, trade.exitTime),
      priceMovement: trade.exitPrice - trade.entryPrice,
      maxFavorableExcursion: null, // Would need tick data
      maxAdverseExcursion: null,   // Would need tick data
      
      // What worked
      positives: [],
      
      // What could improve
      improvements: []
    };

    // Analyze what worked or didn't
    if (analysis.outcome === 'win') {
      analysis.positives.push('Entry timing was good');
      
      if (trade.marketStructure?.volumeRatio > 2) {
        analysis.positives.push('Strong volume confirmation');
      }
      if (trade.marketStructure?.rsi > 50 && trade.side === 'Buy') {
        analysis.positives.push('RSI aligned with direction');
      }
    } else if (analysis.outcome === 'loss') {
      // Analyze why it failed
      if (trade.marketStructure?.volumeRatio < 1.5) {
        analysis.improvements.push('Volume was borderline - consider higher threshold');
      }
      if (trade.marketStructure?.session === 'lunch') {
        analysis.improvements.push('Avoid lunch hour trades');
      }
      if (trade.marketStructure?.atrPercent > 0.5) {
        analysis.improvements.push('High volatility - consider wider stops');
      }
    }

    return analysis;
  }

  /**
   * Calculate holding time
   */
  _calculateHoldingTime(entryTime, exitTime) {
    const entry = new Date(entryTime);
    const exit = new Date(exitTime);
    const diffMs = exit - entry;
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 60) return `${diffMins} minutes`;
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    return `${hours}h ${mins}m`;
  }

  /**
   * Classify trade outcome using exitReason as source of truth.
   * BE trades often have small negative P&L (e.g. -$0.50 from offset),
   * so pnl alone is unreliable for classification.
   */
  _classifyOutcome(trade) {
    const reason = (trade.exitReason || '').toLowerCase();
    if (reason.includes('breakeven') || reason.includes('break-even') || reason.includes('be stop')) {
      return 'breakeven';
    }
    if (trade.pnl > 0) return 'win';
    if (trade.pnl < 0) return 'loss';
    return 'breakeven';
  }

  /**
   * Update feedback system with trade data
   */
  async _updateFeedback(trade) {
    this.feedback.totalTrades++;

    const outcome = this._classifyOutcome(trade);
    if (outcome === 'win') this.feedback.wins++;
    else if (outcome === 'loss') this.feedback.losses++;
    else this.feedback.breakeven++;

    // Track exit reason distribution
    if (!this.feedback.exitReasonPerformance) this.feedback.exitReasonPerformance = {};
    const exitReason = trade.exitReason || 'unknown';
    if (!this.feedback.exitReasonPerformance[exitReason]) {
      this.feedback.exitReasonPerformance[exitReason] = { trades: 0, wins: 0, totalPnL: 0 };
    }
    this.feedback.exitReasonPerformance[exitReason].trades++;
    if (trade.pnl > 0) this.feedback.exitReasonPerformance[exitReason].wins++;
    this.feedback.exitReasonPerformance[exitReason].totalPnL += trade.pnl;

    // Track performance by time of day
    const timeOfDay = trade.marketStructure?.timeOfDay || 'unknown';
    if (!this.feedback.timeOfDayPerformance[timeOfDay]) {
      this.feedback.timeOfDayPerformance[timeOfDay] = { trades: 0, wins: 0, totalPnL: 0 };
    }
    this.feedback.timeOfDayPerformance[timeOfDay].trades++;
    if (trade.pnl > 0) this.feedback.timeOfDayPerformance[timeOfDay].wins++;
    this.feedback.timeOfDayPerformance[timeOfDay].totalPnL += trade.pnl;

    // Track performance by RSI range
    const rsiRange = this._getRsiRange(trade.marketStructure?.rsi);
    if (!this.feedback.rsiAtEntryPerformance[rsiRange]) {
      this.feedback.rsiAtEntryPerformance[rsiRange] = { trades: 0, wins: 0, totalPnL: 0 };
    }
    this.feedback.rsiAtEntryPerformance[rsiRange].trades++;
    if (trade.pnl > 0) this.feedback.rsiAtEntryPerformance[rsiRange].wins++;
    this.feedback.rsiAtEntryPerformance[rsiRange].totalPnL += trade.pnl;

    // Track performance by volume ratio
    const volumeRange = this._getVolumeRange(trade.marketStructure?.volumeRatio);
    if (!this.feedback.volumeAtEntryPerformance[volumeRange]) {
      this.feedback.volumeAtEntryPerformance[volumeRange] = { trades: 0, wins: 0, totalPnL: 0 };
    }
    this.feedback.volumeAtEntryPerformance[volumeRange].trades++;
    if (trade.pnl > 0) this.feedback.volumeAtEntryPerformance[volumeRange].wins++;
    this.feedback.volumeAtEntryPerformance[volumeRange].totalPnL += trade.pnl;

    // Track performance by session
    const session = trade.marketStructure?.session || 'unknown';
    if (!this.feedback.marketConditionPerformance[session]) {
      this.feedback.marketConditionPerformance[session] = { trades: 0, wins: 0, totalPnL: 0 };
    }
    this.feedback.marketConditionPerformance[session].trades++;
    if (trade.pnl > 0) this.feedback.marketConditionPerformance[session].wins++;
    this.feedback.marketConditionPerformance[session].totalPnL += trade.pnl;

    // Generate recommendations if enough data
    if (this.feedback.totalTrades >= this.config.minTradesForAnalysis) {
      this.feedback.recommendations = this._generateRecommendations();
    }

    this.feedback.lastUpdated = new Date().toISOString();
  }

  /**
   * Get RSI range category
   */
  _getRsiRange(rsi) {
    if (!rsi) return 'unknown';
    if (rsi < 30) return 'oversold';
    if (rsi < 40) return 'weak';
    if (rsi < 50) return 'neutral_low';
    if (rsi < 60) return 'neutral_high';
    if (rsi < 70) return 'strong';
    return 'overbought';
  }

  /**
   * Get volume range category
   */
  _getVolumeRange(ratio) {
    if (!ratio) return 'unknown';
    if (ratio < 1.0) return 'below_avg';
    if (ratio < 1.5) return 'average';
    if (ratio < 2.0) return 'above_avg';
    if (ratio < 3.0) return 'high';
    return 'very_high';
  }

  /**
   * Generate algorithm improvement recommendations
   */
  _generateRecommendations() {
    const recommendations = [];
    const winRate = this.feedback.wins / this.feedback.totalTrades;

    // Analyze time of day performance
    for (const [time, stats] of Object.entries(this.feedback.timeOfDayPerformance)) {
      if (stats.trades >= 3) {
        const timeWinRate = stats.wins / stats.trades;
        if (timeWinRate < 0.3) {
          recommendations.push({
            type: 'avoid_time',
            priority: 'high',
            message: `Avoid trading during ${time} - only ${(timeWinRate * 100).toFixed(0)}% win rate`,
            action: `Consider disabling trades during ${time} session`
          });
        } else if (timeWinRate > 0.7) {
          recommendations.push({
            type: 'prefer_time',
            priority: 'medium',
            message: `${time} session performs well - ${(timeWinRate * 100).toFixed(0)}% win rate`,
            action: `Consider increasing position size during ${time}`
          });
        }
      }
    }

    // Analyze RSI performance
    for (const [range, stats] of Object.entries(this.feedback.rsiAtEntryPerformance)) {
      if (stats.trades >= 3) {
        const rsiWinRate = stats.wins / stats.trades;
        if (rsiWinRate < 0.3) {
          recommendations.push({
            type: 'adjust_rsi',
            priority: 'high',
            message: `RSI ${range} entries have ${(rsiWinRate * 100).toFixed(0)}% win rate`,
            action: `Consider adjusting RSI filter to avoid ${range} entries`
          });
        }
      }
    }

    // Analyze volume performance
    for (const [range, stats] of Object.entries(this.feedback.volumeAtEntryPerformance)) {
      if (stats.trades >= 3) {
        const volWinRate = stats.wins / stats.trades;
        if (range === 'average' && volWinRate < 0.4) {
          recommendations.push({
            type: 'adjust_volume',
            priority: 'medium',
            message: `Average volume entries underperform - ${(volWinRate * 100).toFixed(0)}% win rate`,
            action: 'Consider increasing volume spike multiplier from 1.5x to 2.0x'
          });
        }
      }
    }

    // Overall performance check
    if (winRate < 0.4 && this.feedback.totalTrades >= 10) {
      recommendations.push({
        type: 'overall',
        priority: 'critical',
        message: `Overall win rate is ${(winRate * 100).toFixed(0)}% - below profitable threshold`,
        action: 'Review all filter settings and consider paper trading until improvements are made'
      });
    }

    return recommendations;
  }

  /**
   * Get algorithm feedback summary
   */
  getFeedbackSummary() {
    const winRate = this.feedback.totalTrades > 0 
      ? (this.feedback.wins / this.feedback.totalTrades * 100).toFixed(1)
      : 0;

    return {
      totalTrades: this.feedback.totalTrades,
      wins: this.feedback.wins,
      losses: this.feedback.losses,
      breakeven: this.feedback.breakeven || 0,
      winRate: `${winRate}%`,
      recommendations: this.feedback.recommendations,
      bestTimeToTrade: this._getBestPerformingCategory(this.feedback.timeOfDayPerformance),
      bestVolumeCondition: this._getBestPerformingCategory(this.feedback.volumeAtEntryPerformance),
      exitReasons: this.feedback.exitReasonPerformance || {},
      lastUpdated: this.feedback.lastUpdated
    };
  }

  /**
   * Get best performing category
   */
  _getBestPerformingCategory(performanceMap) {
    let best = null;
    let bestWinRate = 0;

    for (const [category, stats] of Object.entries(performanceMap)) {
      if (stats.trades >= 3) {
        const winRate = stats.wins / stats.trades;
        if (winRate > bestWinRate) {
          bestWinRate = winRate;
          best = { category, winRate: `${(winRate * 100).toFixed(0)}%`, trades: stats.trades };
        }
      }
    }

    return best;
  }

  /**
   * Generate exit explanation
   */
  generateExitExplanation(trade, exitData) {
    const emoji = exitData.pnl >= 0 ? '✅' : '❌';
    const outcome = exitData.pnl >= 0 ? 'WIN' : 'LOSS';
    
    let explanation = `${emoji} <b>TRADE ${outcome}</b>\n\n`;
    
    explanation += `<b>📍 Exit Details:</b>\n`;
    explanation += `• Exit Price: $${exitData.exitPrice.toFixed(2)}\n`;
    explanation += `• Exit Reason: ${exitData.exitReason}\n`;
    explanation += `• P&L: ${exitData.pnl >= 0 ? '+' : ''}$${exitData.pnl.toFixed(2)}\n`;
    explanation += `• R-Multiple: ${exitData.rMultiple.toFixed(2)}R\n\n`;
    
    if (trade?.postAnalysis) {
      if (trade.postAnalysis.positives.length > 0) {
        explanation += `<b>✅ What Worked:</b>\n`;
        for (const positive of trade.postAnalysis.positives) {
          explanation += `• ${positive}\n`;
        }
        explanation += '\n';
      }
      
      if (trade.postAnalysis.improvements.length > 0) {
        explanation += `<b>📝 Lessons:</b>\n`;
        for (const improvement of trade.postAnalysis.improvements) {
          explanation += `• ${improvement}\n`;
        }
      }
    }
    
    explanation += `\n<i>Holding time: ${trade?.postAnalysis?.holdingTime || 'N/A'}</i>`;
    
    return explanation;
  }

  /**
   * Get recent trades for analysis
   */
  getRecentTrades(count = 10) {
    return this.trades.slice(-count);
  }

  /**
   * Get all closed trades
   */
  getClosedTrades() {
    return this.trades.filter(t => t.status === 'closed');
  }

  /**
   * Export feedback report
   */
  async exportFeedbackReport() {
    const report = {
      generatedAt: new Date().toISOString(),
      summary: this.getFeedbackSummary(),
      detailedPerformance: {
        byTimeOfDay: this.feedback.timeOfDayPerformance,
        byRSI: this.feedback.rsiAtEntryPerformance,
        byVolume: this.feedback.volumeAtEntryPerformance,
        bySession: this.feedback.marketConditionPerformance
      },
      recommendations: this.feedback.recommendations,
      recentTrades: this.getRecentTrades(20)
    };

    const reportPath = path.join(this.config.dataDir, 'feedback_report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    
    return report;
  }
}

module.exports = TradeAnalyzer;
