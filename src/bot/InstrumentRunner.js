/**
 * InstrumentRunner - Per-instrument trading runner
 * 
 * Encapsulates everything needed to trade ONE instrument:
 * - Strategy (ORB or MNQ Momentum V2)
 * - Databento price stream
 * - Signal handler + Position handler
 * - Risk/loss limits, profit manager, trailing stop
 * - Session management (daily reset, EOD close, watchdogs)
 * 
 * Shared resources (injected from MultiInstrumentBot):
 * - Auth, Client, Account, Order WebSocket
 * - Notifications, MarketHours, TradeAnalyzer
 */

const EventEmitter = require('events');
const DatabentoPriceProvider = require('../data/DatabentoPriceProvider');
const RiskManager = require('../risk/manager');
const LossLimitsManager = require('../risk/loss_limits');
const OpeningRangeBreakoutStrategy = require('../strategies/opening_range_breakout');
const LiquidityORBStrategy = require('../strategies/liquidity_orb');
const MNQMomentumStrategyV2 = require('../strategies/mnq_momentum_strategy_v2');
const VWAPEngine = require('../indicators/VWAPEngine');
const SessionFilter = require('../filters/session_filter');
const TrailingStopManager = require('../orders/trailing_stop');
const ProfitManager = require('../orders/profit_manager');
const PerformanceTracker = require('../analytics/performance');
const SignalHandler = require('./SignalHandler');
const PositionHandler = require('./PositionHandler');
const logger = require('../utils/logger');

class InstrumentRunner extends EventEmitter {
  /**
   * @param {Object} instrumentConfig - Per-instrument configuration
   * @param {string} instrumentConfig.symbol - Contract symbol (e.g. 'MESH6', 'M2KH6')
   * @param {string} instrumentConfig.baseSymbol - Base symbol (e.g. 'MES', 'M2K', 'MNQ')
   * @param {string} instrumentConfig.strategy - Strategy name ('opening_range_breakout' or 'mnq_momentum_v2')
   * @param {Object} instrumentConfig.strategyParams - Strategy-specific parameter overrides
   * @param {Object} instrumentConfig.riskParams - Risk parameters (riskPerTrade, dailyLossLimit, etc.)
   * @param {string} instrumentConfig.databentoSymbol - Databento symbol (e.g. 'MES.FUT')
   * @param {Object} shared - Shared resources from MultiInstrumentBot
   * @param {Object} shared.client - TradovateClient
   * @param {Object} shared.account - Tradovate account
   * @param {Object} shared.orderWs - Tradovate order WebSocket
   * @param {Object} shared.notifications - Notifications instance
   * @param {Object} shared.marketHours - MarketHours instance
   * @param {Object} shared.tradeAnalyzer - TradeAnalyzer instance
   * @param {Object} shared.globalConfig - Global config (env, timezone, AI settings, etc.)
   */
  constructor(instrumentConfig, shared) {
    super();
    this.instrumentConfig = instrumentConfig;
    this.shared = shared;
    this.tag = `[${instrumentConfig.baseSymbol}]`;

    // Will be set after contract lookup
    this.contract = null;

    // Per-instrument components (initialized in initialize())
    this.priceProvider = null;
    this.strategy = null;
    this.signalHandler = null;
    this.positionHandler = null;
    this.riskManager = null;
    this.lossLimits = null;
    this.sessionFilter = null;
    this.trailingStop = null;
    this.profitManager = null;
    this.performance = null;
    this.vwapEngine = null;

    // State
    this.isRunning = false;
    this._warmingUp = false;
    this._todayResetDone = false;
    this._orLoggedToday = false;
    this._eodCloseDoneToday = false;
    this._sessionStartLoggedToday = false;
    this._lastSessionBarTs = null;
    this._lastBarReceivedAt = null;
    this._barWatchdogTimer = null;

    // Entry cutoff
    this._lastEntryHourPST = instrumentConfig.lastEntryHour || 11;
    this._lastEntryMinutePST = instrumentConfig.lastEntryMinute || 0;
  }

  /**
   * Initialize all per-instrument components
   * Contract must be resolved before calling this
   */
  async initialize() {
    const { instrumentConfig: ic, shared } = this;
    const gc = shared.globalConfig;
    const sp = ic.strategyParams || {};

    // Resolve contract
    if (ic.autoRollover !== false) {
      this.contract = await shared.client.getFrontMonthContract(ic.baseSymbol);
    } else {
      this.contract = await shared.client.findContract(ic.symbol);
    }
    logger.info(`${this.tag} Contract: ${this.contract.name} (ID: ${this.contract.id})`);

    // Build a merged config for managers that expect the full config shape
    const mergedConfig = this._buildMergedConfig();

    // ── Managers ──
    this.sessionFilter = new SessionFilter(mergedConfig);
    this.riskManager = new RiskManager(mergedConfig);

    this.lossLimits = new LossLimitsManager(mergedConfig);
    this.lossLimits.on('halt', async (data) => {
      logger.error(`${this.tag} 🛑 TRADING HALTED: ${data.message}`);
      if (this.strategy) this.strategy.isActive = false;
      this.emit('halt', { instrument: ic.baseSymbol, message: data.message });
    });

    this.trailingStop = new TrailingStopManager({
      enabled: sp.trailingStopEnabled,
      atrMultiplier: sp.trailingStopATRMultiplier,
    });
    this.trailingStop.setClient(shared.client, shared.account.id);

    // ProfitManager uses different key names — map from strategyParams (single source of truth)
    this.profitManager = new ProfitManager({
      partialProfitEnabled: sp.partialProfitEnabled,
      partialProfitPercent: sp.partialProfitPercent,
      partialProfitR: sp.partialProfitR,
      breakEvenEnabled: sp.moveStopToBE,
      breakEvenTriggerR: sp.beActivationR,
      breakEvenOffset: 1.0,
    });

    this.performance = new PerformanceTracker();

    // ── Strategy ──
    this._initializeStrategy();

    // ── Handlers ──
    this._initializeHandlers(mergedConfig);

    // ── Price Provider ──
    await this._connectPriceProvider();

    // ── Historical Data ──
    await this._loadInitialData(mergedConfig);

    this.isRunning = true;
    logger.success(`${this.tag} ✅ InstrumentRunner initialized and live`);
  }

