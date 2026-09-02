/**
 * SignalHandler — execution-only signal processor
 *
 * Receives a validated trade signal, checks risk guards, calculates position size
 * (or uses the quantity from the signal), places the entry order, and sets up the
 * OCO bracket parameters for post-fill placement.
 *
 * Stripped from the original: no strategy, no AI confirmation, no slippage guard,
 * no trailing stop, no profit manager, no trade analyzer. Pure execution.
 */

const EventEmitter = require('events');
const logger = require('../utils/logger');
const { ErrorHandler } = require('../utils/error_handler');
const { CONTRACTS } = require('../utils/constants');

class SignalHandler extends EventEmitter {
  /**
   * @param {Object} deps - { client, riskManager, lossLimits, sessionFilter, marketHours, notifications }
   * @param {Object} config - Bot configuration
   */
  constructor(deps, config) {
    super();
    this.client = deps.client;
    this.riskManager = deps.riskManager;
    this.lossLimits = deps.lossLimits;
    this.sessionFilter = deps.sessionFilter;
    this.marketHours = deps.marketHours;
    this.notifications = deps.notifications;
    this.config = config;

    this.account = null;
    this.contract = null;
    this.currentPosition = null;
    this.currentTradeId = null;

    // Position lock — prevents race conditions on rapid signals
    this._processingSignal = false;
  }

  /**
   * Set account and contract context.
   */
  setContext(account, contract) {
    this.account = account;
    this.contract = contract;
  }

  getPosition() { return this.currentPosition; }
  getTradeId() { return this.currentTradeId; }

  clearPosition() {
    this.currentPosition = null;
    this.currentTradeId = null;
    this._processingSignal = false;
  }

  /**
   * Update position after entry fill with actual fill price and recalculated stop/target.
   * Called by ExecutionBot when the entry fill arrives.
   */
  updatePositionFromFill(fillData) {
    if (!this.currentPosition) return;
    const { fillPrice, signalPrice, newStop, newTarget } = fillData;
    this.currentPosition.entryPrice = fillPrice;
    this.currentPosition.signalPrice = signalPrice;
    this.currentPosition.stopLoss = newStop;
    this.currentPosition.target = newTarget;

    const baseSymbol = (this.contract?.name || 'MNQ').substring(0, 3);
    const contractSpecs = CONTRACTS[baseSymbol] || CONTRACTS.MNQ;
    const pointValue = contractSpecs.pointValue || 2;
    this.currentPosition.risk = Math.abs(fillPrice - newStop) * (this.currentPosition.quantity || 1) * pointValue;
  }

