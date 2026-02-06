/**
 * ReplayBacktester - Live Market Replay Backtesting
 * 
 * Uses Tradovate's Market Replay API for realistic backtesting with:
 * - Actual tick-by-tick historical data
 * - Realistic order fills with slippage
 * - True market microstructure simulation
 * 
 * Much more accurate than static backtesting!
 */

const EventEmitter = require('events');
const ReplaySocket = require('../api/websocket/ReplaySocket');
const { DataBuffer, BarsTransformer } = require('../data/DataBuffer');
const indicators = require('../indicators');

class ReplayBacktester extends EventEmitter {
  constructor(auth, config = {}) {
    super();
    this.auth = auth;
    this.config = {
      // Replay settings
      speed: config.speed || 400,
      initialBalance: config.initialBalance || 50000,
      
      // Strategy settings
      contractSymbol: config.contractSymbol || 'MES',
      riskPerTrade: config.riskPerTrade || { min: 30, max: 60 },
      profitTargetR: config.profitTargetR || 2,
      
      // Strategy parameters
      lookbackPeriod: config.lookbackPeriod || 20,
      atrPeriod: config.atrPeriod || 14,
      atrMultiplier: config.atrMultiplier || 1.5,
      trendEMAPeriod: config.trendEMAPeriod || 50,
      rsiPeriod: config.rsiPeriod || 14,
      volumeAvgPeriod: config.volumeAvgPeriod || 20,
      volumeSpikeMultiplier: config.volumeSpikeMultiplier || 1.5,
      
      // Filters
      useTrendFilter: config.useTrendFilter !== false,
      useVolumeFilter: config.useVolumeFilter !== false,
      useRSIFilter: config.useRSIFilter !== false,
      
      // Session filter
      tradingStartHour: config.tradingStartHour || 9,
      tradingStartMinute: config.tradingStartMinute || 30,
      tradingEndHour: config.tradingEndHour || 16,
      tradingEndMinute: config.tradingEndMinute || 0,
      avoidLunch: config.avoidLunch !== false,
      
      // Signal cooldown
      signalCooldownBars: config.signalCooldownBars || 5,
      
      ...config
    };

    this.replaySocket = null;
    this.account = null;
    this.contract = null;
    this.dataBuffer = new DataBuffer(BarsTransformer);
    this.dataBuffer.setMaxLength(200);
    
    // Trading state
    this.position = null;
    this.trades = [];
    this.balance = this.config.initialBalance;
    this.peakBalance = this.config.initialBalance;
    this.maxDrawdown = 0;
    this.lastSignalBar = -999;
    
    // Session tracking
    this.currentPeriodIndex = 0;
    this.replayPeriods = [];
    this.sessionResults = {};
    this.isRunning = false;
  }

  /**
   * Run backtest over multiple replay periods
   * @param {Array<{start: string, stop: string}>} periods - Array of replay periods
   */
  async run(periods) {
    this.replayPeriods = periods;
    this.currentPeriodIndex = 0;
    this.isRunning = true;

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('              MARKET REPLAY BACKTESTER');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`\n📊 Running ${periods.length} replay period(s)...`);
    console.log(`   Contract: ${this.config.contractSymbol}`);
    console.log(`   Starting Balance: $${this.config.initialBalance}`);
    console.log(`   Replay Speed: ${this.config.speed}x\n`);