  /**
   * Build a merged config object that matches what managers expect
   * @private
   */
  _buildMergedConfig() {
    const { instrumentConfig: ic, shared } = this;
    const gc = shared.globalConfig;
    const sp = ic.strategyParams || {};
    const rp = ic.riskParams || {};

    // Merge global config, risk params, and strategy params into one config object.
    // MultiInstrumentBot already parsed .env with correct defaults — just pass through.
    return {
      env: gc.env,
      timezone: gc.timezone || 'America/Los_Angeles',
      contractSymbol: ic.symbol,
      strategy: ic.strategy,
      // Risk (from riskParams)
      riskPerTrade: rp.riskPerTrade || { min: 25, max: 50 },
      dailyLossLimit: rp.dailyLossLimit || 150,
      weeklyLossLimit: rp.weeklyLossLimit || 500,
      maxConsecutiveLosses: rp.maxConsecutiveLosses || 3,
      maxDrawdownPercent: rp.maxDrawdownPercent || 5,
      // Session (from globalConfig)
      tradingStartHour: gc.tradingStartHour || 6,
      tradingStartMinute: gc.tradingStartMinute || 30,
      tradingEndHour: gc.tradingEndHour || 13,
      tradingEndMinute: gc.tradingEndMinute || 0,
      avoidLunch: gc.avoidLunch !== false,
      // AI (from globalConfig)
      aiConfirmationEnabled: gc.aiConfirmationEnabled || false,
      aiProvider: gc.aiProvider || 'anthropic',
      aiApiKey: gc.aiApiKey || '',
      aiModel: gc.aiModel || null,
      aiConfidenceThreshold: gc.aiConfidenceThreshold || 70,
      aiTimeout: gc.aiTimeout || 5000,
      aiDefaultAction: gc.aiDefaultAction || 'confirm',
      // Databento
      databentoApiKey: gc.databentoApiKey || '',
      // Strategy params — pass through directly from MultiInstrumentBot
      ...sp,
    };
  }

