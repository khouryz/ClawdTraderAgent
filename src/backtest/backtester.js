/**
 * Backtesting Engine
 * Simulates the enhanced breakout strategy against historical data
 */

const { CONTRACTS } = require('../utils/constants');

class Backtester {
  constructor(config = {}) {
    this.config = {
      startingBalance: config.startingBalance || 1000,
      riskPerTrade: config.riskPerTrade || { min: 30, max: 60 },
      profitTargetR: config.profitTargetR || 2,
      contractSymbol: config.contractSymbol || 'MES',
      
      // Strategy parameters
      lookbackPeriod: config.lookbackPeriod || 20,
      atrPeriod: config.atrPeriod || 14,
      atrMultiplier: config.atrMultiplier || 1.5,
      trendEMAPeriod: config.trendEMAPeriod || 50,
      rsiPeriod: config.rsiPeriod || 14,
      volumeAvgPeriod: config.volumeAvgPeriod || 20,
      volumeSpikeMultiplier: config.volumeSpikeMultiplier || 1.5,
      
      // Filter toggles
      useTrendFilter: config.useTrendFilter !== false,
      useVolumeFilter: config.useVolumeFilter !== false,
      useRSIFilter: config.useRSIFilter !== false,
      
      // RSI thresholds
      rsiOverbought: config.rsiOverbought || 70,
      rsiOversold: config.rsiOversold || 30,
      rsiNeutralHigh: config.rsiNeutralHigh || 60,
      rsiNeutralLow: config.rsiNeutralLow || 40,
      
      // Session filter
      tradingStartHour: config.tradingStartHour || 9,
      tradingStartMinute: config.tradingStartMinute || 30,
      tradingEndHour: config.tradingEndHour || 16,
      tradingEndMinute: config.tradingEndMinute || 0,
      avoidLunch: config.avoidLunch !== false,
      lunchStartHour: config.lunchStartHour || 12,
      lunchEndHour: config.lunchEndHour || 14,
      
      // Signal cooldown
      signalCooldownBars: config.signalCooldownBars || 5,
      
      ...config
    };

    this.trades = [];
    this.balance = this.config.startingBalance;
    this.peakBalance = this.config.startingBalance;
    this.maxDrawdown = 0;
    this.currentPosition = null;
    this.lastSignalBar = -999;
    
    // Get contract specs
    const baseSymbol = this.config.contractSymbol.substring(0, 3);
    this.contractSpecs = CONTRACTS[baseSymbol] || CONTRACTS.MES;
  }

  /**
   * Run backtest on historical bars
   */
  run(bars) {
    console.log(`\n📊 Starting backtest with ${bars.length} bars...`);
    console.log(`   Starting balance: $${this.config.startingBalance}`);
    console.log(`   Contract: ${this.config.contractSymbol}`);
    console.log(`   Risk per trade: $${this.config.riskPerTrade.min}-$${this.config.riskPerTrade.max}`);
    console.log(`   Profit target: ${this.config.profitTargetR}R\n`);

    // Need enough bars for indicators
    const minBars = Math.max(
      this.config.lookbackPeriod,
      this.config.atrPeriod,
      this.config.trendEMAPeriod,
      this.config.rsiPeriod,
      this.config.volumeAvgPeriod
    ) + 10;

    if (bars.length < minBars) {
      console.error(`Not enough bars. Need at least ${minBars}, got ${bars.length}`);
      return null;
    }

    // Process each bar
    for (let i = minBars; i < bars.length; i++) {
      const historicalBars = bars.slice(0, i + 1);
      const currentBar = bars[i];
      
      // Check if we're in a position
      if (this.currentPosition) {
        this._checkExits(currentBar, i);
      } else {
        this._checkEntry(historicalBars, currentBar, i);
      }
      
      // Update drawdown tracking
      if (this.balance > this.peakBalance) {
        this.peakBalance = this.balance;
      }
      const currentDrawdown = ((this.peakBalance - this.balance) / this.peakBalance) * 100;
      if (currentDrawdown > this.maxDrawdown) {
        this.maxDrawdown = currentDrawdown;
      }
    }

    // Close any open position at end
    if (this.currentPosition) {
      const lastBar = bars[bars.length - 1];
      this._closePosition(lastBar.close, 'End of backtest', bars.length - 1);
    }

    return this._generateReport(bars);
  }

