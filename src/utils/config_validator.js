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
    if (!config.username) errors.push('TRADOVATE_USERNAME is required');
    if (!config.password) errors.push('TRADOVATE_PASSWORD is required');
    if (!config.contractSymbol) errors.push('CONTRACT_SYMBOL is required');

    // MED-6 FIX: Validate AI settings if AI is enabled
    if (config.aiConfirmationEnabled) {
      if (!config.aiApiKey) errors.push('AI_API_KEY is required when AI_CONFIRMATION_ENABLED=true');
      if (config.aiProvider && !['openai', 'anthropic'].includes(config.aiProvider)) {
        errors.push('AI_PROVIDER must be "openai" or "anthropic"');
      }
      if (config.aiConfidenceThreshold && (config.aiConfidenceThreshold < 0 || config.aiConfidenceThreshold > 100)) {
        errors.push('AI_CONFIDENCE_THRESHOLD must be between 0 and 100');
      }
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
      cid: config.cid,
      secret: config.secret,
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
      moveStopToBE: config.moveStopToBE === true,
      beActivationR: this._parseNumber(config.beActivationR) || 1.2,
      beSteps: Array.isArray(config.beSteps) ? config.beSteps : null,
      partialProfitEnabled: config.partialProfitEnabled === true,
      partialProfitPercent: this._parseNumber(config.partialProfitPercent) || 50,
      partialProfitR: this._parseNumber(config.partialProfitR) || 1.0,
      
      // AI Confirmation settings
      aiConfirmationEnabled: config.aiConfirmationEnabled === true,
      aiProvider: config.aiProvider || 'anthropic',
      aiApiKey: config.aiApiKey || '',
      aiModel: config.aiModel || null,
      aiConfidenceThreshold: this._parseInt(config.aiConfidenceThreshold) || 70,
      aiTimeout: this._parseInt(config.aiTimeout) || 5000,
      aiDefaultAction: config.aiDefaultAction || 'confirm',

      // Databento settings (market data provider)
      databentoApiKey: config.databentoApiKey || '',
      databentoSymbol: config.databentoSymbol || null,
      databentoSchema: config.databentoSchema || 'trades',
      databentoDataset: config.databentoDataset || 'GLBX.MDP3',
      pythonPath: config.pythonPath || 'python'
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

  /**
   * Parse BE_STOP_STEPS env var into a sorted array of { triggerR, placementR } objects.
   * Format: "1.0:-0.5,2.0:0.5,3.0:1.5"  (triggerR:placementR pairs, comma-separated)
   * Returns null if the value is empty or unparseable.
   */
  static parseBeStopSteps(val) {
    if (!val || !val.trim()) return null;
    const steps = val.split(',').map(pair => {
      const [t, p] = pair.trim().split(':');
      return { triggerR: parseFloat(t), placementR: parseFloat(p) };
    }).filter(s => !isNaN(s.triggerR) && !isNaN(s.placementR));
    return steps.length > 0 ? steps.sort((a, b) => a.triggerR - b.triggerR) : null;
  }

  /**
   * Parse SKIP_HOURS env var into an array of { start, end } PT-minute ranges.
   * Entries falling inside any range are vetoed (signal rejected).
   *
   * Format (comma-separated, any combination):
   *   - "9"             → skip 9:00-9:59 PT (entire hour)
   *   - "9:30"          → skip the single minute 9:30 PT
   *   - "9:30-9:59"     → skip a half-hour window 9:30 through 9:59 PT (exclusive on end)
   *   - "9,12:00-12:14" → multiple ranges
   *
   * Notes on semantics (matches backtester):
   *   - `start` is INCLUSIVE, `end` is EXCLUSIVE (minute-of-day, e.g. 9*60+30 = 570).
   *   - Bare hour "H" expands to [H*60, (H+1)*60) i.e. the full hour.
   *   - Bare minute "H:M" expands to [H*60+M, H*60+M+1) i.e. exactly one minute.
   *
   * Returns an empty array on null/empty/whitespace input or fully unparseable entries.
   * Always returns an array (never null) so callers can use `.some()` safely.
   *
   * @param {string|undefined|null} val
   * @returns {Array<{start:number,end:number}>}
   */
  static parseSkipHours(val) {
    if (!val || !String(val).trim()) return [];
    const ranges = [];
    for (const raw of String(val).split(',')) {
      const part = raw.trim();
      if (!part) continue;
      const parseTime = (t) => {
        const s = String(t).trim();
        if (s.includes(':')) {
          const [hStr, mStr] = s.split(':');
          const h = parseInt(hStr, 10);
          const m = parseInt(mStr, 10);
          if (isNaN(h) || isNaN(m)) return null;
          return h * 60 + m;
        }
        const h = parseInt(s, 10);
        if (isNaN(h)) return null;
        return h * 60;
      };
      if (part.includes('-')) {
        const [a, b] = part.split('-');
        const start = parseTime(a);
        // For an explicit range, the right side is INCLUSIVE in user-input semantics
        // (e.g. "9:30-9:59" means up to 9:59 inclusive). Internally we use exclusive end,
        // so add 1 minute when the right side is a "H:M" form; if right side is a bare
        // hour (e.g. "9"), treat as start of that hour.
        const rawEnd = parseTime(b);
        if (start === null || rawEnd === null) continue;
        const rightHasMinute = String(b).includes(':');
        const end = rightHasMinute ? rawEnd + 1 : rawEnd;
        if (end > start) ranges.push({ start, end });
      } else if (part.includes(':')) {
        const start = parseTime(part);
        if (start === null) continue;
        ranges.push({ start, end: start + 1 });
      } else {
        const h = parseInt(part, 10);
        if (isNaN(h)) continue;
        ranges.push({ start: h * 60, end: (h + 1) * 60 });
      }
    }
    return ranges;
  }

  /**
   * Test if a given PT minute-of-day falls inside any skip window.
   * @param {number} pstMins - hour*60 + minute, in PT
   * @param {Array<{start:number,end:number}>|undefined|null} ranges
   * @returns {boolean}
   */
  static isInSkipWindow(pstMins, ranges) {
    if (!ranges || !ranges.length) return false;
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (pstMins >= r.start && pstMins < r.end) return true;
    }
    return false;
  }
}

module.exports = ConfigValidator;