  /**
   * Initialize the trading strategy for this instrument
   * @private
   */
  _initializeStrategy() {
    const { instrumentConfig: ic } = this;
    const sp = ic.strategyParams || {};
    const strategyName = (ic.strategy || 'opening_range_breakout').toLowerCase();

    if (strategyName === 'mnq_momentum_v2' || strategyName === 'mnq_momentum') {
      this.vwapEngine = new VWAPEngine();

      // Pass strategy params straight through — MultiInstrumentBot already parsed
      // .env with correct defaults. Strategy constructor has last-resort safety nets.
      this.strategy = new MNQMomentumStrategyV2({
        ...sp,
        vwapEngine: this.vwapEngine,
        sessionFilter: this.sessionFilter,
        minBars: 1,
      });

      const subs = [sp.emaxEnabled ? 'EMAX' : null, 'PB', sp.vrEnabled !== false ? 'VR' : null].filter(Boolean).join('+');
      logger.info(`${this.tag} Strategy: MNQ Momentum V2 (${subs})`);

    } else if (strategyName === 'liquidity_orb') {
      // Liquidity ORB Strategy (Break & Retest + Bounce + Rejection)
      this.strategy = new LiquidityORBStrategy({
        orStartMinPST: sp.orStartMinPST || 300,
        orDurationMin: sp.orDurationMin || 15,
        brtEnabled: sp.brtEnabled !== false,
        brtWaitMinPST: sp.brtWaitMinPST || 390,
        brtMaxTimePST: sp.brtMaxTimePST || 600,
        brtStopPoints: sp.brtStopPoints || 5,
        brtTargetPoints: sp.brtTargetPoints || 15,
        brtRetestTolerance: sp.brtRetestTolerance || 1.5,
        brtMinBodyRatio: sp.brtMinBodyRatio || 0.3,
        bounceEnabled: sp.bounceEnabled !== false,
        bounceStopPoints: sp.bounceStopPoints || 7,
        bounceTargetPoints: sp.bounceTargetPoints || 20,
        bounceConfirmBars: sp.bounceConfirmBars || 5,
        bounceMaxTimePST: sp.bounceMaxTimePST || 660,
        rejectionEnabled: sp.rejectionEnabled !== false,
        rejectionStopPoints: sp.rejectionStopPoints || 6,
        rejectionTargetPoints: sp.rejectionTargetPoints || 30,
        rejectionMinTouches: sp.rejectionMinTouches || 2,
        rejectionMaxTimePST: sp.rejectionMaxTimePST || 660,
        maxTradesPerDay: sp.maxTradesPerDay || 3,
        levelTolerance: sp.levelTolerance || 1.5,
        minBarsSinceOR: sp.minBarsSinceOR || 5,
        sessionFilter: this.sessionFilter,
        minBars: 1,
      });

      const setups = [sp.brtEnabled !== false ? 'BRT' : null, sp.bounceEnabled !== false ? 'Bounce' : null, sp.rejectionEnabled !== false ? 'Reject' : null].filter(Boolean).join('+');
      logger.info(`${this.tag} Strategy: Liquidity ORB (${setups})`);

    } else {
      // ORB Strategy (for MES, M2K)
      this.strategy = new OpeningRangeBreakoutStrategy({
        orPeriodMinutes: sp.orPeriodMinutes || 15,
        orBuffer: sp.orBuffer || 0.5,
        stopBuffer: sp.stopBuffer || 0.5,
        maxStopPoints: sp.maxStopPoints || 15,
        minOrRange: sp.minOrRange || 2,
        maxOrRange: sp.maxOrRange || 12,
        minBodyRatio: sp.minBodyRatio || 0.3,
        profitTargetR: sp.profitTargetR || 2,
        useTrailingStop: sp.trailingStopEnabled || false,
        trailActivationR: sp.trailActivationR || 2.0,
        trailDistancePoints: sp.trailDistancePoints || 8,
        emaFastPeriod: sp.emaFastPeriod || 9,
        emaSlowPeriod: sp.emaSlowPeriod || 21,
        useTrendFilter: sp.useTrendFilter !== undefined ? sp.useTrendFilter : true,
        useVolumeFilter: sp.useVolumeFilter !== undefined ? sp.useVolumeFilter : true,
        volumeAvgPeriod: sp.volumeAvgPeriod || 10,
        volumeMinRatio: sp.volumeMinRatio || 1.0,
        useRSIFilter: sp.useRSIFilter || false,
        rsiPeriod: sp.rsiPeriod || 14,
        rsiOverbought: sp.rsiOverbought || 75,
        rsiOversold: sp.rsiOversold || 25,
        useADXFilter: sp.useADXFilter || false,
        adxPeriod: sp.adxPeriod || 14,
        adxMinTrend: sp.adxMinTrend || 20,
        signalCooldownBars: sp.signalCooldownBars || 3,
        allowShorts: sp.allowShorts !== false,
        sessionFilter: this.sessionFilter,
        minBars: 1,
      });

      const filters = [];
      if (sp.useTrendFilter) filters.push('Trend');
      if (sp.useVolumeFilter !== false) filters.push('Vol');
      logger.info(`${this.tag} Strategy: ORB (filters: ${filters.join('+') || 'none'})`);
    }

    // Wire signals
    this.strategy.on('signal', (signal) => this._onSignal(signal));
    this.strategy.initialize();
  }

  /**
   * Initialize signal and position handlers
   * @private
   */
  _initializeHandlers(mergedConfig) {
    const { shared } = this;

    this.signalHandler = new SignalHandler({
      client: shared.client,
      riskManager: this.riskManager,
      lossLimits: this.lossLimits,
      sessionFilter: this.sessionFilter,
      marketHours: shared.marketHours,
      tradeAnalyzer: shared.tradeAnalyzer,
      notifications: shared.notifications,
      trailingStop: this.trailingStop,
      profitManager: this.profitManager,
      strategy: this.strategy
    }, mergedConfig);

    this.signalHandler.setContext(shared.account, this.contract);

    this.positionHandler = new PositionHandler({
      performance: this.performance,
      lossLimits: this.lossLimits,
      tradeAnalyzer: shared.tradeAnalyzer,
      notifications: shared.notifications,
      trailingStop: this.trailingStop,
      profitManager: this.profitManager,
      strategy: this.strategy,
      dynamicSizing: null // Not used in multi-instrument mode
    }, { ...mergedConfig, dynamicSizingEnabled: false });

    this.positionHandler.setContract(this.contract);

    this.positionHandler.on('positionClosed', () => {
      this.signalHandler.clearPosition();
    });

    logger.info(`${this.tag} Handlers initialized`);
  }

