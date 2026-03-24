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
    // Tick price for slippage guard (updated from Databento trade stream)
    this._lastTickPrice = null;
    this._lastTickReceivedAt = null;
    this._todayResetDone = false;
    this._orLoggedToday = false;
    this._eodCloseDoneToday = false;
    this._sessionStartLoggedToday = false;
    this._lastSessionBarTs = null;
    this._lastBarReceivedAt = null;
    this._barWatchdogTimer = null;

    // Bracket watchdog: tracks order statuses for OCO verification
    this._bracketOrderStatuses = new Map(); // orderId -> latest ordStatus
    this._bracketWatchdogTimer = null;

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
      // Telegram notification — context-aware for profit vs loss halts
      if (this.shared.notifications) {
        const s = this.lossLimits.getStatus();
        const pnlStr = s.dailyPnL >= 0 ? `+$${s.dailyPnL.toFixed(2)}` : `-$${Math.abs(s.dailyPnL).toFixed(2)}`;
        const floorStr = s.currentFloor !== null ? `$${s.currentFloor}` : 'none';
        let emoji, title, details;
        if (data.reason === 'DAILY_PROFIT_TARGET') {
          emoji = '🎯'; title = 'PROFIT TARGET HIT';
          details = `Target: $${s.limits.dailyProfitTarget}`;
        } else if (data.reason === 'PROFIT_PROTECTION') {
          emoji = '🔒'; title = 'PROFIT PROTECTED';
          details = `Floor: ${floorStr} | Peak: $${s.dailyPeakPnL.toFixed(2)}`;
        } else {
          emoji = '🛑'; title = 'TRADING HALTED';
          details = `Consec Losses: ${s.consecutiveLosses}/${s.limits.maxConsecutiveLosses}`;
        }
        this.shared.notifications.send(
          `${emoji} <b>${ic.baseSymbol} ${title}</b>\n` +
          `${data.message}\n\n` +
          `Daily P&L: ${pnlStr}\n` +
          `${details}\n` +
          `Trades today: ${s.tradesToday}\n\n` +
          `<i>Bot will resume tomorrow 6:30 AM PST.</i>`
        ).catch(() => {});
      }
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

    // ── Startup Position & Order Sync ──
    // Cancel any orphaned orders and flatten any leftover positions from before restart.
    // This prevents ghost positions and untracked fills from crashing the bot.
    await this._startupSync();

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
      maxContracts: rp.maxContracts || 10,
      dailyLossLimit: rp.dailyLossLimit || 150,
      weeklyLossLimit: rp.weeklyLossLimit || 500,
      maxConsecutiveLosses: rp.maxConsecutiveLosses || 3,
      maxDrawdownPercent: rp.maxDrawdownPercent || 5,
      dailyProfitTarget: rp.dailyProfitTarget || Infinity,
      profitTiers: rp.profitTiers || '',
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

      const subs = [sp.emaxEnabled ? 'EMAX' : null, 'PB5m', sp.pb3mEnabled ? 'PB3m' : null, sp.pb2mEnabled ? 'PB2m' : null, sp.vrEnabled !== false ? 'VR' : null].filter(Boolean).join('+');
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

    // Sync strategy's consecutive loss counter from persisted LossLimitsManager state.
    // On restart mid-day, LossLimitsManager restores consecutiveLosses from disk but
    // strategy always starts at 0 — without this sync there's a one-trade desync window.
    if (this.lossLimits && typeof this.strategy._consecutiveLosses !== 'undefined') {
      const llState = this.lossLimits.getStatus();
      if (llState.consecutiveLosses > 0) {
        this.strategy._consecutiveLosses = llState.consecutiveLosses;
        logger.info(`${this.tag} Synced strategy consecutive losses from persisted state: ${llState.consecutiveLosses}`);
      }
      // Also sync halt state — if LossLimitsManager is halted, strategy should be inactive
      if (llState.isHalted) {
        this.strategy.isActive = false;
        logger.warn(`${this.tag} LossLimitsManager is halted (${llState.haltReason}) — strategy set inactive`);
      }
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

    // Wire tick price getter for slippage guard
    this.signalHandler.setTickPriceGetter(() => {
      if (this._lastTickPrice === null) return null;
      return {
        price: this._lastTickPrice,
        receivedAt: this._lastTickReceivedAt,
        ageMs: Date.now() - this._lastTickReceivedAt,
      };
    });

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
      this._clearLimitEntryTimeout();
      this.signalHandler.clearPosition();
    });

    // When entry fill arrives, place OCO bracket with fill-adjusted prices
    // and send the entry notification with real prices.
    this.positionHandler.on('entryFilled', async (fillData) => {
      this._clearLimitEntryTimeout();
      this._clearFillWatchdog(); // WebSocket fill arrived — no need to poll REST
      const { fillPrice, signalPrice, slippage, newStop, newTarget, position } = fillData;

      // 1. Update SignalHandler's currentPosition (entryPrice, stop, target, risk)
      this.signalHandler.updatePositionFromFill(fillData);

      // 2. Update ProfitManager internal state
      const posId = position.orderId || position.id || position.clientId || 'active';
      if (this.profitManager) {
        this.profitManager.updatePositionFromFill(posId, { fillPrice, newStop, newTarget });
      }

      // 3. Update TrailingStop internal state
      if (this.trailingStop) {
        this.trailingStop.updatePositionFromFill(posId, { fillPrice, newStop, newTarget });
      }

      // 4. Place OCO bracket NOW with fill-adjusted prices (not signal prices).
      //    This eliminates the race condition where modifyOrder failed on orders
      //    still in PendingNew state, leaving stop/target at wrong signal prices.
      const ocoParams = position._ocoParams;
      if (ocoParams) {
        // Attempt OCO placement with one retry. If both fail, emergency-close the position.
        let ocoPlaced = false;
        for (let attempt = 1; attempt <= 2 && !ocoPlaced; attempt++) {
          try {
            if (attempt > 1) {
              logger.warn(`${this.tag} Retrying OCO placement (attempt ${attempt})...`);
              await new Promise(r => setTimeout(r, 2000));
            }
            logger.trade(`${this.tag} Placing OCO: ${ocoParams.exitAction} Stop @ ${newStop.toFixed(2)} | Limit @ ${newTarget.toFixed(2)}`);
            const oco = await this.shared.client.placeOCO(
              ocoParams.accountSpec,
              ocoParams.accountId,
              ocoParams.contractName,
              ocoParams.contracts,
              ocoParams.exitAction,
              newStop,
              newTarget
            );

            const stopOrderId = oco.orderId;
            const targetOrderId = oco.ocoId;
            position.stopOrderId = stopOrderId;
            position.targetOrderId = targetOrderId;
            ocoPlaced = true;
            logger.success(`${this.tag} ✓ OCO placed: stopOrderId=${stopOrderId}, targetOrderId=${targetOrderId}`);

            if (slippage !== 0) {
              logger.info(`${this.tag} ✓ Bracket reflects fill adjustment (slippage: ${slippage >= 0 ? '+' : ''}${slippage.toFixed(2)}pt)`);
            }

            // Update trailing stop with the actual stopOrderId
            if (this.trailingStop) {
              this.trailingStop.updateStopOrderId(posId, stopOrderId);
            }

            // Start bracket watchdog: verify both orders reach Working within 7s
            this._startBracketWatchdog(stopOrderId, targetOrderId);
          } catch (err) {
            logger.error(`${this.tag} ❌ OCO placement attempt ${attempt} failed: ${err.message}`);
          }
        }

        // EMERGENCY: If OCO could not be placed after retries, the position is NAKED.
        // Close it immediately to prevent unlimited losses.
        if (!ocoPlaced) {
          logger.error(`${this.tag} 🚨 EMERGENCY: OCO placement failed after retries — closing naked position`);
          await this.shared.notifications.send(
            `🚨 <b>${this.instrumentConfig.baseSymbol} EMERGENCY</b>\n` +
            `OCO bracket FAILED after fill. Closing naked position to prevent unlimited loss.`
          ).catch(() => {});
          try {
            await this.shared.client.placeMarketOrder(
              ocoParams.accountId,
              this.contract.id,
              ocoParams.contracts,
              ocoParams.exitAction
            );
            logger.warn(`${this.tag} Emergency close executed`);
            // Let the fill handler process the exit
          } catch (closeErr) {
            logger.error(`${this.tag} ❌ EMERGENCY CLOSE ALSO FAILED: ${closeErr.message} — MANUAL INTERVENTION REQUIRED`);
            await this.shared.notifications.send(
              `🚨🚨 <b>${this.instrumentConfig.baseSymbol} CRITICAL</b>\n` +
              `OCO failed AND emergency close failed!\n` +
              `NAKED POSITION ON EXCHANGE — CLOSE MANUALLY NOW!`
            ).catch(() => {});
          }
        }
        delete position._ocoParams;
      }

      // 5. Send the single entry notification NOW (after fill) with real prices
      const nd = position._notificationData;
      if (nd) {
        const patchedSignal = { ...nd.signal, price: fillPrice };
        const patchedPosition = {
          ...nd.position,
          stopPrice: newStop,
          targetPrice: newTarget,
          totalRisk: position.risk || nd.position.totalRisk,
        };
        try {
          await this.shared.notifications.tradeEntryDetailed({
            signal: patchedSignal,
            position: patchedPosition,
            marketStructure: nd.marketStructure,
            filterResults: nd.filterResults,
            aiDecision: nd.aiDecision,
            slippage: slippage !== 0 ? slippage : undefined,
            signalPrice: slippage !== 0 ? signalPrice : undefined,
          });
          logger.info(`${this.tag} ✓ Entry notification sent`);
        } catch (notifErr) {
          logger.error(`${this.tag} ❌ Entry notification FAILED: ${notifErr.message}`);
        }
        delete position._notificationData;
      }
    });

    // Layer 2: Post-fill risk check — emergency close + HALT if actual risk is too high
    this.positionHandler.on('postFillRiskExceeded', async (data) => {
      const { fillPrice, actualRisk, maxRisk } = data;
      logger.error(`${this.tag} 🚨 POST-FILL RISK EXCEEDED: actual $${actualRisk.toFixed(2)} > 150% of max $${maxRisk}`);

      await this.shared.notifications.send(
        `🚨 <b>${this.instrumentConfig.baseSymbol} POST-FILL RISK EXCEEDED</b>\n` +
        `Fill: $${fillPrice.toFixed(2)}\n` +
        `Actual risk: $${actualRisk.toFixed(2)} (max: $${maxRisk})\n` +
        `Emergency closing position + halting...`
      ).catch(() => {});

      await this._emergencyCloseAndHalt('POST_FILL_RISK_EXCEEDED');
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
      // Subscribe to tick events for slippage guard + intra-bar strategy evaluation
      this.priceProvider.on(`tick:${sym}`, (tick) => {
        this._lastTickPrice = tick.price;
        this._lastTickReceivedAt = Date.now();
        if (this.strategy && typeof this.strategy.onTick === 'function') {
          this.strategy.onTick(tick);
        }
      });

      logger.info(`${this.tag} Wired to shared Databento stream: ${sym} (bars+ticks)`);

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
      // Subscribe to tick events for slippage guard + intra-bar strategy evaluation
      this.priceProvider.on('tick', (tick) => {
        this._lastTickPrice = tick.price;
        this._lastTickReceivedAt = Date.now();
        if (this.strategy && typeof this.strategy.onTick === 'function') {
          this.strategy.onTick(tick);
        }
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
   * Startup sync: re-adopt existing positions or cancel truly orphaned orders.
   * 
   * CRITICAL: If a position exists with bracket orders, we must RE-ADOPT it
   * (reconstruct bot state so it can track the position) rather than cancelling
   * the protective bracket and leaving the position naked.
   * 
   * Order of operations:
   *   1. Check for open positions FIRST
   *   2. If position exists → find its bracket orders, re-adopt into bot state
   *   3. If NO position → cancel any orphaned orders/strategies (safe)
   * @private
   */
  async _startupSync() {
    try {
      const accountId = this.shared.account.id;
      const contractId = this.contract?.id;
      if (!contractId) return;

      // 1. Check for open positions FIRST — before touching any orders
      const positions = await this.shared.client.getOpenPositions(accountId);
      const myPositions = positions.filter(p => p.contractId === contractId);

      if (myPositions.length > 0) {
        // ── POSITION EXISTS: re-adopt it, keep bracket orders intact ──
        const pos = myPositions[0];
        const side = pos.netPos > 0 ? 'Buy' : 'Sell';
        const qty = Math.abs(pos.netPos);
        const entryPrice = pos.netPrice;

        logger.warn(`${this.tag} [StartupSync] Found existing position: ${side} ${qty} @ ${entryPrice} — re-adopting`);

        // Find bracket orders (stop + target) for this contract
        const workingOrders = await this.shared.client.getWorkingOrders(accountId);
        const myOrders = workingOrders.filter(o => o.contractId === contractId);

        // Identify stop and target from bracket orders:
        // Stop = opposite-side Stop order; Target = opposite-side Limit order
        const exitSide = side === 'Buy' ? 'Sell' : 'Buy';
        let stopOrder = null;
        let targetOrder = null;
        for (const o of myOrders) {
          if (o.action === exitSide && (o.ordType === 'Stop' || o.ordType === 'StopLimit')) {
            stopOrder = o;
          } else if (o.action === exitSide && (o.ordType === 'Limit')) {
            targetOrder = o;
          }
        }

        const stopPrice = stopOrder ? (stopOrder.stopPrice || stopOrder.price) : null;
        const targetPrice = targetOrder ? targetOrder.price : null;

        // Reconstruct currentPosition so bot can track this position
        const { CONTRACTS } = require('../utils/constants');
        const baseSymbol = this.instrumentConfig.baseSymbol || 'MNQ';
        const pv = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;
        const risk = stopPrice ? Math.abs(entryPrice - stopPrice) * qty * pv : 0;

        const adoptedPosition = {
          side,
          quantity: qty,
          entryPrice,
          stopLoss: stopPrice,
          target: targetPrice,
          risk,
          orderId: null,
          stopOrderId: stopOrder ? stopOrder.id : null,
          targetOrderId: targetOrder ? targetOrder.id : null,
          entryTime: new Date(),
          strategyName: 'adopted',
          _adopted: true, // Flag so we know this was re-adopted
        };

        // Install into SignalHandler and Strategy
        this.signalHandler.currentPosition = adoptedPosition;
        this.strategy.setPosition(adoptedPosition);
        this.positionHandler.resetFillAccumulators(); // BUG-6 FIX: Clean slate for adopted position

        // Initialize trailing stop if enabled and we have a stop order
        if (this.trailingStop?.config?.enabled && stopOrder) {
          this.trailingStop.initializeTrail({
            id: stopOrder.id,
            ...adoptedPosition,
            atr: this.strategy.atr || 10,
            stopOrderId: stopOrder.id
          });
        }

        // Initialize profit manager
        this.profitManager.initializePosition({
          id: stopOrder?.id || 'adopted',
          ...adoptedPosition
        });

        const stopInfo = stopPrice ? `stop $${stopPrice.toFixed(2)}` : 'NO STOP ⚠️';
        const targetInfo = targetPrice ? `target $${targetPrice.toFixed(2)}` : 'no target';
        logger.success(`${this.tag} [StartupSync] ✓ Re-adopted position: ${side} ${qty} @ ${entryPrice} | ${stopInfo} | ${targetInfo}`);

        await this.shared.notifications.send(
          `🔄 <b>${this.instrumentConfig.baseSymbol} STARTUP SYNC</b>\n` +
          `Re-adopted position: ${side} ${qty} @ ${entryPrice}\n` +
          `${stopInfo} | ${targetInfo}\n` +
          `Bracket orders preserved.`
        ).catch(() => {});

        // If there's a position but NO stop order, that's dangerous — warn loudly
        if (!stopOrder) {
          logger.error(`${this.tag} [StartupSync] ⚠️ DANGER: Position has no stop order!`);
          await this.shared.notifications.send(
            `🚨 <b>${this.instrumentConfig.baseSymbol} STARTUP SYNC — NO STOP!</b>\n` +
            `Position ${side} ${qty} @ ${entryPrice} has NO stop order.\n` +
            `Manual intervention needed!`
          ).catch(() => {});
        }

      } else {
        // ── NO POSITION: safe to cancel any orphaned orders/strategies ──
        let cancelledCount = 0;

        // Interrupt all active order strategies (OCO brackets)
        try {
          const strategies = await this.shared.client.getOrderStrategies(accountId);
          if (Array.isArray(strategies)) {
            const activeStrategies = strategies.filter(s =>
              s.status === 'ActiveStrategy' || s.status === 'ExecutionSuspended'
            );
            for (const strat of activeStrategies) {
              try {
                await this.shared.client.interruptOrderStrategy(strat.id);
                logger.info(`${this.tag} [StartupSync] Interrupted order strategy ${strat.id}`);
                cancelledCount++;
              } catch (err) {
                logger.debug(`${this.tag} [StartupSync] Interrupt strategy ${strat.id}: ${err.message}`);
              }
            }
          }
        } catch (err) {
          logger.debug(`${this.tag} [StartupSync] Order strategies check: ${err.message}`);
        }

        // Cancel all remaining working/suspended orders for this contract
        const workingOrders = await this.shared.client.getWorkingOrders(accountId);
        const myOrders = workingOrders.filter(o => o.contractId === contractId);
        if (myOrders.length > 0) {
          logger.warn(`${this.tag} [StartupSync] Cancelling ${myOrders.length} orphaned order(s) from previous session`);
          for (const order of myOrders) {
            try {
              await this.shared.client.cancelOrder(order.id);
              logger.info(`${this.tag} [StartupSync] Cancelled order ${order.id} (${order.ordType || order.action || 'unknown'})`);
              cancelledCount++;
            } catch (cancelErr) {
              logger.debug(`${this.tag} [StartupSync] Cancel order ${order.id}: ${cancelErr.message}`);
            }
          }
        }

        if (cancelledCount > 0) {
          logger.info(`${this.tag} [StartupSync] ✓ ${cancelledCount} orphaned order(s)/strategies cancelled, no open position — clean start`);
        } else {
          logger.info(`${this.tag} [StartupSync] ✓ No orphaned orders or positions — clean start`);
        }
      }
    } catch (err) {
      logger.warn(`${this.tag} [StartupSync] Failed: ${err.message}`);
    }
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

      // Fetch today's bars for full warmup (VWAP, EMAs, bar counts)
      // Databento historical data is ~15-20 min delayed, so end = now - 20 min.
      // The live stream covers the gap from there to real-time.
      const todayStr = `${yyyy}-${mm}-${dd}`;
      const todaySessionStart = `${todayStr}T13:00:00Z`;
      const nowMins = nowPST.hour * 60 + nowPST.minute;

      if (nowMins >= sessionStartMins) {
        // Try with 20-min offset first, fall back to 30-min if Databento rejects
        let todayBars = null;
        for (const offsetMin of [20, 30, 45]) {
          try {
            const endTime = new Date(Date.now() - offsetMin * 60 * 1000).toISOString();
            todayBars = this._usingSharedProvider
              ? await this.priceProvider.getHistoricalBars(this._databentoSymbol, todaySessionStart, endTime, 'ohlcv-1m', 500)
              : await this.priceProvider.getHistoricalBars(todaySessionStart, endTime, 'ohlcv-1m', 500);
            break; // success
          } catch (err) {
            if (offsetMin < 45) {
              logger.warn(`${this.tag} Today fetch (end=now-${offsetMin}m) failed, retrying with larger offset...`);
            } else {
              throw err; // give up after last attempt
            }
          }
        }
        try {

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
            // Reset signalFired and clear stale armed setups from replay.
            // A bar-close signal during replay sets signalFired=true and arms tick
            // entries that will never trigger (price has moved on). Clear everything
            // so the first live bar starts with a clean slate.
            if (this.strategy.signalFired && !this.strategy.position) {
              this.strategy.signalFired = false;
            }
            if (typeof this.strategy._disarmAll === 'function') {
              this.strategy._disarmAll();
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
    // CRITICAL: Skip if entry hasn't filled yet (no stopOrderId = OCO not placed).
    // Without this guard, ProfitManager treats the phantom position as real and
    // sends bogus "STOP MOVED" notifications for trades that don't exist on exchange.
    if (this.strategy.position && this.profitManager && this.strategy.position.stopOrderId) {
      const pos = this.strategy.position;
      const posId = pos.orderId || pos.id || pos.clientId || 'active';
      const isLong = pos.side === 'Buy';
      const beCheckPrice = isLong ? bar.high : bar.low;
      const { actions } = this.profitManager.update(posId, beCheckPrice, bar);
      for (const action of actions) {
        if (action.type === 'MOVE_STOP') {
          // HIGH-4 FIX: Await the modifyOrder call, retry once, revert + alert on failure.
          // Previously this was fire-and-forget — if it failed, internal state said BE
          // but exchange stop was still at the original level.
          const oldStop = pos.stopLoss;
          this._modifyStopWithRetry(pos, action.newStop, action.reason, oldStop);
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
      if (this.strategy) this.strategy.onSignalRejected();
      return;
    }

    // HIGH-6 FIX: Account-level max simultaneous position guard.
    // In multi-instrument mode, shared.bot is the MultiInstrumentBot instance.
    // Check if the account already has too many open positions across all instruments.
    if (this.shared.bot && typeof this.shared.bot.canOpenNewPosition === 'function') {
      const posCheck = this.shared.bot.canOpenNewPosition();
      if (!posCheck.allowed) {
        logger.warn(`${this.tag} Signal blocked: Account max positions reached (${posCheck.openCount}/${posCheck.maxAllowed})`);
        if (this.strategy) this.strategy.onSignalRejected();
        return;
      }
    }

    // Tag signal with instrument info
    signal.instrument = this.instrumentConfig.baseSymbol;

    if (signal.strategy && signal.confluenceScore !== undefined) {
      logger.info(`${this.tag} 📊 ${signal.strategy} signal: ${signal.type.toUpperCase()} | Confluence: ${signal.confluenceScore}`);
    }

    // CRITICAL-2 FIX: Reset partial fill accumulators before placing a new entry order
    this.positionHandler.resetFillAccumulators();

    const result = await this.signalHandler.handleSignal(signal);

    // NOTE: onSignalRejected() is already called by SignalHandler.handleSignal() in its
    // finally block when no position was opened. Do NOT call it again here — double-calling
    // causes _tradeCountToday to be decremented twice, drifting trade numbers down all day.

    // Start limit entry timeout if a limit order was placed AND not already filled.
    // CRITICAL: The fill can arrive via WebSocket props routing DURING the await on
    // handleSignal (specifically during placeLimitOrder). If it did, the entryFilled
    // handler already placed the OCO and set stopOrderId. Starting a timeout now
    // would nuke a live, properly-bracketed position 5 minutes later.
    if (result && result.executed && signal.orderType === 'Limit') {
      const pos = this.signalHandler.getPosition();
      if (pos && pos._isLimitEntry && pos.orderId) {
        // If stopOrderId is set, the fill already arrived and OCO was placed — no timeout needed
        if (pos.stopOrderId) {
          logger.info(`${this.tag} Limit order already filled & OCO placed — skipping timeout`);
        } else {
          this._startLimitEntryTimeout(pos.orderId, 5 * 60 * 1000); // 5 minutes
        }
      }
    }

    // FILL WATCHDOG: For market orders (and limit orders that may have filled instantly),
    // start a watchdog that polls the REST API if the WebSocket fill doesn't arrive.
    // This catches the case where the exchange fills the order but the WebSocket
    // never delivers the fill notification — leaving the position NAKED with no OCO.
    if (result && result.executed) {
      const pos = this.signalHandler.getPosition();
      if (pos && pos.orderId && !pos.stopOrderId) {
        this._startFillWatchdog(pos.orderId);
      }
    }
  }

  /**
   * Handle fill notification (called by MultiInstrumentBot when routing fills)
   */
  async handleFill(fill) {
    // CRITICAL-3 FIX: Hardened fill deduplication.
    // Tradovate sends fills via BOTH the 'fill' event and 'props' event (entityType=fill).
    // Both are routed here by MultiInstrumentBot. We must dedup on fill.id (unique per
    // fill record), NOT fill.orderId (same for all fills of one order, including partials).
    // Also build a composite key for extra safety in case fill.id is missing.
    if (!this._processedFillIds) this._processedFillIds = new Set();
    const fillId = fill.id;
    const compositeKey = `${fill.orderId || ''}_${fill.price || ''}_${fill.qty || fill.quantity || ''}_${fill.timestamp || ''}`;
    const dedupKey = fillId ? String(fillId) : compositeKey;

    if (dedupKey && this._processedFillIds.has(dedupKey)) {
      logger.debug(`${this.tag} Fill dedup: skipping already-processed fill (key=${dedupKey})`);
      return { isExit: false };
    }
    if (dedupKey) {
      this._processedFillIds.add(dedupKey);
      // Prevent unbounded growth — keep last 200 fill IDs
      if (this._processedFillIds.size > 200) {
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

    if (!order || !order.ordStatus) return;
    const orderId = order.id || order.orderId;

    // Track bracket order statuses for watchdog verification
    if (this._bracketOrderStatuses.has(orderId)) {
      this._bracketOrderStatuses.set(orderId, order.ordStatus);
    }

    // CRITICAL: Detect rejected stop/target orders while in a position.
    // If our stop or target gets rejected (e.g. stop above market for a long),
    // the position is NAKED — emergency close immediately.
    if (order.ordStatus === 'Rejected') {
      const pos = this.signalHandler.getPosition();
      if (pos && (orderId === pos.stopOrderId || orderId === pos.targetOrderId)) {
        const isStop = orderId === pos.stopOrderId;
        logger.error(`${this.tag} 🚨 CRITICAL: ${isStop ? 'STOP' : 'TARGET'} ORDER REJECTED (orderId=${orderId}) — position is NAKED, emergency closing`);
        this.shared.notifications.send(
          `🚨 <b>NAKED POSITION — ${isStop ? 'STOP' : 'TARGET'} REJECTED</b>\n` +
          `${this.tag} orderId=${orderId}\n` +
          `Emergency closing position...`
        ).catch(() => {});
        this._emergencyCloseAndHalt('BRACKET_ORDER_REJECTED');
      }
    }
  }

  /**
   * Start bracket watchdog after OCO placement.
   * Waits 7 seconds then verifies both stop and target orders reached 'Working' status.
   * If either is Rejected, Canceled, or still PendingNew, emergency close.
   * @param {number} stopOrderId
   * @param {number} targetOrderId
   */
  _startBracketWatchdog(stopOrderId, targetOrderId) {
    // Register both order IDs for status tracking
    this._bracketOrderStatuses.set(stopOrderId, 'PendingNew');
    this._bracketOrderStatuses.set(targetOrderId, 'PendingNew');

    if (this._bracketWatchdogTimer) clearTimeout(this._bracketWatchdogTimer);

    this._bracketWatchdogTimer = setTimeout(async () => {
      const pos = this.signalHandler.getPosition();
      if (!pos) {
        // Position already closed (exit fill arrived), clean up
        this._bracketOrderStatuses.clear();
        return;
      }

      let stopStatus = this._bracketOrderStatuses.get(stopOrderId) || 'Unknown';
      let targetStatus = this._bracketOrderStatuses.get(targetOrderId) || 'Unknown';

      // BUG-9 FIX: If status is still Unknown/PendingNew after 7s, check REST API
      // before triggering emergency close. WebSocket order updates can be delayed.
      const needsRestCheck = (s) => s === 'Unknown' || s === 'PendingNew';
      if (needsRestCheck(stopStatus) || needsRestCheck(targetStatus)) {
        try {
          if (needsRestCheck(stopStatus)) {
            const order = await this.shared.client.request('GET', `/order/item?id=${stopOrderId}`);
            if (order && order.ordStatus) stopStatus = order.ordStatus;
          }
          if (needsRestCheck(targetStatus)) {
            const order = await this.shared.client.request('GET', `/order/item?id=${targetOrderId}`);
            if (order && order.ordStatus) targetStatus = order.ordStatus;
          }
        } catch (err) {
          logger.warn(`${this.tag} Bracket watchdog REST check failed: ${err.message}`);
        }
      }

      const stopOk = stopStatus === 'Working' || stopStatus === 'Filled';
      const targetOk = targetStatus === 'Working' || targetStatus === 'Filled';

      if (stopOk && targetOk) {
        logger.info(`${this.tag} ✓ Bracket watchdog: STOP=${stopStatus}, TARGET=${targetStatus} — fully protected`);
      } else {
        logger.error(`${this.tag} 🚨 BRACKET WATCHDOG: STOP=${stopStatus} (${stopOrderId}), TARGET=${targetStatus} (${targetOrderId}) — NOT fully protected!`);
        this.shared.notifications.send(
          `🚨 <b>BRACKET WATCHDOG — POSITION NOT PROTECTED</b>\n` +
          `${this.tag}\n` +
          `Stop: ${stopStatus} (${stopOrderId})\n` +
          `Target: ${targetStatus} (${targetOrderId})\n` +
          `Emergency closing position...`
        ).catch(() => {});
        await this._emergencyCloseAndHalt('BRACKET_WATCHDOG_FAILED');
      }

      this._bracketOrderStatuses.clear();
    }, 7000);
  }

  /**
   * Handle position update (called by MultiInstrumentBot when routing positions)
   */
  handlePositionUpdate(position) {
    this.positionHandler.handlePositionUpdate(position);
  }

  // ═══════════════════════════════════════════════════════════════
  //  EMERGENCY CLOSE + HALT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Emergency close position and HALT trading for the day.
   * Unlike the old behavior (crash → pm2 restart → repeat), this:
   * 1. Closes the position on exchange
   * 2. Clears internal state
   * 3. Halts via lossLimits so no more trades fire
   * 4. Does NOT crash — bot stays alive but inactive
   */
  async _emergencyCloseAndHalt(reason) {
    const pos = this.signalHandler.getPosition();
    if (!pos) return;

    try {
      const closeAction = pos.side === 'Buy' ? 'Sell' : 'Buy';
      const qty = pos.quantity || 1;

      // Tag position so the fill handler knows this is an emergency close
      // (prevents _determineExitReason from mislabeling it as 'Trailing Stop')
      pos._emergencyCloseReason = reason;

      // Cancel bracket orders
      for (const oid of [pos.stopOrderId, pos.targetOrderId].filter(Boolean)) {
        try { await this.shared.client.cancelOrder(oid); } catch (e) { /* may already be canceled */ }
      }

      // Close position
      await this.shared.client.placeMarketOrder(
        this.shared.account.id,
        this.contract.id,
        qty,
        closeAction
      );
      logger.warn(`${this.tag} ✓ Emergency close executed (${reason})`);

      // Wait for the fill to arrive via WebSocket and exit notification to send.
      // Without this, halt/report notifications fire before the exit notification,
      // causing the trade result (e.g. "PB2m WIN") to appear AFTER "HALTED" in Telegram.
      // If the fill already processed during placeMarketOrder, position is already gone — skip wait.
      if (this.signalHandler.getPosition()) {
        await new Promise(resolve => {
          const timeout = setTimeout(resolve, 3000);
          this.positionHandler.once('positionClosed', () => { clearTimeout(timeout); resolve(); });
        });
      }
    } catch (closeErr) {
      logger.error(`${this.tag} ❌ EMERGENCY CLOSE FAILED: ${closeErr.message} — MANUAL INTERVENTION REQUIRED`);
      await this.shared.notifications.send(
        `🚨🚨 <b>${this.instrumentConfig.baseSymbol} CRITICAL</b>\n` +
        `Emergency close failed (${reason})!\n` +
        `CLOSE MANUALLY NOW!`
      ).catch(() => {});
    }

    // Clear internal position state
    this.signalHandler.clearPosition();
    this.positionHandler.resetFillAccumulators(); // BUG-3 FIX: Prevent stale accumulators
    if (this.strategy) {
      // Only clear if not already null (fill handler may have cleared during await)
      if (this.strategy.position !== null) {
        this.strategy.setPosition(null);
      }
      this.strategy.isActive = false;
    }

    // HALT via loss limits so no more trades fire today
    if (this.lossLimits) {
      this.lossLimits.halt(reason, `Emergency close: ${reason}`);
    }

    logger.error(`${this.tag} 🛑 HALTED for the day: ${reason}`);
    await this.shared.notifications.send(
      `🛑 <b>${this.instrumentConfig.baseSymbol} HALTED</b>\n` +
      `Reason: ${reason}\n` +
      `No more trades today.`
    ).catch(() => {});
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

    // Reset daily loss limits, profit tracking, and clear daily-scoped halts.
    // Without this, a halt from yesterday (profit target, consecutive losses, etc.)
    // would leave strategy.isActive=false permanently when the bot runs continuously.
    if (this.lossLimits) {
      const result = this.lossLimits.resetDaily();
      if (result.wasHalted && this.strategy) {
        this.strategy.isActive = true;
      }
    }

    logger.info(`${this.tag} 🔄 Daily reset`);
  }

  /**
   * EOD force-close any open position
   */
  async eodClose() {
    if (this._eodCloseDoneToday) return;

    // Always clear limit entry timeout at EOD — prevents ghost fills after session close
    this._clearLimitEntryTimeout();

    if (this.signalHandler && this.signalHandler.getPosition()) {
      this._eodCloseDoneToday = true;
      logger.warn(`${this.tag} ⏰ EOD — force-closing position`);
      const pos = this.signalHandler.getPosition();
      try {
        const closeAction = pos.side === 'Buy' ? 'Sell' : 'Buy';

        // Cancel unfilled limit entry order if still pending (no OCO placed yet)
        if (pos._isLimitEntry && pos.orderId && !pos.stopOrderId) {
          try {
            await this.shared.client.cancelOrder(pos.orderId);
            logger.info(`${this.tag} EOD: Cancelled unfilled limit entry ${pos.orderId}`);
            this.strategy.setPosition(null);
            this.signalHandler.clearPosition();
            // Clean up ProfitManager + TrailingStop for the phantom position
            if (this.profitManager) this.profitManager.closePosition(pos.orderId);
            if (this.trailingStop) this.trailingStop.removeTrail(pos.orderId);
            this._eodCloseDoneToday = true;
            return; // No position to flatten — just cancel and exit
          } catch (cancelErr) {
            logger.debug(`${this.tag} EOD: Cancel limit entry ${pos.orderId}: ${cancelErr.message}`);
          }
        }

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
            this.lossLimits.recordTrade(pnl, { symbol: this.contract?.name || 'MNQ', quantity: pos.quantity || 1 });
          }

          // HIGH-2 FIX: Record EOD close in PerformanceTracker so daily reports are accurate.
          // Previously this was missing — EOD-closed trades didn't appear in daily reports.
          if (this.performance) {
            this.performance.recordTrade({
              symbol: this.contract?.name || 'MNQ',
              side: pos.side,
              quantity: pos.quantity || 1,
              entryPrice: pos.entryPrice,
              exitPrice,
              stopLoss: pos.stopLoss,
              target: pos.target,
              pnl,
              exitReason: 'EOD Close'
            });
          }
        }

        if (typeof this.strategy.onTradeResult === 'function') {
          this.strategy.onTradeResult(eodResult);
        }

        // Clean up
        const entryOrderId = pos.orderId;
        this.strategy.setPosition(null);
        this.signalHandler.clearPosition();
        this.positionHandler.resetFillAccumulators(); // BUG-2 FIX: Prevent stale accumulators leaking to next day
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
        this.positionHandler.resetFillAccumulators(); // BUG-2 FIX: error path
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

  /**
   * HIGH-4 FIX: Modify stop order with retry, revert on failure, alert + emergency close.
   * Called from _onBar for BE stop moves and profit-lock moves.
   * Runs async but handles its own errors — does NOT block bar processing.
   * @private
   */
  async _modifyStopWithRetry(pos, newStop, reason, oldStop) {
    // Optimistically update internal state so exit reason detection uses the new stop
    pos.stopLoss = newStop;
    pos.breakEvenMoved = true;
    const shPos = this.signalHandler.getPosition();
    if (shPos) {
      shPos.stopLoss = newStop;
      shPos.breakEvenMoved = true;
    }

    logger.info(`${this.tag} 🔒 BE Stop → requesting $${newStop.toFixed(2)} (${reason})...`);

    let success = false;
    for (let attempt = 1; attempt <= 2 && !success; attempt++) {
      try {
        if (attempt > 1) {
          logger.warn(`${this.tag} Retrying stop modification (attempt ${attempt})...`);
          await new Promise(r => setTimeout(r, 1000));
        }
        await this.shared.client.modifyOrder(pos.stopOrderId, {
          orderType: 'Stop',
          stopPrice: newStop,
          orderQty: pos.quantity || 1,
        });

        // Verify the modification actually took effect on the exchange.
        // Tradovate can return HTTP 200 but silently keep the old stop price
        // (e.g., Buy Stop modified below current market triggers immediate reject).
        await new Promise(r => setTimeout(r, 300));
        try {
          const order = await this.shared.client.getOrder(pos.stopOrderId);
          if (order && order.ordStatus === 'Working') {
            // Check the latest orderVersion's stopPrice via the order's price field
            // Tradovate order item has 'stopPrice' on the orderVersion, but the
            // order/item endpoint may return it directly or via nested fields.
            // Use a tolerance of 0.5pt to account for tick rounding.
            const exchangeStop = order.stopPrice ?? order.price;
            if (exchangeStop !== undefined && Math.abs(exchangeStop - newStop) > 0.5) {
              logger.error(`${this.tag} ⚠️ Stop modification SILENT REJECT: requested $${newStop.toFixed(2)} but exchange has $${exchangeStop.toFixed(2)}`);
              continue; // retry
            }
          } else if (order && (order.ordStatus === 'Filled' || order.ordStatus === 'Cancelled')) {
            logger.warn(`${this.tag} Stop order ${pos.stopOrderId} is ${order.ordStatus} — position may have closed during modification`);
            return; // position gone, nothing to revert
          }
        } catch (verifyErr) {
          logger.warn(`${this.tag} Could not verify stop modification: ${verifyErr.message} — assuming success`);
        }

        success = true;
        logger.success(`${this.tag} ✓ Stop order ${pos.stopOrderId} modified to $${newStop.toFixed(2)} (verified)`);
      } catch (err) {
        logger.error(`${this.tag} ❌ Stop modification attempt ${attempt}/2 failed: ${err.message}`);
      }
    }

    if (success) {
      this.shared.notifications.send(
        `🔒 <b>${this.instrumentConfig.baseSymbol} STOP MOVED</b>\n` +
        `${pos.side} @ $${pos.entryPrice?.toFixed(2) || '?'}\n` +
        `Stop: $${newStop.toFixed(2)} (${reason})`
      ).catch(() => {});
    } else {
      // REVERT internal state — exchange stop is still at oldStop
      logger.error(`${this.tag} 🚨 STOP MODIFICATION FAILED after 2 attempts — reverting internal stop to $${oldStop.toFixed(2)}`);
      pos.stopLoss = oldStop;
      pos.breakEvenMoved = false;
      if (shPos) {
        shPos.stopLoss = oldStop;
        shPos.breakEvenMoved = false;
      }

      await this.shared.notifications.send(
        `🚨 <b>${this.instrumentConfig.baseSymbol} STOP MOVE FAILED</b>\n` +
        `Could not move stop to $${newStop.toFixed(2)} (${reason})\n` +
        `Stop remains at $${oldStop.toFixed(2)}\n` +
        `Monitor position manually!`
      ).catch(() => {});
    }
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
   * Position sync: check bot state vs exchange.
   * 
   * CRITICAL GUARD: If the bot has a position with a pending limit entry
   * (no stopOrderId yet = entry hasn't filled, OCO not placed), we must
   * NOT clear it — the limit order may fill seconds later. Clearing here
   * would orphan the resulting exchange position with no stop/target.
   */
  async syncPosition() {
    try {
      const positions = await this.shared.client.getOpenPositions(this.shared.account.id);
      // Filter to this instrument's contract
      const myPositions = positions.filter(p => p.contractId === this.contract?.id);
      const hasOpenPosition = myPositions.length > 0;
      const botPosition = this.signalHandler.getPosition();
      const botHasPosition = botPosition !== null;

      if (botHasPosition && !hasOpenPosition) {
        // ── GUARD: Don't clear if entry order is still pending ──
        // When using limit entries, the bot sets currentPosition BEFORE the
        // limit fills. The exchange won't show a position until the fill.
        // If we clear now, the fill arrives into a null position → orphaned trade.
        const hasPendingEntry = botPosition && !botPosition.stopOrderId && botPosition._isLimitEntry;
        if (hasPendingEntry) {
          logger.info(`${this.tag} [PositionSync] Bot has pending limit entry (orderId=${botPosition.orderId}) — skipping clear`);
          return;
        }

        // Also check for working entry orders on the exchange as a safety net
        try {
          const workingOrders = await this.shared.client.getWorkingOrders(this.shared.account.id);
          const myEntryOrders = workingOrders.filter(o =>
            o.contractId === this.contract?.id &&
            o.action === botPosition.side &&
            (o.ordType === 'Limit' || o.ordType === 'Market')
          );
          if (myEntryOrders.length > 0) {
            logger.info(`${this.tag} [PositionSync] ${myEntryOrders.length} working entry order(s) found — skipping clear`);
            return;
          }
        } catch (ordErr) {
          logger.debug(`${this.tag} [PositionSync] Working orders check failed: ${ordErr.message}`);
        }

        logger.warn(`${this.tag} [PositionSync] Bot has stale position — clearing`);
        const pos = botPosition;
        const entryOrderId = pos?.orderId;

        // ── CASE A: No stopOrderId means OCO was never placed.
        // This happens when:
        //   1. Entry order was REJECTED (account locked, margin, etc.)
        //   2. Entry fill was missed (WebSocket glitch)
        // In case 1, the order never filled → P&L is $0, not a loss.
        // In case 2, we need to check the exchange for actual fills.
        const hadOCO = !!pos?.stopOrderId;

        // Determine win/loss by checking which exit order filled (stop or target)
        let tradeResult = 'loss'; // default assumption
        let estimatedPnl = -(pos?.risk || 0);
        let exitPrice = null;
        const { CONTRACTS } = require('../utils/constants');
        const baseSymbol = this.instrumentConfig.baseSymbol || 'MNQ';
        const pv = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;

        if (!hadOCO) {
          // No OCO placed — check if the entry order even filled
          let entryFilled = false;
          try {
            if (entryOrderId) {
              const entryFills = await this.shared.client.getFillsByOrder(entryOrderId);
              entryFilled = Array.isArray(entryFills) && entryFills.length > 0;
            }
          } catch (err) {
            logger.debug(`${this.tag} [PositionSync] Could not check entry fills: ${err.message}`);
          }

          if (!entryFilled) {
            // Entry never filled (order was rejected) → P&L is $0, not a real trade
            tradeResult = 'rejected';
            estimatedPnl = 0;
            logger.warn(`${this.tag} [PositionSync] No OCO and no entry fill — order was likely rejected (P&L: $0)`);
          } else {
            // Entry filled but no OCO — position was closed externally (AutoLiq, manual, etc.)
            // Try to find exit fills from recent fills on this contract
            logger.warn(`${this.tag} [PositionSync] Entry filled but no OCO — checking for external exit`);
            try {
              // Check if there are any recent fills that could be the exit
              const recentFills = await this.shared.client.request('GET', `/fill/list?accountId=${this.shared.account.id}`);
              if (Array.isArray(recentFills)) {
                const myExitFills = recentFills.filter(f =>
                  f.contractId === this.contract?.id &&
                  f.action !== pos.side
                ).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
                if (myExitFills.length > 0) {
                  exitPrice = myExitFills[0].price;
                  estimatedPnl = pos.side === 'Buy'
                    ? (exitPrice - pos.entryPrice) * (pos.quantity || 1) * pv
                    : (pos.entryPrice - exitPrice) * (pos.quantity || 1) * pv;
                  const beThreshold = pv * 2 * (pos.quantity || 1);
                  tradeResult = Math.abs(estimatedPnl) <= beThreshold ? 'breakeven' : estimatedPnl > 0 ? 'win' : 'loss';
                }
              }
            } catch (err) {
              logger.warn(`${this.tag} [PositionSync] Could not check recent fills: ${err.message}`);
            }
          }
        } else {
          // Had OCO — check which bracket order filled
          try {
            const stopFills = await this.shared.client.getFillsByOrder(pos.stopOrderId);
            const targetFills = pos.targetOrderId ? await this.shared.client.getFillsByOrder(pos.targetOrderId) : [];

            if (Array.isArray(targetFills) && targetFills.length > 0) {
              exitPrice = targetFills[0].price;
            } else if (Array.isArray(stopFills) && stopFills.length > 0) {
              exitPrice = stopFills[0].price;
            }

            if (exitPrice !== null) {
              estimatedPnl = pos.side === 'Buy'
                ? (exitPrice - pos.entryPrice) * (pos.quantity || 1) * pv
                : (pos.entryPrice - exitPrice) * (pos.quantity || 1) * pv;
              const beThreshold = pv * 2 * (pos.quantity || 1);
              tradeResult = Math.abs(estimatedPnl) <= beThreshold ? 'breakeven' : estimatedPnl > 0 ? 'win' : 'loss';
            }
          } catch (err) {
            logger.warn(`${this.tag} [PositionSync] Could not determine exit fill: ${err.message}`);
          }
        }

        // Only record real trades (not rejected orders) in strategy and loss limits
        if (tradeResult !== 'rejected') {
          if (typeof this.strategy.onTradeResult === 'function') {
            this.strategy.onTradeResult(tradeResult);
          }

          if (this.lossLimits) {
            this.lossLimits.recordTrade(estimatedPnl, { symbol: this.contract?.name || 'MNQ', quantity: pos.quantity || 1 });
          }

          // Record in performance tracker so daily reports are accurate
          if (this.performance && exitPrice !== null) {
            this.performance.recordTrade({
              symbol: this.contract?.name || 'MNQ',
              side: pos.side,
              quantity: pos.quantity || 1,
              entryPrice: pos.entryPrice,
              exitPrice,
              stopLoss: pos.stopLoss,
              target: pos.target,
              pnl: estimatedPnl,
              exitReason: 'position_sync'
            });
          }
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

        if (tradeResult === 'rejected') {
          logger.info(`${this.tag} [PositionSync] Cleared phantom position (order rejected, no P&L impact)`);
          await this.shared.notifications.send(
            `⚠️ <b>${this.instrumentConfig.baseSymbol} POSITION SYNC</b>\n` +
            `Order was rejected — no fill, no P&L.\nPosition state cleared.`
          ).catch(() => {});
        } else {
          const resultEmoji = tradeResult === 'win' ? '💰' : tradeResult === 'breakeven' ? '🔒' : '❌';
          const pnlStr = estimatedPnl >= 0 ? `+$${estimatedPnl.toFixed(2)}` : `-$${Math.abs(estimatedPnl).toFixed(2)}`;
          await this.shared.notifications.send(
            `⚠️ <b>${this.instrumentConfig.baseSymbol} POSITION SYNC</b>\n` +
            `Stale position cleared\n${resultEmoji} Result: ${tradeResult.toUpperCase()} (${pnlStr})`
          ).catch(() => {});
        }
      } else if (!botHasPosition && hasOpenPosition) {
        // ── Exchange has position bot doesn't track — attempt to re-adopt ──
        const pos = myPositions[0];
        const side = pos.netPos > 0 ? 'Buy' : 'Sell';
        const qty = Math.abs(pos.netPos);
        const entryPrice = pos.netPrice;

        logger.error(`${this.tag} [PositionSync] Exchange has position (${pos.netPos} @ ${pos.netPrice}) bot doesn't track — re-adopting`);

        // Find bracket orders (stop + target) for this contract
        let stopOrder = null;
        let targetOrder = null;
        try {
          const workingOrders = await this.shared.client.getWorkingOrders(this.shared.account.id);
          const myOrders = workingOrders.filter(o => o.contractId === this.contract?.id);
          const exitSide = side === 'Buy' ? 'Sell' : 'Buy';
          for (const o of myOrders) {
            if (o.action === exitSide && (o.ordType === 'Stop' || o.ordType === 'StopLimit')) {
              stopOrder = o;
            } else if (o.action === exitSide && (o.ordType === 'Limit')) {
              targetOrder = o;
            }
          }
        } catch (ordErr) {
          logger.warn(`${this.tag} [PositionSync] Could not fetch working orders for re-adopt: ${ordErr.message}`);
        }

        const stopPrice = stopOrder ? (stopOrder.stopPrice || stopOrder.price) : null;
        const targetPrice = targetOrder ? targetOrder.price : null;

        const { CONTRACTS } = require('../utils/constants');
        const baseSymbol = this.instrumentConfig.baseSymbol || 'MNQ';
        const pv = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;
        const risk = stopPrice ? Math.abs(entryPrice - stopPrice) * qty * pv : 0;

        const adoptedPosition = {
          side,
          quantity: qty,
          entryPrice,
          stopLoss: stopPrice,
          target: targetPrice,
          risk,
          orderId: null,
          stopOrderId: stopOrder ? stopOrder.id : null,
          targetOrderId: targetOrder ? targetOrder.id : null,
          entryTime: new Date(),
          strategyName: 'adopted',
          _adopted: true,
        };

        this.signalHandler.currentPosition = adoptedPosition;
        this.strategy.setPosition(adoptedPosition);
        this.positionHandler.resetFillAccumulators(); // BUG-6 FIX: Clean slate for re-adopted position

        if (this.trailingStop?.config?.enabled && stopOrder) {
          this.trailingStop.initializeTrail({
            id: stopOrder.id,
            ...adoptedPosition,
            atr: this.strategy.atr || 10,
            stopOrderId: stopOrder.id
          });
        }

        this.profitManager.initializePosition({
          id: stopOrder?.id || 'adopted',
          ...adoptedPosition
        });

        const stopInfo = stopPrice ? `stop $${stopPrice.toFixed(2)}` : 'NO STOP';
        const targetInfo = targetPrice ? `target $${targetPrice.toFixed(2)}` : 'no target';
        logger.success(`${this.tag} [PositionSync] ✓ Re-adopted: ${side} ${qty} @ ${entryPrice} | ${stopInfo} | ${targetInfo}`);

        await this.shared.notifications.send(
          `🔄 <b>${this.instrumentConfig.baseSymbol} POSITION RE-ADOPTED</b>\n` +
          `${side} ${qty} @ ${entryPrice}\n` +
          `${stopInfo} | ${targetInfo}\n` +
          `Bot is now tracking this position.`
        ).catch(() => {});

        if (!stopOrder) {
          logger.error(`${this.tag} [PositionSync] ⚠️ Re-adopted position has NO stop order!`);
          await this.shared.notifications.send(
            `🚨 <b>${this.instrumentConfig.baseSymbol} RE-ADOPTED — NO STOP!</b>\n` +
            `Position ${side} ${qty} @ ${entryPrice} has no stop.\nManual intervention needed!`
          ).catch(() => {});
        }
      }
    } catch (error) {
      logger.debug(`${this.tag} [PositionSync] Failed: ${error.message}`);
    }
  }

  // ── Limit Entry Timeout ──
  // If a limit entry order isn't filled within timeoutMs, cancel it and reset.

  _startLimitEntryTimeout(orderId, timeoutMs) {
    this._clearLimitEntryTimeout();
    logger.info(`${this.tag} ⏱ Limit entry timeout: cancel orderId=${orderId} in ${(timeoutMs / 1000).toFixed(0)}s if unfilled`);
    this._limitEntryTimer = setTimeout(async () => {
      this._limitEntryTimer = null;
      try {
        logger.warn(`${this.tag} ⏰ Limit entry timeout — cancelling orderId=${orderId}`);
        await this.shared.client.cancelOrder(orderId);
        // Reset strategy & signal handler so new signals can fire
        this.signalHandler.clearPosition();
        this.positionHandler.resetFillAccumulators(); // BUG-4 FIX: Prevent stale accumulators
        if (this.strategy) {
          this.strategy.setPosition(null);
          this.strategy.onSignalRejected();
        }
        // Clean up ProfitManager + TrailingStop for the phantom position
        if (this.profitManager) this.profitManager.closePosition(orderId);
        if (this.trailingStop) this.trailingStop.removeTrail(orderId);
        logger.info(`${this.tag} ✓ Limit entry cancelled, ready for new signals`);
      } catch (err) {
        logger.error(`${this.tag} ❌ Failed to cancel limit entry: ${err.message}`);
      }
    }, timeoutMs);
  }

  _clearLimitEntryTimeout() {
    if (this._limitEntryTimer) {
      clearTimeout(this._limitEntryTimer);
      this._limitEntryTimer = null;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  FILL WATCHDOG: Detects when a market order was filled on the
  //  exchange but the WebSocket fill notification was never delivered.
  //  After a market order is placed, if entryFilled doesn't fire
  //  within 5 seconds, we poll the REST API for fills. If fills exist,
  //  we inject them into handleFill() to trigger OCO placement.
  //  Without this, the position sits NAKED on the exchange.
  // ════════════════════════════════════════════════════════════════════

  _startFillWatchdog(orderId) {
    this._clearFillWatchdog();
    this._fillWatchdogOrderId = orderId;
    logger.info(`${this.tag} ⏱ Fill watchdog: checking orderId=${orderId} in 5s if no WebSocket fill`);
    this._fillWatchdogTimer = setTimeout(async () => {
      this._fillWatchdogTimer = null;
      const pos = this.signalHandler.getPosition();
      // If position already has stopOrderId, entryFilled already fired — all good
      if (!pos || pos.stopOrderId) return;
      // If orderId changed (new trade), skip
      if (pos.orderId !== orderId) return;

      logger.warn(`${this.tag} ⚠️ FILL WATCHDOG: No WebSocket fill received for orderId=${orderId} after 5s — polling REST API`);
      try {
        const fills = await this.shared.client.getFillsByOrder(orderId);
        if (Array.isArray(fills) && fills.length > 0) {
          const fill = fills[0];
          logger.warn(`${this.tag} ⚠️ FILL WATCHDOG: Found fill via REST: ${fill.action} ${fill.qty || 1} @ ${fill.price} — injecting into handleFill`);
          await this.shared.notifications.send(
            `⚠️ <b>${this.instrumentConfig.baseSymbol} FILL WATCHDOG</b>\n` +
            `WebSocket missed fill for order ${orderId}\n` +
            `Recovered via REST: ${fill.action} ${fill.qty || 1} @ ${fill.price}\n` +
            `Placing OCO bracket now...`
          ).catch(() => {});
          // Inject the fill into normal processing — this triggers entryFilled → OCO placement
          await this.handleFill(fill);
        } else {
          // No fills found — order may still be pending or was rejected
          // Check order status
          try {
            const order = await this.shared.client.request('GET', `/order/item?id=${orderId}`);
            if (order && order.ordStatus === 'Rejected') {
              logger.error(`${this.tag} 🚨 FILL WATCHDOG: Order ${orderId} was REJECTED — clearing position`);
              this.signalHandler.clearPosition();
              this.strategy.setPosition(null);
              await this.shared.notifications.send(
                `🚨 <b>${this.instrumentConfig.baseSymbol} ORDER REJECTED</b>\n` +
                `Order ${orderId} rejected: ${order.rejectReason || order.text || 'unknown'}\n` +
                `Position state cleared.`
              ).catch(() => {});
            } else {
              logger.warn(`${this.tag} ⚠️ FILL WATCHDOG: No fills and order status=${order?.ordStatus || 'unknown'} — will retry in 5s`);
              // Retry once more after another 5s
              this._fillWatchdogTimer = setTimeout(async () => {
                this._fillWatchdogTimer = null;
                const pos2 = this.signalHandler.getPosition();
                if (!pos2 || pos2.stopOrderId || pos2.orderId !== orderId) return;

                logger.error(`${this.tag} 🚨 FILL WATCHDOG: Still no fill after 10s — emergency close`);
                await this.shared.notifications.send(
                  `🚨 <b>${this.instrumentConfig.baseSymbol} FILL WATCHDOG TIMEOUT</b>\n` +
                  `No fill received for order ${orderId} after 10s.\n` +
                  `Emergency closing any exchange position...`
                ).catch(() => {});

                // Check if exchange has a position for this contract
                try {
                  const positions = await this.shared.client.getOpenPositions(this.shared.account.id);
                  const myPos = positions.find(p => p.contractId === this.contract?.id);
                  if (myPos && myPos.netPos !== 0) {
                    // Exchange has position — liquidate it
                    await this.shared.client.liquidatePosition(this.shared.account.id, this.contract.id, myPos.netPos);
                    logger.error(`${this.tag} 🚨 FILL WATCHDOG: Liquidated naked exchange position`);
                  }
                } catch (liqErr) {
                  logger.error(`${this.tag} 🚨 FILL WATCHDOG: Liquidation failed: ${liqErr.message}`);
                }

                this.signalHandler.clearPosition();
                this.strategy.setPosition(null);
              }, 5000);
            }
          } catch (orderErr) {
            logger.warn(`${this.tag} FILL WATCHDOG: Could not check order status: ${orderErr.message}`);
          }
        }
      } catch (err) {
        logger.error(`${this.tag} FILL WATCHDOG: REST poll failed: ${err.message}`);
      }
    }, 5000);
  }

  _clearFillWatchdog() {
    if (this._fillWatchdogTimer) {
      clearTimeout(this._fillWatchdogTimer);
      this._fillWatchdogTimer = null;
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    this.isRunning = false;
    this._stopBarWatchdog();
    this._clearLimitEntryTimeout();
    this._clearFillWatchdog();

    if (this.strategy) this.strategy.stop();
    if (this.priceProvider) this.priceProvider.stop();

    logger.info(`${this.tag} Stopped`);
  }
}

module.exports = InstrumentRunner;
