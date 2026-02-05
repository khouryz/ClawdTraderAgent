/**
 * Enhanced Breakout Strategy
 * Advanced breakout strategy with trend filter, volume confirmation, RSI, and session awareness
 */

const BaseStrategy = require('./base');

class EnhancedBreakoutStrategy extends BaseStrategy {
  constructor(config) {
    super('EnhancedBreakout', config);
    
    // Breakout parameters
    this.lookbackPeriod = config.lookbackPeriod || 20;
    this.atrMultiplier = config.atrMultiplier || 1.5;
    this.atrPeriod = config.atrPeriod || 14;
    
    // Trend filter parameters
    this.trendEMAPeriod = config.trendEMAPeriod || 50;
    this.useTrendFilter = config.useTrendFilter !== false;
    
    // Volume filter parameters
    this.useVolumeFilter = config.useVolumeFilter !== false;
    this.volumeSpikeMult = config.volumeSpikeMultiplier || 1.5;
    this.volumeAvgPeriod = config.volumeAvgPeriod || 20;
    
    // RSI filter parameters
    this.useRSIFilter = config.useRSIFilter !== false;
    this.rsiPeriod = config.rsiPeriod || 14;
    this.rsiOverbought = config.rsiOverbought || 70;
    this.rsiOversold = config.rsiOversold || 30;
    this.rsiNeutralHigh = config.rsiNeutralHigh || 60;
    this.rsiNeutralLow = config.rsiNeutralLow || 40;
    
    // Breakout confirmation
    this.requireCloseAbove = config.requireCloseAbove || false;
    this.breakoutBuffer = config.breakoutBuffer || 0;  // Points above/below level
    
    // Signal cooldown (prevent rapid signals)
    this.signalCooldownBars = config.signalCooldownBars || 5;
    this.lastSignalBar = -999;
    
    // State
    this.lastHigh = null;
    this.lastLow = null;
    this.atr = null;
    this.ema = null;
    this.rsi = null;
    this.avgVolume = null;
    this.currentVolume = null;
    
    // Session filter reference (injected)
    this.sessionFilter = config.sessionFilter || null;
  }

  /**
   * Calculate Exponential Moving Average
   */
  calculateEMA(period) {
    if (this.bars.length < period) return null;
    
    const closes = this.bars.map(b => b.close);
    const multiplier = 2 / (period + 1);
    
    // Start with SMA for first EMA value
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    
    // Calculate EMA for remaining values
    for (let i = period; i < closes.length; i++) {
      ema = (closes[i] - ema) * multiplier + ema;
    }
    
    return ema;
  }

  /**
   * Calculate Average True Range (ATR)
   */
  calculateATR(period = null) {
    const p = period || this.atrPeriod;
    if (this.bars.length < p + 1) return null;

    const trueRanges = [];
    for (let i = 1; i < this.bars.length; i++) {
      const high = this.bars[i].high;
      const low = this.bars[i].low;
      const prevClose = this.bars[i - 1].close;

      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }

    const recentTR = trueRanges.slice(-p);
    return recentTR.reduce((a, b) => a + b, 0) / recentTR.length;
  }

