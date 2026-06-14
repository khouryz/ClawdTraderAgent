/**
 * AccountInstance - Per-account trading bot encapsulation
 * 
 * Extracted from MultiInstrumentBot for multi-account support.
 * Each instance owns its own auth, client, orderWs, Telegram, and runners.
 * The SharedPriceProvider is injected so all accounts share one Databento feed.
 */

const TradovateAuth = require('../api/auth');
const TradovateClient = require('../api/client');
const TradovateWebSocket = require('../api/websocket');
const MarketHours = require('../utils/market_hours');
const Notifications = require('../utils/notifications');
const TradeAnalyzer = require('../analytics/trade_analyzer');
const logger = require('../utils/logger');
const InstrumentRunner = require('./InstrumentRunner');
const TelegramCommandHandler = require('../utils/TelegramCommandHandler');
const ContractRollReminder = require('../utils/contract_roll_reminder');
const { createOrderClient } = require('../api/OrderMirror');
const Journals = require('../analytics/Journals');
const path = require('path');

class AccountInstance extends require('events') {
  constructor(config) {
    super();
    this.accountId = config.accountId;
    this.credentials = config.credentials;
    this.telegram = config.telegram;
    this.instruments = config.instruments;
    this.sharedPriceProvider = config.sharedPriceProvider;
    this.globalConfig = config.globalConfig;
    this.dataDir = config.dataDir;
    this.isPrimaryLogger = config.isPrimaryLogger || false;

    this.auth = null;
    this.client = null;
    // Sub-account fanout: `this.account` stays = PRIMARY sub-account for backward
    // compatibility (every existing single-account call site reads it unchanged).
    // `this.subAccounts` is the full ordered list (primary first) that one login
    // mirrors trades across. Single-sub-account configs collapse to [primary].
    this.account = null;
    this.subAccounts = [];
    // OrderMirror instance when this login mirrors across >1 sub-account; null for
    // single-sub-account configs (which use the real client unchanged). Used to
    // classify WS fills (primary vs secondary) and to halt-all on divergence.
    this._orderMirror = null;
    this._mirrorAlertAt = new Map(); // per-sub-account alert throttle (mirror self-heals; no halt)
    this.orderWs = null;
    this.marketHours = new MarketHours(this.globalConfig.timezone);
    this.notifications = new Notifications({
      telegramToken: this.telegram.token,
      telegramChatId: this.telegram.chatId,
      accountId: this.accountId,
      botName: 'TradovateBot',
    });
    this.tradeAnalyzer = new TradeAnalyzer({ dataDir: this.dataDir });
    this.notifications.setTradeAnalyzer(this.tradeAnalyzer);

    // Per-account structured journals (orders/signals/trades) + incident tracker.
    // Shared into every runner via the `shared` context. Disable with
    // RECORD_JOURNALS=false. Never throws into trading (recorders swallow errors).
    this.journals = new Journals({
      dir: path.join(this.dataDir || './data', 'journals'),
      accountId: this.accountId,
      enabled: process.env.RECORD_JOURNALS !== 'false',
    });

    this.runners = new Map();
    this._contractIdToRunner = new Map();

    this.isRunning = false;
    this._pausedByUser = false;
    this.telegramCommands = null;
    this._sessionCheckInterval = null;
    this._positionSyncInterval = null;
    this._todayResetDone = false;
    this._eodCloseDoneToday = false;
    this._dailyReportSentToday = false;
    this._sessionStartLoggedToday = false;
    this._rollReminders = [];

    this.maxSimultaneousPositions = parseInt(this.globalConfig.maxSimultaneousPositions) || 2;
    this.tag = `[${this.accountId}]`;
  }

  canOpenNewPosition() {
    let openCount = 0;
    for (const runner of this.runners.values()) {
      if (runner.hasPosition()) openCount++;
    }
    return { allowed: openCount < this.maxSimultaneousPositions, openCount, maxAllowed: this.maxSimultaneousPositions };
  }

