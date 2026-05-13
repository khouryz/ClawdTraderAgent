/**
 * Account Config Loader
 * 
 * Discovers, validates, and parses per-account .env files from the accounts/ directory.
 * Each account gets its own isolated config object for AccountInstance.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const ConfigValidator = require('./config_validator');
const logger = require('./logger');

/**
 * Load all account configs from the accounts directory
 * @param {string} accountsDir - Path to accounts directory (e.g. './accounts')
 * @returns {Array<Object>} Array of validated account configs
 */
function loadAccountConfigs(accountsDir) {
  if (!fs.existsSync(accountsDir)) {
    logger.error(`[AccountConfigLoader] Accounts directory not found: ${accountsDir}`);
    return [];
  }

  const files = fs.readdirSync(accountsDir).filter(f => f.endsWith('.env'));
  if (files.length === 0) {
    logger.warn(`[AccountConfigLoader] No .env files found in ${accountsDir}`);
    return [];
  }

  const configs = [];
  for (const file of files) {
    const accountId = path.basename(file, '.env');
    const filePath = path.join(accountsDir, file);

    try {
      const raw = dotenv.parse(fs.readFileSync(filePath));
      const validation = validateAccountConfig(accountId, raw);
      
      if (!validation.ok) {
        logger.error(`[AccountConfigLoader] ${accountId}: invalid config - ${validation.errors.join('; ')}`);
        continue;
      }

      const config = buildAccountConfig(accountId, raw);
      configs.push(config);
      logger.info(`[AccountConfigLoader] ${accountId}: config loaded successfully`);
    } catch (err) {
      logger.error(`[AccountConfigLoader] ${accountId}: failed to parse - ${err.message}`);
    }
  }

  return configs;
}

/**
 * Validate required fields in account config
 * @param {string} accountId - Account identifier
 * @param {Object} env - Parsed environment variables
 * @returns {{ok: boolean, errors: Array<string>}}
 */
