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
const ConfigValidator = require('../utils/config_validator');
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
    const accountId = shared.accountId || '';
    this.tag = accountId ? `[${accountId}][${instrumentConfig.baseSymbol}]` : `[${instrumentConfig.baseSymbol}]`;
    // In multi-account mode, only the primary logger emits data/signal logs.
    // Execution logs (orders, fills, P&L) always emit from every account.
    this._logDataSignals = shared.isPrimaryLogger !== false;

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
    this._lastTickHigh = null;
    this._lastTickLow = null;
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

    // External-fill detection: orderIds the BOT placed (entry + OCO stop/target,
    // long-lived) plus a short window after the bot opens/closes a position (covers
    // the fill-arrives-before-we-recorded-the-id race). A fill outside both = a
    // manual/external order on the account. Diagnostic only — see handleFill.
    this._botOrderIds = new Set();
    this._botActionUntil = 0;

    // Entry cutoff
    this._lastEntryHourPST = instrumentConfig.lastEntryHour || 11;
    this._lastEntryMinutePST = instrumentConfig.lastEntryMinute || 0;

    // SKIP_HOURS: surgical chop-window veto.
    // Accepts either a pre-parsed array of {start,end} ranges (preferred — MultiInstrumentBot
    // pre-parses via ConfigValidator.parseSkipHours) OR a raw string to parse here.
    if (Array.isArray(instrumentConfig.skipHourRanges)) {
      this._skipHourRanges = instrumentConfig.skipHourRanges;
    } else if (typeof instrumentConfig.skipHours === 'string' && instrumentConfig.skipHours.trim()) {
      this._skipHourRanges = ConfigValidator.parseSkipHours(instrumentConfig.skipHours);
    } else {
      this._skipHourRanges = [];
    }
    if (this._skipHourRanges.length > 0 && this._logDataSignals) {
      const summary = this._skipHourRanges
        .map(r => {
          const sh = Math.floor(r.start / 60), sm = r.start % 60;
          const eh = Math.floor(r.end / 60), em = r.end % 60;
          return `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}-${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
        })
        .join(', ');
      logger.info(`${this.tag} SKIP_HOURS active: ${summary} (PT)`);
    }

    // Post-reconnect cooldown: timestamp-based, RESETS (never compounds) on each reconnect
    this._reconnectCooldownUntil = null;
    this._reconnectCooldownTimer = null;
  }

  /**
   * Start post-reconnect cooldown — RESETS timer on each call (never compounds).
   * Suppresses new signal execution for N minutes while indicators rebuild on fresh data.
   * Bars, ticks, and existing position management continue normally.
   * @param {number} droppedBars - Number of bars dropped during the disconnect
   * @param {number} downtimeMs - Duration of the disconnect in milliseconds
   */
  startReconnectCooldown(droppedBars, downtimeMs = 0) {
    const gc = this.shared.globalConfig;
    const cooldownMins = gc.postReconnectCooldownMins || 10;
    const minDropped = gc.postReconnectMinDroppedBars || 3;

    // Only apply cooldown if enough bars were dropped to affect indicator reliability
    if (droppedBars < minDropped) {
      if (this._logDataSignals) logger.info(`${this.tag} [RECONNECT] ${droppedBars} bar(s) dropped (< ${minDropped} threshold) — no cooldown needed`);
      return;
    }

    // RESET (not add) — always cooldownMins from NOW, regardless of any existing cooldown
    const cooldownMs = cooldownMins * 60 * 1000;
    this._reconnectCooldownUntil = Date.now() + cooldownMs;
    this._j((j) => j.incident('reconnectCooldown', { droppedBars, downtimeMs }));

    // Clear any existing expiry timer to prevent stale expiry logs
    if (this._reconnectCooldownTimer) {
      clearTimeout(this._reconnectCooldownTimer);
      this._reconnectCooldownTimer = null;
    }

    const downtimeSec = (downtimeMs / 1000).toFixed(1);
    if (this._logDataSignals) logger.warn(`${this.tag} [RECONNECT COOLDOWN] 🕐 ${cooldownMins}min cooldown started — ${droppedBars} bars dropped, ${downtimeSec}s downtime`);

    // Telegram notification: cooldown started
    if (this.shared.notifications) {
      this.shared.notifications.send(
        `🕐 <b>${this.instrumentConfig.baseSymbol} RECONNECT COOLDOWN</b>\n` +
        `Signals suppressed for ${cooldownMins} minutes.\n` +
        `Bars dropped: ${droppedBars} | Downtime: ${downtimeSec}s\n` +
        `Indicators rebuilding on fresh data.\n` +
        `Bars, ticks, and existing positions unaffected.`
      ).catch(() => {});
    }

    // Schedule expiry log + Telegram notification
    this._reconnectCooldownTimer = setTimeout(() => {
      this._reconnectCooldownUntil = null;
      this._reconnectCooldownTimer = null;
      logger.info(`${this.tag} [RECONNECT COOLDOWN] ✅ Cooldown expired — ready for new signals`);
      if (this.shared.notifications) {
        this.shared.notifications.send(
          `✅ <b>${this.instrumentConfig.baseSymbol} COOLDOWN EXPIRED</b>\n` +
          `Post-reconnect cooldown complete. Signals re-enabled.`
        ).catch(() => {});
      }
    }, cooldownMs);
  }

  /**
   * Initialize all per-instrument components
   * Contract must be resolved before calling this
   */
  async initialize() {
    const { instrumentConfig: ic, shared } = this;
    const gc = shared.globalConfig;
    const sp = ic.strategyParams || {};

    // Cancel-if-unfilled window for marketable-limit entries (MES). Default 180s
    // (3 min). Only used when entryOrderType === 'Limit'; market entries never
    // arm this timer.
    this._limitEntryTimeoutMs = (sp.limitEntryTimeoutSec !== undefined ? sp.limitEntryTimeoutSec : 180) * 1000;

    // Resolve contract
    if (ic.autoRollover !== false) {
      this.contract = await shared.client.getFrontMonthContract(ic.baseSymbol);
    } else {
      this.contract = await shared.client.findContract(ic.symbol);
    }
    if (this._logDataSignals) logger.info(`${this.tag} Contract: ${this.contract.name} (ID: ${this.contract.id})`);

    // Build a merged config for managers that expect the full config shape
    const mergedConfig = this._buildMergedConfig();

    // ── Managers ──
    this.sessionFilter = new SessionFilter(mergedConfig);
    this.riskManager = new RiskManager(mergedConfig);

    // Per-instrument data dir: loss-limits + performance use FIXED filenames
    // (loss_limits_state.json / trades.json), so under one shared account dir MNQ
    // and MES would clobber each other's risk/P&L state on restart. Scope each
    // instrument to its own subdir.
    const instrDataDir = shared.dataDir ? `${shared.dataDir}/${ic.baseSymbol}` : mergedConfig.dataDir;
    this._instrDataDir = instrDataDir;  // logged in EFFECTIVE CONFIG as isolation proof
    this.lossLimits = new LossLimitsManager({ ...mergedConfig, dataDir: instrDataDir });
    this.lossLimits.on('halt', async (data) => {
      logger.error(`${this.tag} 🛑 TRADING HALTED: ${data.message}`);
      this._j((j) => j.incident('halt', { reason: data.reason, message: data.message }));
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

    // Re-activate strategy when trading is resumed via /forceresume
    this.lossLimits.on('resumed', () => {
      logger.info(`${this.tag} ▶️ Trading RESUMED — strategy re-activated`);
      if (this.strategy) {
        this.strategy.isActive = true;
        this.strategy._consecutiveLosses = 0; // Reset strategy's counter too
      }
    });

    // Per-instrument risk-counter trace. This LossLimitsManager is private to THIS
    // runner (own instance, own state file under instrDataDir, own MNQ_*/MES_*-loaded
    // limits), so every closed trade logs THIS instrument's isolated running totals —
    // making the independence of MNQ vs MES daily-loss / weekly-loss / consecutive-loss
    // tracking directly observable in the logs. (Counters are post-trade; if this trade
    // breaches a limit the dedicated 🛑 halt line follows immediately.)
    this.lossLimits.on('tradeRecorded', (t) => {
      const s = this.lossLimits.getStatus();
      const money = (v) => (v >= 0 ? `+$${v.toFixed(0)}` : `-$${Math.abs(v).toFixed(0)}`);
      logger.info(`${this.tag} 📊 risk [isolated → ${this._instrDataDir}]: this trade ${money(t.pnl)} | ` +
        `daily ${money(s.dailyPnL)} of -$${s.limits.dailyLossLimit} (room $${Math.max(0, s.dailyLossRemaining).toFixed(0)}) | ` +
        `weekly ${money(s.weeklyPnL)} of -$${s.limits.weeklyLossLimit} | ` +
        `consecLoss ${s.consecutiveLosses}/${s.limits.maxConsecutiveLosses} | trades today ${s.tradesToday}`);
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
      beSteps: sp.beSteps || null,
    });

    this.performance = new PerformanceTracker({ dataDir: instrDataDir });
    // Single choke point for the trade journal (⑤): every exit path funnels through
    // PerformanceTracker.recordTrade → 'tradeRecorded'. We attach MAE/MFE + correlation.
    this.performance.on('tradeRecorded', (rec) => this._journalTradeClosed(rec));

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
    this._logEffectiveConfig();
  }

  /**
   * Log the EFFECTIVE, RESOLVED config for this instrument on THIS account at
   * startup — both the values LOADED from this account's .env AND the constants
   * HARDCODED in code — so a deploy can be confirmed from the logs without reading
   * source. Reads straight from the live objects (strategy / confluenceScorer /
   * profitManager / riskParams) so the printout can NEVER drift from what is
   * actually running. Prints once per runner with this.tag, so every linked login
   * (account1.env, account2.env, …) emits its OWN block. Not gated by the
   * primary-logger dedup — we WANT each account's resolved config visible.
   * @private
   */
  _logEffectiveConfig() {
    try {
      const { instrumentConfig: ic, shared } = this;
      const sp = ic.strategyParams || {};
      const rp = ic.riskParams || {};
      const gc = shared.globalConfig || {};
      const L = (s) => logger.info(`${this.tag} ${s}`);
      const hh = (h, m) => `${h}:${String(m).padStart(2, '0')}`;

      L('━━━━━━━━━━ EFFECTIVE CONFIG (loaded .env + hardcoded) ━━━━━━━━━━');
      L(`  strategy=${ic.strategy}  contract=${this.contract ? this.contract.name : '?'} (${ic.databentoSymbol})  autoRollover=${ic.autoRollover !== false}`);
      // Isolation proof — make multi-instrument separation auditable from the logs:
      // each runner owns its OWN data dir (loss-limits + performance + journals), its
      // OWN Databento feed, and tags every journal record with this instrument. If two
      // instruments are live on this login, each prints a DISTINCT dataDir here.
      L(`  [isolation] dataDir=${this._instrDataDir} | feed=${ic.databentoSymbol} | own loss-limits + performance + journals (records tagged instrument=${ic.baseSymbol})`);

      if (/mnq_momentum/i.test(ic.strategy || '') && this.strategy) {
        const st = this.strategy;
        const sc = st.confluenceScorer || {};
        const pm = (this.profitManager && this.profitManager.config) || {};
        const subs = ['PB5m',
          sp.pb3mEnabled ? 'PB3m' : null,
          sp.pb2mEnabled ? 'PB2m' : null,
          sp.emaxEnabled ? 'EMAX' : null,
          (sp.vrEnabled !== false) ? 'VR' : null].filter(Boolean).join('+');
        const ladder = (pm.beSteps && pm.beSteps.length)
          ? pm.beSteps.map(s => `${s.triggerR}R→${s.placementR === 0 ? `entry+${pm.breakEvenOffset}pt` : (s.placementR > 0 ? '+' : '') + s.placementR + 'R'}`).join(', ')
          : 'DISABLED';
        L(`  sub-strategies ON: ${subs}`);
        L(`  [loaded] confluence: shared=${st.minConfluence} PB=${st.pbMinConfluence} PB3m=${st.pb3mMinConfluence} PB2m=${st.pb2mMinConfluence}`);
        L(`  [loaded] target=${sp.profitTargetR}R minTgt=${sp.minTargetPoints}pt | stop max=${sp.maxStopPoints} min=${sp.minStopPoints} buffer=${sp.stopBuffer}pt`);
        L(`  [loaded] BE ladder: moveToBE=${!!sp.moveStopToBE} → ${ladder}`);
        L(`  [loaded] entry timing: cooldown=${sp.cooldownBars}bars consecTicks=${sp.consecTicksRequired} zoneExitMargin=${sp.zoneExitMargin} slippageGuard=${sp.maxEntrySlippagePts}pt deferred=${sp.deferredEntryWindowSec || 60}s`);

        // ── Entry order-type self-verification (Market vs marketable-Limit) ──
        // Proves at startup exactly how THIS instrument will place entries, with the
        // tick buffer resolved to a price using the live contract's tickSize.
        try {
          const isLimit = st.entryOrderType === 'Limit';
          if (isLimit) {
            const specs = this.riskManager.getContractSpecs(ic.symbol);
            const tickSize = specs && specs.tickSize ? specs.tickSize : null;
            const bufTicks = st.entryLimitBufferTicks;
            const bufPts = tickSize != null ? (bufTicks * tickSize) : null;
            const timeoutSec = (this._limitEntryTimeoutMs || 0) / 1000;
            // Sanity checks — any failure flips the READY flag to a loud warning.
            const problems = [];
            if (!(bufTicks >= 0)) problems.push(`buffer ticks invalid (${bufTicks})`);
            if (tickSize == null) problems.push('tickSize unavailable for contract');
            if (!(timeoutSec > 0)) problems.push(`cancel timeout invalid (${timeoutSec}s)`);
            L(`  [ENTRY MODE] 🎯 LIMIT (marketable): buy=signal+${bufTicks}tick sell=signal-${bufTicks}tick${bufPts != null ? ` (±$${bufPts.toFixed(2)}, tickSize=${tickSize})` : ''}`);
            L(`  [ENTRY MODE]    fill-or-cancel: unfilled limit cancelled after ${timeoutSec}s | stop/target stay STRUCTURAL | OCO placed on fill (2 retries + emergency close)`);
            if (problems.length === 0) {
              logger.success(`${this.tag}  ✅ ENTRY MODE READY: ${ic.baseSymbol} marketable-limit @ signal±${bufTicks}tick (±$${bufPts.toFixed(2)}), ${timeoutSec}s cancel — verified`);
            } else {
              logger.error(`${this.tag}  ❌ ENTRY MODE MISCONFIGURED: ${problems.join('; ')} — fix .env before trading`);
            }
          } else {
            L(`  [ENTRY MODE] 🟦 MARKET (default): entries placed at market on signal | slippage guard ${sp.maxEntrySlippagePts}pt + deferred-entry window`);
            logger.success(`${this.tag}  ✅ ENTRY MODE READY: ${ic.baseSymbol} market entry — verified`);
          }
        } catch (eMode) {
          logger.warn(`${this.tag} entry-mode self-check failed: ${eMode.message}`);
        }
        L(`  [hardcoded] RSI veto momentum: long<${sc.rsiOverbought} short>${sc.rsiOversold} | RSI mean-rev(VR): long<35 short>65`);
        L(`  [hardcoded] momentumBars=${sc.momentumBars} volumeAvgPeriod=${sc.volumeAvgPeriod} volumeThresh=${sc.volumeThreshold}x priorLevelTol=${sc.priorLevelTolerance}pt`);
        L(`  [hardcoded] BE offset=${pm.breakEvenOffset}pt (placementR:0 → entry±offset) | tick cadence = 1s bar close (backtest parity)`);
      }

      const rpt = rp.riskPerTrade || {};
      L(`  [loaded] risk: $${rpt.min}-${rpt.max}/trade maxContracts=${rp.maxContracts} dailyLoss=$${rp.dailyLossLimit} weeklyLoss=$${rp.weeklyLossLimit} maxConsecLoss=${rp.maxConsecutiveLosses} maxLoss/day=${sp.maxLossesPerDay != null ? sp.maxLossesPerDay : '?'}`);
      const skip = (this._skipHourRanges || []).map(r =>
        `${hh(Math.floor(r.start / 60), r.start % 60)}-${hh(Math.floor((r.end - 1) / 60), (r.end - 1) % 60)}`).join(', ') || 'none';
      L(`  [loaded] session: entries until ${hh(this._lastEntryHourPST, this._lastEntryMinutePST)} PT | window ${hh(gc.tradingStartHour || 6, gc.tradingStartMinute || 30)}-${hh(gc.tradingEndHour || 13, gc.tradingEndMinute || 0)} PT | skip [${skip}]`);
      logger.success(`${this.tag}  ✅ safety: shared-listener isolation ON | BE safety-net ON (1s force + 3s exchange-confirm)`);
      L('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    } catch (e) {
      logger.warn(`${this.tag} _logEffectiveConfig failed: ${e.message}`);
    }
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
      // Per-account data directory (multi-account isolation for LossLimitsManager, PerformanceTracker)
      dataDir: shared.dataDir || undefined,
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
        // Multi-account dedup: only the primary account prints data-stream price
        // lines (1m/5m OHLCV, heartbeat, 1m REJECT). Signals/orders/BE/fills still
        // log on every account so each account's actions remain auditable.
        quietPriceLogs: !this._logDataSignals,
      });

      const subs = [sp.emaxEnabled ? 'EMAX' : null, 'PB5m', sp.pb3mEnabled ? 'PB3m' : null, sp.pb2mEnabled ? 'PB2m' : null, sp.vrEnabled !== false ? 'VR' : null].filter(Boolean).join('+');
      if (this._logDataSignals) logger.info(`${this.tag} Strategy: MNQ Momentum V2 (${subs})`);

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
      if (this._logDataSignals) logger.info(`${this.tag} Strategy: Liquidity ORB (${setups})`);

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
      if (this._logDataSignals) logger.info(`${this.tag} Strategy: ORB (filters: ${filters.join('+') || 'none'})`);
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

    // Wire tick price getter for slippage guard + deferred entry
    this.signalHandler.setTickPriceGetter(() => {
      if (this._lastTickPrice === null) return null;
      return {
        price: this._lastTickPrice,
        high: this._lastTickHigh,
        low: this._lastTickLow,
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
      this._bracketOrderStatuses.clear();
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
            this._noteBotOrder(stopOrderId);   // OCO legs are bot orders (external-fill detector)
            this._noteBotOrder(targetOrderId);
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
            // Flatten by NET (not a blind market order): the mirror flattens each
            // secondary's OWN net, so a secondary that already exited isn't re-opened.
            // For a single account this is identical to a market close.
            const _net = ocoParams.exitAction === 'Sell' ? ocoParams.contracts : -ocoParams.contracts;
            this._botActionUntil = Date.now() + 8000; // bot-initiated close (external-fill detector)
            await this.shared.client.liquidatePosition(
              ocoParams.accountId,
              this.contract.id,
              _net
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

      // Subscribe to per-symbol events from the shared provider.
      // Store listener refs so we can removeListener on shutdown (prevent leaks).
      const sym = this._databentoSymbol;
      this._sharedListeners = [];
      // ROOT-CAUSE ISOLATION: the SharedPriceProvider fans ONE Databento stream
      // out to EVERY account via a single synchronous emit(). Node calls listeners
      // in registration order; if one account's handler THROWS synchronously, the
      // exception propagates out of emit() and the sibling accounts' listeners
      // (registered after it) are STARVED for that tick — i.e. their _checkTickBE /
      // signal processing silently does not run. That is the mechanism behind the
      // account2 "missed BE" incident (it only surfaced once account1 gained a
      // sub-account, which added work/throw-surface to account1's earlier-
      // registered handler). Wrap every shared listener so a fault in one account
      // can NEVER block another's tick/bar processing. Store the wrapped ref so
      // shutdown's removeListener still works.
      const addShared = (event, fn) => {
        const safe = (payload) => {
          try {
            const r = fn(payload);
            if (r && typeof r.then === 'function') {
              r.catch((e) => logger.error(`${this.tag} shared '${event}' async handler rejected (isolated; siblings unaffected): ${e && e.stack ? e.stack : e}`));
            }
          } catch (e) {
            logger.error(`${this.tag} shared '${event}' handler threw (isolated; siblings unaffected): ${e && e.stack ? e.stack : e}`);
          }
        };
        this._sharedListeners.push({ event, fn: safe });
        this.priceProvider.on(event, safe);
      };

      addShared(`bar:${sym}`, (bar) => this._onBar(bar));
      // 1s bars are our "tick cadence". The 1s close is used for:
      //   - strategy.onTick() — same call signature as the backtester
      //   - _lastTickPrice → slippage guard in SignalHandler
      //   - _checkTickBE() → real-time BE ladder evaluation
      // We no longer subscribe to raw trade prints; the 1s bar is our finest
      // resolution. This matches the backtester exactly (live ↔ backtest parity).
      addShared(`bar1s:${sym}`, (bar1s) => {
        this._lastTickPrice = bar1s.close;
        this._lastTickHigh = bar1s.high;
        this._lastTickLow = bar1s.low;
        this._lastTickReceivedAt = Date.now();
        if (this.strategy && typeof this.strategy.onTick === 'function') {
          this.strategy.onTick({ price: bar1s.close, timestamp: bar1s.timestamp });
        }
        this._checkTickBE(bar1s.close);
        this._checkBEReconcile(bar1s);   // near-immediate BE safety-net + post-move confirm
        this._updateExcursion(bar1s);    // MAE/MFE tracking for the trade journal (⑤)
        // Feed every 1s bar into any pending deferred entry (event-driven, parity
        // with the backtester — every bar evaluated once, no timer sampling).
        if (this.signalHandler && typeof this.signalHandler.feedDeferredTick === 'function') {
          this.signalHandler.feedDeferredTick(bar1s);
        }
      });

      if (this._logDataSignals) logger.info(`${this.tag} Wired to shared Databento stream: ${sym} (1m + 1s)`);

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
      // 1s bars are our "tick cadence". The 1s close is used for:
      //   - strategy.onTick() — same call signature as the backtester
      //   - _lastTickPrice → slippage guard in SignalHandler
      //   - _checkTickBE() → real-time BE ladder evaluation
      // We no longer subscribe to raw trade prints; the 1s bar is our finest
      // resolution. This matches the backtester exactly (live ↔ backtest parity).
      this.priceProvider.on('bar1s', (bar1s) => {
        this._lastTickPrice = bar1s.close;
        this._lastTickHigh = bar1s.high;
        this._lastTickLow = bar1s.low;
        this._lastTickReceivedAt = Date.now();
        if (this.strategy && typeof this.strategy.onTick === 'function') {
          this.strategy.onTick({ price: bar1s.close, timestamp: bar1s.timestamp });
        }
        this._checkTickBE(bar1s.close);
        this._checkBEReconcile(bar1s);   // near-immediate BE safety-net + post-move confirm
        this._updateExcursion(bar1s);    // MAE/MFE tracking for the trade journal (⑤)
        // Feed every 1s bar into any pending deferred entry (event-driven, parity
        // with the backtester — every bar evaluated once, no timer sampling).
        if (this.signalHandler && typeof this.signalHandler.feedDeferredTick === 'function') {
          this.signalHandler.feedDeferredTick(bar1s);
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
        const downtimeMs = data.downtimeMs || 0;
        const downtimeSec = (downtimeMs / 1000).toFixed(1);
        const estimatedDroppedBars = Math.floor(downtimeMs / 60000);
        logger.info(`${this.tag} [Databento] Reconnected after ${downtimeSec}s (~${estimatedDroppedBars} bars dropped) — recovering gap bars`);
        await this._recoverGapBars(data);
        shared.notifications.send(
          `✅ <b>${ic.baseSymbol} RECONNECTED</b>\n` +
          `Downtime: ${downtimeSec}s (${data.attempts || '?'} attempts)\n` +
          `Est. bars dropped: ~${estimatedDroppedBars}`
        ).catch(() => {});

        // Trigger post-reconnect cooldown (evaluates threshold internally)
        this.startReconnectCooldown(estimatedDroppedBars, downtimeMs);
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

      if (this._logDataSignals) logger.info(`${this.tag} Prior day: ${priorDayStr}`);

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
          if (this._logDataSignals) logger.info(`${this.tag} Prior day: ${priorDayBars} bars loaded`);
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
            if (this._logDataSignals) logger.info(`${this.tag} Today: ${todaySessionBars} bars loaded`);
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
        if (this._logDataSignals) logger.warn(`${this.tag} [GAP] ${dropped} bar(s) dropped: ${this._lastSessionBarTs} → ${bar.timestamp}`);
        this._j((j) => j.incident('gap', { dropped, from: this._lastSessionBarTs, to: bar.timestamp }));
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
      const pmState = this.profitManager.getPosition(posId);
      const oldBeStepIndex = pmState ? pmState.beStepIndex : 0;
      const { actions } = this.profitManager.update(posId, beCheckPrice, bar);
      // If multiple steps fired at once, send only one exchange modification (the final stop)
      const stopActions = actions.filter(a => a.type === 'MOVE_STOP');
      if (stopActions.length > 0) {
        const finalAction = stopActions[stopActions.length - 1];
        const oldStop = pos.stopLoss;
        this._armBEConfirm(finalAction.newStop);
        this._modifyStopWithRetry(pos, finalAction.newStop, finalAction.reason, oldStop, oldBeStepIndex);
      }
    }

    // Log OR establishment (ORB strategy only)
    if (this.strategy.orEstablished !== undefined && this.strategy.orEstablished && !this._orLoggedToday) {
      this._orLoggedToday = true;
      const orRange = (this.strategy.orHigh - this.strategy.orLow).toFixed(2);
      if (this._logDataSignals) logger.success(`${this.tag} 📊 OR: $${this.strategy.orLow.toFixed(2)} - $${this.strategy.orHigh.toFixed(2)} (${orRange} pts)`);
      this.shared.notifications.send(`📊 ${this.instrumentConfig.baseSymbol} OR: $${this.strategy.orLow.toFixed(2)} - $${this.strategy.orHigh.toFixed(2)} (${orRange} pts)`).catch(() => {});
    }
  }

  /**
   * Handle trading signal from strategy
   * @private
   */
  async _onSignal(signal) {
    if (this._warmingUp) return;

    // User pause check (via parent bot reference)
    if (this.shared.bot && this.shared.bot._pausedByUser) {
      logger.warn(`${this.tag} Signal blocked: Trading paused by user`);
      this._j((j) => j.signalRejected('paused', { strategy: signal.strategy, type: signal.type, price: signal.price }));
      if (this.strategy) this.strategy.onSignalRejected();
      return;
    }

    // Post-reconnect cooldown: block signals while indicators rebuild on fresh data
    if (this._reconnectCooldownUntil && Date.now() < this._reconnectCooldownUntil) {
      const remainMin = ((this._reconnectCooldownUntil - Date.now()) / 60000).toFixed(1);
      logger.warn(`${this.tag} Signal blocked: post-reconnect cooldown (${remainMin}min remaining)`);
      this._j((j) => j.signalRejected('reconnectCooldown', { strategy: signal.strategy, type: signal.type, price: signal.price }));
      if (this.strategy) this.strategy.onSignalRejected();
      return;
    }

    // Entry cutoff
    if (this._isPastEntryCutoff()) {
      const pst = this._getPSTTime();
      logger.warn(`${this.tag} Signal blocked: Past entry cutoff (${pst.hour}:${String(pst.minute).padStart(2, '0')} PST)`);
      this._j((j) => j.signalRejected('entryCutoff', { strategy: signal.strategy, type: signal.type, price: signal.price }));
      if (this.strategy) this.strategy.onSignalRejected();
      return;
    }

    // SKIP_HOURS: surgical chop-window veto (e.g. 7:00-7:14 PT post-NYSE-open noise)
    if (this._isInSkipWindow()) {
      const pst = this._getPSTTime();
      logger.warn(`${this.tag} Signal blocked: In SKIP_HOURS window (${pst.hour}:${String(pst.minute).padStart(2, '0')} PT)`);
      this._j((j) => j.signalRejected('skipHours', { strategy: signal.strategy, type: signal.type, price: signal.price }));
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
        this._j((j) => j.signalRejected('maxPositions', { strategy: signal.strategy, type: signal.type, price: signal.price, openCount: posCheck.openCount }));
        if (this.strategy) this.strategy.onSignalRejected();
        return;
      }
    }

    // Tag signal with instrument info
    signal.instrument = this.instrumentConfig.baseSymbol;

    if (signal.strategy && signal.confluenceScore !== undefined && this._logDataSignals) {
      logger.info(`${this.tag} 📊 ${signal.strategy} signal: ${signal.type.toUpperCase()} | Confluence: ${signal.confluenceScore}`);
    }

    // CRITICAL-2 FIX: Reset partial fill accumulators before placing a new entry order
    this.positionHandler.resetFillAccumulators();

    // Open the "bot just acted" window BEFORE placing — the entry can fill before
    // handleSignal returns the orderId, so this prevents the external-fill detector
    // from false-flagging our own entry.
    this._botActionUntil = Date.now() + 8000;

    const result = await this.signalHandler.handleSignal(signal);

    // ── Journal the signal outcome (④) + open the correlation trade (⑤) ──
    if (result && result.executed) {
      const pos = this.signalHandler.getPosition();
      const tradeId = (pos && pos.orderId != null) ? String(pos.orderId) : null;
      this._activeTrade = {
        tradeId, entryOrderId: pos ? pos.orderId : null, strategy: signal.strategy,
        signalPrice: signal.price, signalTime: Date.now(),
        side: signal.type === 'buy' ? 'Buy' : 'Sell',
      };
      this._noteBotOrder(pos ? pos.orderId : null); // entry is a bot order (external-fill detector)
      this._j((j) => {
        j.signalTaken({ tradeId, strategy: signal.strategy, type: signal.type, price: signal.price, confluence: signal.confluenceScore, stop: pos && pos.stopLoss, target: pos && pos.target, contracts: pos && pos.quantity });
        j.tradeOpened({ tradeId, strategy: signal.strategy, side: signal.type === 'buy' ? 'Buy' : 'Sell', signalPrice: signal.price, entry: (pos && pos.entryPrice != null) ? pos.entryPrice : signal.price, stop: pos && pos.stopLoss, target: pos && pos.target, contracts: pos && pos.quantity, confluence: signal.confluenceScore });
      });
    } else if (result) {
      const key = this._rejectKey(result.reason);
      this._j((j) => j.signalRejected(key, { strategy: signal.strategy, type: signal.type, price: signal.price, detail: result.reason }));
    }

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
          this._startLimitEntryTimeout(pos.orderId, this._limitEntryTimeoutMs || 180000); // default 3 min
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

  // ═══════════════════════════════════════════════════════════════
  //  JOURNALING HELPERS — structured logging; NEVER affects trading
  // ═══════════════════════════════════════════════════════════════

  /** Run fn with the per-account Journals if present. Swallows everything.
   *  Auto-tags every record with this instrument's baseSymbol so MNQ and MES
   *  records stay distinguishable in the shared per-account journal files. */
  _j(fn) {
    try {
      const j = this.shared && this.shared.journals;
      if (!j) return;
      const inst = this.instrumentConfig.baseSymbol;
      const w = {
        signalTaken: (r) => j.signalTaken({ instrument: inst, ...r }),
        signalRejected: (reason, r) => j.signalRejected(reason, { instrument: inst, ...(r || {}) }),
        order: (r) => j.order({ instrument: inst, ...r }),
        tradeOpened: (r) => j.tradeOpened({ instrument: inst, ...r }),
        tradeClosed: (r) => j.tradeClosed({ instrument: inst, ...r }),
        incident: (c, d) => j.incident(c, { instrument: inst, ...(d || {}) }),
      };
      fn(w);
    } catch (_) { /* logging must never break trading */ }
  }

  /** Map a SignalHandler rejection reason string to a stable journal key. */
  _rejectKey(reason) {
    const r = String(reason || '').toLowerCase();
    if (r.includes('slippage')) return 'slippage';
    if (r.includes('deferred entry')) return 'deferredTimeout';
    if (r.includes('in position')) return 'inPosition';
    if (r.includes('already processing')) return 'processing';
    if (r.includes('ai rejected')) return 'aiRejected';
    if (r.includes('loss') || r.includes('risk') || r.includes('limit') || r.includes('halt')) return 'riskLimit';
    return 'other';
  }

  /** Record a closed trade (subscribed to PerformanceTracker 'tradeRecorded'). */
  _journalTradeClosed(rec) {
    this._j((j) => {
      const exc = this._exc || {};
      const at = this._activeTrade || {};
      j.tradeClosed({
        tradeId: at.tradeId || (rec && rec.id) || null,
        entryOrderId: at.entryOrderId || null,
        strategy: at.strategy || null,
        symbol: rec.symbol, side: rec.side, quantity: rec.quantity,
        entryPrice: rec.entryPrice, exitPrice: rec.exitPrice,
        stopLoss: rec.stopLoss, target: rec.target,
        pnl: rec.pnl, rMultiple: rec.rMultiple, exitReason: rec.exitReason,
        durationSec: at.signalTime ? Math.round((Date.now() - at.signalTime) / 1000) : null,
        maePts: (exc.mae != null) ? Number(exc.mae.toFixed(2)) : null,   // worst adverse excursion (pts)
        mfePts: (exc.mfe != null) ? Number(exc.mfe.toFixed(2)) : null,   // best favorable excursion (pts)
        barsInTrade: exc.bars || null,
      });
    });
    this._activeTrade = null;
    this._exc = null;
  }

  /** Track MAE/MFE (worst-adverse / best-favorable excursion in points) from 1s bars. */
  _updateExcursion(bar) {
    const pos = this.signalHandler && this.signalHandler.getPosition();
    if (!pos || pos.entryPrice == null) { this._exc = null; return; }
    if (!this._exc || this._exc.orderId !== pos.orderId) {
      this._exc = { orderId: pos.orderId, entry: pos.entryPrice, side: pos.side, mae: 0, mfe: 0, bars: 0 };
    }
    const isLong = pos.side === 'Buy';
    const hi = (bar.high != null) ? bar.high : bar.close;
    const lo = (bar.low != null) ? bar.low : bar.close;
    const adverse = isLong ? (pos.entryPrice - lo) : (hi - pos.entryPrice);
    const favorable = isLong ? (hi - pos.entryPrice) : (pos.entryPrice - lo);
    if (adverse > this._exc.mae) this._exc.mae = adverse;
    if (favorable > this._exc.mfe) this._exc.mfe = favorable;
    this._exc.bars++;
  }

  /**
   * Handle fill notification (called by MultiInstrumentBot when routing fills)
   */
  /** Record an orderId the bot placed (entry / OCO leg) for external-fill detection. */
  _noteBotOrder(id) {
    if (id == null) return;
    this._botOrderIds.add(String(id));
    if (this._botOrderIds.size > 300) {
      const first = this._botOrderIds.values().next().value;
      this._botOrderIds.delete(first);
    }
  }

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

    // ── External / manual-fill detector (diagnostic; never alters trading) ──
    // A fill the bot didn't place — not a known entry/OCO leg, and not within the
    // brief window after the bot opened/closed a position — almost always means the
    // account was traded by hand. Manual fills corrupt position/P&L tracking, so make
    // them LOUD + journaled. This is the fastest way to diagnose an account that
    // "doesn't reconcile" (the 2026-06-15 client incident took manual log forensics).
    const at0 = this._activeTrade;
    const recognized = fill.orderId != null && (
      this._botOrderIds.has(String(fill.orderId)) ||
      (at0 && at0.entryOrderId != null && String(at0.entryOrderId) === String(fill.orderId))
    );
    if (fill.orderId != null && !recognized && Date.now() > this._botActionUntil) {
      logger.warn(`${this.tag} ⚠️ EXTERNAL FILL: order ${fill.orderId} (${fill.action} ${fill.qty || fill.quantity || 1} @ ${fill.price}) was NOT placed by the bot — likely a MANUAL/external order on this account. Position & P&L tracking may be affected; halt before hand-trading a live bot account.`);
      this._j((j) => j.incident('externalFill', { orderId: fill.orderId, action: fill.action, qty: fill.qty || fill.quantity || 1, price: fill.price }));
    }

    const result = await this.positionHandler.handleFill(
      fill,
      this.signalHandler.getPosition(),
      this.signalHandler.getTradeId()
    );

    if (result.isFullyClosed) {
      this.signalHandler.clearPosition();
    }

    // Journal the fill (③). For the ENTRY fill, compute realized slippage + latency
    // (signal price → actual fill) — direct evidence of fill quality per account.
    this._j((j) => {
      const at = this._activeTrade;
      const isEntry = at && at.entryOrderId != null && fill.orderId === at.entryOrderId;
      const rec = {
        event: 'fill', orderId: fill.orderId,
        fillPrice: fill.price, qty: (fill.qty != null ? fill.qty : fill.quantity),
        isExit: !!(result && result.isExit), tradeId: at ? at.tradeId : undefined,
      };
      if (isEntry) {
        rec.signalPrice = at.signalPrice;
        rec.slippagePt = (fill.price != null && at.signalPrice != null) ? Number(Math.abs(fill.price - at.signalPrice).toFixed(2)) : null;
        rec.latencyMs = at.signalTime ? (Date.now() - at.signalTime) : null;
      }
      j.order(rec);
    });

    return result;
  }

  /**
   * Handle order update (called by MultiInstrumentBot when routing orders)
   */
  handleOrderUpdate(order) {
    this.positionHandler.handleOrderUpdate(order);

    if (!order || !order.ordStatus) return;
    const orderId = order.id || order.orderId;

    // Track bracket order statuses for watchdog verification AND BE stop verify
    const currentPos = this.signalHandler.getPosition();
    if (this._bracketOrderStatuses.has(orderId) ||
        (currentPos && (orderId === currentPos.stopOrderId || orderId === currentPos.targetOrderId))) {
      this._bracketOrderStatuses.set(orderId, order.ordStatus);
    }

    // CRITICAL: Detect rejected stop/target orders while in a position.
    // If our stop or target gets rejected (e.g. stop above market for a long),
    // the position is NAKED — emergency close immediately.
    if (order.ordStatus === 'Rejected') {
      if (currentPos && (orderId === currentPos.stopOrderId || orderId === currentPos.targetOrderId)) {
        const isStop = orderId === currentPos.stopOrderId;
        logger.error(`${this.tag} 🚨 CRITICAL: ${isStop ? 'STOP' : 'TARGET'} ORDER REJECTED (orderId=${orderId}) — position is NAKED, emergency closing`);
        this.shared.notifications.send(
          `🚨 <b>NAKED POSITION — ${isStop ? 'STOP' : 'TARGET'} REJECTED</b>\n` +
          `${this.tag} orderId=${orderId}\n` +
          `Emergency closing position...`
        ).catch(() => {});
        this._emergencyCloseAndHalt('BRACKET_ORDER_REJECTED');
      }
    }

    // Journal non-fill order status transitions (③) — fills are journaled in handleFill.
    this._j((j) => {
      if (order.ordStatus === 'Filled') return;
      const map = { Working: 'accept', Accepted: 'accept', PendingNew: 'submit', PendingReplace: 'modify', Replaced: 'modify', Canceled: 'cancel', Cancelled: 'cancel', Rejected: 'reject', Expired: 'cancel' };
      const ev = map[order.ordStatus];
      if (!ev) return;
      j.order({ event: ev, orderId, status: order.ordStatus, tradeId: this._activeTrade ? this._activeTrade.tradeId : undefined, reason: ev === 'reject' ? 'exchange rejected' : undefined });
    });
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
        // Position already closed (exit fill arrived)
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

      // Close position by NET (mirror flattens each secondary's OWN net, so an
      // already-exited secondary is not re-opened). Identical to a market close
      // for a single account.
      const _net = closeAction === 'Sell' ? qty : -qty;
      this._botActionUntil = Date.now() + 8000; // bot-initiated close (external-fill detector)
      await this.shared.client.liquidatePosition(
        this.shared.account.id,
        this.contract.id,
        _net
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

  /**
   * Reconcile mirrored sub-accounts against exchange truth so each secondary is
   * protected exactly like the primary (re-bracket / flatten / cancel-stray /
   * BE-sync). No-op for single-account configs (the real client has no such
   * method). Called on the heartbeat, after WS reconnect, and at EOD.
   */
  async reconcileMirroredAccounts() {
    const c = this.shared && this.shared.client;
    if (c && typeof c.reconcileSecondaries === 'function' && this.contract) {
      try { await c.reconcileSecondaries(this.contract.id, this.contract.name); }
      catch (e) { logger.debug(`${this.tag} reconcileMirroredAccounts failed: ${e.message}`); }
    }
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
          // The PRIMARY is flat, but a mirrored secondary may still be open (its
          // bracket didn't fill the same instant) — reconcile flattens any leftover.
          await this.reconcileMirroredAccounts();
          return;
        }

        // Position still open — flatten by NET. The mirror flattens each secondary's
        // OWN net (an already-exited secondary is NOT re-opened); identical to a
        // market close for a single account.
        const _net = closeAction === 'Sell' ? pos.quantity : -pos.quantity;
        this._botActionUntil = Date.now() + 8000; // bot-initiated close (external-fill detector)
        const eodOrder = await this.shared.client.liquidatePosition(
          this.shared.account.id,
          this.contract.id,
          _net
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

        // Sweep mirrored secondaries: cancel any stray bracket legs / flatten any
        // that didn't exit alongside the primary.
        await this.reconcileMirroredAccounts();
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
      // No primary position — still make sure no mirrored secondary is left exposed.
      await this.reconcileMirroredAccounts();
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
   * Check whether current PT clock time falls inside any configured SKIP_HOURS window.
   * Used to veto signals during known chop windows (e.g. 7:00-7:14 PT post-NYSE-open).
   * Returns false when no ranges are configured.
   * @private
   * @returns {boolean}
   */
  _isInSkipWindow() {
    if (!this._skipHourRanges.length) return false;
    const pst = this._getPSTTime();
    const mins = pst.hour * 60 + pst.minute;
    return ConfigValidator.isInSkipWindow(mins, this._skipHourRanges);
  }

  /**
   * Real-time tick-based breakeven check.
   * Called on every Databento trade print while in a position.
   * Moves stop to BE immediately when price reaches the trigger threshold,
   * instead of waiting for the 1-minute bar to close.
   * @param {number} tickPrice - Current tick price
   * @private
   */
  _checkTickBE(tickPrice) {
    // Only check if we have an active position with OCO placed and pending ladder steps
    const pos = this.strategy?.position;
    if (!pos || !pos.stopOrderId || !this.profitManager) return;

    const posId = pos.orderId || pos.id || pos.clientId || 'active';
    const pmState = this.profitManager.getPosition(posId);
    if (!pmState || pmState.beStepIndex >= this.profitManager.config.beSteps.length) return;

    // Validate tick price is reasonable — reject contaminated/stale ticks.
    // Use riskAmount (stop distance) as the anchor: no real tick should be
    // more than 5R from entry while stop is still at its original level.
    // TP is typically 2.5R, so 5R gives 2× safety margin while catching
    // contaminated ticks (e.g. the 149R tick from $26297.75).
    const maxDeviationPts = pmState.riskAmount * 5;
    const tickDeviation = Math.abs(tickPrice - pmState.entryPrice);
    if (tickDeviation > maxDeviationPts) {
      logger.warn(`${this.tag} ⚠️ Ignoring unrealistic tick $${tickPrice.toFixed(2)} for BE (entry: $${pmState.entryPrice.toFixed(2)}, ${(tickDeviation / pmState.riskAmount).toFixed(1)}R deviation, max: 5R)`);
      return;
    }

    // Check if tick price has reached the next pending step's trigger threshold
    const isLong = pos.side === 'Buy';
    const priceDiff = isLong ? tickPrice - pmState.entryPrice : pmState.entryPrice - tickPrice;
    const currentR = priceDiff / pmState.riskAmount;

    const nextStep = this.profitManager.config.beSteps[pmState.beStepIndex];
    if (currentR >= nextStep.triggerR) {
      const oldBeStepIndex = pmState.beStepIndex;
      const { actions } = this.profitManager.update(posId, tickPrice);
      // If multiple steps fired at once, send only one exchange modification (the final stop)
      const stopActions = actions.filter(a => a.type === 'MOVE_STOP');
      if (stopActions.length > 0) {
        const finalAction = stopActions[stopActions.length - 1];
        const oldStop = pos.stopLoss;
        logger.info(`${this.tag} ⚡ Real-time stop ladder step ${oldBeStepIndex + 1} triggered by tick @ $${tickPrice.toFixed(2)} (${currentR.toFixed(2)}R)`);
        this._armBEConfirm(finalAction.newStop);
        this._modifyStopWithRetry(pos, finalAction.newStop, finalAction.reason, oldStop, oldBeStepIndex);
      }
    }
  }

  /**
   * BE safety-net + post-move confirmation. Runs every 1s alongside _checkTickBE
   * so protection is near-immediate (≤1-2s), for EVERY account & sub-account.
   *   (1) Tracks favorable excursion since entry INDEPENDENTLY of ProfitManager
   *       state, so the same desync that broke the primary BE path cannot fool it.
   *       If price reached the BE-trigger R but the stop was never moved, it forces
   *       the BE move that same second.
   *   (2) For ~3s after ANY BE move it re-reads the exchange stop and re-issues the
   *       modify if it didn't land; alerts if still unconfirmed. The OrderMirror
   *       replicates the move to sub-accounts and the confirm nudges reconcile.
   * @private
   */
  _checkBEReconcile(bar1s) {
    const pos = this.signalHandler && this.signalHandler.getPosition();
    if (!pos || pos.entryPrice == null) { this._beFav = null; this._beConfirm = null; return; }
    const steps = this.profitManager && this.profitManager.config && this.profitManager.config.beSteps;
    if (!steps || !steps.length) return;

    // Favorable excursion since entry — independent of ProfitManager.
    const isLong = pos.side === 'Buy';
    const ext = isLong ? (bar1s.high != null ? bar1s.high : bar1s.close)
                       : (bar1s.low != null ? bar1s.low : bar1s.close);
    this._beFav = (this._beFav == null) ? pos.entryPrice
      : (isLong ? Math.max(this._beFav, ext) : Math.min(this._beFav, ext));

    // (1) Confirm a recent BE move actually landed (re-checks each tick for ~3s).
    if (this._beConfirm && pos.stopOrderId) this._confirmBEMoved(pos);

    // (2) Safety-net: BE trigger reached but stop never moved -> force it NOW.
    if (pos.breakEvenMoved || this._beForcing) return;
    const risk = Math.abs(pos.entryPrice - pos.stopLoss);
    if (!(risk > 0)) return;
    const triggerR = steps[0].triggerR || 1.0;
    const favR = (isLong ? this._beFav - pos.entryPrice : pos.entryPrice - this._beFav) / risk;
    if (favR < triggerR) return;
    if (!pos.stopOrderId) {
      if (!pos._beNoStopWarned) {
        pos._beNoStopWarned = true;
        logger.error(`${this.tag} 🚨 BE safety-net: reached ${favR.toFixed(2)}R but NO stopOrderId tracked — cannot auto-move BE; MANUAL CHECK ADVISED`);
      }
      return;
    }
    this._beForcing = true;
    this._armBEConfirm(pos.entryPrice);
    logger.warn(`${this.tag} 🛟 BE safety-net: reached ${favR.toFixed(2)}R but stop never moved — forcing BE to $${pos.entryPrice.toFixed(2)}`);
    this._j((j) => j.incident('beSafetyNet', { favR: Number(favR.toFixed(2)), entry: pos.entryPrice, orderId: pos.stopOrderId }));
    Promise.resolve(this._modifyStopWithRetry(pos, pos.entryPrice, 'BE safety-net (tick)', pos.stopLoss, 0))
      .catch(() => {}).finally(() => { this._beForcing = false; });
  }

  /** Arm a ~3s window to confirm a BE stop actually landed on the exchange. */
  _armBEConfirm(expectedStop) {
    this._beConfirm = { until: Date.now() + 3000, expected: expectedStop, lastCheck: 0, inFlight: false };
  }

  /** Verify (≤1/s) the working stop is at BE; re-issue if not; alert if it never confirms. */
  _confirmBEMoved(pos) {
    const c = this._beConfirm;
    if (!c || c.inFlight) return;
    if (Date.now() - c.lastCheck < 900) return;            // rate-limit to ~1/s
    c.lastCheck = Date.now(); c.inFlight = true;
    (async () => {
      try {
        const order = await this.shared.client.getOrder(pos.stopOrderId);
        const st = order && order.ordStatus;
        if (st === 'Filled' || st === 'Cancelled') { this._beConfirm = null; return; } // resolved
        const exch = order ? (order.stopPrice != null ? order.stopPrice
          : (order.price != null ? order.price : order.stop)) : undefined;
        if (exch != null) {
          // REST echoed a stop price — trust it directly.
          if (Math.abs(exch - c.expected) <= 0.5) {
            this._beConfirm = null;                          // confirmed at BE
            Promise.resolve(this.reconcileMirroredAccounts()).catch(() => {}); // verify sub-accounts too
          } else if (Date.now() <= c.until) {
            logger.warn(`${this.tag} 🛟 BE not confirmed (stop ${exch} ≠ ${c.expected.toFixed(2)}) — re-issuing`);
            await this._modifyStopWithRetry(pos, c.expected, 'BE confirm retry', pos.stopLoss, 0);
          } else {
            logger.error(`${this.tag} 🚨 BE NOT confirmed after 3s — stop may not be at BE! MANUAL CHECK ADVISED`);
            this._beConfirm = null;
          }
        } else {
          // Tradovate's REST /order/item frequently OMITS stopPrice, so a null readback
          // is NOT evidence the move failed — it just can't be read this way. Fall back to
          // the WS-tracked order status, the same basis _modifyStopWithRetry uses to declare
          // success. Only re-issue if WS shows the order actually Rejected/Cancelled; a live
          // (Working/PendingReplace) order means the move landed. This removes the false
          // "not confirmed" loop that re-issued the move and spammed STOP MOVED alerts.
          const wsStatus = this._bracketOrderStatuses?.get(pos.stopOrderId);
          if (wsStatus === 'Rejected' || wsStatus === 'Cancelled') {
            if (Date.now() <= c.until) {
              logger.warn(`${this.tag} 🛟 BE rejected (WS ${wsStatus}) — re-issuing`);
              await this._modifyStopWithRetry(pos, c.expected, 'BE confirm retry', pos.stopLoss, 0);
            } else {
              logger.error(`${this.tag} 🚨 BE NOT confirmed after 3s (WS ${wsStatus}) — MANUAL CHECK ADVISED`);
              this._beConfirm = null;
            }
          } else {
            this._beConfirm = null;                          // live order, no contradiction → confirmed
            Promise.resolve(this.reconcileMirroredAccounts()).catch(() => {});
          }
        }
      } catch (_) { /* try again next tick */ }
      finally { if (this._beConfirm) this._beConfirm.inFlight = false; }
    })();
  }

  /**
   * HIGH-4 FIX: Modify stop order with retry, revert on failure, alert + emergency close.
   * Called from _onBar for BE stop moves and profit-lock moves.
   * Runs async but handles its own errors — does NOT block bar processing.
   * @private
   */
  async _modifyStopWithRetry(pos, newStop, reason, oldStop, oldBeStepIndex = 0) {
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
          const ordSt = order?.ordStatus;
          if (order && (ordSt === 'Working' || ordSt === 'PendingReplace')) {
            // Try to read stop price from order response. Tradovate /order/item
            // may or may not include stopPrice directly — check multiple fields.
            const exchangeStop = order.stopPrice ?? order.price ?? order.stop;
            if (exchangeStop === undefined) {
              // Cannot read back stop price from REST — use WebSocket-based check.
              // Look at the latest order status we tracked from WebSocket props.
              const wsStatus = this._bracketOrderStatuses?.get(pos.stopOrderId);
              if (wsStatus === 'Rejected' || wsStatus === 'Cancelled') {
                logger.error(`${this.tag} ⚠️ Stop modification REJECTED (WebSocket status: ${wsStatus})`);
                continue; // retry
              }
              // If WS shows Working/PendingReplace, the modify likely went through.
              logger.info(`${this.tag} ℹ️ REST /order/item lacks stopPrice field — WS status: ${wsStatus || 'unknown'}, proceeding`);
            } else if (Math.abs(exchangeStop - newStop) > 0.5) {
              logger.error(`${this.tag} ⚠️ Stop modification SILENT REJECT: requested $${newStop.toFixed(2)} but exchange has $${exchangeStop.toFixed(2)}`);
              continue; // retry
            }
          } else if (order && (ordSt === 'Rejected')) {
            logger.error(`${this.tag} ⚠️ Stop modification REJECTED by exchange (REST status: Rejected)`);
            continue; // retry
          } else if (order && (ordSt === 'Filled' || ordSt === 'Cancelled')) {
            logger.warn(`${this.tag} Stop order ${pos.stopOrderId} is ${ordSt} — position may have closed during modification`);
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
      // Don't re-notify on confirmation retries — the original BE move already sent a
      // "STOP MOVED" alert; a retry at the same price would just spam Telegram.
      if (!/confirm retry/i.test(reason)) {
        this.shared.notifications.send(
          `🔒 <b>${this.instrumentConfig.baseSymbol} STOP MOVED</b>\n` +
          `${pos.side} @ $${pos.entryPrice?.toFixed(2) || '?'}\n` +
          `Stop: $${newStop.toFixed(2)} (${reason})`
        ).catch(() => {});
      }
    } else {
      // REVERT internal state — exchange stop is still at oldStop
      logger.error(`${this.tag} 🚨 STOP MODIFICATION FAILED after 2 attempts — reverting internal stop to $${oldStop.toFixed(2)}`);
      pos.stopLoss = oldStop;
      pos.breakEvenMoved = oldBeStepIndex > 0;
      if (shPos) {
        shPos.stopLoss = oldStop;
        shPos.breakEvenMoved = oldBeStepIndex > 0;
      }

      // CRITICAL: Revert ProfitManager state so tick/bar-based check will retry
      // Without this, ProfitManager thinks the step succeeded and never tries again.
      const posId = pos.orderId || pos.id || pos.clientId || 'active';
      if (this.profitManager) {
        this.profitManager.revertBreakEven(posId, oldStop, oldBeStepIndex);
        logger.info(`${this.tag} ProfitManager stop ladder reverted to step ${oldBeStepIndex} — will retry on next tick/bar`);
      }

      await this.shared.notifications.send(
        `🚨 <b>${this.instrumentConfig.baseSymbol} STOP MOVE FAILED</b>\n` +
        `Could not move stop to $${newStop.toFixed(2)} (${reason})\n` +
        `Stop remains at $${oldStop.toFixed(2)}\n` +
        `⚠️ Will retry on next tick. Monitor position!`
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
        // Never cancel/clear a position that already filled + bracketed (live trade).
        const posNow = this.signalHandler.getPosition();
        if (posNow && posNow.stopOrderId) {
          logger.info(`${this.tag} Limit entry already filled & OCO placed — skipping cancel`);
          return;
        }
        // Defense-in-depth: the limit may have FILLED with the WS fill missed (so no OCO
        // yet). Verify on the exchange before cancelling — cancelling a filled order then
        // clearing state would orphan a NAKED position. If filled, recover via handleFill
        // (→ entryFilled → OCO) instead of cancelling.
        try {
          const fills = await this.shared.client.getFillsByOrder(orderId);
          if (Array.isArray(fills) && fills.length > 0) {
            logger.warn(`${this.tag} ⏰ Limit-entry timeout but order FILLED (WS missed) — recovering: ${fills[0].action} ${fills[0].qty || 1} @ ${fills[0].price} → placing OCO`);
            await this.handleFill(fills[0]);
            return;
          }
        } catch (fe) { logger.warn(`${this.tag} limit-timeout fill check failed: ${fe.message}`); }

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
            } else if (pos._isLimitEntry) {
              // ── CRITICAL: a still-working LIMIT entry is NOT an emergency. ──
              // A market order should fill instantly, so no-fill = trouble. But a limit
              // legitimately RESTS until price reaches it — it's owned by the 3-min
              // limit-entry cancel timeout (unfilled) and the entryFilled handler (fill).
              // The old code emergency-closed + clearPosition() here, which orphaned the
              // live limit; it then filled into a NAKED position (re-adopted, no stop).
              // So: keep POLLING (never emergency-close) so a missed-WS fill is still caught
              // fast and gets its OCO. The poll self-stops once the position resolves
              // (stopOrderId set on fill, or pos cleared by the 3-min cancel timeout).
              logger.info(`${this.tag} ⏳ FILL WATCHDOG: limit entry ${orderId} still working (status=${order?.ordStatus || '?'}) — re-polling in 10s (NO emergency close; 3-min timeout owns cancel)`);
              this._fillWatchdogTimer = setTimeout(() => this._startFillWatchdog(orderId), 10000);
            } else {
              logger.warn(`${this.tag} ⚠️ FILL WATCHDOG: No fills and order status=${order?.ordStatus || 'unknown'} — will retry in 5s`);
              // Retry once more after another 5s (market orders only)
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
                    this._botActionUntil = Date.now() + 8000; // bot-initiated close (external-fill detector)
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

    // Clear reconnect cooldown timer to prevent stale callbacks after shutdown
    if (this._reconnectCooldownTimer) {
      clearTimeout(this._reconnectCooldownTimer);
      this._reconnectCooldownTimer = null;
      this._reconnectCooldownUntil = null;
    }

    if (this.strategy) this.strategy.stop();
    // Only stop the price provider if we own it (per-instrument mode).
    // In shared mode, AccountManager owns the SharedPriceProvider lifecycle.
    if (this.priceProvider && !this._usingSharedProvider) {
      this.priceProvider.stop();
    } else if (this._usingSharedProvider && this._sharedListeners) {
      // Remove our listeners from the shared provider to prevent leaks
      for (const { event, fn } of this._sharedListeners) {
        this.priceProvider.removeListener(event, fn);
      }
      this._sharedListeners = [];
    }

    logger.info(`${this.tag} Stopped`);
  }
}

module.exports = InstrumentRunner;