  /**
   * Connect to price data — either shared provider or per-instrument
   * @private
   */
  async _connectPriceProvider() {
    const { instrumentConfig: ic, shared } = this;
    this._databentoSymbol = ic.databentoSymbol || `${ic.baseSymbol}.FUT`;

    if (shared.sharedPriceProvider) {
      // ── Shared mode: single Databento stream for all instruments ──
      this.priceProvider = shared.sharedPriceProvider;
      this._usingSharedProvider = true;

      // Subscribe to per-symbol events from the shared provider
      const sym = this._databentoSymbol;
      this.priceProvider.on(`bar:${sym}`, (bar) => this._onBar(bar));
      this.priceProvider.on(`quote:${sym}`, (quote) => {
        if (this.strategy && this.strategy.onQuote) this.strategy.onQuote(quote);
      });

      logger.info(`${this.tag} Wired to shared Databento stream: ${sym}`);

    } else {
      // ── Per-instrument mode (fallback / single-instrument) ──
      this.priceProvider = new DatabentoPriceProvider({
        apiKey: shared.globalConfig.databentoApiKey,
        symbol: this._databentoSymbol,
        schema: 'ohlcv-1m',
        dataset: shared.globalConfig.databentoDataset || 'GLBX.MDP3',
        pythonPath: shared.globalConfig.pythonPath || 'python',
      });
      this._usingSharedProvider = false;

      this.priceProvider.on('bar', (bar) => this._onBar(bar));
      this.priceProvider.on('quote', (quote) => {
        if (this.strategy && this.strategy.onQuote) this.strategy.onQuote(quote);
      });
      this.priceProvider.on('error', (error) => logger.error(`${this.tag} [Databento] Error: ${error.message}`));

      this.priceProvider.on('disconnected', ({ code }) => {
        logger.warn(`${this.tag} [Databento] Disconnected (code: ${code})`);
        shared.notifications.send(
          `⚠️ <b>${ic.baseSymbol} DATABENTO DISCONNECTED</b>\nStream lost (code: ${code}). Reconnecting...`
        ).catch(() => {});
      });

      this.priceProvider.on('reconnected', async (data) => {
        const downtimeSec = (data.downtimeMs / 1000).toFixed(1);
        logger.info(`${this.tag} [Databento] Reconnected — recovering gap bars`);
        await this._recoverGapBars(data);
        shared.notifications.send(
          `✅ <b>${ic.baseSymbol} RECONNECTED</b>\nDowntime: ${downtimeSec}s`
        ).catch(() => {});
      });

      this.priceProvider.on('maxReconnectAttemptsReached', () => {
        logger.error(`${this.tag} [Databento] Max reconnect attempts — BLIND`);
        shared.notifications.send(
          `🚨 <b>${ic.baseSymbol} DATABENTO DEAD</b>\nAll reconnect attempts exhausted. No market data!`
        ).catch(() => {});
      });

      await this.priceProvider.startLiveStream();
      logger.info(`${this.tag} Databento stream connected: ${this._databentoSymbol} (ohlcv-1m)`);
    }
  }

  /**
   * Recover gap bars after a reconnection
   * @private
   */
  async _recoverGapBars(data) {
    if (!data.lastBarTs) return 0;
    let recoveredBars = 0;
    try {
      const gapStart = new Date(new Date(data.lastBarTs).getTime() - 60000).toISOString();
      const gapEnd = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      if (new Date(gapStart) < new Date(gapEnd)) {
        const fetcher = this._usingSharedProvider ? this.priceProvider : this.priceProvider;
        const gapBars = this._usingSharedProvider
          ? await fetcher.getHistoricalBars(this._databentoSymbol, gapStart, gapEnd, 'ohlcv-1m', 100)
          : await fetcher.getHistoricalBars(gapStart, gapEnd, 'ohlcv-1m', 100);
        if (gapBars && gapBars.length > 0) {
          const existingTs = new Set((this.strategy.bars || []).map(b => b.timestamp));
          this._warmingUp = true;
          try {
            for (const bar of gapBars) {
              if (existingTs.has(bar.timestamp)) continue;
              if (!this._isInSession(bar.timestamp)) continue;
              this.strategy.onBar(bar);
              recoveredBars++;
            }
          } finally {
            this._warmingUp = false;
          }
          if (this.strategy.signalFired && !this.strategy.position) {
            this.strategy.signalFired = false;
          }
        }
      }
    } catch (err) {
      logger.warn(`${this.tag} Gap recovery failed: ${err.message}`);
    }
    return recoveredBars;
  }

