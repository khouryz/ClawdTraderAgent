/**
 * Risk Manager
 * Handles position sizing, risk calculations, and trade validation
 */

const { TRADING, CONTRACTS } = require('../utils/constants');

class RiskManager {
  constructor(config) {
    this.config = config;
    this.riskPerTrade = {
      min: config.riskPerTrade.min || 30,
      max: config.riskPerTrade.max || 60
    };
    this.profitTargetR = config.profitTargetR || 2;
  }

  /**
   * Calculate position size based on risk parameters
   * @param {number} accountBalance - Current account balance
   * @param {number} entryPrice - Entry price for the trade
   * @param {number} stopPrice - Stop loss price
   * @param {number} tickSize - Contract tick size
   * @param {number} tickValue - Dollar value per tick
   * @returns {Object} Position size calculation
   */
  calculatePositionSize(accountBalance, entryPrice, stopPrice, tickSize, tickValue) {
    // Calculate risk per contract
    const priceRisk = Math.abs(entryPrice - stopPrice);
    const ticksRisk = priceRisk / tickSize;
    const dollarRiskPerContract = ticksRisk * tickValue;

    // HIGH-1 FIX: Guard against zero/invalid dollarRiskPerContract to prevent Infinity
    if (!dollarRiskPerContract || dollarRiskPerContract <= 0 || !isFinite(dollarRiskPerContract)) {
      console.error(`[RiskManager] Invalid risk calculation: dollarRiskPerContract=${dollarRiskPerContract}`);
      return {
        contracts: 0,
        riskPerContract: 0,
        totalRisk: 0,
        profitTarget: 0,
        stopPrice,
        targetPrice: entryPrice,
        riskRewardRatio: this.profitTargetR,
        entryPrice,
        error: 'Invalid stop distance - risk per contract is zero or invalid'
      };
    }

    // HARD CAP: If even 1 contract exceeds max risk, reject the trade
    if (dollarRiskPerContract > this.riskPerTrade.max) {
      console.warn(`[RiskManager] REJECTED: 1 contract risk $${dollarRiskPerContract.toFixed(2)} exceeds max $${this.riskPerTrade.max}`);
      return {
        contracts: 0,
        riskPerContract: dollarRiskPerContract,
        totalRisk: dollarRiskPerContract,
        profitTarget: 0,
        stopPrice,
        targetPrice: entryPrice,
        riskRewardRatio: this.profitTargetR,
        entryPrice,
        error: `Stop too wide: $${dollarRiskPerContract.toFixed(2)} risk per contract exceeds max $${this.riskPerTrade.max}`
      };
    }

    // Use max risk amount (ensures we stay at or below the cap)
    const targetRisk = this.riskPerTrade.max;

    // Calculate number of contracts
    const contracts = Math.floor(targetRisk / dollarRiskPerContract);

    // Ensure minimum 1 contract (already validated above that 1 contract is within max risk)
    const finalContracts = Math.max(TRADING.MIN_CONTRACTS, contracts);
    const actualRisk = finalContracts * dollarRiskPerContract;

    // Calculate profit target (2R)
    const profitTarget = actualRisk * this.profitTargetR;
    const targetPrice = entryPrice + (stopPrice < entryPrice ? 1 : -1) * (priceRisk * this.profitTargetR);

    return {
      contracts: finalContracts,
      riskPerContract: dollarRiskPerContract,
      totalRisk: actualRisk,
      profitTarget,
      stopPrice,
      targetPrice,
      riskRewardRatio: this.profitTargetR,
      entryPrice
    };
  }

  /**
   * Validate if a trade meets risk requirements
   */
  validateTrade(position) {
    // Check if risk is within bounds
    if (position.totalRisk < this.riskPerTrade.min) {
      return {
        valid: false,
        reason: `Risk too low: $${position.totalRisk.toFixed(2)} (min: $${this.riskPerTrade.min})`
      };
    }

    if (position.totalRisk > this.riskPerTrade.max) {
      return {
        valid: false,
        reason: `Risk too high: $${position.totalRisk.toFixed(2)} (max: $${this.riskPerTrade.max})`
      };
    }

    // Check if we have at least 1 contract
    if (position.contracts < 1) {
      return {
        valid: false,
        reason: 'Position size too small (< 1 contract)'
      };
    }

    return { valid: true };
  }

  /**
   * Get contract specifications for MES or MNQ
   */
  getContractSpecs(symbol) {
    // Extract base symbol (remove month/year codes)
    const baseSymbol = symbol.substring(0, 3);
    return CONTRACTS[baseSymbol] || CONTRACTS.MES;
  }

  /**
   * Format a trade summary for logging
   */
  formatTradeSummary(position) {
    return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 TRADE SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Contracts:     ${position.contracts}
Entry:         $${position.entryPrice.toFixed(2)}
Stop Loss:     $${position.stopPrice.toFixed(2)}
Target:        $${position.targetPrice.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Risk:          $${position.totalRisk.toFixed(2)}
Profit Target: $${position.profitTarget.toFixed(2)}
R:R Ratio:     1:${position.riskRewardRatio}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `;
  }
}

module.exports = RiskManager;