  async _authenticateWithRetry(maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`${this.tag} [Auth] Attempt ${attempt}/${maxRetries}`);
        await this.auth.authenticate();
        logger.info(`${this.tag} [Auth] Success`);
        return;
      } catch (error) {
        logger.error(`${this.tag} [Auth] Attempt ${attempt} failed: ${error.message}`);
        if (attempt === maxRetries) {
          logger.error(`${this.tag} [Auth] All attempts failed - waiting 5min...`);
          await new Promise(r => setTimeout(r, 5 * 60 * 1000));
          try {
            await this.auth.authenticate();
            logger.info(`${this.tag} [Auth] Final success`);
            return;
          } catch (finalError) {
            logger.error(`${this.tag} [Auth] Final failed - will retry later`);
            return;
          }
        }
        const delay = Math.min(30000 * Math.pow(2, attempt - 1), 120000);
        logger.info(`${this.tag} [Auth] Waiting ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  async initialize() {
    this._logStartupBanner();

    const tgOk = await this.notifications.test();
    if (!tgOk) logger.warn(`${this.tag} Telegram validation failed - notifications best-effort`);

    this.auth = new TradovateAuth(this.credentials);
    await this._authenticateWithRetry();
    this.client = new TradovateClient(this.auth);

    const accounts = await this.client.getAccounts();
    if (accounts.length === 0) throw new Error(`${this.tag} No accounts found`);

    // ── Resolve sub-account(s) under this single login ──────────────────────
    // One auth token covers every sub-account returned by getAccounts(). The
    // config's accountNames[] (comma-list of TRADOVATE_ACCOUNT_NAME) selects
    // WHICH ones this login mirrors trades across. Resolve them ALL, primary
    // first; `this.account` aliases the primary so single-account paths are
    // untouched.
    const preferredNames = Array.isArray(this.credentials.accountNames) && this.credentials.accountNames.length
      ? this.credentials.accountNames
      : (this.credentials.accountName ? [this.credentials.accountName] : []);
    const preferredId = this.credentials.accountId;
    const available = () => accounts.map(a => `${a.name} (ID: ${a.id})`).join(', ');

    if (preferredNames.length) {
      this.subAccounts = preferredNames.map((name) => {
        const acct = accounts.find(a => a.name === name);
        if (!acct) throw new Error(`${this.tag} Sub-account "${name}" not found. Available: ${available()}`);
        return acct;
      });
    } else if (preferredId) {
      const acct = accounts.find(a => a.id === preferredId);
      if (!acct) throw new Error(`${this.tag} Account ID ${preferredId} not found. Available: ${available()}`);
      this.subAccounts = [acct];
    } else {
      const active = accounts.filter(a => a.active !== false);
      this.subAccounts = [active[0] || accounts[0]];
      if (accounts.length > 1) {
        logger.warn(`${this.tag} Multiple accounts - using "${this.subAccounts[0].name}"`);
      }
    }
    this.account = this.subAccounts[0]; // primary — backward-compat alias

    // Verbose, exchange-resolved sub-account roster (authoritative — these are the
    // accounts that actually exist under this login, matched from the .env names).
    if (this.subAccounts.length > 1) {
      logger.success(`${this.tag} 🪞 MIRROR FANOUT — ${this.subAccounts.length} sub-accounts resolved under this login:`);
      this.subAccounts.forEach((a, i) => {
        logger.info(`${this.tag}    ${i === 0 ? 'PRIMARY ' : `mirror#${i}`}  ${a.name} (ID: ${a.id})`);
      });
      logger.info(`${this.tag}    → every primary order will replicate to ${this.subAccounts.length - 1} secondary sub-account(s)`);
    } else {
      logger.info(`${this.tag} Single sub-account (no fanout): ${this.account.name} (ID: ${this.account.id})`);
    }

    await this._connectOrderWebSocket();

    logger.info(`${this.tag} ${this.instruments.length} instrument(s): ${this.instruments.map(c => c.baseSymbol).join(', ')}`);

    this._wireDatabentoEvents();

    // ── Order-layer mirror fanout ───────────────────────────────────────────
    // For a single sub-account this returns the REAL client unchanged (byte-for-
    // byte identical behavior). For >1 sub-account it returns a drop-in proxy
    // that replicates every order the primary places onto the secondaries, plus
    // the OrderMirror instance for fill classification + divergence handling.
    // `this.client` stays the REAL client for AccountInstance's own primary-only
    // reads (balance/positions); runners receive the mirror via shared.client.
    const { client: orderClient, mirror } = createOrderClient(this.client, this.subAccounts);
    this._orderMirror = mirror;
    if (this._orderMirror) {
      this._orderMirror.setDivergenceHandler((info) => this._onMirrorDivergence(info));
      logger.success(`${this.tag} 🪞 OrderMirror ENGAGED — orders fan out to ${this.subAccounts.length - 1} secondary sub-account(s); divergence alerts wired`);
    } else if (this.subAccounts.length > 1) {
      // Defensive: >1 sub-account but no mirror means the secondaries would NOT be
      // traded. This should never happen (createOrderClient mirrors for N>1); surface
      // it loudly rather than silently single-account-trading.
      logger.error(`${this.tag} ⚠️ ${this.subAccounts.length} sub-accounts configured but OrderMirror did NOT engage — secondaries will NOT be traded!`);
    } else {
      logger.info(`${this.tag} OrderMirror not engaged (single sub-account) — using the real client directly`);
    }

    const shared = {
      accountId: this.accountId,
      client: orderClient,
      account: this.account,
      orderWs: this.orderWs,
      notifications: this.notifications,
      marketHours: this.marketHours,
      tradeAnalyzer: this.tradeAnalyzer,
      globalConfig: this.globalConfig,
      sharedPriceProvider: this.sharedPriceProvider,
      isPrimaryLogger: this.isPrimaryLogger,
      dataDir: this.dataDir,
      journals: this.journals,
      bot: this,
    };

    for (const ic of this.instruments) {
      logger.info(`${'─'.repeat(60)}`);
      logger.info(`  ${this.tag} Initializing ${ic.baseSymbol} (${ic.strategy})`);
      logger.info(`${'─'.repeat(60)}`);

      const runner = new InstrumentRunner(ic, shared);
      await runner.initialize();
      this.runners.set(ic.baseSymbol, runner);

      const contractId = runner.getContractId();
      if (contractId) {
        this._contractIdToRunner.set(contractId, runner);
        logger.info(`  ${this.tag} Routing: contractId ${contractId} -> ${ic.baseSymbol}`);
      }

      runner.on('halt', async (data) => {
        logger.error(`${this.tag} ${data.instrument} HALTED: ${data.message}`);
        await this._sendDailyReport(`${data.instrument} halted: ${data.message}`);
      });
    }

    this.isRunning = true;
    logger.success(`\n✅ ${this.tag} LIVE - ${this.runners.size} instrument(s)`);

    const mirrorLine = this.subAccounts.length > 1
      ? `\n🪞 Mirror fanout: ${this.subAccounts.length} sub-accounts [${this.subAccounts.map(a => a.name).join(', ')}]`
      : `\nSingle sub-account (no fanout)`;
    await this.notifications.send(
      `🤖 <b>BOT STARTED</b>\nAccount: ${this.accountId}\nInstruments: ${[...this.runners.keys()].join(', ')}\nTradovate: ${this.account.name}${mirrorLine}`
    ).catch(() => {});

    this.telegramCommands = new TelegramCommandHandler({
      bot: this, notifications: this.notifications,
      telegramToken: this.telegram.token, telegramChatId: this.telegram.chatId,
      accountId: this.accountId,
    });
    this.telegramCommands.start();

    for (const [sym, runner] of this.runners) {
      const contract = runner.contract;
      if (contract && contract.name) {
        const reminder = new ContractRollReminder({
          notifications: this.notifications, contractName: contract.name,
          expirationDate: contract.expirationDate, baseSymbol: sym,
        });
        await reminder.start();
        this._rollReminders.push(reminder);
      }
    }
  }

  _wireDatabentoEvents() {
    // Store listener refs so we can remove them on shutdown (prevent leaks)
    this._databentoListeners = [];
    // ISOLATION: these listeners live on the SHARED price provider alongside every
    // other account's. A synchronous throw here would propagate out of the single
    // emit() and starve sibling accounts' listeners registered after this one (e.g.
    // a sibling would miss its post-reconnect cooldown and could trade on stale
    // data). Wrap so one account's fault can never block another's. (Reconnect
    // handler is async — guard its rejection too.)
    const addListener = (event, fn) => {
      const safe = (payload) => {
        try {
          const r = fn(payload);
          if (r && typeof r.then === 'function') {
            r.catch((e) => logger.error(`${this.tag} [Databento] '${event}' async handler rejected (isolated): ${e && e.stack ? e.stack : e}`));
          }
        } catch (e) {
          logger.error(`${this.tag} [Databento] '${event}' handler threw (isolated): ${e && e.stack ? e.stack : e}`);
        }
      };
      this._databentoListeners.push({ event, fn: safe });
      this.sharedPriceProvider.on(event, safe);
    };

    addListener('disconnected', ({ code }) => {
      if (this.isPrimaryLogger) logger.warn(`${this.tag} [Databento] Disconnected (code: ${code})`);
      this.notifications.send('⚠️ <b>DATABENTO DISCONNECTED</b>').catch(() => {});
    });

    addListener('reconnected', async (data) => {
      const downtimeSec = ((data.downtimeMs || 0) / 1000).toFixed(1);
      const droppedBars = Math.floor((data.downtimeMs || 0) / 60000);
      if (this.isPrimaryLogger) logger.info(`${this.tag} [Databento] Reconnected after ${downtimeSec}s (~${droppedBars} bars)`);
      this.notifications.send(`✅ <b>DATABENTO RECONNECTED</b>\nDowntime: ${downtimeSec}s`).catch(() => {});
      try { this.journals.incident('disconnect', { downtimeMs: data.downtimeMs || 0, droppedBars }); } catch (_) {}
      for (const runner of this.runners.values()) {
        runner.startReconnectCooldown(droppedBars, data.downtimeMs || 0);
      }
    });

    addListener('maxReconnectAttemptsReached', () => {
      if (this.isPrimaryLogger) logger.error(`${this.tag} [Databento] Max reconnect attempts`);
      this.notifications.send('🚨 <b>DATABENTO DEAD</b>').catch(() => {});
    });
  }

  async _connectOrderWebSocket() {
    this.orderWs = new TradovateWebSocket(this.auth, 'order');

    // Sub-account fanout observability (Phase 1, read-only): log the routing-
    // relevant identifiers on every inbound entity so we can confirm the wire
    // schema against live/DEMO data. Validated by code inspection (#25):
    //   • order/position entities carry `accountId` → can route by it directly
    //   • fill entities carry orderId + contractId but NO accountId → fills must
    //     route by an orderId→sub-account map (built at placement time, Phase 2)
    // Only chatty when actually mirroring (>1 sub-account) to avoid log noise.
    const logRoute = (event, entity) => {
      if (this.subAccounts.length <= 1) return;
      logger.info(`${this.tag} [OrderWs:${event}] acct=${entity.accountId ?? 'n/a'} ` +
        `orderId=${entity.orderId ?? entity.id ?? 'n/a'} contractId=${entity.contractId ?? 'n/a'}`);
    };
    // Phase 1 safety guard: only the PRIMARY sub-account actually trades until
    // the Phase 2 per-account fanout lands. We sync ALL sub-accounts on this
    // socket (to validate multi-account streaming), so an order/position event
    // for a *mirrored* sub-account — e.g. pre-existing/manual state in the same
    // contract — could otherwise leak into the primary runner and corrupt its
    // position/order tracking. Order & Position entities carry `accountId`
    // (verified against Tradovate's OpenAPI spec), so drop foreign ones here.
    // Fills carry NO accountId; in Phase 1 only the primary places orders, so
    // every fill is the primary's. (Phase 2 replaces this with per-account
    // executors that route fills by an orderId→account map.)
    // NOTE: no-op for single-account configs — the only synced account is the
    // primary, so accountId always equals this.account.id.
    const isForeignAccount = (entity) =>
      entity && entity.accountId != null && Number(entity.accountId) !== Number(this.account.id);
    const route = (event, handler, accountScoped) => {
      this.orderWs.on(event, (entity) => {
        logRoute(event, entity);
        if (accountScoped && isForeignAccount(entity)) return;
        const runner = this._contractIdToRunner.get(entity.contractId);
        if (runner) runner[handler](entity);
      });
    };
    route('order', 'handleOrderUpdate', true);
    route('position', 'handlePositionUpdate', true);

    // Fills carry orderId + contractId but NO accountId, so they can't be foreign-
    // filtered like orders/positions. In mirror mode, fills for SECONDARY orders
    // arrive on this same stream — they must NOT reach the primary runner (which
    // manages only the primary account). _routeFill classifies via the mirror and
    // drops secondary fills. For single-account configs it's a direct passthrough.
    this.orderWs.on('fill', (fill) => {
      logRoute('fill', fill);
      this._routeFill(fill);
    });

    this.orderWs.on('props', (data) => {
      if (!data || !data.entityType || !data.entity) return;
      const entity = data.entity;
      logRoute(`props:${data.entityType}`, entity);
      // Same guard for the props-delivered duplicates of order/position events.
      if (data.entityType !== 'fill' && isForeignAccount(entity)) return;
      const runner = this._contractIdToRunner.get(entity.contractId);
      if (!runner) return;
      if (data.entityType === 'fill' && data.eventType === 'Created') this._routeFill(entity);
      else if (data.entityType === 'order') runner.handleOrderUpdate(entity);
      else if (data.entityType === 'position') runner.handlePositionUpdate(entity);
    });

    this.orderWs.on('reconnected', async (data) => {
      try {
        await new Promise((resolve) => {
          if (this.orderWs.isAuthorized) resolve();
          else { this.orderWs.once('authorized', resolve); setTimeout(resolve, 5000); }
        });
        this.orderWs.synchronize(this.subAccounts.map(a => a.id));
        logger.info(`${this.tag} [OrderWs] Re-synced ${this.subAccounts.length} sub-account(s)`);
      } catch (e) { logger.error(`${this.tag} [OrderWs] Re-sync failed: ${e.message}`); }
      if (data.requiresPositionSync) {
        for (const runner of this.runners.values()) {
          await runner.syncPosition();
          await runner.reconcileMirroredAccounts();
        }
      }
    });

    this.orderWs.on('maxReconnectAttemptsReached', async (data) => {
      logger.error(`${this.tag} [OrderWs] CRITICAL: ${data.attempts} attempts - HALTING`);
      for (const [symbol, runner] of this.runners.entries()) {
        try {
          if (runner.lossLimits) runner.lossLimits.halt('WEBSOCKET_DEAD', 'Order WS lost');
        } catch (err) { logger.error(`${this.tag} Halt ${symbol} failed: ${err.message}`); }
      }
      await this.notifications.send('🚨 <b>ORDER WS DEAD</b> - All trading halted').catch(() => {});
    });

    await this.orderWs.connect();
    await new Promise((resolve) => {
      if (this.orderWs.isAuthorized) resolve();
      else { this.orderWs.once('authorized', resolve); setTimeout(resolve, 5000); }
    });
    this.orderWs.synchronize(this.subAccounts.map(a => a.id));
    logger.info(`${this.tag} Order WS connected (synced ${this.subAccounts.length} sub-account(s))`);
  }

  /**
   * Route an inbound WS fill to the primary runner, dropping fills that belong to
   * a SECONDARY sub-account (mirror mode). For single-account configs there's no
   * mirror, so every fill goes straight to the runner — identical to before.
   *
   * Unknown orderIds are briefly re-checked to cover the rare race where the WS
   * fill frame beats the placement HTTP ack (so the secondary orderId isn't
   * recorded yet). The primary's OWN orders are recorded synchronously at
   * placement — before any fill event for them can be processed — so in mirror
   * mode an unknown fill is NEVER a primary bot order. It is either a secondary
   * fill whose ack hasn't landed yet or a foreign/manual order; after the retry
   * budget it is DROPPED, because feeding it to the primary runner would corrupt
   * the primary's position tracking. (Single-account mode has no mirror, so every
   * fill goes straight to the runner — identical to before.)
   * @private
   */
  _routeFill(fill, _attempt = 0) {
    const runner = this._contractIdToRunner.get(fill.contractId);
    if (!runner) return;
    if (!this._orderMirror) { runner.handleFill(fill); return; }

    const owner = this._orderMirror.ownerOfOrder(fill.orderId);
    if (owner && owner.kind === 'secondary') { this._recordSecondaryFill(owner, fill); return; }
    if (owner && owner.kind === 'primary') { runner.handleFill(fill); return; }

    // Unknown — retry briefly to let a slow secondary ack record (for logging)…
    if (_attempt < 8) { setTimeout(() => this._routeFill(fill, _attempt + 1), 40); return; }
    // …then drop it. It is not the primary's order (those are always recorded),
    // so it must not reach the primary runner.
    logger.warn(`${this.tag} 🪞 dropping unclassified fill (orderId=${fill.orderId ?? 'n/a'}, contractId=${fill.contractId ?? 'n/a'}) — not the primary's; not fed to runner`);
  }

  /**
   * A fill on a SECONDARY sub-account. It is intentionally NOT fed to the primary
   * runner (which tracks only the primary account). Logged with the sub-account
   * id so every account's executions remain auditable in the journal.
   * @private
   */
  _recordSecondaryFill(owner, fill) {
    const px = (fill.price != null) ? `@ ${fill.price}` : '';
    logger.info(`${this.tag}[${owner.accountSpec}] 🪞 mirror fill: ${fill.action || '?'} ${fill.qty ?? '?'} ${px} (orderId=${fill.orderId})`);
    // Journal the mirror sub-account's execution (③) — tagged + correlated to the
    // primary order it replicates, so account1's journal captures BOTH sub-accounts.
    try {
      const primaryOrderId = this._orderMirror ? this._orderMirror.primaryOrderFor(fill.orderId) : null;
      const runner = this._contractIdToRunner.get(fill.contractId);
      this.journals.order({
        event: 'fill', mirror: true,
        instrument: runner ? runner.instrumentConfig.baseSymbol : undefined,
        contractId: fill.contractId,
        subAccount: owner.accountSpec, subAccountId: owner.accountId,
        orderId: fill.orderId,
        tradeId: (primaryOrderId != null) ? String(primaryOrderId) : undefined,
        action: fill.action, qty: (fill.qty != null ? fill.qty : fill.quantity), fillPrice: fill.price,
      });
    } catch (_) { /* logging must never disturb fill routing */ }
  }

  /**
   * Alert sink for the mirror (NO halt). Each sub-account is independently
   * protected by its OWN OCO bracket, and the mirror self-heals via
   * reconcileSecondaries (re-bracket / flatten / cancel-stray / BE-sync), so a
   * drift on one account never halts the others. This just surfaces meaningful
   * corrective actions to Telegram, throttled per sub-account so a transient
   * loop can't spam.
   * @private
   */
  _onMirrorDivergence(info) {
    const spec = info && info.accountSpec ? String(info.accountSpec) : 'secondary';
    const now = Date.now();
    if (!this._mirrorAlertAt) this._mirrorAlertAt = new Map();
    if (now - (this._mirrorAlertAt.get(spec) || 0) < 30000) return; // <=1 alert / 30s / sub-account
    this._mirrorAlertAt.set(spec, now);
    this.notifications.send(
      `⚠️ <b>MIRROR — ${this.accountId}</b>\n` +
      `Sub-account <b>${info.accountSpec}</b> (ID ${info.accountId}) on <b>${info.method}</b>:\n` +
      `${info.error}` +
      (info.naked ? `\n(position force-flattened to stay protected)` : '')
    ).catch(() => {});
  }

  async start() {
    await this.initialize();
    this._startSessionManager();
    this._startPositionSyncHeartbeat();

    const pst = this._getPSTTime();
    const mins = pst.hour * 60 + pst.minute;
    const ss = this.globalConfig.tradingStartHour * 60 + this.globalConfig.tradingStartMinute;
    const se = this.globalConfig.tradingEndHour * 60 + this.globalConfig.tradingEndMinute;

    if (mins >= ss && mins < se) {
      logger.info(`${this.tag} Started mid-session - daily reset already done`);
      this._todayResetDone = true;
    } else if (mins < ss) {
      logger.info(`${this.tag} Waiting for session start at ${this.globalConfig.tradingStartHour}:${String(this.globalConfig.tradingStartMinute).padStart(2, '0')} PST`);
    } else {
      logger.info(`${this.tag} Session ended for today - will trade tomorrow`);
    }

    // Note: In multi-account mode, AccountManager owns SIGINT/SIGTERM.
    // Only register if running standalone (no sharedPriceProvider injected from AccountManager).
    if (!this.sharedPriceProvider) {
      process.on('SIGINT', () => this.shutdown());
      process.on('SIGTERM', () => this.shutdown());
    }

    logger.success(`📅 DAILY SCHEDULE (PST):`);
    logger.success(`   6:29 AM  — Daily reset`);
    logger.success(`   6:30 AM  — Session start`);
    for (const [sym, runner] of this.runners) {
      logger.success(`   ${sym}: ${runner.instrumentConfig.strategy}`);
    }
    logger.success(`  12:55 PM  — EOD force-close`);
    logger.success(`   1:00 PM  — Session end, daily report`);
  }

  _startSessionManager() {
    const checkSession = async () => {
      if (!this.isRunning) return;

      const pst = this._getPSTTime();
      const mins = pst.hour * 60 + pst.minute;
      const ss = this.globalConfig.tradingStartHour * 60 + this.globalConfig.tradingStartMinute;
      const se = this.globalConfig.tradingEndHour * 60 + this.globalConfig.tradingEndMinute;

      // Daily Reset at 6:29 AM PST
      if (pst.hour === 6 && pst.minute === 29 && !this._todayResetDone) {
        this._todayResetDone = true;
        this._eodCloseDoneToday = false;
        this._dailyReportSentToday = false;
        this._sessionStartLoggedToday = false;

        for (const runner of this.runners.values()) runner.dailyReset();
        try { this.journals.dailyReset(); } catch (_) {}
        logger.info(`${this.tag} Daily reset - all instruments`);
        await this.notifications.send('🔄 New trading day - all instruments reset').catch(() => {});
      }

      if (pst.hour === 0 && pst.minute < 2) {
        this._todayResetDone = false;
        this._dailyReportSentToday = false;
      }

      // EOD Force-Close at 12:55 PM PST
      if (mins >= se - 5 && mins < se && !this._eodCloseDoneToday) {
        this._eodCloseDoneToday = true;
        for (const runner of this.runners.values()) await runner.eodClose();
      }

      if (mins >= ss && !this._sessionStartLoggedToday) {
        this._sessionStartLoggedToday = true;
        logger.info(`${this.tag} Trading session started`);
      }

      if (mins >= se && !this._dailyReportSentToday) {
        logger.info(`${this.tag} Session ended - generating daily report`);
        await this._sendDailyReport('Session ended');
      }
    };

    this._sessionCheckInterval = setInterval(checkSession, 15000);
    checkSession();
  }

  _startPositionSyncHeartbeat() {
    this._positionSyncInterval = setInterval(async () => {
      if (!this.isRunning) return;
      if (!this._isInSession()) return;
      for (const runner of this.runners.values()) {
        await runner.syncPosition();                 // primary reconciliation
        await runner.reconcileMirroredAccounts();    // mirror reconciliation (no-op for single account)
      }
    }, 60000);
    logger.info(`${this.tag} Position sync heartbeat started (60s)`);
  }

  async _sendDailyReport(reason) {
    if (this._dailyReportSentToday) return;
    this._dailyReportSentToday = true;

    try {
      const today = new Date().toISOString().split('T')[0];
      let totalPnl = 0, totalTrades = 0, totalWins = 0, totalLosses = 0, totalBE = 0;
      const lines = [];

      for (const [sym, runner] of this.runners) {
        const stats = runner.getTodayStats();
        totalPnl += stats.pnl || 0;
        totalTrades += stats.trades || 0;
        totalWins += stats.wins || 0;
        totalLosses += stats.losses || 0;
        totalBE += stats.breakeven || 0;
        const pnlStr = (stats.pnl || 0) >= 0 ? `+$${(stats.pnl || 0).toFixed(2)}` : `-$${Math.abs(stats.pnl || 0).toFixed(2)}`;
        lines.push(`${sym}: ${stats.trades || 0}t ${stats.wins || 0}W/${stats.losses || 0}L/${stats.breakeven || 0}BE ${pnlStr}`);
      }

      const totalPnlStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;
      const wr = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(0) : '0';

      // Incident digest (②): persist incidents_<date>.json + append a compact
      // summary to the report so disconnects/drops/slippage-blocks/etc. are visible.
      let incidentText = '';
      try {
        const res = this.journals.writeDigest(path.join('.', 'logs', this.accountId));
        if (res && res.text) incidentText = `\n\n${res.text}`;
        await this.journals.flushAll();
      } catch (e) { logger.warn(`${this.tag} incident digest failed: ${e.message}`); }

      const msg = `📊 <b>DAILY REPORT</b> (${today})\n` +
        `Reason: ${reason}\n\n` +
        lines.join('\n') + '\n\n' +
        `<b>TOTAL: ${totalTrades}t ${totalWins}W/${totalLosses}L/${totalBE}BE ${totalPnlStr} (${wr}% WR)</b>` +
        incidentText;

      await this.notifications.send(msg).catch(() => {});

      const fs = require('fs');
      const logDir = path.join('.', 'logs', this.accountId);
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

      const logEntry = { date: today, reason, totalTrades, totalWins, totalLosses, totalBE, totalPnl };
      const logFile = path.join(logDir, `daily_${today}.json`);
      fs.writeFileSync(logFile, JSON.stringify(logEntry, null, 2));
      logger.info(`${this.tag} Daily report saved to ${logFile}`);
    } catch (err) {
      logger.error(`${this.tag} Failed to send daily report: ${err.message}`);
    }
  }

  async shutdown() {
    logger.info(`${this.tag} Shutting down...`);
    this.isRunning = false;

    if (this._sessionCheckInterval) clearInterval(this._sessionCheckInterval);
    if (this._positionSyncInterval) clearInterval(this._positionSyncInterval);

    for (const runner of this.runners.values()) await runner.shutdown();

    // Remove our Databento event listeners from the shared provider (prevent leaks)
    if (this.sharedPriceProvider && this._databentoListeners) {
      for (const { event, fn } of this._databentoListeners) {
        this.sharedPriceProvider.removeListener(event, fn);
      }
      this._databentoListeners = [];
    }

    await this.notifications.send('🛑 <b>BOT STOPPED</b>').catch(() => {});

    if (this.orderWs) this.orderWs.disconnect();
    if (this.telegramCommands) this.telegramCommands.stop();
    for (const reminder of this._rollReminders) reminder.stop();
    try { this.journals.closeAll(); } catch (_) {}

    logger.info(`${this.tag} Stopped`);
  }

  async getAggregatedStatus() {
    const balance = await this.client.getRealTimeBalance(this.account.id);
    const positions = await this.client.getOpenPositions(this.account.id);

    let totalPnl = 0, totalTrades = 0;
    const instrumentStats = [];

    for (const [symbol, runner] of this.runners) {
      const stats = runner.getTodayStats();
      const llStatus = runner.lossLimits.getStatus();
      totalPnl += stats.pnl || 0;
      totalTrades += stats.trades || 0;
      instrumentStats.push({ symbol, pnl: stats.pnl, trades: stats.trades, isHalted: llStatus.isHalted, haltReason: llStatus.haltReason });
    }

    // Per sub-account snapshot (primary + mirrors). One entry for a single account.
    // Reads go through the REAL client, which is authorized for every sub-account
    // under this login. Kept simple: name, equity, open-position count.
    const subAccounts = [];
    for (const sub of this.subAccounts) {
      try {
        const bal = await this.client.getRealTimeBalance(sub.id);
        const pos = await this.client.getOpenPositions(sub.id);
        subAccounts.push({
          name: sub.name, id: sub.id,
          equity: bal && bal.equity != null ? bal.equity : null,
          positions: Array.isArray(pos) ? pos.length : 0,
          primary: sub.id === this.account.id,
        });
      } catch (e) {
        subAccounts.push({ name: sub.name, id: sub.id, equity: null, positions: null, primary: sub.id === this.account.id, error: true });
      }
    }

    return { accountId: this.accountId, account: this.account, balance, positions, totalPnl, totalTrades, instrumentStats, subAccounts, paused: this._pausedByUser };
  }

  _getPSTTime(date = new Date()) {
    const fmt = (type) => parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', [type]: 'numeric', hour12: false }).format(date));
    return { hour: fmt('hour'), minute: fmt('minute') };
  }

  _isInSession() {
    const pst = this._getPSTTime();
    const mins = pst.hour * 60 + pst.minute;
    const ss = this.globalConfig.tradingStartHour * 60 + this.globalConfig.tradingStartMinute;
    const se = this.globalConfig.tradingEndHour * 60 + this.globalConfig.tradingEndMinute;
    return mins >= ss && mins < se;
  }

  _logStartupBanner() {
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`🤖 AccountInstance Starting...`);
    logger.info(`Account: ${this.accountId}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  }
}

module.exports = AccountInstance;
