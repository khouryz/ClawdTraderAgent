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

    // Layer 2: Post-fill risk check — emergency close if actual risk is too high
    this.positionHandler.on('postFillRiskExceeded', async (data) => {
      const { fillPrice, actualRisk, maxRisk, position } = data;
      logger.error(`${this.tag} 🚨 POST-FILL RISK EXCEEDED: actual $${actualRisk.toFixed(2)} > 150% of max $${maxRisk}`);

      await this.shared.notifications.send(
        `🚨 <b>${this.instrumentConfig.baseSymbol} POST-FILL RISK EXCEEDED</b>\n` +
        `Fill: $${fillPrice.toFixed(2)}\n` +
        `Actual risk: $${actualRisk.toFixed(2)} (max: $${maxRisk})\n` +
        `Emergency closing position...`
      ).catch(() => {});

      try {
        const closeAction = position.side === 'Buy' ? 'Sell' : 'Buy';
        const qty = position.quantity || 1;

        // Cancel any bracket orders first
        const orderIdsToCancel = [position.stopOrderId, position.targetOrderId].filter(Boolean);
        for (const oid of orderIdsToCancel) {
          try { await this.shared.client.cancelOrder(oid); } catch (e) { /* may not exist yet */ }
        }

        // Close position
        await this.shared.client.placeMarketOrder(
          this.shared.account.id,
          this.contract.id,
          qty,
          closeAction
        );
        logger.warn(`${this.tag} ✓ Emergency close executed (post-fill risk exceeded)`);
      } catch (closeErr) {
        logger.error(`${this.tag} ❌ EMERGENCY CLOSE FAILED: ${closeErr.message} — MANUAL INTERVENTION REQUIRED`);
        await this.shared.notifications.send(
          `🚨🚨 <b>${this.instrumentConfig.baseSymbol} CRITICAL</b>\n` +
          `Post-fill risk exceeded AND emergency close failed!\n` +
          `CLOSE MANUALLY NOW!`
        ).catch(() => {});
      }
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

        // Initialize trailing stop if enabled and we have a stop order
        if (this.config.trailingStopEnabled && stopOrder) {
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
    // CRITICAL: Skip if this is an unfilled limit entry (no OCO placed yet).
    // Without this guard, ProfitManager treats the phantom position as real and
    // sends bogus "STOP MOVED" notifications for trades that don't exist on exchange.
    if (this.strategy.position && this.profitManager
        && !(this.strategy.position._isLimitEntry && !this.strategy.position.stopOrderId)) {
      const pos = this.strategy.position;
      const posId = pos.orderId || pos.id || pos.clientId || 'active';
      const isLong = pos.side === 'Buy';
      const beCheckPrice = isLong ? bar.high : bar.low;
      const { actions } = this.profitManager.update(posId, beCheckPrice, bar);
      for (const action of actions) {
        if (action.type === 'MOVE_STOP') {
          logger.success(`${this.tag} 🔒 BE Stop → $${action.newStop.toFixed(2)} (${action.reason})`);

          // Update currentPosition.stopLoss so exit reason detection uses the moved stop
          pos.stopLoss = action.newStop;
          pos.breakEvenMoved = true;
          // Also update SignalHandler's position reference
          const shPos = this.signalHandler.getPosition();
          if (shPos) {
            shPos.stopLoss = action.newStop;
            shPos.breakEvenMoved = true;
          }

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
      if (this.strategy) this.strategy.onSignalRejected();
      return;
    }

    // Tag signal with instrument info
    signal.instrument = this.instrumentConfig.baseSymbol;

    if (signal.strategy && signal.confluenceScore !== undefined) {
      logger.info(`${this.tag} 📊 ${signal.strategy} signal: ${signal.type.toUpperCase()} | Confluence: ${signal.confluenceScore}`);
    }

    const result = await this.signalHandler.handleSignal(signal);

    // If signal was rejected (slippage guard, risk validation, AI, etc.), reset strategy state
    // so signalFired and _tradeCountToday don't stay stuck from the tick/bar-close trigger
    if (result && !result.executed) {
      if (this.strategy) this.strategy.onSignalRejected();
    }

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

        if (this.config.trailingStopEnabled && stopOrder) {
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

  /**
   * Graceful shutdown
   */
  async shutdown() {
    this.isRunning = false;
    this._stopBarWatchdog();
    this._clearLimitEntryTimeout();

    if (this.strategy) this.strategy.stop();
    if (this.priceProvider) this.priceProvider.stop();

    logger.info(`${this.tag} Stopped`);
  }
}

module.exports = InstrumentRunner;
