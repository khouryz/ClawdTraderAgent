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
 * Parse TRADOVATE_ACCOUNT_NAME into an ordered list of sub-account names.
 *
 * Sub-account fanout: a single login (one .env file) may drive MULTIPLE
 * Tradovate sub-accounts that all share the same auth token. The value may be
 * a single name ("1699181") or a comma-separated list ("1699181,1699182").
 * The FIRST entry is the PRIMARY sub-account; the rest are mirror targets.
 *
 * @param {string|undefined} raw - Raw TRADOVATE_ACCOUNT_NAME value
 * @returns {string[]} Trimmed, de-duplicated, non-empty names (order preserved)
 */
function parseAccountNames(raw) {
  if (!raw) return [];
  const seen = new Set();
  const out = [];
  for (const part of String(raw).split(',')) {
    const name = part.trim();
    if (name && !seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

/**
 * Build account config object from parsed env
 * @param {string} accountId - Account identifier
 * @param {Object} env - Parsed environment variables
 * @returns {Object} Account config for AccountInstance
 */
function buildAccountConfig(accountId, env) {
  const accountNames = parseAccountNames(env.TRADOVATE_ACCOUNT_NAME);
  return {
    accountId,
    credentials: {
      env: env.TRADOVATE_ENV || 'demo',
      username: env.TRADOVATE_USERNAME,
      password: env.TRADOVATE_PASSWORD,
      cid: env.TRADOVATE_CID ? parseInt(env.TRADOVATE_CID) : null,
      secret: env.TRADOVATE_SECRET,
      // Sub-account fanout: full ordered list of sub-account names under this login.
      accountNames,
      // Backward compat: single-account call sites read `accountName` = primary.
      accountName: accountNames[0] || null,
      accountId: env.TRADOVATE_ACCOUNT_ID ? parseInt(env.TRADOVATE_ACCOUNT_ID) : null,
    },
    telegram: {
      token: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
    },
    // Account-level daily loss halt (across ALL instruments on this account). 0 = disabled.
    accountDailyLossLimit: parseFloat(env.ACCOUNT_DAILY_LOSS_LIMIT) || 0,
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

    // Build strategy params from prefixed env vars
    // IMPORTANT: This must stay in sync with MultiInstrumentBot._parseInstrumentConfigs()
    const strategyParams = {};

    if (strategyName === 'mnq_momentum_v2' || strategyName === 'mnq_momentum') {
      // MNQ Momentum V2 params
      strategyParams.emaxEnabled = getEnv('EMAX_ENABLED', 'false') === 'true';
      strategyParams.emaxEmaFast = parseInt(getEnv('EMAX_EMA_FAST', '9'));
      strategyParams.emaxEmaSlow = parseInt(getEnv('EMAX_EMA_SLOW', '21'));
      strategyParams.emaxMinBarRange = parseFloat(getEnv('EMAX_MIN_BAR_RANGE', '5'));
      strategyParams.emaxMinBodyRatio = parseFloat(getEnv('EMAX_MIN_BODY_RATIO', '0.5'));
      strategyParams.emaxMaxTime = parseInt(getEnv('EMAX_MAX_TIME', '480'));
      strategyParams.emaxUseZLEMA = getEnv('EMAX_USE_ZLEMA', 'false') === 'true';
      strategyParams.pbMinImpulse = parseFloat(getEnv('PB_MIN_IMPULSE', '15'));
      strategyParams.pbMinImpBodyRatio = parseFloat(getEnv('PB_MIN_IMP_BODY_RATIO', '0.15'));
      strategyParams.pbRetraceMin = parseFloat(getEnv('PB_RETRACE_MIN', '0.10'));
      strategyParams.pbRetraceMax = parseFloat(getEnv('PB_RETRACE_MAX', '0.85'));
      strategyParams.pbMaxTime = parseInt(getEnv('PB_MAX_TIME', '570'));
      strategyParams.vrEnabled = getEnv('VR_ENABLED', 'true') !== 'false';
      strategyParams.vrMinTime = parseInt(getEnv('VR_MIN_TIME', '510'));
      strategyParams.vrMaxTime = parseInt(getEnv('VR_MAX_TIME', '660'));
      strategyParams.vrMinSigma = parseFloat(getEnv('VR_MIN_SIGMA', '1.3'));
      strategyParams.vrEntrySigmaMax = parseFloat(getEnv('VR_ENTRY_SIGMA_MAX', '1.0'));
      strategyParams.vrStopBeyondBand = parseFloat(getEnv('VR_STOP_BEYOND_BAND', '3'));
      strategyParams.vrTargetMode = getEnv('VR_TARGET_MODE', 'fixed');
      strategyParams.vrTargetR = parseFloat(getEnv('VR_TARGET_R', '4'));
      strategyParams.vrMinBarVolRatio = parseFloat(getEnv('VR_MIN_BAR_VOL_RATIO', '0.8'));
      strategyParams.vrMaxStopPoints = parseInt(getEnv('VR_MAX_STOP_POINTS', '20'));
      strategyParams.vrMinStopPoints = parseInt(getEnv('VR_MIN_STOP_POINTS', '4'));
      strategyParams.vrCooldownBars = parseInt(getEnv('VR_COOLDOWN_BARS', '10'));
      // parseFloat (not parseInt): stop/target points are fractional for tick-0.10
      // instruments (e.g. M2K maxStop 4.8, minStop 0.6). parseInt would truncate
      // 0.6→0 (disabling the min-stop filter) and 4.8→4. Integer configs (MNQ/MES) unchanged.
      strategyParams.maxStopPoints = parseFloat(getEnv('MAX_STOP_POINTS', '35'));
      strategyParams.minStopPoints = parseFloat(getEnv('MIN_STOP_POINTS', '5'));
      strategyParams.stopBuffer = parseFloat(getEnv('STOP_BUFFER', '2'));
      strategyParams.profitTargetR = parseFloat(getEnv('PROFIT_TARGET_R', '2.5'));
      strategyParams.minTargetPoints = parseFloat(getEnv('MIN_TARGET_POINTS', '20'));
      strategyParams.minConfluence = parseInt(getEnv('MIN_CONFLUENCE', '0'));
      // Per-strategy confluence overrides — leave unset to fall back to shared MIN_CONFLUENCE
      if (getEnv('PB_MIN_CONFLUENCE', '') !== '')   strategyParams.pbMinConfluence   = parseInt(getEnv('PB_MIN_CONFLUENCE', '0'));
      if (getEnv('PB3M_MIN_CONFLUENCE', '') !== '') strategyParams.pb3mMinConfluence = parseInt(getEnv('PB3M_MIN_CONFLUENCE', '0'));
      if (getEnv('PB2M_MIN_CONFLUENCE', '') !== '') strategyParams.pb2mMinConfluence = parseInt(getEnv('PB2M_MIN_CONFLUENCE', '0'));
      if (getEnv('VR_MIN_CONFLUENCE', '') !== '')   strategyParams.vrMinConfluence   = parseInt(getEnv('VR_MIN_CONFLUENCE', '0'));
      if (getEnv('EMAX_MIN_CONFLUENCE', '') !== '') strategyParams.emaxMinConfluence = parseInt(getEnv('EMAX_MIN_CONFLUENCE', '0'));
      strategyParams.volumeAvgPeriod = parseInt(getEnv('VOLUME_AVG_PERIOD', '20'));
      strategyParams.momentumBars = parseInt(getEnv('MOMENTUM_BARS', '3'));
      strategyParams.priorLevelTolerance = parseFloat(getEnv('PRIOR_LEVEL_TOLERANCE', '5'));
      strategyParams.moveStopToBE = getEnv('MOVE_STOP_TO_BE', 'false') === 'true';
      strategyParams.beActivationR = parseFloat(getEnv('BE_ACTIVATION_R', '1.2'));
      strategyParams.beSteps = ConfigValidator.parseBeStopSteps(getEnv('BE_STOP_STEPS', ''));
      strategyParams.partialProfitEnabled = getEnv('PARTIAL_PROFIT_ENABLED', 'false') === 'true';
      strategyParams.partialProfitR = parseFloat(getEnv('PARTIAL_PROFIT_R', '2'));
      strategyParams.maxLossesPerDay = parseInt(getEnv('MAX_LOSSES_PER_DAY', '') || getEnv('MAX_CONSECUTIVE_LOSSES', '3'));
      strategyParams.volumeFilterEnabled = getEnv('VOLUME_FILTER_ENABLED', 'false') === 'true';
      strategyParams.volumeFilterMin = parseFloat(getEnv('VOLUME_FILTER_MIN', '0.9'));
      strategyParams.volumeFilterPeriod = parseInt(getEnv('VOLUME_FILTER_PERIOD', '20'));
      // PB 5m additional params
      strategyParams.pbMaxImpulse = parseFloat(getEnv('PB_MAX_IMPULSE', 'Infinity'));
      strategyParams.pbLookbackBars = parseInt(getEnv('PB_LOOKBACK_BARS', '1'));
      // PB 3m sub-strategy
      strategyParams.pb3mEnabled = getEnv('PB3M_ENABLED', 'false') === 'true';
      strategyParams.pb3mMinImpulse = parseFloat(getEnv('PB3M_MIN_IMPULSE', '10'));
      strategyParams.pb3mMaxImpulse = parseFloat(getEnv('PB3M_MAX_IMPULSE', '30'));
      strategyParams.pb3mLookbackBars = parseInt(getEnv('PB3M_LOOKBACK_BARS', '1'));
      strategyParams.pb3mMaxTime = parseInt(getEnv('PB3M_MAX_TIME', '570'));
      strategyParams.pb3mRetraceMin = parseFloat(getEnv('PB3M_RETRACE_MIN', '0.10'));
      strategyParams.pb3mRetraceMax = parseFloat(getEnv('PB3M_RETRACE_MAX', '0.85'));
      strategyParams.pb3mMinImpBodyRatio = parseFloat(getEnv('PB3M_MIN_IMP_BODY_RATIO', '0.15'));
      strategyParams.pb3mMaxStopPoints = parseFloat(getEnv('PB3M_MAX_STOP_POINTS', '25'));
      strategyParams.pb3mMinStopPoints = parseFloat(getEnv('PB3M_MIN_STOP_POINTS', '3'));
      strategyParams.pb3mMinTargetPoints = parseFloat(getEnv('PB3M_MIN_TARGET_POINTS', '15'));
      // PB 2m sub-strategy
      strategyParams.pb2mEnabled = getEnv('PB2M_ENABLED', 'false') === 'true';
      strategyParams.pb2mMinImpulse = parseFloat(getEnv('PB2M_MIN_IMPULSE', '8'));
      strategyParams.pb2mMaxImpulse = parseFloat(getEnv('PB2M_MAX_IMPULSE', '25'));
      strategyParams.pb2mLookbackBars = parseInt(getEnv('PB2M_LOOKBACK_BARS', '1'));
      strategyParams.pb2mMaxTime = parseInt(getEnv('PB2M_MAX_TIME', '570'));
      strategyParams.pb2mRetraceMin = parseFloat(getEnv('PB2M_RETRACE_MIN', '0.10'));
      strategyParams.pb2mRetraceMax = parseFloat(getEnv('PB2M_RETRACE_MAX', '0.85'));
      strategyParams.pb2mMinImpBodyRatio = parseFloat(getEnv('PB2M_MIN_IMP_BODY_RATIO', '0.15'));
      strategyParams.pb2mMaxStopPoints = parseFloat(getEnv('PB2M_MAX_STOP_POINTS', '20'));
      strategyParams.pb2mMinStopPoints = parseFloat(getEnv('PB2M_MIN_STOP_POINTS', '2'));
      strategyParams.pb2mMinTargetPoints = parseFloat(getEnv('PB2M_MIN_TARGET_POINTS', '10'));
      // Slippage guard (global default + per-strategy overrides)
      strategyParams.maxEntrySlippagePts = parseFloat(getEnv('MAX_ENTRY_SLIPPAGE_PTS', '5'));
      strategyParams.slippageByStrategy = {
        PB:   parseFloat(getEnv('PB_MAX_ENTRY_SLIPPAGE_PTS',   String(strategyParams.maxEntrySlippagePts))),
        PB3m: parseFloat(getEnv('PB3M_MAX_ENTRY_SLIPPAGE_PTS', String(strategyParams.maxEntrySlippagePts))),
        PB2m: parseFloat(getEnv('PB2M_MAX_ENTRY_SLIPPAGE_PTS', String(strategyParams.maxEntrySlippagePts))),
        VR:   parseFloat(getEnv('VR_MAX_ENTRY_SLIPPAGE_PTS',   String(strategyParams.maxEntrySlippagePts))),
        EMAX: parseFloat(getEnv('EMAX_MAX_ENTRY_SLIPPAGE_PTS', String(strategyParams.maxEntrySlippagePts))),
      };
      // Deferred entry: how long to monitor the tick stream for price to return within
      // range when adverse slippage exceeds the guard. Kept in sync with
      // MultiInstrumentBot._parseInstrumentConfigs (consumed by SignalHandler).
      strategyParams.deferredEntryWindowSec = parseInt(getEnv('DEFERRED_ENTRY_WINDOW_SEC', '60'));
      // PB Entry Timing Improvements
      strategyParams.pbEntryMode = 'immediate';  // V2.11: always market entry for PB 5m
      strategyParams.pbConfirmBars = parseInt(getEnv('PB_CONFIRM_BARS', '5'));
      strategyParams.pbLimitRetracePct = parseFloat(getEnv('PB_LIMIT_RETRACE_PCT', '0.6'));
      strategyParams.pbLimitTimeoutBars = parseInt(getEnv('PB_LIMIT_TIMEOUT_BARS', '5'));
      strategyParams.pbTrendFilterEnabled = getEnv('PB_TREND_FILTER', 'false') === 'true';
      // Entry order type (per-instrument). MNQ stays 'Market' (default); MES can opt
      // into 'Limit' for a marketable limit at signal ± ENTRY_LIMIT_BUFFER_TICKS,
      // cancelled after LIMIT_ENTRY_TIMEOUT_SEC if unfilled.
      strategyParams.entryOrderType = getEnv('ENTRY_ORDER_TYPE', 'Market');
      strategyParams.entryLimitBufferTicks = parseInt(getEnv('ENTRY_LIMIT_BUFFER_TICKS', '1'));
      strategyParams.limitEntryTimeoutSec = parseInt(getEnv('LIMIT_ENTRY_TIMEOUT_SEC', '180'));
      // Tick-triggered entry (intra-bar evaluation via real-time trade prints)
      strategyParams.pbTickEntry = getEnv('PB_TICK_ENTRY', 'false') === 'true';
      strategyParams.pb3mTickEntry = getEnv('PB3M_TICK_ENTRY', 'false') === 'true';
      strategyParams.pb2mTickEntry = getEnv('PB2M_TICK_ENTRY', 'false') === 'true';
      // Zone-exit bounce + consecutive tick confirmation (V2.12b)
      strategyParams.zoneExitMargin = parseFloat(getEnv('ZONE_EXIT_MARGIN', '0.10'));
      strategyParams.consecTicksRequired = parseInt(getEnv('CONSEC_TICKS_REQUIRED', '3'));
      // Post-trade cooldown (1m bars to wait after a trade closes before next signal)
      strategyParams.cooldownBars = parseInt(getEnv('COOLDOWN_BARS', '6'));
      // Zone-exit entry mode
      strategyParams.pbZoneExitEntry = getEnv('PB_ZONE_EXIT_ENTRY', 'true') === 'true';
      strategyParams.pb3mZoneExitEntry = getEnv('PB3M_ZONE_EXIT_ENTRY', 'true') === 'true';
      strategyParams.pb2mZoneExitEntry = getEnv('PB2M_ZONE_EXIT_ENTRY', 'true') === 'true';
      // ── Brooks stop-entry + EMA-pullback (EPB) + PDH/PDL break + regime filters ──
      // Defaults below EXACTLY match the strategy's own constructor defaults, so an
      // UNSET var leaves behavior unchanged; the MES momentum book turns these on via .env.
      // (Keep in sync with MultiInstrumentBot._parseInstrumentConfigs.)
      strategyParams.pbEnabled = getEnv('PB_ENABLED', 'true') !== 'false';
      strategyParams.stopEntryEnabled = getEnv('STOP_ENTRY_ENABLED', 'false') === 'true';
      strategyParams.stopEntryOffsetTicks = parseInt(getEnv('STOP_ENTRY_OFFSET_TICKS', '1'));
      strategyParams.stopEntryCancelBars = parseInt(getEnv('STOP_ENTRY_CANCEL_BARS', '2'));
      // Native stop-entry is an execution-layer setting normally wanted bot-wide, so —
      // unlike the per-instrument setup flags — it honors an UNPREFIXED global
      // NATIVE_STOP_ENTRY (like ACCOUNT_DAILY_LOSS_LIMIT), with an optional per-instrument
      // <SYM>_NATIVE_STOP_ENTRY override taking precedence (e.g. to A/B one leg).
      strategyParams.nativeStopEntry = getEnv('NATIVE_STOP_ENTRY', env['NATIVE_STOP_ENTRY'] || 'false') === 'true';
      strategyParams.sigBarMaxBodyPct = parseFloat(getEnv('SIG_BAR_MAX_BODY_PCT', '0'));
      strategyParams.sigBarMinTailPct = parseFloat(getEnv('SIG_BAR_MIN_TAIL_PCT', '0'));
      strategyParams.sigBarMinCloseLoc = parseFloat(getEnv('SIG_BAR_MIN_CLOSE_LOC', '0'));
      strategyParams.sigBarMaxRangePts = parseFloat(getEnv('SIG_BAR_MAX_RANGE_PTS', '0'));
      strategyParams.emaPbEnabled = getEnv('EMA_PB_ENABLED', 'false') === 'true';
      strategyParams.emaPbTF = getEnv('EMA_PB_TF', '5m');
      strategyParams.emaPbPeriod = parseInt(getEnv('EMA_PB_PERIOD', '20'));
      strategyParams.emaPbSlopeLookback = parseInt(getEnv('EMA_PB_SLOPE_LOOKBACK', '3'));
      strategyParams.emaPbTouchTolATR = parseFloat(getEnv('EMA_PB_TOUCH_TOL_ATR', '0.10'));
      strategyParams.emaPbMinLegATR = parseFloat(getEnv('EMA_PB_MIN_LEG_ATR', '1.0'));
      strategyParams.emaPbLegLookback = parseInt(getEnv('EMA_PB_LEG_LOOKBACK', '10'));
      strategyParams.emaPbMaxStopPoints = parseFloat(getEnv('EMA_PB_MAX_STOP_POINTS', '0'));
      strategyParams.emaPbMinStopPoints = parseFloat(getEnv('EMA_PB_MIN_STOP_POINTS', '0'));
      strategyParams.lbEnabled = getEnv('LB_ENABLED', 'false') === 'true';
      strategyParams.lbTargetR = parseFloat(getEnv('LB_TARGET_R', '1.5'));
      strategyParams.lbStopATR = parseFloat(getEnv('LB_STOP_ATR', '1.0'));
      strategyParams.lbRequireBias = getEnv('LB_REQUIRE_BIAS', 'true') !== 'false';
      strategyParams.lbIncludePdc = getEnv('LB_INCLUDE_PDC', 'false') === 'true';
      strategyParams.lbIncludeWeekly = getEnv('LB_INCLUDE_WEEKLY', 'false') === 'true';
      strategyParams.levelRoundStep = parseFloat(getEnv('LEVEL_ROUND_STEP', '0'));
      strategyParams.lbMaxPerDay = parseInt(getEnv('LB_MAX_PER_DAY', '0'));
      strategyParams.levelBiasFilter = getEnv('LEVEL_BIAS_FILTER', 'false') === 'true';
      strategyParams.levelConfluence = getEnv('LEVEL_CONFLUENCE', 'false') === 'true';
      strategyParams.levelTolATR = parseFloat(getEnv('LEVEL_TOL_ATR', '0.5'));
      strategyParams.htfAlignEnabled = getEnv('HTF_ALIGN_ENABLED', 'false') === 'true';
      strategyParams.htfAlignPeriod = parseInt(getEnv('HTF_ALIGN_PERIOD', '50'));
      strategyParams.skipDows = (getEnv('SKIP_DOWS', '') || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      strategyParams.hardEntryCutoff = parseInt(getEnv('HARD_ENTRY_CUTOFF', '0'));
      strategyParams.gapSkipLo = parseFloat(getEnv('GAP_SKIP_LO', '0'));
      strategyParams.gapSkipHi = parseFloat(getEnv('GAP_SKIP_HI', '0'));
      strategyParams.gapAtrPeriod = parseInt(getEnv('GAP_ATR_PERIOD', '14'));
      // Range-regime book: RF edge-fade in flat-EMA ranges (+ optional own window), and
      // the FTG failed-breakout (validated OFF on MES; kept configurable).
      strategyParams.rangeFadeEnabled = getEnv('RANGE_FADE_ENABLED', 'false') === 'true';
      strategyParams.rangeFadeTF = getEnv('RANGE_FADE_TF', '5m');
      strategyParams.rangeFadeLookback = parseInt(getEnv('RANGE_FADE_LOOKBACK', '20'));
      strategyParams.rangeFadeMaxSlopeATR = parseFloat(getEnv('RANGE_FADE_MAX_SLOPE_ATR', '0.10'));
      strategyParams.rangeFadeMinSizeATR = parseFloat(getEnv('RANGE_FADE_MIN_SIZE_ATR', '1.5'));
      strategyParams.rangeFadeMaxSizeATR = parseFloat(getEnv('RANGE_FADE_MAX_SIZE_ATR', '4.0'));
      strategyParams.rangeFadeEdgePct = parseFloat(getEnv('RANGE_FADE_EDGE_PCT', '0.15'));
      strategyParams.rangeFadeTargetR = parseFloat(getEnv('RANGE_FADE_TARGET_R', '1.5'));
      strategyParams.rfWinLo = parseInt(getEnv('RF_WIN_LO', '0'));
      strategyParams.rfWinHi = parseInt(getEnv('RF_WIN_HI', '0'));
      strategyParams.fthEnabled = getEnv('FTH_ENABLED', 'false') === 'true';
      strategyParams.fthTF = getEnv('FTH_TF', '5m');
      strategyParams.fthTargetR = parseFloat(getEnv('FTH_TARGET_R', '2.0'));
      strategyParams.fthWinLo = parseInt(getEnv('FTH_WIN_LO', '0'));
      strategyParams.fthWinHi = parseInt(getEnv('FTH_WIN_HI', '0'));
      strategyParams.fthMaxSlopeATR = parseFloat(getEnv('FTH_MAX_SLOPE_ATR', '0'));
      strategyParams.seEnabled = getEnv('SE_ENABLED', 'false') === 'true';
      strategyParams.vpbEnabled = getEnv('VPB_ENABLED', 'false') === 'true';
      // Gap-Fill Fade: mean-reversion on gap days (trades days the gap-skip filter sits out)
      strategyParams.gapFillEnabled = getEnv('GAP_FILL_ENABLED', 'false') === 'true';
      strategyParams.gapFillMinATR = parseFloat(getEnv('GAP_FILL_MIN_ATR', '0.35'));
      strategyParams.gapFillMaxATR = parseFloat(getEnv('GAP_FILL_MAX_ATR', '1.0'));
      strategyParams.gapFillTargetR = parseFloat(getEnv('GAP_FILL_TARGET_R', '1.5'));
      strategyParams.gapFillMaxTime = parseInt(getEnv('GAP_FILL_MAX_TIME', '600'));
      strategyParams.gapFillMaxStopPts = parseFloat(getEnv('GAP_FILL_MAX_STOP_POINTS', '0'));
      strategyParams.gapFillRequireExtend = getEnv('GAP_FILL_REQUIRE_EXTEND', 'true') !== 'false';
      strategyParams.gapFillMinExtendATR = parseFloat(getEnv('GAP_FILL_MIN_EXTEND_ATR', '0.15'));
      strategyParams.gapFillVwapBias = getEnv('GAP_FILL_VWAP_BIAS', 'true') !== 'false';
      strategyParams.gapFillGapRegimeFilter = getEnv('GAP_FILL_GAP_REGIME_FILTER', 'false') === 'true';
      // Inter-Market Divergence: cross-instrument catch-up signal
      strategyParams.divergenceEnabled = getEnv('DIVERGENCE_ENABLED', 'false') === 'true';
      strategyParams.divergenceTargetR = parseFloat(getEnv('DIVERGENCE_TARGET_R', '1.5'));
      strategyParams.divergenceMaxTime = parseInt(getEnv('DIVERGENCE_MAX_TIME', '660'));
      strategyParams.divergenceMinGapATR = parseFloat(getEnv('DIVERGENCE_MIN_GAP_ATR', '0.2'));
      strategyParams.divergenceCooldownMs = parseInt(getEnv('DIVERGENCE_COOLDOWN_MS', '900000'));
      strategyParams.divergenceMinBars = parseInt(getEnv('DIVERGENCE_MIN_BARS', '24'));
      strategyParams.divergenceRSIMax = parseInt(getEnv('DIVERGENCE_RSI_MAX', '80'));
      strategyParams.divergenceRSIMin = parseInt(getEnv('DIVERGENCE_RSI_MIN', '20'));
      strategyParams.divergenceATRStop = parseFloat(getEnv('DIVERGENCE_ATR_STOP', '0.5'));
    } else if (strategyName === 'liquidity_orb') {
      // Liquidity ORB params
      strategyParams.orStartMinPST = parseInt(getEnv('OR_START_MIN_PST', '300'));
      strategyParams.orDurationMin = parseInt(getEnv('OR_DURATION_MIN', '15'));
      strategyParams.brtEnabled = getEnv('BRT_ENABLED', 'true') !== 'false';
      strategyParams.brtWaitMinPST = parseInt(getEnv('BRT_WAIT_MIN_PST', '390'));
      strategyParams.brtMaxTimePST = parseInt(getEnv('BRT_MAX_TIME_PST', '600'));
      strategyParams.brtStopPoints = parseFloat(getEnv('BRT_STOP_POINTS', '5'));
      strategyParams.brtTargetPoints = parseFloat(getEnv('BRT_TARGET_POINTS', '15'));
      strategyParams.brtRetestTolerance = parseFloat(getEnv('BRT_RETEST_TOLERANCE', '1.5'));
      strategyParams.brtMinBodyRatio = parseFloat(getEnv('BRT_MIN_BODY_RATIO', '0.3'));
      strategyParams.bounceEnabled = getEnv('BOUNCE_ENABLED', 'true') !== 'false';
      strategyParams.bounceStopPoints = parseFloat(getEnv('BOUNCE_STOP_POINTS', '7'));
      strategyParams.bounceTargetPoints = parseFloat(getEnv('BOUNCE_TARGET_POINTS', '20'));
      strategyParams.bounceConfirmBars = parseInt(getEnv('BOUNCE_CONFIRM_BARS', '5'));
      strategyParams.bounceMaxTimePST = parseInt(getEnv('BOUNCE_MAX_TIME_PST', '660'));
      strategyParams.rejectionEnabled = getEnv('REJECTION_ENABLED', 'true') !== 'false';
      strategyParams.rejectionStopPoints = parseFloat(getEnv('REJECTION_STOP_POINTS', '6'));
      strategyParams.rejectionTargetPoints = parseFloat(getEnv('REJECTION_TARGET_POINTS', '30'));
      strategyParams.rejectionMinTouches = parseInt(getEnv('REJECTION_MIN_TOUCHES', '2'));
      strategyParams.rejectionMaxTimePST = parseInt(getEnv('REJECTION_MAX_TIME_PST', '660'));
      strategyParams.maxTradesPerDay = parseInt(getEnv('MAX_TRADES_PER_DAY', '3'));
      strategyParams.levelTolerance = parseFloat(getEnv('LEVEL_TOLERANCE', '1.5'));
      strategyParams.minBarsSinceOR = parseInt(getEnv('MIN_BARS_SINCE_OR', '5'));
    } else {
      // ORB params
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
      strategyParams.useRSIFilter = getEnv('USE_RSI_FILTER', 'false') === 'true';
      strategyParams.useADXFilter = getEnv('USE_ADX_FILTER', 'false') === 'true';
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
      symbol: getEnv('SYMBOL', `${baseSymbol}H6`),
      strategy: strategyName,
      strategyParams,
      databentoSymbol: getEnv('DATABENTO_SYMBOL', `${baseSymbol}.FUT`),
      autoRollover: getEnv('AUTO_ROLLOVER', 'true') !== 'false',
      lastEntryHour: parseInt(getEnv('LAST_ENTRY_HOUR', '11')),
      lastEntryMinute: parseInt(getEnv('LAST_ENTRY_MINUTE', '0')),
      skipHours: getEnv('SKIP_HOURS', ''),
      skipHourRanges: ConfigValidator.parseSkipHours(getEnv('SKIP_HOURS', '')),
      riskParams: {
        riskPerTrade: {
          min: parseFloat(getEnv('RISK_PER_TRADE_MIN', '25')),
          max: parseFloat(getEnv('RISK_PER_TRADE_MAX', '90')),
        },
        maxContracts: parseInt(getEnv('MAX_CONTRACTS', '1')),
        dailyLossLimit: parseFloat(getEnv('DAILY_LOSS_LIMIT', '200')),
        weeklyLossLimit: parseFloat(getEnv('WEEKLY_LOSS_LIMIT', '500')),
        maxConsecutiveLosses: parseInt(getEnv('MAX_CONSECUTIVE_LOSSES', '3')),
        maxDrawdownPercent: parseFloat(getEnv('MAX_DRAWDOWN_PERCENT', '5')),
        dailyProfitTarget: parseFloat(getEnv('DAILY_PROFIT_TARGET', 'Infinity')),
        profitTiers: getEnv('DAILY_PROFIT_TIERS', ''),
      },
    });
  }

  return configs;
}

module.exports = { loadAccountConfigs, validateAccountConfig, buildAccountConfig, parseInstrumentConfigs, parseAccountNames };
