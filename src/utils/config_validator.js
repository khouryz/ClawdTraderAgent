/**
 * Configuration Validator
 * Validates and sanitizes all bot configuration parameters
 */

const { TRADING } = require('./constants');

class ConfigValidator {
  /**
   * Validate the entire configuration object
   */
  static validate(config) {
    const errors = [];
    const warnings = [];

    // Required credentials
    if (!config.username || typeof config.username !== 'string') {
      errors.push('TRADOVATE_USERNAME is required');
    }
    if (!config.password || typeof config.password !== 'string') {
      errors.push('TRADOVATE_PASSWORD is required');
    }

    // Environment
    if (config.env && !['demo', 'live'].includes(config.env)) {
      errors.push('TRADOVATE_ENV must be "demo" or "live"');
    }

    // Risk per trade validation
    const riskMin = this._parseNumber(config.riskPerTrade?.min);
    const riskMax = this._parseNumber(config.riskPerTrade?.max);
    
    if (riskMin !== null && riskMax !== null && riskMin > riskMax) {
      errors.push('RISK_PER_TRADE_MIN cannot exceed RISK_PER_TRADE_MAX');
    }
    if (riskMin !== null && riskMin < 10) {
      warnings.push('RISK_PER_TRADE_MIN below $10 may be too small');
    }
    if (riskMax !== null && riskMax > 500) {
      warnings.push('RISK_PER_TRADE_MAX above $500 is high risk');
    }

    // Loss limits
    const dailyLoss = this._parseNumber(config.dailyLossLimit);
    const weeklyLoss = this._parseNumber(config.weeklyLossLimit);
    
    if (dailyLoss !== null && weeklyLoss !== null && dailyLoss > weeklyLoss) {
      errors.push('DAILY_LOSS_LIMIT should not exceed WEEKLY_LOSS_LIMIT');
    }

    // Profit target
    const profitR = this._parseNumber(config.profitTargetR);
    if (profitR !== null && (profitR < 0.5 || profitR > 10)) {
      warnings.push('PROFIT_TARGET_R outside 0.5-10 range is unusual');
    }

    // Session times
    const startHour = this._parseNumber(config.tradingStartHour);
    const endHour = this._parseNumber(config.tradingEndHour);
    
    if (startHour !== null && (startHour < 0 || startHour > 23)) {
      errors.push('TRADING_START_HOUR must be 0-23');
    }
    if (endHour !== null && (endHour < 0 || endHour > 23)) {
      errors.push('TRADING_END_HOUR must be 0-23');
    }

    // Trailing stop
    if (config.trailingStopEnabled) {
      const trailATR = this._parseNumber(config.trailingStopATRMultiplier);
      if (trailATR !== null && (trailATR < 0.5 || trailATR > 5)) {
        warnings.push('TRAILING_STOP_ATR_MULTIPLIER outside 0.5-5 range is unusual');
      }
    }

    // Partial profit
    if (config.partialProfitEnabled) {
      const partialPct = this._parseNumber(config.partialProfitPercent);
      if (partialPct !== null && (partialPct < 10 || partialPct > 90)) {
        warnings.push('PARTIAL_PROFIT_PERCENT should be between 10-90%');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Sanitize configuration with defaults
   */
  static sanitize(config) {
    return {
      env: config.env || 'demo',
      username: config.username,
      password: config.password,
      contractSymbol: config.contractSymbol || 'MESM5',
      autoRollover: config.autoRollover === true,
      
      riskPerTrade: {
        min: this._parseNumber(config.riskPerTrade?.min) || TRADING.DEFAULT_RISK_MIN,
        max: this._parseNumber(config.riskPerTrade?.max) || TRADING.DEFAULT_RISK_MAX
      },
      profitTargetR: this._parseNumber(config.profitTargetR) || TRADING.DEFAULT_PROFIT_TARGET_R,
      dailyLossLimit: this._parseNumber(config.dailyLossLimit) || TRADING.DEFAULT_DAILY_LOSS_LIMIT,
      weeklyLossLimit: this._parseNumber(config.weeklyLossLimit) || TRADING.DEFAULT_WEEKLY_LOSS_LIMIT,
      maxConsecutiveLosses: this._parseInt(config.maxConsecutiveLosses) || TRADING.DEFAULT_MAX_CONSECUTIVE_LOSSES,
      maxDrawdownPercent: this._parseNumber(config.maxDrawdownPercent) || TRADING.DEFAULT_MAX_DRAWDOWN_PERCENT,
      
      strategy: config.strategy || 'enhanced_breakout',
      lookbackPeriod: this._parseInt(config.lookbackPeriod) || 20,
      atrMultiplier: this._parseNumber(config.atrMultiplier) || 1.5,
      trendEMAPeriod: this._parseInt(config.trendEMAPeriod) || 50,
      useTrendFilter: config.useTrendFilter !== false,
      useVolumeFilter: config.useVolumeFilter !== false,
      useRSIFilter: config.useRSIFilter !== false,
      
      tradingStartHour: this._parseInt(config.tradingStartHour) || 9,
      tradingStartMinute: this._parseInt(config.tradingStartMinute) || 30,
      tradingEndHour: this._parseInt(config.tradingEndHour) || 16,
      tradingEndMinute: this._parseInt(config.tradingEndMinute) || 0,
      avoidLunch: config.avoidLunch !== false,
      timezone: config.timezone || 'America/New_York',
      
      trailingStopEnabled: config.trailingStopEnabled === true,
      trailingStopATRMultiplier: this._parseNumber(config.trailingStopATRMultiplier) || 2.0,
      partialProfitEnabled: config.partialProfitEnabled === true,
      partialProfitPercent: this._parseNumber(config.partialProfitPercent) || 50,
      partialProfitR: this._parseNumber(config.partialProfitR) || 1.0
    };
  }

  static _parseNumber(value) {
    if (value === null || value === undefined) return null;
    const num = parseFloat(value);
    return isNaN(num) ? null : num;
  }

  static _parseInt(value) {
    if (value === null || value === undefined) return null;
    const num = parseInt(value);
    return isNaN(num) ? null : num;
  }
}

module.exports = ConfigValidator;