  /**
   * Check for entry signals
   */
  _checkEntry(bars, currentBar, barIndex) {
    // Check session filter
    if (!this._isWithinTradingHours(currentBar.timestamp)) {
      return;
    }

    // Check cooldown
    if (barIndex - this.lastSignalBar < this.config.signalCooldownBars) {
      return;
    }

    // Calculate indicators
    const atr = this._calculateATR(bars);
    const ema = this._calculateEMA(bars, this.config.trendEMAPeriod);
    const rsi = this._calculateRSI(bars);
    const avgVolume = this._calculateAvgVolume(bars);
    const { high: breakoutHigh, low: breakoutLow } = this._findRecentHighLow(bars);

    if (!atr || !breakoutHigh || !breakoutLow) return;

    const currentPrice = currentBar.close;
    const currentVolume = currentBar.volume || 0;

    // Check for breakout
    let signalType = null;
    if (currentPrice > breakoutHigh) {
      signalType = 'buy';
    } else if (currentPrice < breakoutLow) {
      signalType = 'sell';
    }

    if (!signalType) return;

    // Apply filters
    if (!this._passesFilters(signalType, currentPrice, ema, rsi, currentVolume, avgVolume)) {
      return;
    }

    // Calculate stop loss
    let stopLoss;
    if (signalType === 'buy') {
      stopLoss = currentPrice - (atr * this.config.atrMultiplier);
    } else {
      stopLoss = currentPrice + (atr * this.config.atrMultiplier);
    }

    // Calculate position size
    const position = this._calculatePositionSize(currentPrice, stopLoss);
    if (!position) return;

    // Open position
    this.currentPosition = {
      side: signalType === 'buy' ? 'Buy' : 'Sell',
      entryPrice: currentPrice,
      entryBar: barIndex,
      entryTime: currentBar.timestamp,
      stopLoss,
      target: position.targetPrice,
      contracts: position.contracts,
      risk: position.totalRisk,
      atr,
      rsi,
      ema,
      volumeRatio: avgVolume > 0 ? currentVolume / avgVolume : 0,
      breakoutLevel: signalType === 'buy' ? breakoutHigh : breakoutLow
    };

    this.lastSignalBar = barIndex;
  }

  /**
   * Check for exit conditions
   */
  _checkExits(currentBar, barIndex) {
    const pos = this.currentPosition;
    const isLong = pos.side === 'Buy';

    // Check stop loss
    if (isLong && currentBar.low <= pos.stopLoss) {
      this._closePosition(pos.stopLoss, 'Stop Loss', barIndex, currentBar.timestamp);
      return;
    }
    if (!isLong && currentBar.high >= pos.stopLoss) {
      this._closePosition(pos.stopLoss, 'Stop Loss', barIndex, currentBar.timestamp);
      return;
    }

    // Check take profit
    if (isLong && currentBar.high >= pos.target) {
      this._closePosition(pos.target, 'Take Profit', barIndex, currentBar.timestamp);
      return;
    }
    if (!isLong && currentBar.low <= pos.target) {
      this._closePosition(pos.target, 'Take Profit', barIndex, currentBar.timestamp);
      return;
    }
  }