  /**
   * Handle incoming trading signal.
   * @param {Object} signal - { type:'buy'|'sell', price, stopLoss, targetPrice?, orderType, quantity?, strategy?, signalId }
   * @returns {Object} { executed, reason?, position?, tradeId? }
   */
  async handleSignal(signal) {
    // Position lock — reject if already processing or in position
    if (this._processingSignal) {
      logger.warn('Signal rejected: Already processing another signal');
      return { executed: false, reason: 'Already processing signal' };
    }
    if (this.currentPosition) {
      logger.warn('Signal rejected: Already in position');
      return { executed: false, reason: 'Already in position' };
    }

    this._processingSignal = true;

    try {
      // Validate signal has required fields
      if (!signal || !signal.type || signal.price === undefined || signal.stopLoss === undefined) {
        logger.warn('Invalid signal: missing required fields (type, price, stopLoss)');
        return { executed: false, reason: 'Invalid signal: missing required fields' };
      }

      logger.trade(`📊 Signal received: ${signal.type.toUpperCase()} at $${signal.price} | strategy: ${signal.strategy || 'webhook'}`);

      // Validate against guards (market hours, loss limits, session filter)
      const validation = this._validateSignal();
      if (!validation.valid) {
        logger.warn(`Trade blocked: ${validation.reason}`);
        return { executed: false, reason: validation.reason, blocked: true };
      }

      // Get account balance
      const balance = await this.client.getCashBalance(this.account.id);
      const accountBalance = balance.cashBalance;

      // Get contract specs
      const specs = this.riskManager.getContractSpecs(this.config.contractSymbol);

      // Determine quantity: use signal's quantity if provided, else calculate from risk
      let contracts;
      let position;

      if (signal.quantity && signal.quantity > 0) {
        // Webhook specified quantity — use it directly
        contracts = signal.quantity;
        const priceRisk = Math.abs(signal.price - signal.stopLoss);
        const dollarRiskPerContract = (priceRisk / specs.tickSize) * specs.tickValue;
        const totalRisk = contracts * dollarRiskPerContract;
        const stopPrice = signal.stopLoss;
        // Target: use signal's targetPrice if provided, else compute from profitTargetR
        let targetPrice = signal.targetPrice;
        const explicitTarget = targetPrice != null;
        if (!targetPrice) {
          const profitTargetR = this.config.profitTargetR || 2.5;
          targetPrice = signal.type === 'buy'
            ? signal.price + (priceRisk * profitTargetR)
            : signal.price - (priceRisk * profitTargetR);
        }
        position = {
          contracts,
          riskPerContract: dollarRiskPerContract,
          totalRisk,
          stopPrice,
          targetPrice,
          explicitTarget,
          riskRewardRatio: this.config.profitTargetR || 2.5,
          entryPrice: signal.price,
        };
      } else {
        // Calculate position size from risk
        position = this.riskManager.calculatePositionSize(
          accountBalance,
          signal.price,
          signal.stopLoss,
          specs.tickSize,
          specs.tickValue
        );

        // Override target with signal's targetPrice if provided
        if (signal.targetPrice) {
          position.targetPrice = signal.targetPrice;
          position.explicitTarget = true;
        } else {
          position.explicitTarget = false;
        }

        contracts = position.contracts;
      }

      // Validate trade
      const tradeValidation = this.riskManager.validateTrade(position);
      if (!tradeValidation.valid) {
        logger.warn(`Trade rejected: ${tradeValidation.reason}`);
        return { executed: false, reason: tradeValidation.reason, blocked: true };
      }

      if (contracts < 1) {
        logger.warn(`Trade rejected: calculated contracts = ${contracts}`);
        return { executed: false, reason: 'Position size calculated as 0 — stop too wide for risk budget', blocked: true };
      }

      logger.trade(`Trade: ${signal.type.toUpperCase()} ${contracts} @ $${signal.price} | Stop: $${position.stopPrice.toFixed(2)} | Target: $${position.targetPrice.toFixed(2)} | Risk: $${position.totalRisk.toFixed(2)}`);

      // Determine order action
      const action = signal.type === 'buy' ? 'Buy' : 'Sell';
      const exitAction = signal.type === 'buy' ? 'Sell' : 'Buy';

      // CRITICAL: Set currentPosition BEFORE placing the order.
      // The fill can arrive via WebSocket within milliseconds of the order,
      // and handleFill() needs currentPosition to detect entry vs exit fills.
      this.currentPosition = {
        side: action,
        quantity: contracts,
        entryPrice: signal.price,
        stopLoss: position.stopPrice,
        target: position.targetPrice,
        explicitTarget: position.explicitTarget || false,
        risk: position.totalRisk,
        profitTargetR: position.riskRewardRatio || this.config.profitTargetR || 2.5,
        orderId: null,
        stopOrderId: null,
        targetOrderId: null,
        // Multi-leg OCO support: list of { orderId, ocoId, qty, targetPrice }
        // Populated by ExecutionBot after placing each leg. When present,
        // stopOrderId/targetOrderId are the FIRST leg's IDs (for backwards compat).
        bracketLegs: [],
        exits: signal.exits || null,
        moveStopToBEAfterFirstTarget: signal.moveStopToBEAfterFirstTarget === true,
        firstTargetFilled: false,
        entryTime: new Date(),
        strategyName: signal.strategy || 'webhook',
        signalId: signal.signalId || null,
        _maxRiskPerTrade: this.config.riskPerTrade?.max || 60,
      };

      // Stash notification data — sent AFTER fill arrives with real fill price
      this.currentPosition._notificationData = {
        signal,
        position,
      };

      // Set OCO params BEFORE placing the order (fill can arrive during await)
      this.currentPosition._isLimitEntry = signal.orderType === 'Limit';
      this.currentPosition._isStopEntry = signal.orderType === 'Stop';
      this.currentPosition._ocoParams = {
        accountSpec: this.account.name || this.account.id.toString(),
        accountId: this.account.id,
        contractName: this.contract.name,
        contracts,
        exitAction,
        signalStopPrice: position.stopPrice,
        signalTargetPrice: position.targetPrice,
        exits: signal.exits || null,
        moveStopToBEAfterFirstTarget: signal.moveStopToBEAfterFirstTarget === true,
      };

      // Place entry order
      let entryOrder;
      let placedType = signal.orderType || 'Market';

      if (signal.orderType === 'Limit') {
        // Marketable-limit: place at signal price (sender decides the limit)
        const limitPrice = parseFloat((Math.round(signal.price / specs.tickSize) * specs.tickSize).toFixed(2));
        logger.trade(`Placing ${action} LIMIT entry @ $${limitPrice.toFixed(2)} for ${contracts} contracts...`);
        entryOrder = await this.client.placeLimitOrder(
          this.account.id,
          this.contract.id,
          contracts,
          action,
          limitPrice
        );
      } else if (signal.orderType === 'Stop') {
        // Stop entry: a RESTING order that triggers only once price trades
        // through it — the correct type for a break-of-signal-bar entry.
        // A Limit here would be actively wrong: it fills at-or-BETTER, so a
        // buy limit parked above the market fills instantly at the current
        // (lower) price, entering before any break ever happened.
        const stopEntry = parseFloat((Math.round(signal.price / specs.tickSize) * specs.tickSize).toFixed(2));

        // A Buy Stop must sit ABOVE the market, a Sell Stop BELOW it. On the
        // wrong side it triggers on submission and degrades into a market fill.
        //
        // The market reference comes from the SENDER via refPrice, not from the
        // broker. Tradovate has no REST quote endpoint — client.getQuote() hits
        // /md/getquote on the trading server, which does not exist and 404s on
        // both servers; quotes are WebSocket-only (md/subscribeQuote) and this
        // bot never connects an MD socket. Depending on it made this check dead
        // code that logged "quote check failed" on every single entry.
        //
        // The sender reads the price off the chart before every entry anyway,
        // so it is the reliable source. No refPrice means no check — say so
        // loudly rather than implying a guard that is not running.
        const ref = signal.refPrice;
        if (ref != null && Number.isFinite(ref)) {
          const wrongSide = action === 'Buy' ? stopEntry <= ref : stopEntry >= ref;
          if (wrongSide) {
            const reason = `Stop entry ${stopEntry.toFixed(2)} is on the wrong side of the market (refPrice ${ref}) for a ${action} — it would trigger immediately`;
            logger.warn(`Trade rejected: ${reason}`);
            this.currentPosition = null;
            return { executed: false, reason, blocked: true };
          }
          logger.info(`Stop entry side check OK: ${action} stop ${stopEntry.toFixed(2)} vs refPrice ${ref}`);
        } else {
          logger.warn('⚠️ Stop entry: NO refPrice supplied — side check SKIPPED. Wrong-side protection is off for this order.');
        }

        logger.trade(`Placing ${action} STOP entry @ $${stopEntry.toFixed(2)} for ${contracts} contracts...`);
        entryOrder = await this.client.placeStopOrder(
          this.account.id,
          this.contract.id,
          contracts,
          action,
          stopEntry
        );
      } else {
        // Market entry (default)
        logger.trade(`Placing ${action} MARKET entry for ${contracts} contracts...`);
        entryOrder = await this.client.placeMarketOrder(
          this.account.id,
          this.contract.id,
          contracts,
          action
        );
      }

      this.currentPosition.orderId = entryOrder.orderId;
      logger.success(`✓ Entry order placed (${placedType}): ${entryOrder.orderId}`);

      // Generate a trade ID for tracking
      this.currentTradeId = signal.signalId || `webhook-${entryOrder.orderId}`;

      this.emit('tradeEntered', {
        position: this.currentPosition,
        tradeId: this.currentTradeId,
      });

      return {
        executed: true,
        position: this.currentPosition,
        tradeId: this.currentTradeId,
        orderId: entryOrder.orderId,
      };

    } catch (error) {
      const errorInfo = ErrorHandler.handle(error, {
        component: 'SignalHandler',
        action: 'handleSignal',
      });
      logger.error(`Trade failed: ${errorInfo.message}`);

      // Clear stale position if it was set before the error
      if (this.currentPosition) {
        logger.warn('Clearing stale position state after order placement failure');
        this.currentPosition = null;
        this.currentTradeId = null;
      }

      // If the order was REJECTED by the exchange, halt trading
      if (error.isOrderRejection) {
        logger.error('🚨 ORDER REJECTED BY EXCHANGE — halting trading');
        this.lossLimits.halt('ORDER_REJECTED', `Order rejected: ${error.message}`);
        await this.notifications.send(
          `🚨 <b>ORDER REJECTED BY EXCHANGE</b>\n` +
          `${error.message}\n` +
          `Trading halted — manual review needed.`
        ).catch(() => {});
        this.emit('tradingHalted', { reason: 'ORDER_REJECTED', message: error.message });
      } else if (errorInfo.recovery?.action === 'HALT') {
        logger.error(`Halting trading: ${errorInfo.recovery.message}`);
        this.lossLimits.halt(errorInfo.code, errorInfo.recovery.message || `Halted: ${errorInfo.code}`);
        await this.notifications.tradingHalted?.(errorInfo.recovery.message).catch(() => {});
        this.emit('tradingHalted', errorInfo);
      }

      await this.notifications.error?.(errorInfo.message).catch(() => {});

      return { executed: false, error: errorInfo };
    } finally {
      this._processingSignal = false;
    }
  }

  /**
   * Validate signal against market hours, loss limits, and session filter.
   * @returns {{ valid: boolean, reason?: string }}
   */
  _validateSignal() {
    // Check market hours
    const marketStatus = this.marketHours.getStatus();
    if (!marketStatus.isOpen) {
      return { valid: false, reason: `Market closed: ${marketStatus.message}` };
    }

    // Check loss limits
    const canTrade = this.lossLimits.canTrade();
    if (!canTrade.allowed) {
      return { valid: false, reason: `Loss limit: ${canTrade.reason}` };
    }

    // Check session filter
    if (this.sessionFilter) {
      const sessionCheck = this.sessionFilter.canTrade();
      if (!sessionCheck.allowed) {
        return { valid: false, reason: `Session filter: ${sessionCheck.reason}` };
      }
    }

    return { valid: true };
  }
}

module.exports = SignalHandler;
