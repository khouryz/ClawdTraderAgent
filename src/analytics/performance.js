/**
 * Performance Analytics
 * Tracks trade performance, win rate, P&L, and generates reports
 * Designed for Clawdbot integration - outputs JSON for easy parsing
 */

const EventEmitter = require('events');
const FileOps = require('../utils/file_ops');
const { FILES } = require('../utils/constants');

class PerformanceTracker extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      dataDir: config.dataDir || FILES.DATA_DIR,
      tradesFile: config.tradesFile || FILES.TRADES_FILE,
      dailyStatsFile: config.dailyStatsFile || FILES.DAILY_STATS_FILE,
      ...config
    };

    this.trades = [];
    this.dailyStats = {};
    this.currentSession = {
      startTime: new Date(),
      trades: [],
      pnl: 0
    };

    this.ensureDataDir();
    this.loadData();
  }

  /**
   * Ensure data directory exists
   */
  ensureDataDir() {
    FileOps.ensureDirSync(this.config.dataDir);
  }

  /**
   * Load persisted data
   */
  loadData() {
    try {
      const tradesPath = `${this.config.dataDir}/${this.config.tradesFile}`;
      this.trades = FileOps.readJSONSync(tradesPath, []);

      const statsPath = `${this.config.dataDir}/${this.config.dailyStatsFile}`;
      this.dailyStats = FileOps.readJSONSync(statsPath, {});
    } catch (error) {
      console.error('[Performance] Error loading data:', error.message);
    }
  }

  /**
   * Save data to files (async for non-blocking)
   */
  async saveData() {
    try {
      const tradesPath = `${this.config.dataDir}/${this.config.tradesFile}`;
      await FileOps.writeJSON(tradesPath, this.trades);

      const statsPath = `${this.config.dataDir}/${this.config.dailyStatsFile}`;
      await FileOps.writeJSON(statsPath, this.dailyStats);
    } catch (error) {
      console.error('[Performance] Error saving data:', error.message);
    }
  }

  /**
   * Record a completed trade
   */
  recordTrade(trade) {
    const tradeRecord = {
      id: trade.id || `trade_${Date.now()}`,
      timestamp: new Date().toISOString(),
      date: new Date().toISOString().split('T')[0],
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      stopLoss: trade.stopLoss,
      target: trade.target,
      pnl: trade.pnl,
      rMultiple: trade.rMultiple || this.calculateRMultiple(trade),
      exitReason: trade.exitReason,
      duration: trade.duration || null,
      fees: trade.fees || 0
    };

    this.trades.push(tradeRecord);
    this.currentSession.trades.push(tradeRecord);
    this.currentSession.pnl += tradeRecord.pnl;

    // Update daily stats
    this.updateDailyStats(tradeRecord);

    this.saveData();
    this.emit('tradeRecorded', tradeRecord);

    return tradeRecord;
  }

  /**
   * Calculate R multiple for a trade
   */
  calculateRMultiple(trade) {
    const risk = Math.abs(trade.entryPrice - trade.stopLoss) * trade.quantity;
    if (risk === 0) return 0;
    return trade.pnl / risk;
  }

  /**
   * Update daily statistics
   */
  updateDailyStats(trade) {
    const date = trade.date;
    
    if (!this.dailyStats[date]) {
      this.dailyStats[date] = {
        date,
        trades: 0,
        wins: 0,
        losses: 0,
        breakeven: 0,
        pnl: 0,
        fees: 0,
        bestTrade: 0,
        worstTrade: 0,
        avgWin: 0,
        avgLoss: 0,
        totalWinAmount: 0,
        totalLossAmount: 0,
        rMultiples: []
      };
    }

    const stats = this.dailyStats[date];
    stats.trades++;
    stats.pnl += trade.pnl;
    stats.fees += trade.fees || 0;
    stats.rMultiples.push(trade.rMultiple);

    if (trade.pnl > 0) {
      stats.wins++;
      stats.totalWinAmount += trade.pnl;
      stats.avgWin = stats.totalWinAmount / stats.wins;
      if (trade.pnl > stats.bestTrade) stats.bestTrade = trade.pnl;
    } else if (trade.pnl < 0) {
      stats.losses++;
      stats.totalLossAmount += Math.abs(trade.pnl);
      stats.avgLoss = stats.totalLossAmount / stats.losses;
      if (trade.pnl < stats.worstTrade) stats.worstTrade = trade.pnl;
    } else {
      stats.breakeven++;
    }
  }

  /**
   * Get today's statistics
   */
  getTodayStats() {
    const today = new Date().toISOString().split('T')[0];
    return this.getDayStats(today);
  }

  /**
   * Get statistics for a specific day
   */
  getDayStats(date) {
    const stats = this.dailyStats[date];
    if (!stats) {
      return {
        date,
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        pnl: 0,
        avgR: 0,
        profitFactor: 0
      };
    }

    const winRate = stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0;
    const avgR = stats.rMultiples.length > 0 
      ? stats.rMultiples.reduce((a, b) => a + b, 0) / stats.rMultiples.length 
      : 0;
    const profitFactor = stats.totalLossAmount > 0 
      ? stats.totalWinAmount / stats.totalLossAmount 
      : stats.totalWinAmount > 0 ? Infinity : 0;

    return {
      ...stats,
      winRate,
      avgR,
      profitFactor,
      expectancy: (winRate / 100 * stats.avgWin) - ((100 - winRate) / 100 * stats.avgLoss)
    };
  }

  /**
   * Get current session statistics
   */
  getSessionStats() {
    const trades = this.currentSession.trades;
    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.pnl < 0).length;

    return {
      startTime: this.currentSession.startTime,
      duration: Date.now() - this.currentSession.startTime.getTime(),
      trades: trades.length,
      wins,
      losses,
      winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      pnl: this.currentSession.pnl,
      avgR: trades.length > 0 
        ? trades.reduce((sum, t) => sum + t.rMultiple, 0) / trades.length 
        : 0
    };
  }

  /**
   * Get overall statistics
   */
  getOverallStats() {
    const wins = this.trades.filter(t => t.pnl > 0).length;
    const losses = this.trades.filter(t => t.pnl < 0).length;
    const totalPnL = this.trades.reduce((sum, t) => sum + t.pnl, 0);
    const totalWinAmount = this.trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
    const totalLossAmount = this.trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + Math.abs(t.pnl), 0);

    const winRate = this.trades.length > 0 ? (wins / this.trades.length) * 100 : 0;
    const avgR = this.trades.length > 0 
      ? this.trades.reduce((sum, t) => sum + t.rMultiple, 0) / this.trades.length 
      : 0;
    const profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : 0;

    // Calculate max drawdown
    let peak = 0;
    let maxDrawdown = 0;
    let runningPnL = 0;
    for (const trade of this.trades) {
      runningPnL += trade.pnl;
      if (runningPnL > peak) peak = runningPnL;
      const drawdown = peak - runningPnL;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    return {
      totalTrades: this.trades.length,
      wins,
      losses,
      breakeven: this.trades.length - wins - losses,
      winRate,
      totalPnL,
      avgPnL: this.trades.length > 0 ? totalPnL / this.trades.length : 0,
      avgR,
      profitFactor,
      maxDrawdown,
      avgWin: wins > 0 ? totalWinAmount / wins : 0,
      avgLoss: losses > 0 ? totalLossAmount / losses : 0,
      bestTrade: this.trades.length > 0 ? Math.max(...this.trades.map(t => t.pnl)) : 0,
      worstTrade: this.trades.length > 0 ? Math.min(...this.trades.map(t => t.pnl)) : 0,
      tradingDays: Object.keys(this.dailyStats).length
    };
  }

  /**
   * Get weekly statistics
   */
  getWeeklyStats() {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    weekStart.setHours(0, 0, 0, 0);

    const weekTrades = this.trades.filter(t => new Date(t.timestamp) >= weekStart);
    const wins = weekTrades.filter(t => t.pnl > 0).length;
    const pnl = weekTrades.reduce((sum, t) => sum + t.pnl, 0);

    return {
      weekStart: weekStart.toISOString().split('T')[0],
      trades: weekTrades.length,
      wins,
      losses: weekTrades.filter(t => t.pnl < 0).length,
      winRate: weekTrades.length > 0 ? (wins / weekTrades.length) * 100 : 0,
      pnl,
      avgR: weekTrades.length > 0 
        ? weekTrades.reduce((sum, t) => sum + t.rMultiple, 0) / weekTrades.length 
        : 0
    };
  }

  /**
   * Get monthly statistics
   */
  getMonthlyStats() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthTrades = this.trades.filter(t => new Date(t.timestamp) >= monthStart);
    const wins = monthTrades.filter(t => t.pnl > 0).length;
    const pnl = monthTrades.reduce((sum, t) => sum + t.pnl, 0);

    return {
      month: `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`,
      trades: monthTrades.length,
      wins,
      losses: monthTrades.filter(t => t.pnl < 0).length,
      winRate: monthTrades.length > 0 ? (wins / monthTrades.length) * 100 : 0,
      pnl,
      avgR: monthTrades.length > 0 
        ? monthTrades.reduce((sum, t) => sum + t.rMultiple, 0) / monthTrades.length 
        : 0
    };
  }

  /**
   * Generate a full report (JSON format for Clawdbot)
   */
  generateReport() {
    return {
      generated: new Date().toISOString(),
      session: this.getSessionStats(),
      today: this.getTodayStats(),
      week: this.getWeeklyStats(),
      month: this.getMonthlyStats(),
      overall: this.getOverallStats(),
      recentTrades: this.trades.slice(-10).reverse()
    };
  }

  /**
   * Format report as readable text (for Clawdbot messages)
   */
  formatReportText() {
    const report = this.generateReport();
    const today = report.today;
    const overall = report.overall;

    return `
📊 TRADING PERFORMANCE REPORT
Generated: ${new Date().toLocaleString()}

━━━ TODAY ━━━
Trades: ${today.trades} | Wins: ${today.wins} | Losses: ${today.losses}
Win Rate: ${today.winRate.toFixed(1)}%
P&L: $${today.pnl.toFixed(2)}
Avg R: ${today.avgR.toFixed(2)}

━━━ OVERALL ━━━
Total Trades: ${overall.totalTrades}
Win Rate: ${overall.winRate.toFixed(1)}%
Total P&L: $${overall.totalPnL.toFixed(2)}
Profit Factor: ${overall.profitFactor.toFixed(2)}
Max Drawdown: $${overall.maxDrawdown.toFixed(2)}
Avg R: ${overall.avgR.toFixed(2)}
Best Trade: $${overall.bestTrade.toFixed(2)}
Worst Trade: $${overall.worstTrade.toFixed(2)}
    `.trim();
  }

  /**
   * Get recent trades
   */
  getRecentTrades(count = 10) {
    return this.trades.slice(-count).reverse();
  }

  /**
   * Clear all data (use with caution)
   */
  clearAllData() {
    this.trades = [];
    this.dailyStats = {};
    this.currentSession = {
      startTime: new Date(),
      trades: [],
      pnl: 0
    };
    this.saveData();
    this.emit('dataCleared');
  }

  /**
   * Reset session (call at start of each trading day)
   */
  resetSession() {
    this.currentSession = {
      startTime: new Date(),
      trades: [],
      pnl: 0
    };
    this.emit('sessionReset');
  }
}

module.exports = PerformanceTracker;