  /**
   * Close current position
   */
  _closePosition(exitPrice, reason, barIndex, exitTime = null) {
    const pos = this.currentPosition;
    const isLong = pos.side === 'Buy';

    // Calculate P&L in points
    const pointsPnL = isLong 
      ? exitPrice - pos.entryPrice 
      : pos.entryPrice - exitPrice;

    // Calculate dollar P&L
    const ticksPnL = pointsPnL / this.contractSpecs.tickSize;
    const dollarPnL = ticksPnL * this.contractSpecs.tickValue * pos.contracts;

    // Calculate R multiple
    const rMultiple = pos.risk > 0 ? dollarPnL / pos.risk : 0;

    // Update balance
    this.balance += dollarPnL;

    // Record trade
    this.trades.push({
      id: this.trades.length + 1,
      side: pos.side,
      entryPrice: pos.entryPrice,
      entryTime: pos.entryTime,
      entryBar: pos.entryBar,
      exitPrice,
      exitTime,
      exitBar: barIndex,
      exitReason: reason,
      contracts: pos.contracts,
      stopLoss: pos.stopLoss,
      target: pos.target,
      risk: pos.risk,
      pnl: dollarPnL,
      rMultiple,
      balanceAfter: this.balance,
      barsHeld: barIndex - pos.entryBar,
      // Entry conditions
      atr: pos.atr,
      rsi: pos.rsi,
      ema: pos.ema,
      volumeRatio: pos.volumeRatio,
      breakoutLevel: pos.breakoutLevel
    });

    this.currentPosition = null;
  }

  /**
   * Check if filters pass
   */
  _passesFilters(signalType, price, ema, rsi, currentVolume, avgVolume) {
    // Trend filter
    if (this.config.useTrendFilter && ema) {
      if (signalType === 'buy' && price <= ema) return false;
      if (signalType === 'sell' && price >= ema) return false;
    }

    // RSI filter
    if (this.config.useRSIFilter && rsi !== null) {
      if (signalType === 'buy') {
        if (rsi >= this.config.rsiOverbought) return false;
        if (rsi < this.config.rsiNeutralLow) return false;
      } else {
        if (rsi <= this.config.rsiOversold) return false;
        if (rsi > this.config.rsiNeutralHigh) return false;
      }
    }

    // Volume filter
    if (this.config.useVolumeFilter && avgVolume > 0) {
      const volumeRatio = currentVolume / avgVolume;
      if (volumeRatio < this.config.volumeSpikeMultiplier) return false;
    }

    return true;
  }

  /**
   * Check if within trading hours
   */
  _isWithinTradingHours(timestamp) {
    if (!timestamp) return true;
    
    const date = new Date(timestamp);
    const hour = date.getHours();
    const minute = date.getMinutes();
    const dayOfWeek = date.getDay();

    // Skip weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) return false;

    const currentMinutes = hour * 60 + minute;
    const startMinutes = this.config.tradingStartHour * 60 + this.config.tradingStartMinute;
    const endMinutes = this.config.tradingEndHour * 60 + this.config.tradingEndMinute;

    // Check trading hours
    if (currentMinutes < startMinutes || currentMinutes >= endMinutes) return false;

    // Check lunch hour
    if (this.config.avoidLunch) {
      const lunchStart = this.config.lunchStartHour * 60;
      const lunchEnd = this.config.lunchEndHour * 60;
      if (currentMinutes >= lunchStart && currentMinutes < lunchEnd) return false;
    }

    return true;
  }

  /**
   * Calculate position size
   */
  _calculatePositionSize(entryPrice, stopPrice) {
    const priceRisk = Math.abs(entryPrice - stopPrice);
    const ticksRisk = priceRisk / this.contractSpecs.tickSize;
    const dollarRiskPerContract = ticksRisk * this.contractSpecs.tickValue;

    const targetRisk = (this.config.riskPerTrade.min + this.config.riskPerTrade.max) / 2;
    const contracts = Math.max(1, Math.floor(targetRisk / dollarRiskPerContract));
    const actualRisk = contracts * dollarRiskPerContract;

    // Validate risk bounds
    if (actualRisk > this.config.riskPerTrade.max * 1.5) {
      return null; // Risk too high
    }

    // Calculate target
    const targetDistance = priceRisk * this.config.profitTargetR;
    const targetPrice = entryPrice > stopPrice 
      ? entryPrice + targetDistance 
      : entryPrice - targetDistance;

    return {
      contracts,
      totalRisk: actualRisk,
      targetPrice,
      riskPerContract: dollarRiskPerContract
    };
  }