  /**
   * Calculate RSI (Relative Strength Index)
   */
  calculateRSI(period = null) {
    const p = period || this.rsiPeriod;
    if (this.bars.length < p + 1) return null;

    const closes = this.bars.map(b => b.close);
    const changes = [];
    
    for (let i = 1; i < closes.length; i++) {
      changes.push(closes[i] - closes[i - 1]);
    }

    const recentChanges = changes.slice(-p);
    
    let gains = 0;
    let losses = 0;
    
    for (const change of recentChanges) {
      if (change > 0) {
        gains += change;
      } else {
        losses += Math.abs(change);
      }
    }

    const avgGain = gains / p;
    const avgLoss = losses / p;

    if (avgLoss === 0) return 100;
    
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Calculate average volume
   */
  calculateAvgVolume(period = null) {
    const p = period || this.volumeAvgPeriod;
    if (this.bars.length < p) return null;

    const volumes = this.bars.slice(-p).map(b => b.volume || 0);
    return volumes.reduce((a, b) => a + b, 0) / volumes.length;
  }

  /**
   * Find recent high/low for breakout levels
   */
  findRecentHighLow() {
    if (this.bars.length < this.lookbackPeriod) {
      return { high: null, low: null };
    }

    // Use bars before the current one (exclude current bar)
    const recentBars = this.bars.slice(-this.lookbackPeriod - 1, -1);
    const high = Math.max(...recentBars.map(b => b.high));
    const low = Math.min(...recentBars.map(b => b.low));

    return { high, low };
  }

  /**
   * Check trend filter
   */
  checkTrendFilter(price, signalType) {
    if (!this.useTrendFilter) {
      return { passed: true, reason: 'Trend filter disabled' };
    }

    this.ema = this.calculateEMA(this.trendEMAPeriod);
    if (!this.ema) {
      return { passed: false, reason: 'Insufficient data for EMA' };
    }

    if (signalType === 'buy') {
      if (price > this.ema) {
        return { passed: true, reason: `Price above ${this.trendEMAPeriod} EMA` };
      } else {
        return { passed: false, reason: `Price below ${this.trendEMAPeriod} EMA - no longs` };
      }
    } else {
      if (price < this.ema) {
        return { passed: true, reason: `Price below ${this.trendEMAPeriod} EMA` };
      } else {
        return { passed: false, reason: `Price above ${this.trendEMAPeriod} EMA - no shorts` };
      }
    }
  }

  /**
   * Check volume filter
   */
  checkVolumeFilter() {
    if (!this.useVolumeFilter) {
      return { passed: true, reason: 'Volume filter disabled' };
    }

    this.avgVolume = this.calculateAvgVolume();
    if (!this.avgVolume) {
      return { passed: false, reason: 'Insufficient data for volume average' };
    }

    const currentBar = this.bars[this.bars.length - 1];
    this.currentVolume = currentBar.volume || 0;

    const volumeRatio = this.currentVolume / this.avgVolume;
    
    if (volumeRatio >= this.volumeSpikeMult) {
      return { 
        passed: true, 
        reason: `Volume spike: ${volumeRatio.toFixed(2)}x average`,
        volumeRatio 
      };
    } else {
      return { 
        passed: false, 
        reason: `Volume too low: ${volumeRatio.toFixed(2)}x (need ${this.volumeSpikeMult}x)`,
        volumeRatio 
      };
    }
  }

  /**
   * Check RSI filter
   */
  checkRSIFilter(signalType) {
    if (!this.useRSIFilter) {
      return { passed: true, reason: 'RSI filter disabled' };
    }

    this.rsi = this.calculateRSI();
    if (!this.rsi) {
      return { passed: false, reason: 'Insufficient data for RSI' };
    }

    if (signalType === 'buy') {
      // For longs, RSI should not be overbought and ideally above neutral
      if (this.rsi >= this.rsiOverbought) {
        return { passed: false, reason: `RSI overbought: ${this.rsi.toFixed(1)}`, rsi: this.rsi };
      }
      if (this.rsi >= this.rsiNeutralLow) {
        return { passed: true, reason: `RSI bullish: ${this.rsi.toFixed(1)}`, rsi: this.rsi };
      }
      // RSI below neutral - weak momentum
      return { passed: false, reason: `RSI weak for long: ${this.rsi.toFixed(1)}`, rsi: this.rsi };
    } else {
      // For shorts, RSI should not be oversold and ideally below neutral
      if (this.rsi <= this.rsiOversold) {
        return { passed: false, reason: `RSI oversold: ${this.rsi.toFixed(1)}`, rsi: this.rsi };
      }
      if (this.rsi <= this.rsiNeutralHigh) {
        return { passed: true, reason: `RSI bearish: ${this.rsi.toFixed(1)}`, rsi: this.rsi };
      }
      // RSI above neutral - weak momentum for shorts
      return { passed: false, reason: `RSI weak for short: ${this.rsi.toFixed(1)}`, rsi: this.rsi };
    }
  }

  /**
   * Check session filter
   */
  checkSessionFilter() {
    if (!this.sessionFilter) {
      return { passed: true, reason: 'Session filter not configured' };
    }

    const result = this.sessionFilter.canTrade();
    return {
      passed: result.allowed,
      reason: result.reason || 'Session OK',
      session: result.session
    };
  }

  /**
   * Check signal cooldown
   */
  checkCooldown() {
    const barsSinceLastSignal = this.bars.length - this.lastSignalBar;
    if (barsSinceLastSignal < this.signalCooldownBars) {
      return { 
        passed: false, 
        reason: `Cooldown: ${this.signalCooldownBars - barsSinceLastSignal} bars remaining` 
      };
    }
    return { passed: true, reason: 'Cooldown OK' };
  }

  /**
   * Main analysis logic
   */
  analyze() {
    if (!this.hasEnoughData()) {
      return;
    }

    const currentPrice = this.getCurrentPrice();
    if (!currentPrice) {
      return;
    }

    // Already in a position - don't generate new signals
    if (this.position) {
      return;
    }

    // Calculate ATR for stop placement
    this.atr = this.calculateATR();
    if (!this.atr) {
      return;
    }

    // Find recent high/low
    const { high, low } = this.findRecentHighLow();
    if (!high || !low) {
      return;
    }

    this.lastHigh = high;
    this.lastLow = low;

    // Check for breakout conditions
    const breakoutHigh = high + this.breakoutBuffer;
    const breakoutLow = low - this.breakoutBuffer;

    // Potential BUY signal
    if (currentPrice > breakoutHigh) {
      this.evaluateSignal('buy', currentPrice, breakoutHigh);
    }

    // Potential SELL signal
    if (currentPrice < breakoutLow) {
      this.evaluateSignal('sell', currentPrice, breakoutLow);
    }
  }

  /**
   * Evaluate a potential signal through all filters
   */
  evaluateSignal(signalType, currentPrice, breakoutLevel) {
    const filters = [];

    // 1. Check cooldown
    const cooldownCheck = this.checkCooldown();
    filters.push({ name: 'Cooldown', ...cooldownCheck });
    if (!cooldownCheck.passed) {
      this.logFilterResults(signalType, filters);
      return;
    }

    // 2. Check session filter
    const sessionCheck = this.checkSessionFilter();
    filters.push({ name: 'Session', ...sessionCheck });
    if (!sessionCheck.passed) {
      this.logFilterResults(signalType, filters);
      return;
    }

    // 3. Check trend filter
    const trendCheck = this.checkTrendFilter(currentPrice, signalType);
    filters.push({ name: 'Trend', ...trendCheck });
    if (!trendCheck.passed) {
      this.logFilterResults(signalType, filters);
      return;
    }

    // 4. Check RSI filter
    const rsiCheck = this.checkRSIFilter(signalType);
    filters.push({ name: 'RSI', ...rsiCheck });
    if (!rsiCheck.passed) {
      this.logFilterResults(signalType, filters);
      return;
    }

    // 5. Check volume filter
    const volumeCheck = this.checkVolumeFilter();
    filters.push({ name: 'Volume', ...volumeCheck });
    if (!volumeCheck.passed) {
      this.logFilterResults(signalType, filters);
      return;
    }

    // All filters passed - generate signal
    this.logFilterResults(signalType, filters, true);
    
    // Calculate stop loss
    let stopLoss;
    if (signalType === 'buy') {
      stopLoss = currentPrice - (this.atr * this.atrMultiplier);
    } else {
      stopLoss = currentPrice + (this.atr * this.atrMultiplier);
    }

    // Update last signal bar
    this.lastSignalBar = this.bars.length;

    // Emit signal with filter results for learning system
    if (signalType === 'buy') {
      this.signalBuyWithFilters(currentPrice, stopLoss, filters);
    } else {
      this.signalSellWithFilters(currentPrice, stopLoss, filters);
    }
  }

  /**
   * Generate a buy signal with filter results
   */
  signalBuyWithFilters(price, stopLoss, filterResults) {
    if (!this.isActive || this.position) return;

    console.log(`[Strategy:${this.name}] 🟢 BUY SIGNAL at ${price}`);
    this.emit('signal', {
      type: 'buy',
      price,
      stopLoss,
      timestamp: new Date(),
      filterResults
    });
  }

  /**
   * Generate a sell signal with filter results
   */
  signalSellWithFilters(price, stopLoss, filterResults) {
    if (!this.isActive || this.position) return;

    console.log(`[Strategy:${this.name}] 🔴 SELL SIGNAL at ${price}`);
    this.emit('signal', {
      type: 'sell',
      price,
      stopLoss,
      timestamp: new Date(),
      filterResults
    });
  }

  /**
   * Log filter results
   */
  logFilterResults(signalType, filters, allPassed = false) {
    const symbol = signalType === 'buy' ? '🟢' : '🔴';
    const status = allPassed ? '✅ SIGNAL GENERATED' : '❌ SIGNAL BLOCKED';
    
    console.log(`[Strategy:${this.name}] ${symbol} ${signalType.toUpperCase()} evaluation:`);
    
    for (const filter of filters) {
      const icon = filter.passed ? '✓' : '✗';
      console.log(`  ${icon} ${filter.name}: ${filter.reason}`);
    }
    
    console.log(`  → ${status}`);
  }

  /**
   * Get strategy status for logging
   */
  getStatus() {
    return {
      name: this.name,
      active: this.isActive,
      barsCount: this.bars.length,
      currentPrice: this.getCurrentPrice(),
      recentHigh: this.lastHigh,
      recentLow: this.lastLow,
      atr: this.atr,
      ema: this.ema,
      rsi: this.rsi,
      avgVolume: this.avgVolume,
      position: this.position,
      filters: {
        trendFilter: this.useTrendFilter,
        volumeFilter: this.useVolumeFilter,
        rsiFilter: this.useRSIFilter,
        sessionFilter: !!this.sessionFilter
      }
    };
  }

  /**
   * Format status for logging
   */
  formatStatus() {
    const status = this.getStatus();
    return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 ENHANCED BREAKOUT STATUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Active:         ${status.active ? '✅' : '❌'}
Bars:           ${status.barsCount}
Price:          $${status.currentPrice?.toFixed(2) || 'N/A'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Breakout High:  $${status.recentHigh?.toFixed(2) || 'N/A'}
Breakout Low:   $${status.recentLow?.toFixed(2) || 'N/A'}
ATR:            ${status.atr?.toFixed(2) || 'N/A'}
EMA(${this.trendEMAPeriod}):        $${status.ema?.toFixed(2) || 'N/A'}
RSI(${this.rsiPeriod}):         ${status.rsi?.toFixed(1) || 'N/A'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Filters:
  Trend:        ${status.filters.trendFilter ? '✅' : '❌'}
  Volume:       ${status.filters.volumeFilter ? '✅' : '❌'}
  RSI:          ${status.filters.rsiFilter ? '✅' : '❌'}
  Session:      ${status.filters.sessionFilter ? '✅' : '❌'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `;
  }

  /**
   * Set session filter reference
   */
  setSessionFilter(sessionFilter) {
    this.sessionFilter = sessionFilter;
  }
}

module.exports = EnhancedBreakoutStrategy;