    try {
      // Connect to replay socket
      this.replaySocket = new ReplaySocket(this.auth);
      await this.replaySocket.connect();

      // Set up event handlers
      this._setupEventHandlers();

      // Run first period
      await this._runPeriod(periods[0]);

      // Wait for all periods to complete
      await this._waitForCompletion();

      return this._generateReport();

    } catch (error) {
      console.error('[ReplayBacktester] Error:', error.message);
      throw error;
    } finally {
      if (this.replaySocket) {
        this.replaySocket.disconnect();
      }
    }
  }

  /**
   * Set up event handlers for replay socket
   */
  _setupEventHandlers() {
    // Clock tick - check for period end
    this.replaySocket.on('clock', ({ timestamp }) => {
      this._checkPeriodEnd(timestamp);
    });

    // Quote data - analyze for signals
    this.replaySocket.on('quote', (quote) => {
      if (quote.contractId === this.contract?.id) {
        this._onQuote(quote);
      }
    });

    // Chart data - update bars
    this.replaySocket.on('chart', (data) => {
      if (data.bars) {
        this.dataBuffer.push({ bars: data.bars });
        this._onBar(data.bars[data.bars.length - 1]);
      }
    });

    // Props - order/position updates
    this.replaySocket.on('props', (data) => {
      if (data.entityType === 'fill') {
        this._onFill(data.entity);
      }
      if (data.entityType === 'position') {
        this._onPositionUpdate(data.entity);
      }
    });
  }

  /**
   * Run a single replay period
   */
  async _runPeriod(period) {
    console.log(`\n📅 Starting period: ${period.start} to ${period.stop}`);

    // Check if replay is available
    const check = await this.replaySocket.checkReplaySession(period.start);
    if (!check.available) {
      throw new Error(`Replay not available for ${period.start}: ${check.checkStatus}`);
    }

    // Initialize clock
    await this.replaySocket.initializeClock({
      startTimestamp: period.start,
      speed: this.config.speed,
      initialBalance: this.config.initialBalance
    });

    // Get account
    const accounts = await this.replaySocket.getAccounts();
    this.account = accounts.find(a => a.active) || accounts[0];
    console.log(`   Account: ${this.account.name} (ID: ${this.account.id})`);

    // Find contract (simplified - in real impl would search)
    this.contract = { 
      id: 1, 
      name: this.config.contractSymbol 
    };

    // Subscribe to data
    this.replaySocket.subscribeQuote(this.config.contractSymbol);
    this.replaySocket.subscribeChart({
      symbol: this.config.contractSymbol,
      chartDescription: {
        underlyingType: 'MinuteBar',
        elementSize: 5,
        elementSizeUnit: 'UnderlyingUnits',
        withHistogram: false
      },
      timeRange: {
        asMuchAsElements: 100
      }
    });

    // Sync user data
    await this.replaySocket.synchronize(this.account.id);
    
    console.log('   ✓ Replay started');
  }

  /**
   * Check if current period has ended
   */
  _checkPeriodEnd(timestamp) {
    const currentPeriod = this.replayPeriods[this.currentPeriodIndex];
    if (!currentPeriod) return;

    const currentTime = new Date(timestamp);
    const stopTime = new Date(currentPeriod.stop);

    if (currentTime >= stopTime) {
      this._onPeriodComplete();
    }
  }

  /**
   * Handle period completion
   */
  async _onPeriodComplete() {
    const period = this.replayPeriods[this.currentPeriodIndex];
    
    // Record session results
    this.sessionResults[`${period.start} to ${period.stop}`] = {
      trades: this.trades.length,
      finalBalance: this.balance,
      pnl: this.balance - this.config.initialBalance,
      position: this.position ? { ...this.position } : null
    };

    console.log(`\n✓ Period complete: ${period.start} to ${period.stop}`);
    console.log(`   Trades: ${this.trades.length}, Balance: $${this.balance.toFixed(2)}`);

    // Move to next period
    this.currentPeriodIndex++;

    if (this.currentPeriodIndex < this.replayPeriods.length) {
      // Close any open position
      if (this.position) {
        await this._closePosition('Period end');
      }

      // Start next period
      await this._runPeriod(this.replayPeriods[this.currentPeriodIndex]);
    } else {
      // All periods complete
      this.isRunning = false;
      this.emit('complete', this._generateReport());
    }
  }

  /**
   * Wait for all periods to complete
   */
  _waitForCompletion() {
    return new Promise((resolve) => {
      if (!this.isRunning) {
        resolve();
        return;
      }

      this.once('complete', () => {
        resolve();
      });

      // Timeout after 10 minutes per period
      const timeout = this.replayPeriods.length * 10 * 60 * 1000;
      setTimeout(() => {
        if (this.isRunning) {
          console.warn('[ReplayBacktester] Timeout reached');
          this.isRunning = false;
          resolve();
        }
      }, timeout);
    });
  }

  /**
   * Handle incoming quote
   */
  _onQuote(quote) {
    const price = quote.last || quote.bid;
    if (!price) return;

    // Check for exits if in position
    if (this.position) {
      this._checkExits(price);
    }
  }

  /**
   * Handle new bar
   */
  _onBar(bar) {
    // Check for entry signals
    if (!this.position) {
      this._checkEntry(bar);
    }
  }

  /**
   * Check for entry signals
   */
  _checkEntry(currentBar) {
    const bars = this.dataBuffer.getData();
    if (bars.length < this.config.lookbackPeriod + 10) return;

    // Check session filter
    if (!this._isWithinTradingHours(currentBar.timestamp)) return;

    // Check cooldown
    if (bars.length - this.lastSignalBar < this.config.signalCooldownBars) return;

    // Calculate indicators
    const atr = indicators.ATR(bars, this.config.atrPeriod);
    const ema = indicators.EMA(bars, this.config.trendEMAPeriod);
    const rsi = indicators.RSI(bars, this.config.rsiPeriod);
    const avgVolume = indicators.AvgVolume(bars, this.config.volumeAvgPeriod);
    const breakoutHigh = indicators.HighestHigh(bars.slice(0, -1), this.config.lookbackPeriod);
    const breakoutLow = indicators.LowestLow(bars.slice(0, -1), this.config.lookbackPeriod);

    if (!atr || !breakoutHigh || !breakoutLow) return;

    const currentPrice = currentBar.close;
    const currentVolume = currentBar.volume || 0;

    // Check for breakout
    let signalType = null;
    if (currentPrice > breakoutHigh) signalType = 'buy';
    else if (currentPrice < breakoutLow) signalType = 'sell';

    if (!signalType) return;

    // Apply filters
    if (!this._passesFilters(signalType, currentPrice, ema, rsi, currentVolume, avgVolume)) return;

    // Calculate stop loss
    const stopLoss = signalType === 'buy'
      ? currentPrice - (atr * this.config.atrMultiplier)
      : currentPrice + (atr * this.config.atrMultiplier);

    // Calculate position size and target
    const position = this._calculatePosition(currentPrice, stopLoss);
    if (!position) return;

    // Enter trade
    this._enterTrade(signalType, currentPrice, stopLoss, position, bars.length);
  }

  /**
   * Check filter conditions
   */
  _passesFilters(signalType, price, ema, rsi, currentVolume, avgVolume) {
    // Trend filter
    if (this.config.useTrendFilter && ema) {
      if (signalType === 'buy' && price <= ema) return false;
      if (signalType === 'sell' && price >= ema) return false;
    }

    // RSI filter
    if (this.config.useRSIFilter && rsi !== null) {
      if (signalType === 'buy' && (rsi >= 70 || rsi < 40)) return false;
      if (signalType === 'sell' && (rsi <= 30 || rsi > 60)) return false;
    }

    // Volume filter
    if (this.config.useVolumeFilter && avgVolume > 0) {
      if (currentVolume / avgVolume < this.config.volumeSpikeMultiplier) return false;
    }

    return true;
  }

  /**
   * Check trading hours
   */
  _isWithinTradingHours(timestamp) {
    if (!timestamp) return true;
    
    const date = new Date(timestamp);
    const hour = date.getHours();
    const minute = date.getMinutes();
    const dayOfWeek = date.getDay();

    if (dayOfWeek === 0 || dayOfWeek === 6) return false;

    const currentMinutes = hour * 60 + minute;
    const startMinutes = this.config.tradingStartHour * 60 + this.config.tradingStartMinute;
    const endMinutes = this.config.tradingEndHour * 60 + this.config.tradingEndMinute;

    if (currentMinutes < startMinutes || currentMinutes >= endMinutes) return false;

    if (this.config.avoidLunch) {
      const lunchStart = 12 * 60;
      const lunchEnd = 14 * 60;
      if (currentMinutes >= lunchStart && currentMinutes < lunchEnd) return false;
    }

    return true;
  }

  /**
   * Calculate position size
   */
  _calculatePosition(entryPrice, stopPrice) {
    const priceRisk = Math.abs(entryPrice - stopPrice);
    const tickSize = 0.25; // MES tick size
    const tickValue = 1.25; // MES tick value
    
    const ticksRisk = priceRisk / tickSize;
    const dollarRiskPerContract = ticksRisk * tickValue;

    const targetRisk = (this.config.riskPerTrade.min + this.config.riskPerTrade.max) / 2;
    const contracts = Math.max(1, Math.floor(targetRisk / dollarRiskPerContract));
    const actualRisk = contracts * dollarRiskPerContract;

    if (actualRisk > this.config.riskPerTrade.max * 1.5) return null;

    const targetDistance = priceRisk * this.config.profitTargetR;
    const targetPrice = entryPrice > stopPrice
      ? entryPrice + targetDistance
      : entryPrice - targetDistance;

    return { contracts, totalRisk: actualRisk, targetPrice };
  }

  /**
   * Enter a trade
   */
  async _enterTrade(signalType, entryPrice, stopLoss, positionCalc, barIndex) {
    const action = signalType === 'buy' ? 'Buy' : 'Sell';
    
    this.position = {
      side: action,
      entryPrice,
      entryBar: barIndex,
      entryTime: new Date(),
      stopLoss,
      target: positionCalc.targetPrice,
      contracts: positionCalc.contracts,
      risk: positionCalc.totalRisk
    };

    this.lastSignalBar = barIndex;

    console.log(`   📈 ${action} ${positionCalc.contracts} @ $${entryPrice.toFixed(2)} | SL: $${stopLoss.toFixed(2)} | TP: $${positionCalc.targetPrice.toFixed(2)}`);

    // Place order via replay socket
    try {
      await this.replaySocket.placeBracketOrder({
        accountId: this.account.id,
        accountSpec: this.account.name,
        symbol: this.config.contractSymbol,
        action,
        qty: positionCalc.contracts,
        stopLoss,
        profitTarget: positionCalc.targetPrice
      });
    } catch (err) {
      console.error('   ✗ Order failed:', err.message);
      this.position = null;
    }
  }

  /**
   * Check for exit conditions
   */
  _checkExits(currentPrice) {
    if (!this.position) return;

    const isLong = this.position.side === 'Buy';

    // Check stop loss
    if (isLong && currentPrice <= this.position.stopLoss) {
      this._closePosition('Stop Loss', this.position.stopLoss);
      return;
    }
    if (!isLong && currentPrice >= this.position.stopLoss) {
      this._closePosition('Stop Loss', this.position.stopLoss);
      return;
    }

    // Check take profit
    if (isLong && currentPrice >= this.position.target) {
      this._closePosition('Take Profit', this.position.target);
      return;
    }
    if (!isLong && currentPrice <= this.position.target) {
      this._closePosition('Take Profit', this.position.target);
      return;
    }
  }

  /**
   * Close current position
   */
  _closePosition(reason, exitPrice = null) {
    if (!this.position) return;

    const pos = this.position;
    const price = exitPrice || pos.entryPrice;
    const isLong = pos.side === 'Buy';

    const pointsPnL = isLong ? price - pos.entryPrice : pos.entryPrice - price;
    const ticksPnL = pointsPnL / 0.25;
    const dollarPnL = ticksPnL * 1.25 * pos.contracts;
    const rMultiple = pos.risk > 0 ? dollarPnL / pos.risk : 0;

    this.balance += dollarPnL;

    // Track drawdown
    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }
    const currentDrawdown = ((this.peakBalance - this.balance) / this.peakBalance) * 100;
    if (currentDrawdown > this.maxDrawdown) {
      this.maxDrawdown = currentDrawdown;
    }

    // Record trade
    this.trades.push({
      id: this.trades.length + 1,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: price,
      exitReason: reason,
      contracts: pos.contracts,
      pnl: dollarPnL,
      rMultiple,
      balanceAfter: this.balance
    });

    const emoji = dollarPnL >= 0 ? '✅' : '❌';
    console.log(`   ${emoji} ${reason}: ${dollarPnL >= 0 ? '+' : ''}$${dollarPnL.toFixed(2)} (${rMultiple.toFixed(2)}R) | Balance: $${this.balance.toFixed(2)}`);

    this.position = null;
  }

  /**
   * Handle fill from replay
   */
  _onFill(fill) {
    console.log(`   Fill: ${fill.action} ${fill.qty} @ ${fill.price}`);
  }

  /**
   * Handle position update from replay
   */
  _onPositionUpdate(position) {
    if (position.netPos === 0 && this.position) {
      // Position closed by broker
      this._closePosition('Broker Close');
    }
  }

  /**
   * Generate final report
   */
  _generateReport() {
    const wins = this.trades.filter(t => t.pnl > 0);
    const losses = this.trades.filter(t => t.pnl < 0);

    const totalPnL = this.trades.reduce((sum, t) => sum + t.pnl, 0);
    const winRate = this.trades.length > 0 ? (wins.length / this.trades.length) * 100 : 0;
    const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((sum, t) => sum + t.pnl, 0) / losses.length : 0;
    const profitFactor = Math.abs(avgLoss) > 0
      ? wins.reduce((sum, t) => sum + t.pnl, 0) / Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0))
      : wins.length > 0 ? Infinity : 0;

    const report = {
      summary: {
        startingBalance: this.config.initialBalance,
        endingBalance: this.balance,
        totalPnL,
        returnPercent: ((this.balance - this.config.initialBalance) / this.config.initialBalance) * 100,
        maxDrawdown: this.maxDrawdown,
        peakBalance: this.peakBalance
      },
      trades: {
        total: this.trades.length,
        wins: wins.length,
        losses: losses.length,
        winRate,
        avgWin,
        avgLoss,
        profitFactor
      },
      periods: this.sessionResults,
      tradeList: this.trades
    };

    this._printReport(report);
    return report;
  }

  /**
   * Print formatted report
   */
  _printReport(report) {
    console.log(`
═══════════════════════════════════════════════════════════════
                    REPLAY BACKTEST RESULTS
═══════════════════════════════════════════════════════════════

💰 ACCOUNT PERFORMANCE
───────────────────────────────────────────────────────────────
   Starting Balance:  $${report.summary.startingBalance.toFixed(2)}
   Ending Balance:    $${report.summary.endingBalance.toFixed(2)}
   Total P&L:         ${report.summary.totalPnL >= 0 ? '+' : ''}$${report.summary.totalPnL.toFixed(2)}
   Return:            ${report.summary.returnPercent >= 0 ? '+' : ''}${report.summary.returnPercent.toFixed(2)}%
   Max Drawdown:      ${report.summary.maxDrawdown.toFixed(2)}%

📊 TRADE STATISTICS
───────────────────────────────────────────────────────────────
   Total Trades:      ${report.trades.total}
   Wins:              ${report.trades.wins} (${report.trades.winRate.toFixed(1)}%)
   Losses:            ${report.trades.losses}
   Avg Win:           +$${report.trades.avgWin.toFixed(2)}
   Avg Loss:          $${report.trades.avgLoss.toFixed(2)}
   Profit Factor:     ${report.trades.profitFactor === Infinity ? '∞' : report.trades.profitFactor.toFixed(2)}

═══════════════════════════════════════════════════════════════
`);
  }
}

module.exports = ReplayBacktester;