  /**
   * Load initial historical data (prior day + today warmup)
   * @private
   */
  async _loadInitialData(mergedConfig) {
    const sessionStartMins = (mergedConfig.tradingStartHour || 6) * 60 + (mergedConfig.tradingStartMinute || 30);
    const sessionEndMins = (mergedConfig.tradingEndHour || 13) * 60 + (mergedConfig.tradingEndMinute || 0);

    try {
      const nowPST = this._getPSTTime();
      const now = new Date();
      const pstDateStr = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(now);
      const [mm, dd, yyyy] = pstDateStr.split('/');
      const todayPST = new Date(`${yyyy}-${mm}-${dd}T00:00:00-08:00`);

      // Find prior trading day
      let priorDay = new Date(todayPST);
      priorDay.setDate(priorDay.getDate() - 1);
      while (priorDay.getDay() === 0 || priorDay.getDay() === 6) {
        priorDay.setDate(priorDay.getDate() - 1);
      }

      const priorDayStr = priorDay.toISOString().split('T')[0];
      const priorSessionStartUTC = `${priorDayStr}T13:00:00Z`;
      const priorSessionEndUTC = `${priorDayStr}T22:00:00Z`;

      logger.info(`${this.tag} Prior day: ${priorDayStr}`);

      // Fetch prior day bars
      let priorDayBars = 0;
      try {
        const priorBars = this._usingSharedProvider
          ? await this.priceProvider.getHistoricalBars(this._databentoSymbol, priorSessionStartUTC, priorSessionEndUTC, 'ohlcv-1m', 500)
          : await this.priceProvider.getHistoricalBars(priorSessionStartUTC, priorSessionEndUTC, 'ohlcv-1m', 500);

        if (priorBars && priorBars.length > 0) {
          const priorSessionBars = [];
          for (const bar of priorBars) {
            const pst = this._getPSTTime(new Date(bar.timestamp));
            const mins = pst.hour * 60 + pst.minute;
            if (mins >= sessionStartMins && mins < sessionEndMins) {
              if (this.vwapEngine) this.vwapEngine.onBar(bar);
              priorSessionBars.push(bar);
              priorDayBars++;
            }
          }

          if (this.strategy && this.strategy.bars) {
            for (const bar of priorSessionBars) {
              this.strategy.bars.push(bar);
              if (this.strategy.bars.length > 500) this.strategy.bars.shift();
            }
          }
          logger.info(`${this.tag} Prior day: ${priorDayBars} bars loaded`);
        }
      } catch (err) {
        logger.warn(`${this.tag} Prior day fetch failed: ${err.message}`);
      }

      // Reset VWAP engine
      if (this.vwapEngine) this.vwapEngine.resetDay();

      // Fetch today's bars
      const todayStr = `${yyyy}-${mm}-${dd}`;
      const todaySessionStart = `${todayStr}T13:00:00Z`;
      const endTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      const nowMins = nowPST.hour * 60 + nowPST.minute;

      if (nowMins >= sessionStartMins) {
        try {
          const todayBars = this._usingSharedProvider
            ? await this.priceProvider.getHistoricalBars(this._databentoSymbol, todaySessionStart, endTime, 'ohlcv-1m', 500)
            : await this.priceProvider.getHistoricalBars(todaySessionStart, endTime, 'ohlcv-1m', 500);

          if (todayBars && todayBars.length > 0) {
            let todaySessionBars = 0;
            this._warmingUp = true;
            try {
              for (const bar of todayBars) {
                const pst = this._getPSTTime(new Date(bar.timestamp));
                const mins = pst.hour * 60 + pst.minute;
                if (mins >= sessionStartMins && mins < sessionEndMins) {
                  this.strategy.onBar(bar);
                  todaySessionBars++;
                }
              }
            } finally {
              this._warmingUp = false;
            }
            if (this.strategy.signalFired && !this.strategy.position) {
              this.strategy.signalFired = false;
            }
            logger.info(`${this.tag} Today: ${todaySessionBars} bars loaded`);
          }
        } catch (err) {
          logger.warn(`${this.tag} Today fetch failed: ${err.message}`);
        }
      }
    } catch (error) {
      logger.warn(`${this.tag} Historical data load failed: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  EVENT HANDLERS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Handle incoming 1-min bar from Databento
   * @private
   */
  _onBar(bar) {
    if (!this._isInSession(bar.timestamp)) return;

    // Gap detection
    if (this._lastSessionBarTs) {
      const prev = new Date(this._lastSessionBarTs).getTime();
      const curr = new Date(bar.timestamp).getTime();
      const gapMin = Math.round((curr - prev) / 60000);
      if (gapMin > 1) {
        const dropped = gapMin - 1;
        logger.warn(`${this.tag} [GAP] ${dropped} bar(s) dropped: ${this._lastSessionBarTs} → ${bar.timestamp}`);
        if (dropped >= 2) {
          this.shared.notifications.send(`⚠️ ${this.instrumentConfig.baseSymbol}: ${dropped} bars dropped`).catch(() => {});
        }
      }
    }
    this._lastSessionBarTs = bar.timestamp;

    // Bar watchdog
    this._lastBarReceivedAt = Date.now();
    this._resetBarWatchdog();

    // Feed to strategy
    this.strategy.onBar(bar);

    // Active trade management: BE stop
    // Use bar's favorable extreme (high for longs, low for shorts) so BE triggers
    // if price reached 2.0R at any point during the bar, not just at close
    if (this.strategy.position && this.profitManager) {
      const pos = this.strategy.position;
      const posId = pos.orderId || pos.id || pos.clientId || 'active';
      const isLong = pos.side === 'Buy';
      const beCheckPrice = isLong ? bar.high : bar.low;
      const { actions } = this.profitManager.update(posId, beCheckPrice, bar);
      for (const action of actions) {
        if (action.type === 'MOVE_STOP') {
          logger.success(`${this.tag} 🔒 BE Stop → $${action.newStop.toFixed(2)} (${action.reason})`);
          if (this.shared.client && pos.stopOrderId) {
            this.shared.client.modifyOrder(pos.stopOrderId, {
              orderType: 'Stop',
              stopPrice: action.newStop,
              orderQty: pos.quantity || 1,
            }).catch(err => {
              logger.error(`${this.tag} Failed to modify stop: ${err.message}`);
            });
          }
          this.shared.notifications.send(
            `🔒 <b>${this.instrumentConfig.baseSymbol} STOP MOVED</b>\n` +
            `${pos.side} @ $${pos.entryPrice?.toFixed(2) || '?'}\n` +
            `Stop: $${action.newStop.toFixed(2)} (${action.reason})`
          ).catch(() => {});
        }
      }
    }

    // Log OR establishment (ORB strategy only)
    if (this.strategy.orEstablished !== undefined && this.strategy.orEstablished && !this._orLoggedToday) {
      this._orLoggedToday = true;
      const orRange = (this.strategy.orHigh - this.strategy.orLow).toFixed(2);
      logger.success(`${this.tag} 📊 OR: $${this.strategy.orLow.toFixed(2)} - $${this.strategy.orHigh.toFixed(2)} (${orRange} pts)`);
      this.shared.notifications.send(`📊 ${this.instrumentConfig.baseSymbol} OR: $${this.strategy.orLow.toFixed(2)} - $${this.strategy.orHigh.toFixed(2)} (${orRange} pts)`).catch(() => {});
    }
  }

  /**
   * Handle trading signal from strategy
   * @private
   */
  async _onSignal(signal) {
    if (this._warmingUp) return;

    // Entry cutoff
    if (this._isPastEntryCutoff()) {
      const pst = this._getPSTTime();
      logger.warn(`${this.tag} Signal blocked: Past entry cutoff (${pst.hour}:${String(pst.minute).padStart(2, '0')} PST)`);
      return;
    }

    // Tag signal with instrument info
    signal.instrument = this.instrumentConfig.baseSymbol;

    if (signal.strategy && signal.confluenceScore !== undefined) {
      logger.info(`${this.tag} 📊 ${signal.strategy} signal: ${signal.type.toUpperCase()} | Confluence: ${signal.confluenceScore}`);
    }

    await this.signalHandler.handleSignal(signal);
  }

  /**
   * Handle fill notification (called by MultiInstrumentBot when routing fills)
   */
  async handleFill(fill) {
    // Dedup: skip if we already processed this fill ID
    if (!this._processedFillIds) this._processedFillIds = new Set();
    const fillId = fill.id || fill.orderId;
    if (fillId && this._processedFillIds.has(fillId)) return { isExit: false };
    if (fillId) {
      this._processedFillIds.add(fillId);
      // Prevent unbounded growth — keep last 100 fill IDs
      if (this._processedFillIds.size > 100) {
        const first = this._processedFillIds.values().next().value;
        this._processedFillIds.delete(first);
      }
    }

    const result = await this.positionHandler.handleFill(
      fill,
      this.signalHandler.getPosition(),
      this.signalHandler.getTradeId()
    );

    if (result.isFullyClosed) {
      this.signalHandler.clearPosition();
    }

    return result;
  }

  /**
   * Handle order update (called by MultiInstrumentBot when routing orders)
   */
  handleOrderUpdate(order) {
    this.positionHandler.handleOrderUpdate(order);
  }

  /**
   * Handle position update (called by MultiInstrumentBot when routing positions)
   */
  handlePositionUpdate(position) {
    this.positionHandler.handlePositionUpdate(position);
  }

  // ═══════════════════════════════════════════════════════════════
  //  SESSION MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Perform daily reset for this instrument
   */
  dailyReset() {
    this._todayResetDone = true;
    this._orLoggedToday = false;
    this._eodCloseDoneToday = false;
    this._sessionStartLoggedToday = false;
    this._lastSessionBarTs = null;
    this.strategy.resetDay();

    logger.info(`${this.tag} 🔄 Daily reset`);
  }

  /**
   * EOD force-close any open position
   */
  async eodClose() {
    if (this._eodCloseDoneToday) return;

    if (this.signalHandler && this.signalHandler.getPosition()) {
      this._eodCloseDoneToday = true;
      logger.warn(`${this.tag} ⏰ EOD — force-closing position`);
      const pos = this.signalHandler.getPosition();
      try {
        const closeAction = pos.side === 'Buy' ? 'Sell' : 'Buy';

        // Cancel only THIS instrument's bracket orders (not all account orders)
        // This prevents nuking brackets for other instruments in multi-instrument mode
        const orderIdsToCancel = [pos.stopOrderId, pos.targetOrderId].filter(Boolean);
        for (const oid of orderIdsToCancel) {
          try {
            await this.shared.client.cancelOrder(oid);
            logger.info(`${this.tag} EOD: Cancelled order ${oid}`);
          } catch (cancelErr) {
            // Order may already be filled or cancelled — not fatal
            logger.debug(`${this.tag} EOD: Cancel order ${oid} failed: ${cancelErr.message}`);
          }
        }

        // Verify position still exists on exchange before flattening
        // The bracket cancel + race could mean stop/target already filled
        const positions = await this.shared.client.getOpenPositions(this.shared.account.id);
        const myPositions = positions.filter(p => p.contractId === this.contract?.id);
        if (myPositions.length === 0) {
          logger.info(`${this.tag} EOD: Position already closed (bracket filled during cancel)`);
          // Position was already closed by stop/target — the props handler will process the fill
          // Just clean up bot state in case props hasn't fired yet
          const entryOrderId = pos.orderId;
          this.strategy.setPosition(null);
          this.signalHandler.clearPosition();
          if (entryOrderId) {
            this.profitManager.closePosition(entryOrderId);
            this.trailingStop.removeTrail(entryOrderId);
          }
          return;
        }

        // Position still open — flatten with market order
        const eodOrder = await this.shared.client.placeMarketOrder(
          this.shared.account.id,
          this.contract.id,
          pos.quantity,
          closeAction
        );
        logger.success(`${this.tag} ✓ EOD position closed`);

        // Get the actual fill price from the EOD close order
        let exitPrice = null;
        try {
          const eodOrderId = eodOrder?.orderId || eodOrder?.id;
          if (eodOrderId) {
            // Wait briefly for fill to propagate
            await new Promise(r => setTimeout(r, 1500));
            const fills = await this.shared.client.getFillsByOrder(eodOrderId);
            if (Array.isArray(fills) && fills.length > 0) {
              exitPrice = fills[0].price;
            }
          }
        } catch (fillErr) {
          logger.warn(`${this.tag} EOD: Could not get fill price: ${fillErr.message}`);
        }

        // Determine win/loss from actual fill price vs entry
        const isLong = pos.side === 'Buy';
        let eodResult = 'loss';
        let eodPnlStr = '';
        if (exitPrice !== null && pos.entryPrice) {
          const { CONTRACTS } = require('../utils/constants');
          const baseSymbol = this.instrumentConfig.baseSymbol || 'MNQ';
          const pv = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;
          const pnl = isLong
            ? (exitPrice - pos.entryPrice) * (pos.quantity || 1) * pv
            : (pos.entryPrice - exitPrice) * (pos.quantity || 1) * pv;
          const beThreshold = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue * 2 * (pos.quantity || 1);
          eodResult = Math.abs(pnl) <= beThreshold ? 'breakeven' : pnl > 0 ? 'win' : 'loss';
          eodPnlStr = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;

          if (this.lossLimits) {
            this.lossLimits.recordTrade(pnl, { symbol: this.contract?.name || 'MNQ' });
          }
        }

        if (typeof this.strategy.onTradeResult === 'function') {
          this.strategy.onTradeResult(eodResult);
        }

        // Clean up
        const entryOrderId = pos.orderId;
        this.strategy.setPosition(null);
        this.signalHandler.clearPosition();
        if (entryOrderId) {
          this.profitManager.closePosition(entryOrderId);
          this.trailingStop.removeTrail(entryOrderId);
        }

        const eodEmoji = eodResult === 'win' ? '💰' : eodResult === 'breakeven' ? '🔒' : '❌';
        const exitStr = exitPrice !== null ? `@ $${exitPrice.toFixed(2)}` : '@ market';
        await this.shared.notifications.send(
          `⏰ <b>${this.instrumentConfig.baseSymbol} EOD CLOSE</b>\n` +
          `${closeAction} ${pos.quantity} ${exitStr}\n` +
          `${eodEmoji} ${eodResult.toUpperCase()} ${eodPnlStr}`
        ).catch(() => {});
      } catch (err) {
        logger.error(`${this.tag} EOD close failed: ${err.message}`);
        // On error we can't determine P&L — default to loss conservatively
        if (typeof this.strategy.onTradeResult === 'function') {
          this.strategy.onTradeResult('loss');
        }
        const entryOrderId = pos?.orderId;
        this.strategy.setPosition(null);
        this.signalHandler.clearPosition();
        if (entryOrderId) {
          this.profitManager.closePosition(entryOrderId);
          this.trailingStop.removeTrail(entryOrderId);
        }
      }
    } else {
      this._eodCloseDoneToday = true;
    }
  }

  /**
   * Get today's performance stats
   */
  getTodayStats() {
    return this.performance.getTodayStats();
  }

  /**
   * Check if this runner has an open position
   */
  hasPosition() {
    return this.signalHandler && this.signalHandler.getPosition() !== null;
  }

  /**
   * Get the contract ID for order routing
   */
  getContractId() {
    return this.contract?.id;
  }

  /**
   * Get the contract name for order routing
   */
  getContractName() {
    return this.contract?.name;
  }

  // ═══════════════════════════════════════════════════════════════
  //  UTILITIES
  // ═══════════════════════════════════════════════════════════════

  _getPSTTime(date = new Date()) {
    const fmt = (type) => parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', [type]: 'numeric', hour12: false
    }).format(date));
    const dayOfWeek = new Date(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date)).getDay();
    return { hour: fmt('hour'), minute: fmt('minute'), dayOfWeek };
  }

  _isInSession(timestamp) {
    const pst = this._getPSTTime(new Date(timestamp));
    const mins = pst.hour * 60 + pst.minute;
    const gc = this.shared.globalConfig;
    const sessionStart = (gc.tradingStartHour || 6) * 60 + (gc.tradingStartMinute || 30);
    const sessionEnd = (gc.tradingEndHour || 13) * 60 + (gc.tradingEndMinute || 0);
    return mins >= sessionStart && mins < sessionEnd;
  }

  _isPastEntryCutoff() {
    const pst = this._getPSTTime();
    const mins = pst.hour * 60 + pst.minute;
    const cutoff = this._lastEntryHourPST * 60 + this._lastEntryMinutePST;
    return mins >= cutoff;
  }

  _resetBarWatchdog() {
    if (this._barWatchdogTimer) clearTimeout(this._barWatchdogTimer);
    this._barWatchdogTimer = setTimeout(() => {
      if (!this.isRunning) return;
      if (!this._isInSession(new Date().toISOString())) return;
      const silenceSec = this._lastBarReceivedAt
        ? ((Date.now() - this._lastBarReceivedAt) / 1000).toFixed(0)
        : '?';
      logger.warn(`${this.tag} [Watchdog] No bar for 90s (${silenceSec}s ago)`);
      this.shared.notifications.send(
        `⚠️ <b>${this.instrumentConfig.baseSymbol} BAR WATCHDOG</b>\nNo bar for 90s`
      ).catch(() => {});
    }, 90000);
  }

  _stopBarWatchdog() {
    if (this._barWatchdogTimer) {
      clearTimeout(this._barWatchdogTimer);
      this._barWatchdogTimer = null;
    }
  }

  /**
   * Position sync: check bot state vs exchange
   */
  async syncPosition() {
    try {
      const positions = await this.shared.client.getOpenPositions(this.shared.account.id);
      // Filter to this instrument's contract
      const myPositions = positions.filter(p => p.contractId === this.contract?.id);
      const hasOpenPosition = myPositions.length > 0;
      const botHasPosition = this.signalHandler.getPosition() !== null;

      if (botHasPosition && !hasOpenPosition) {
        logger.warn(`${this.tag} [PositionSync] Bot has stale position — clearing`);
        const pos = this.signalHandler.getPosition();
        const entryOrderId = pos?.orderId;

        // Determine win/loss by checking which exit order filled (stop or target)
        let tradeResult = 'loss'; // default assumption
        let estimatedPnl = -(pos?.risk || 0);
        try {
          if (pos?.stopOrderId) {
            const stopFills = await this.shared.client.getFillsByOrder(pos.stopOrderId);
            const targetFills = pos.targetOrderId ? await this.shared.client.getFillsByOrder(pos.targetOrderId) : [];
            const { CONTRACTS } = require('../utils/constants');
            const baseSymbol = this.instrumentConfig.baseSymbol || 'MNQ';
            const pv = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;

            // Check which exit order filled and compute actual P&L
            let exitPrice = null;
            if (Array.isArray(targetFills) && targetFills.length > 0) {
              exitPrice = targetFills[0].price;
            } else if (Array.isArray(stopFills) && stopFills.length > 0) {
              exitPrice = stopFills[0].price;
            }

            if (exitPrice !== null) {
              estimatedPnl = pos.side === 'Buy'
                ? (exitPrice - pos.entryPrice) * (pos.quantity || 1) * pv
                : (pos.entryPrice - exitPrice) * (pos.quantity || 1) * pv;
              const beThreshold = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue * 2 * (pos.quantity || 1);
              tradeResult = Math.abs(estimatedPnl) <= beThreshold ? 'breakeven' : estimatedPnl > 0 ? 'win' : estimatedPnl < 0 ? 'loss' : 'breakeven';
            }
          }
        } catch (err) {
          logger.warn(`${this.tag} [PositionSync] Could not determine exit fill: ${err.message}`);
        }

        // Record the result in strategy so _lossCountToday and _prevTradeResult update
        if (typeof this.strategy.onTradeResult === 'function') {
          this.strategy.onTradeResult(tradeResult);
        }

        // Record in loss limits so daily loss tracking stays accurate
        if (this.lossLimits) {
          this.lossLimits.recordTrade(estimatedPnl, { symbol: this.contract?.name || 'MNQ' });
        }

        // Cancel any orphaned bracket orders still live on the exchange
        const orphanIds = [pos?.stopOrderId, pos?.targetOrderId].filter(Boolean);
        for (const oid of orphanIds) {
          try {
            await this.shared.client.cancelOrder(oid);
            logger.info(`${this.tag} [PositionSync] Cancelled orphaned order ${oid}`);
          } catch (cancelErr) {
            // Already filled or cancelled — expected
            logger.debug(`${this.tag} [PositionSync] Cancel order ${oid}: ${cancelErr.message}`);
          }
        }

        this.signalHandler.clearPosition();
        this.strategy.setPosition(null);
        if (entryOrderId) {
          this.profitManager.closePosition(entryOrderId);
          this.trailingStop.removeTrail(entryOrderId);
        }
        const resultEmoji = tradeResult === 'win' ? '💰' : tradeResult === 'breakeven' ? '🔒' : '❌';
        const pnlStr = estimatedPnl >= 0 ? `+$${estimatedPnl.toFixed(2)}` : `-$${Math.abs(estimatedPnl).toFixed(2)}`;
        await this.shared.notifications.send(
          `⚠️ <b>${this.instrumentConfig.baseSymbol} POSITION SYNC</b>\n` +
          `Stale position cleared\n${resultEmoji} Result: ${tradeResult.toUpperCase()} (${pnlStr})`
        ).catch(() => {});
      } else if (!botHasPosition && hasOpenPosition) {
        const pos = myPositions[0];
        logger.error(`${this.tag} [PositionSync] Exchange has position (${pos.netPos} @ ${pos.netPrice}) bot doesn't track!`);
        await this.shared.notifications.send(
          `🚨 <b>${this.instrumentConfig.baseSymbol} POSITION MISMATCH</b>\n` +
          `Exchange: ${pos.netPos} @ ${pos.netPrice}\nBot doesn't track this!`
        ).catch(() => {});
      }
    } catch (error) {
      logger.debug(`${this.tag} [PositionSync] Failed: ${error.message}`);
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    this.isRunning = false;
    this._stopBarWatchdog();

    if (this.strategy) this.strategy.stop();
    if (this.priceProvider) this.priceProvider.stop();

    logger.info(`${this.tag} Stopped`);
  }
}

module.exports = InstrumentRunner;