function validateAccountConfig(accountId, env) {
  const errors = [];
  
  // Tradovate credentials
  if (!env.TRADOVATE_ENV) errors.push('missing TRADOVATE_ENV');
  if (!env.TRADOVATE_USERNAME) errors.push('missing TRADOVATE_USERNAME');
  if (!env.TRADOVATE_PASSWORD) errors.push('missing TRADOVATE_PASSWORD');
  if (!env.TRADOVATE_CID) errors.push('missing TRADOVATE_CID');
  if (!env.TRADOVATE_SECRET) errors.push('missing TRADOVATE_SECRET');
  
  // Telegram (required per account)
  if (!env.TELEGRAM_BOT_TOKEN) errors.push('missing TELEGRAM_BOT_TOKEN');
  if (!env.TELEGRAM_CHAT_ID) errors.push('missing TELEGRAM_CHAT_ID');
  
  // Instruments
  if (!env.INSTRUMENTS) errors.push('missing INSTRUMENTS');

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Build account config object from parsed env
 * @param {string} accountId - Account identifier
 * @param {Object} env - Parsed environment variables
 * @returns {Object} Account config for AccountInstance
 */
function buildAccountConfig(accountId, env) {
  return {
    accountId,
    credentials: {
      env: env.TRADOVATE_ENV || 'demo',
      username: env.TRADOVATE_USERNAME,
      password: env.TRADOVATE_PASSWORD,
      cid: env.TRADOVATE_CID ? parseInt(env.TRADOVATE_CID) : null,
      secret: env.TRADOVATE_SECRET,
      accountName: env.TRADOVATE_ACCOUNT_NAME,
      accountId: env.TRADOVATE_ACCOUNT_ID ? parseInt(env.TRADOVATE_ACCOUNT_ID) : null,
    },
    telegram: {
      token: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
    },
    instruments: parseInstrumentConfigs(env),
  };
}

/**
 * Parse instrument configurations from env object (mirrors MultiInstrumentBot._parseInstrumentConfigs)
 * @param {Object} env - Parsed environment variables
 * @returns {Array<Object>} Array of instrument configs
 */
function parseInstrumentConfigs(env) {
  const instrumentList = (env.INSTRUMENTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (instrumentList.length === 0) {
    throw new Error('INSTRUMENTS not set in config');
  }

  const configs = [];
  for (const baseSymbol of instrumentList) {
    const prefix = baseSymbol.toUpperCase();
    const getEnv = (key, fallback) => env[`${prefix}_${key}`] !== undefined 
      ? env[`${prefix}_${key}`] 
      : fallback;

    const strategyName = (getEnv('STRATEGY', 'opening_range_breakout')).toLowerCase();
    const strategyParams = {};

    if (strategyName === 'mnq_momentum_v2' || strategyName === 'mnq_momentum') {
      strategyParams.emaxEnabled = getEnv('EMAX_ENABLED', 'false') === 'true';
      strategyParams.emaxEmaFast = parseInt(getEnv('EMAX_EMA_FAST', '9'));
      strategyParams.emaxEmaSlow = parseInt(getEnv('EMAX_EMA_SLOW', '21'));
      strategyParams.emaxMinBarRange = parseFloat(getEnv('EMAX_MIN_BAR_RANGE', '5'));
      strategyParams.emaxMinBodyRatio = parseFloat(getEnv('EMAX_MIN_BODY_RATIO', '0.5'));
      strategyParams.emaxMaxTime = parseInt(getEnv('EMAX_MAX_TIME', '480'));
      strategyParams.emaxUseZLEMA = getEnv('EMAX_USE_ZLEMA', 'false') === 'true';
      strategyParams.pbMinImpulse = parseFloat(getEnv('PB_MIN_IMPULSE', '15'));
      strategyParams.pbMinImpBodyRatio = parseFloat(getEnv('PB_MIN_IMP_BODY_RATIO', '0.15'));
      strategyParams.pbRetraceMin = parseFloat(getEnv('PB_RETRACE_MIN', '0.30'));
      strategyParams.pbRetraceMax = parseFloat(getEnv('PB_RETRACE_MAX', '0.60'));
      strategyParams.pbMaxTime = parseInt(getEnv('PB_MAX_TIME', '780'));
      strategyParams.pbLookbackBars = parseInt(getEnv('PB_LOOKBACK_BARS', '3'));
      strategyParams.vrEnabled = getEnv('VR_ENABLED', 'true') !== 'false';
      strategyParams.maxStopPoints = parseInt(getEnv('MAX_STOP_POINTS', '35'));
      strategyParams.minStopPoints = parseInt(getEnv('MIN_STOP_POINTS', '5'));
      strategyParams.stopBuffer = parseFloat(getEnv('STOP_BUFFER', '2'));
      strategyParams.profitTargetR = parseFloat(getEnv('PROFIT_TARGET_R', '6.0'));
      strategyParams.minTargetPoints = parseFloat(getEnv('MIN_TARGET_POINTS', '8'));
      strategyParams.minConfluence = parseInt(getEnv('MIN_CONFLUENCE', '2'));
      strategyParams.volumeAvgPeriod = parseInt(getEnv('VOLUME_AVG_PERIOD', '20'));
      strategyParams.momentumBars = parseInt(getEnv('MOMENTUM_BARS', '5'));
      strategyParams.priorLevelTolerance = parseFloat(getEnv('PRIOR_LEVEL_TOLERANCE', '5'));
      strategyParams.moveStopToBE = getEnv('MOVE_STOP_TO_BE', 'false') === 'true';
      strategyParams.beActivationR = parseFloat(getEnv('BE_ACTIVATION_R', '1.0'));
      strategyParams.beSteps = ConfigValidator.parseBeStopSteps(getEnv('BE_STOP_STEPS', '1.9:0'));
      strategyParams.partialProfitEnabled = getEnv('PARTIAL_PROFIT_ENABLED', 'false') === 'true';
      strategyParams.maxLossesPerDay = parseInt(getEnv('MAX_LOSSES_PER_DAY', '') || getEnv('MAX_CONSECUTIVE_LOSSES', '5'));
      strategyParams.volumeFilterEnabled = getEnv('VOLUME_FILTER_ENABLED', 'false') === 'true';
      strategyParams.pbMaxImpulse = parseFloat(getEnv('PB_MAX_IMPULSE', 'Infinity'));
      strategyParams.pbEntryMode = 'immediate';
      strategyParams.pbConfirmBars = parseInt(getEnv('PB_CONFIRM_BARS', '5'));
      strategyParams.pbLimitRetracePct = parseFloat(getEnv('PB_LIMIT_RETRACE_PCT', '0.6'));
      strategyParams.pbLimitTimeoutBars = parseInt(getEnv('PB_LIMIT_TIMEOUT_BARS', '5'));
      strategyParams.pbTrendFilterEnabled = getEnv('PB_TREND_FILTER', 'false') === 'true';
      strategyParams.pbTickEntry = getEnv('PB_TICK_ENTRY', 'false') === 'true';
      strategyParams.pb3mTickEntry = getEnv('PB3M_TICK_ENTRY', 'false') === 'true';
      strategyParams.pb2mTickEntry = getEnv('PB2M_TICK_ENTRY', 'false') === 'true';
      strategyParams.zoneExitMargin = parseFloat(getEnv('ZONE_EXIT_MARGIN', '0.05'));
      strategyParams.consecTicksRequired = parseInt(getEnv('CONSEC_TICKS_REQUIRED', '3'));
      strategyParams.cooldownBars = parseInt(getEnv('COOLDOWN_BARS', '2'));
      strategyParams.pb3mEnabled = getEnv('PB3M_ENABLED', 'true') === 'true';
      strategyParams.pb3mMinImpulse = parseFloat(getEnv('PB3M_MIN_IMPULSE', '8'));
      strategyParams.pb3mMaxImpulse = parseFloat(getEnv('PB3M_MAX_IMPULSE', '50'));
      strategyParams.pb3mLookbackBars = parseInt(getEnv('PB3M_LOOKBACK_BARS', '4'));
      strategyParams.pb3mMaxTime = parseInt(getEnv('PB3M_MAX_TIME', '570'));
      strategyParams.pb3mRetraceMin = parseFloat(getEnv('PB3M_RETRACE_MIN', '0.30'));
      strategyParams.pb3mRetraceMax = parseFloat(getEnv('PB3M_RETRACE_MAX', '0.55'));
      strategyParams.pb3mMinImpBodyRatio = parseFloat(getEnv('PB3M_MIN_IMP_BODY_RATIO', '0.10'));
      strategyParams.pb3mMaxStopPoints = parseInt(getEnv('PB3M_MAX_STOP_POINTS', '25'));
      strategyParams.pb3mMinStopPoints = parseInt(getEnv('PB3M_MIN_STOP_POINTS', '5'));
      strategyParams.pb3mMinTargetPoints = parseInt(getEnv('PB3M_MIN_TARGET_POINTS', '8'));
      strategyParams.pb2mEnabled = getEnv('PB2M_ENABLED', 'true') === 'true';
      strategyParams.pb2mMinImpulse = parseFloat(getEnv('PB2M_MIN_IMPULSE', '8'));
      strategyParams.pb2mMaxImpulse = parseFloat(getEnv('PB2M_MAX_IMPULSE', '40'));
      strategyParams.pb2mLookbackBars = parseInt(getEnv('PB2M_LOOKBACK_BARS', '4'));
      strategyParams.pb2mMaxTime = parseInt(getEnv('PB2M_MAX_TIME', '570'));
      strategyParams.pb2mRetraceMin = parseFloat(getEnv('PB2M_RETRACE_MIN', '0.30'));
      strategyParams.pb2mRetraceMax = parseFloat(getEnv('PB2M_RETRACE_MAX', '0.55'));
      strategyParams.pb2mMinImpBodyRatio = parseFloat(getEnv('PB2M_MIN_IMP_BODY_RATIO', '0.10'));
      strategyParams.pb2mMaxStopPoints = parseInt(getEnv('PB2M_MAX_STOP_POINTS', '25'));
      strategyParams.pb2mMinStopPoints = parseInt(getEnv('PB2M_MIN_STOP_POINTS', '5'));
      strategyParams.pb2mMinTargetPoints = parseInt(getEnv('PB2M_MIN_TARGET_POINTS', '8'));
      strategyParams.maxEntrySlippagePts = parseFloat(getEnv('MAX_ENTRY_SLIPPAGE_PTS', '5'));
      strategyParams.pbZoneExitEntry = getEnv('PB_ZONE_EXIT_ENTRY', 'true') === 'true';
      strategyParams.pb3mZoneExitEntry = getEnv('PB3M_ZONE_EXIT_ENTRY', 'true') === 'true';
      strategyParams.pb2mZoneExitEntry = getEnv('PB2M_ZONE_EXIT_ENTRY', 'true') === 'true';
    } else if (strategyName === 'liquidity_orb') {
      strategyParams.orStartMinPST = parseInt(getEnv('OR_START_MIN_PST', '300'));
      strategyParams.orDurationMin = parseInt(getEnv('OR_DURATION_MIN', '15'));
      strategyParams.brtEnabled = getEnv('BRT_ENABLED', 'true') !== 'false';
      strategyParams.brtWaitMinPST = parseInt(getEnv('BRT_WAIT_MIN_PST', '390'));
      strategyParams.brtMaxTimePST = parseInt(getEnv('BRT_MAX_TIME_PST', '600'));
      strategyParams.brtStopPoints = parseFloat(getEnv('BRT_STOP_POINTS', '5'));
      strategyParams.brtTargetPoints = parseFloat(getEnv('BRT_TARGET_POINTS', '15'));
      strategyParams.bounceEnabled = getEnv('BOUNCE_ENABLED', 'true') !== 'false';
      strategyParams.maxTradesPerDay = parseInt(getEnv('MAX_TRADES_PER_DAY', '3'));
    } else {
      // ORB params (legacy)
      strategyParams.orPeriodMinutes = parseInt(getEnv('OR_PERIOD_MINUTES', '15'));
      strategyParams.orBuffer = parseFloat(getEnv('OR_BUFFER', '0.5'));
      strategyParams.stopBuffer = parseFloat(getEnv('STOP_BUFFER', '0.5'));
      strategyParams.maxStopPoints = parseInt(getEnv('MAX_STOP_POINTS', '15'));
      strategyParams.minOrRange = parseInt(getEnv('MIN_OR_RANGE', '2'));
      strategyParams.maxOrRange = parseInt(getEnv('MAX_OR_RANGE', '12'));
      strategyParams.minBodyRatio = parseFloat(getEnv('MIN_BODY_RATIO', '0.3'));
      strategyParams.profitTargetR = parseFloat(getEnv('PROFIT_TARGET_R', '2'));
      strategyParams.useTrendFilter = getEnv('USE_TREND_FILTER', 'true') === 'true';
      strategyParams.useVolumeFilter = getEnv('USE_VOLUME_FILTER', 'true') !== 'false';
      strategyParams.volumeAvgPeriod = parseInt(getEnv('VOLUME_AVG_PERIOD', '10'));
      strategyParams.volumeMinRatio = parseFloat(getEnv('VOLUME_MIN_RATIO', '1.0'));
      strategyParams.allowShorts = getEnv('ALLOW_SHORTS', 'true') !== 'false';
      strategyParams.trailingStopEnabled = getEnv('TRAILING_STOP_ENABLED', 'false') === 'true';
      strategyParams.trailActivationR = parseFloat(getEnv('TRAIL_ACTIVATION_R', '2.0'));
      strategyParams.trailDistancePoints = parseFloat(getEnv('TRAIL_DISTANCE_POINTS', '8'));
      strategyParams.moveStopToBE = getEnv('MOVE_STOP_TO_BE', 'false') === 'true';
      strategyParams.beActivationR = parseFloat(getEnv('BE_ACTIVATION_R', '1.2'));
      strategyParams.beSteps = ConfigValidator.parseBeStopSteps(getEnv('BE_STOP_STEPS', ''));
    }

    configs.push({
      baseSymbol: baseSymbol.toUpperCase(),
      symbol: getEnv('SYMBOL', `${baseSymbol}M6`),
      strategy: strategyName,
      strategyParams,
      databentoSymbol: getEnv('DATABENTO_SYMBOL', `${baseSymbol}.FUT`),
      autoRollover: getEnv('AUTO_ROLLOVER', 'false') === 'true',
      lastEntryHour: parseInt(getEnv('LAST_ENTRY_HOUR', '11')),
      lastEntryMinute: parseInt(getEnv('LAST_ENTRY_MINUTE', '30')),
      skipHours: getEnv('SKIP_HOURS', ''),
      skipHourRanges: ConfigValidator.parseSkipHours(getEnv('SKIP_HOURS', '')),
      riskParams: {
        riskPerTrade: {
          min: parseFloat(getEnv('RISK_PER_TRADE_MIN', '15')),
          max: parseFloat(getEnv('RISK_PER_TRADE_MAX', '90')),
        },
        maxContracts: parseInt(getEnv('MAX_CONTRACTS', '5')),
        dailyLossLimit: parseFloat(getEnv('DAILY_LOSS_LIMIT', '200')),
        weeklyLossLimit: parseFloat(getEnv('WEEKLY_LOSS_LIMIT', '650')),
        maxConsecutiveLosses: parseInt(getEnv('MAX_CONSECUTIVE_LOSSES', '5')),
        maxDrawdownPercent: parseFloat(getEnv('MAX_DRAWDOWN_PERCENT', '15')),
        dailyProfitTarget: parseFloat(getEnv('DAILY_PROFIT_TARGET', 'Infinity')),
        profitTiers: getEnv('DAILY_PROFIT_TIERS', ''),
      },
    });
  }

  return configs;
}

module.exports = { loadAccountConfigs, validateAccountConfig, buildAccountConfig, parseInstrumentConfigs };