  /**
   * Calculate ATR
   */
  _calculateATR(bars) {
    const period = this.config.atrPeriod;
    if (bars.length < period + 1) return null;

    const trueRanges = [];
    for (let i = 1; i < bars.length; i++) {
      const high = bars[i].high;
      const low = bars[i].low;
      const prevClose = bars[i - 1].close;

      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }

    const recentTR = trueRanges.slice(-period);
    return recentTR.reduce((a, b) => a + b, 0) / recentTR.length;
  }

  /**
   * Calculate EMA
   */
  _calculateEMA(bars, period) {
    if (bars.length < period) return null;

    const closes = bars.map(b => b.close);
    const multiplier = 2 / (period + 1);

    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < closes.length; i++) {
      ema = (closes[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * Calculate RSI
   */
  _calculateRSI(bars) {
    const period = this.config.rsiPeriod;
    if (bars.length < period + 1) return null;

    const closes = bars.map(b => b.close);
    const changes = [];

    for (let i = 1; i < closes.length; i++) {
      changes.push(closes[i] - closes[i - 1]);
    }

    const recentChanges = changes.slice(-period);

    let gains = 0;
    let losses = 0;

    for (const change of recentChanges) {
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Calculate average volume
   */
  _calculateAvgVolume(bars) {
    const period = this.config.volumeAvgPeriod;
    if (bars.length < period) return null;

    const volumes = bars.slice(-period - 1, -1).map(b => b.volume || 0);
    return volumes.reduce((a, b) => a + b, 0) / volumes.length;
  }

  /**
   * Find recent high/low for breakout
   */
  _findRecentHighLow(bars) {
    const period = this.config.lookbackPeriod;
    if (bars.length < period + 1) return { high: null, low: null };

    const recentBars = bars.slice(-period - 1, -1);
    const high = Math.max(...recentBars.map(b => b.high));
    const low = Math.min(...recentBars.map(b => b.low));

    return { high, low };
  }

  /**
   * Generate backtest report
   */
  _generateReport(bars) {
    const wins = this.trades.filter(t => t.pnl > 0);
    const losses = this.trades.filter(t => t.pnl < 0);
    const breakeven = this.trades.filter(t => t.pnl === 0);

    const totalPnL = this.trades.reduce((sum, t) => sum + t.pnl, 0);
    const winRate = this.trades.length > 0 ? (wins.length / this.trades.length) * 100 : 0;

    const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((sum, t) => sum + t.pnl, 0) / losses.length : 0;
    const avgRMultiple = this.trades.length > 0 
      ? this.trades.reduce((sum, t) => sum + t.rMultiple, 0) / this.trades.length 
      : 0;

    const profitFactor = Math.abs(avgLoss) > 0 
      ? (wins.reduce((sum, t) => sum + t.pnl, 0)) / Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0))
      : wins.length > 0 ? Infinity : 0;

    const avgBarsHeld = this.trades.length > 0
      ? this.trades.reduce((sum, t) => sum + t.barsHeld, 0) / this.trades.length
      : 0;

    // Calculate consecutive wins/losses
    let maxConsecutiveWins = 0;
    let maxConsecutiveLosses = 0;
    let currentStreak = 0;
    let lastWasWin = null;

    for (const trade of this.trades) {
      const isWin = trade.pnl > 0;
      if (lastWasWin === isWin) {
        currentStreak++;
      } else {
        currentStreak = 1;
        lastWasWin = isWin;
      }
      if (isWin && currentStreak > maxConsecutiveWins) {
        maxConsecutiveWins = currentStreak;
      }
      if (!isWin && currentStreak > maxConsecutiveLosses) {
        maxConsecutiveLosses = currentStreak;
      }
    }

    // Date range
    const startDate = bars[0]?.timestamp ? new Date(bars[0].timestamp).toISOString().split('T')[0] : 'N/A';
    const endDate = bars[bars.length - 1]?.timestamp 
      ? new Date(bars[bars.length - 1].timestamp).toISOString().split('T')[0] 
      : 'N/A';

    return {
      summary: {
        startingBalance: this.config.startingBalance,
        endingBalance: this.balance,
        totalPnL,
        returnPercent: ((this.balance - this.config.startingBalance) / this.config.startingBalance) * 100,
        maxDrawdown: this.maxDrawdown,
        peakBalance: this.peakBalance
      },
      trades: {
        total: this.trades.length,
        wins: wins.length,
        losses: losses.length,
        breakeven: breakeven.length,
        winRate,
        avgWin,
        avgLoss,
        avgRMultiple,
        profitFactor,
        avgBarsHeld,
        maxConsecutiveWins,
        maxConsecutiveLosses
      },
      period: {
        startDate,
        endDate,
        totalBars: bars.length
      },
      config: this.config,
      tradeList: this.trades
    };
  }

  /**
   * Format report for console output
   */
  static formatReport(report) {
    let output = `
════════════════════════════════════════════════════════════════
                    BACKTEST RESULTS
════════════════════════════════════════════════════════════════

📅 Period: ${report.period.startDate} to ${report.period.endDate}
   Total bars: ${report.period.totalBars}

💰 ACCOUNT PERFORMANCE
────────────────────────────────────────────────────────────────
   Starting Balance:  $${report.summary.startingBalance.toFixed(2)}
   Ending Balance:    $${report.summary.endingBalance.toFixed(2)}
   Total P&L:         ${report.summary.totalPnL >= 0 ? '+' : ''}$${report.summary.totalPnL.toFixed(2)}
   Return:            ${report.summary.returnPercent >= 0 ? '+' : ''}${report.summary.returnPercent.toFixed(2)}%
   Max Drawdown:      ${report.summary.maxDrawdown.toFixed(2)}%
   Peak Balance:      $${report.summary.peakBalance.toFixed(2)}

📊 TRADE STATISTICS
────────────────────────────────────────────────────────────────
   Total Trades:      ${report.trades.total}
   Wins:              ${report.trades.wins} (${report.trades.winRate.toFixed(1)}%)
   Losses:            ${report.trades.losses}
   Breakeven:         ${report.trades.breakeven}
   
   Avg Win:           +$${report.trades.avgWin.toFixed(2)}
   Avg Loss:          $${report.trades.avgLoss.toFixed(2)}
   Avg R-Multiple:    ${report.trades.avgRMultiple.toFixed(2)}R
   Profit Factor:     ${report.trades.profitFactor === Infinity ? '∞' : report.trades.profitFactor.toFixed(2)}
   
   Avg Bars Held:     ${report.trades.avgBarsHeld.toFixed(1)}
   Max Win Streak:    ${report.trades.maxConsecutiveWins}
   Max Loss Streak:   ${report.trades.maxConsecutiveLosses}

════════════════════════════════════════════════════════════════
`;

    // Add trade list
    if (report.tradeList.length > 0) {
      output += `\n📋 TRADE LIST\n────────────────────────────────────────────────────────────────\n`;
      output += `${'#'.padEnd(4)} ${'Side'.padEnd(5)} ${'Entry'.padEnd(10)} ${'Exit'.padEnd(10)} ${'P&L'.padEnd(12)} ${'R'.padEnd(7)} ${'Reason'.padEnd(12)} Date\n`;
      output += `────────────────────────────────────────────────────────────────\n`;

      for (const trade of report.tradeList) {
        const pnlStr = (trade.pnl >= 0 ? '+' : '') + '$' + trade.pnl.toFixed(2);
        const rStr = (trade.rMultiple >= 0 ? '+' : '') + trade.rMultiple.toFixed(2) + 'R';
        const dateStr = trade.entryTime ? new Date(trade.entryTime).toLocaleDateString() : 'N/A';
        
        output += `${String(trade.id).padEnd(4)} `;
        output += `${trade.side.padEnd(5)} `;
        output += `$${trade.entryPrice.toFixed(2).padEnd(9)} `;
        output += `$${trade.exitPrice.toFixed(2).padEnd(9)} `;
        output += `${pnlStr.padEnd(12)} `;
        output += `${rStr.padEnd(7)} `;
        output += `${trade.exitReason.padEnd(12)} `;
        output += `${dateStr}\n`;
      }
    }

    return output;
  }
}

module.exports = Backtester;
