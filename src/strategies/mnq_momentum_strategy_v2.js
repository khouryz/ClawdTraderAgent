/**
 * MNQ Momentum Strategy V2.9 — PB + VR (EMAX disabled)
 * 
 * Two active sub-strategies covering the trading session:
 * 
 * 1. EMAX (EMA Cross Momentum) — DISABLED (PF 0.80-0.89)
 * 
 * 2. PB (Momentum Pullback) — 5-min bars, 6:30-9:30 AM PST
 *    - Strong impulse bar (>= 15pt), 10-85% retrace
 *    - limit_structural entry mode (limit order at 60% retrace zone)
 *    - Confluence: disabled (minConfluence=0)
 *    - Target: 2.5R | Stop: pullback extreme + 2pt buffer, max 35pt
 *    - BE stop at 1.2R activation
 * 
 * 3. VR (VWAP Mean Reversion) — 1-min bars, 8:30-11:00 AM PST
 *    - Price stretches to VWAP ±1.3σ band (overextended)
 *    - Confirmation candle: opens+closes between 1σ and VWAP (reverting)
 *    - Volume spike on reversion bar (>= 0.8x avg)
 *    - Target: 4R fixed | Stop: beyond 2σ band + 3pt, max 20pt
 *    - This fills the 8:30 AM - 11:00 AM window after PB cutoff
 * 
 * Shared features:
 * - VWAP as directional filter (PB) and target reference (VR)
 * - Prior day levels (HOD/LOD/Close/VWAP/VAH/VAL/POC) as confluence factors
 * - Volume filter: bar vol >= 0.9x avg (Monte Carlo validated)
 * - Dynamic contract sizing: $60 max risk, up to 10 contracts
 * - Max 3 losses/day, max 3 consecutive losses
 * - Max 1 trade at a time
 * 
 * MNQ: tick=0.25, tickValue=$0.50, pointValue=$2.00
 */

const BaseStrategy = require('./base');
const VWAPEngine = require('../indicators/VWAPEngine');
const ConfluenceScorer = require('../indicators/ConfluenceScorer');
const { calcZLEMA, calcEMA, calcATR, calcRSI } = require('../indicators/zlema');

class MNQMomentumStrategyV2 extends BaseStrategy {
  constructor(config) {
    super('MNQ_MOMENTUM_V2', config);

    // ── Log prefix: tags every console line with the instrument ([MNQ]/[MES]/[M2K])
    // so multi-instrument logs are readable. Empty when no label (e.g. backtest). ──
    this.logTag = config.instrumentLabel ? `[${config.instrumentLabel}] ` : '';

    // ── EMAX Parameters ──
    this.emaxEnabled = config.emaxEnabled !== undefined ? config.emaxEnabled : false; // Default: false (PF 0.80-0.89)
    this.emaxEmaFast = config.emaxEmaFast || 9;
    this.emaxEmaSlow = config.emaxEmaSlow || 21;
    this.emaxMinBarRange = config.emaxMinBarRange || 5;
    this.emaxMinBodyRatio = config.emaxMinBodyRatio || 0.5;
    this.emaxMaxTime = config.emaxMaxTime || 480;             // 8:00 AM PST
    this.emaxUseZLEMA = config.emaxUseZLEMA === true;         // Default: false (EMA outperforms ZLEMA)

    // ── PB Parameters (5m) ──
    this.pbMinImpulse = config.pbMinImpulse || 15;
    this.pbMaxImpulse = config.pbMaxImpulse || Infinity;      // Max impulse range (pts), Infinity = no cap
    this.pbMinImpBodyRatio = config.pbMinImpBodyRatio || 0.15;
    this.pbRetraceMin = config.pbRetraceMin || 0.10;
    this.pbRetraceMax = config.pbRetraceMax || 0.85;
    this.pbMaxTime = config.pbMaxTime || 510;                 // 8:30 AM PST
    this.pbLookbackBars = config.pbLookbackBars || 1;         // How many bars back to search for impulse (1=adjacent only)

    // ── PB 3m Parameters (scaled from 5m) ──
    this.pb3mEnabled = config.pb3mEnabled === true;            // Default: false (opt-in)
    this.pb3mMinImpulse = config.pb3mMinImpulse || 10;
    this.pb3mMaxImpulse = config.pb3mMaxImpulse || 30;
    this.pb3mMinImpBodyRatio = config.pb3mMinImpBodyRatio || 0.15;
    this.pb3mRetraceMin = config.pb3mRetraceMin || 0.10;
    this.pb3mRetraceMax = config.pb3mRetraceMax || 0.85;
    this.pb3mMaxTime = config.pb3mMaxTime || 570;             // 9:30 AM PST
    this.pb3mLookbackBars = config.pb3mLookbackBars || 1;
    this.pb3mMaxStopPoints = config.pb3mMaxStopPoints || 25;  // Tighter stops for smaller TF
    this.pb3mMinStopPoints = config.pb3mMinStopPoints || 3;
    this.pb3mMinTargetPoints = config.pb3mMinTargetPoints || 15;

    // ── PB 2m Parameters (scaled from 3m) ──
    this.pb2mEnabled = config.pb2mEnabled === true;            // Default: false (opt-in)
    this.pb2mMinImpulse = config.pb2mMinImpulse || 8;
    this.pb2mMaxImpulse = config.pb2mMaxImpulse || 25;
    this.pb2mMinImpBodyRatio = config.pb2mMinImpBodyRatio || 0.15;
    this.pb2mRetraceMin = config.pb2mRetraceMin || 0.10;
    this.pb2mRetraceMax = config.pb2mRetraceMax || 0.85;
    this.pb2mMaxTime = config.pb2mMaxTime || 570;             // 9:30 AM PST
    this.pb2mLookbackBars = config.pb2mLookbackBars || 1;
    this.pb2mMaxStopPoints = config.pb2mMaxStopPoints || 20;  // Tighter stops for smallest TF
    this.pb2mMinStopPoints = config.pb2mMinStopPoints || 2;
    this.pb2mMinTargetPoints = config.pb2mMinTargetPoints || 10;

    // ── PB Entry Timing Improvements ──
    // Entry mode: 'immediate' (5m close, legacy), 'confirm1m' (wait for 1m bounce), 'limit' (limit at zone)
    this.pbEntryMode = config.pbEntryMode || 'immediate';
    this.pbConfirmBars = config.pbConfirmBars || 5;            // Max 1m bars to wait for confirmation
    this.pbLimitRetracePct = config.pbLimitRetracePct || 0.5;  // Limit order at 50% of impulse retrace zone
    this.pbLimitTimeoutBars = config.pbLimitTimeoutBars || 3;  // Cancel limit after N 1m bars
    this.pbTrendFilterEnabled = config.pbTrendFilterEnabled === true;  // VWAP+EMA trend filter (default OFF, opt-in via .env)

    // ── Entry Order Type (per-instrument marketable-limit support) ──
    // 'Market' (default — used by MNQ) places a market order at the signal.
    // 'Limit' (opt-in via *_ENTRY_ORDER_TYPE=Limit — used by MES) emits a
    // marketable limit: buy at signal + entryLimitBufferTicks ticks, sell at
    // signal − buffer. The buffer keeps the limit marketable (fills immediately
    // up to the buffer, capping worst-case slippage) while never paying more
    // than the buffer. SignalHandler converts the tick buffer to a price using
    // the contract's tickSize and places the order; OCO/timeout are unchanged.
    this.entryOrderType = config.entryOrderType === 'Limit' ? 'Limit' : 'Market';
    this.entryLimitBufferTicks = config.entryLimitBufferTicks !== undefined ? config.entryLimitBufferTicks : 1;

    // ── Tick-Triggered Entry (intra-bar evaluation) ──
    this.pbTickEntry = config.pbTickEntry === true;             // PB 5m tick entry (default OFF)
    this.pb3mTickEntry = config.pb3mTickEntry === true;         // PB 3m tick entry (default OFF)
    this.pb2mTickEntry = config.pb2mTickEntry === true;         // PB 2m tick entry (default OFF)

    // ── Zone-Exit Bounce + Consecutive Tick Confirmation ──
    // Price must: 1) enter retrace zone, 2) exit zone toward trade direction by margin,
    // 3) accumulate N consecutive ticks in trade direction → then FIRE.
    // zoneExitMargin: fraction of impulse range past zone boundary (e.g., 0.10 = 10%)
    // consecTicksRequired: consecutive directional ticks needed after zone exit (e.g., 3)
    this.zoneExitMargin = config.zoneExitMargin !== undefined ? config.zoneExitMargin : 0.10;
    this.consecTicksRequired = config.consecTicksRequired !== undefined ? config.consecTicksRequired : 3;

    // ── Al Brooks STOP-ENTRY (break of the signal bar's extreme) ──
    // When ON, a confirmed pullback signal bar does NOT enter at its close. Instead
    // we arm a STOP entry one tick beyond the signal (pullback) bar's extreme:
    //   buy  → stop-entry at pb.high + offset ; protective stop at pb.low  − buffer
    //   sell → stop-entry at pb.low  − offset ; protective stop at pb.high + buffer
    // Fires only if price CONFIRMS by trading through the extreme (momentum); if the
    // opposite extreme is hit first, or it isn't triggered within the cancel window,
    // the setup is dead (no trade). This is Brooks' core entry mechanic and acts as a
    // structural chop filter (no break → no fill → no loss).
    this.stopEntryEnabled = config.stopEntryEnabled === true;        // master flag (default OFF)
    this.stopEntryOffsetTicks = config.stopEntryOffsetTicks !== undefined ? config.stopEntryOffsetTicks : 1;
    this.stopEntryCancelBars = config.stopEntryCancelBars !== undefined ? config.stopEntryCancelBars : 2;
    this.tickSize = config.tickSize || 0.25;                          // for the 1-tick break offset
    this._armedStop = null;                                           // single in-flight stop-entry arm
    // Brooks signal-bar quality gates (0 = off). closeLoc = close in favorable
    // portion of the bar (strong reversal bar); maxRange = small low-risk bar.
    this.sigBarMinCloseLoc = config.sigBarMinCloseLoc || 0;
    this.sigBarMaxRangePts = config.sigBarMaxRangePts || 0;
    this.sigBarMaxBodyPct = config.sigBarMaxBodyPct || 0;   // exclude big-body signal bars (0=off)
    this.sigBarMinTailPct = config.sigBarMinTailPct || 0;   // require rejection tail in trade dir (0=off)
    // Higher-timeframe trend alignment: only take stop-entries on the correct side of a
    // slower EMA (e.g. 5m EMA50) — filters trades fighting the larger trend (0=off).
    this.htfAlignEnabled = config.htfAlignEnabled === true;
    this.htfAlignPeriod = config.htfAlignPeriod || 50;
    // Regime filters: skip entire weekdays (0=Sun..6=Sat) and/or hard-block fills after a
    // PST minute-of-day (kills late entries that leak past the signal cutoff via the arm window).
    this.skipDows = Array.isArray(config.skipDows) ? config.skipDows : [];
    this.hardEntryCutoff = config.hardEntryCutoff || 0;
    // Skip whole days whose opening gap (vs prior-day close, in daily-ATR units) falls in a
    // net-negative band (e.g. moderate gap-downs chop continuation). The gap is computed
    // INTERNALLY each session (live == backtest, no external feed): once the first RTH bar
    // sets the session open, _todayGapATR = (sessionOpen − priorDayClose) / dailyATR, where
    // dailyATR is the mean of the last `gapAtrPeriod` completed RTH-session ranges (the same
    // RTH day-tracking that powers PDH/PDL). 0,0 = filter off.
    this.gapSkipLo = config.gapSkipLo || 0;
    this.gapSkipHi = config.gapSkipHi || 0;
    this.gapAtrPeriod = config.gapAtrPeriod || 14;
    this._todayGapATR = null;        // set in onBar once the session open is known
    this._dailyRanges = [];          // rolling completed RTH-session ranges (high−low)
    this._dailyATR = null;           // mean of last gapAtrPeriod ranges

    // ── Opening Range Breakout (ORB, default OFF) — Zarattini et al. ──
    // Build the opening range over the first orbMinutes of the session; on a break of the
    // OR high/low, enter (stop-entry), protective stop at the OPPOSITE OR edge, R-target.
    // Filter: OR width must be >= orbMinRangeATR×ATR (big-enough range = higher continuation).
    this.orbEnabled = config.orbEnabled === true;
    this.orbMinutes = config.orbMinutes || 15;                  // OR window length (min from open)
    this.orbMinRangeATR = config.orbMinRangeATR !== undefined ? config.orbMinRangeATR : 0.6;
    this.orbMaxRangeATR = config.orbMaxRangeATR !== undefined ? config.orbMaxRangeATR : 3.0; // skip huge ORs (too much risk)
    this.orbTargetR = config.orbTargetR || 1.0;                 // target = R × OR-width stop
    this.orbStopCap = config.orbStopCap || 0;                   // ORB's own max stop (0 = use maxStopPoints)
    this.orbSessionOpen = config.orbSessionOpen || 390;        // 6:30am PST

    // ── FADE engine (mean-reversion: sell local highs / buy local lows, default OFF) ──
    // Sell when price pokes VWAP+kσ (overbought), buy at VWAP−kσ (oversold); DYNAMIC target
    // = VWAP (the intraday mean) so reward varies per trade; stop beyond the band/extreme;
    // time-stop after N bars (MR trades that don't revert quickly are exited). Market entry.
    this.fadeEnabled = config.fadeEnabled === true;
    this.fadeTF = config.fadeTF || '5m';
    this.fadeSigma = config.fadeSigma !== undefined ? config.fadeSigma : 2.0;   // entry band = VWAP ± kσ
    this.fadeRSIPeriod = config.fadeRSIPeriod || 2;                              // Connors RSI(2)
    this.fadeRSIMax = config.fadeRSIMax || 0;                                    // sell needs RSI≥this (0=off)
    this.fadeRSIMin = config.fadeRSIMin || 0;                                    // buy needs RSI≤this (0=off)
    this.fadeStopMode = config.fadeStopMode || 'sigma';                          // 'sigma'|'atr'|'extreme'
    this.fadeStopSigma = config.fadeStopSigma !== undefined ? config.fadeStopSigma : 1.0;
    this.fadeStopATR = config.fadeStopATR !== undefined ? config.fadeStopATR : 0.5;
    this.fadeTargetMode = config.fadeTargetMode || 'vwap';                       // 'vwap'|'band1'
    this.fadeMaxHoldBars = config.fadeMaxHoldBars || 5;                          // time-stop (bars)
    this.fadeRequireReject = config.fadeRequireReject !== false;                 // require close back inside the bar
    this.fadeMaxStopPts = config.fadeMaxStopPts || 0;                            // skip if stop wider than this (0=off)

    // ── KEY LEVELS / supply-demand (prior-day H/L/C, round numbers, session open) ──
    // PDC = institutional directional-bias anchor (above=bullish). PDH/PDL = S/R; breaking
    // them tends to CONTINUE (not reverse) on index futures. Used 3 ways (all default OFF):
    //  (1) levelBiasFilter: only longs above PDC / shorts below PDC.
    //  (2) levelConfluence: only take stop-entries occurring within levelTolATR×ATR of a level.
    //  (3) lbEnabled: PDH/PDL break-continuation setup (buy break of PDH in bull bias, etc.).
    this.levelBiasFilter = config.levelBiasFilter === true;
    this.levelConfluence = config.levelConfluence === true;
    this.levelTolATR = config.levelTolATR !== undefined ? config.levelTolATR : 0.5;
    this.levelRoundStep = config.levelRoundStep || 0;                            // round-number spacing (0=off, e.g. 25)
    this.lbEnabled = config.lbEnabled === true;                                  // PDH/PDL break-continuation setup
    this.lbTargetR = config.lbTargetR || 1.5;
    this.lbStopATR = config.lbStopATR !== undefined ? config.lbStopATR : 1.0;
    this.lbRequireBias = config.lbRequireBias !== false;                         // break must align with PDC bias
    this.lbIncludePdc = config.lbIncludePdc === true;                            // also break PDC as a level
    this.lbIncludeWeekly = config.lbIncludeWeekly === true;                      // also break prior-week H/L
    this.lbMaxPerDay = config.lbMaxPerDay || 0;                                  // cap LVLB trades/day (0=off)
    this.injectedLevels = config.injectedLevels || [];                          // HTF swing levels (1h/4h/daily/weekly), set per-day by runner/harness
    // Optional multi-window entry schedule (PST minute ranges) — when set, OVERRIDES the
    // per-setup maxTime + hardEntryCutoff for BOTH signal generation and fills. Lets us run
    // e.g. a morning window AND a separate final-hour window. Example: [[0,630],[720,780]].
    this.entryWindows = Array.isArray(config.entryWindows) ? config.entryWindows : null;

    // ── Brooks EMA-pullback setup (additive with-trend frequency, default OFF) ──
    // In a trending market (rising/falling 20-EMA), buy/sell the pullback to the EMA:
    // signal bar dips to/through the EMA and closes back on the trend side, then enter
    // on the break of its extreme (reuses the Brooks stop-entry + signal-bar filters).
    // Distinct from PB (which needs a single big impulse bar) → catches microchannel /
    // multi-bar legs that grind to the EMA. Quantified H1/H2-to-EMA pullback.
    this.emaPbEnabled = config.emaPbEnabled === true;          // master flag (default OFF)
    this.emaPbPeriod = config.emaPbPeriod || 20;              // EMA length (Brooks 20)
    this.emaPbSlopeLookback = config.emaPbSlopeLookback || 3;  // bars to measure EMA slope
    this.emaPbTouchTolATR = config.emaPbTouchTolATR !== undefined ? config.emaPbTouchTolATR : 0.10; // how close the dip must get to EMA (×ATR)
    this.emaPbMinLegATR = config.emaPbMinLegATR !== undefined ? config.emaPbMinLegATR : 1.0;        // min prior-leg size above/below EMA (×ATR)
    this.emaPbLegLookback = config.emaPbLegLookback || 10;     // bars to measure the prior leg / swing
    this.emaPbTF = config.emaPbTF || '5m';                    // '5m' or '3m'
    this.emaPbMaxStopPoints = config.emaPbMaxStopPoints || 0;  // per-setup stop cap (0 = use shared maxStopPoints)
    this.emaPbMinStopPoints = config.emaPbMinStopPoints || 0;
    this.pbEnabled = config.pbEnabled !== false;             // impulse-pullback master (default ON; set false to isolate EPB)

    // ── Brooks trading-range FADE setup (counter-trend, range regime, default OFF) ──
    // Brooks: ranges → Buy Low, Sell High, Scalp; >80% of range breakouts fail. Only
    // trade at the EXTREMES (not the middle). When the EMA is flat (range) and a bar
    // pokes the top/bottom of the recent range and rejects it, fade it: sell-stop on
    // break of the bar's low at the top / buy-stop on break of the high at the bottom,
    // protective stop beyond the signal bar, SCALP target (lower R). Distinct regime
    // from the trend setups (flat-EMA gate) → fires on the chop days they sit out.
    this.rangeFadeEnabled = config.rangeFadeEnabled === true;          // master flag (default OFF)
    this.rangeFadeTF = config.rangeFadeTF || '5m';
    this.rangeFadeLookback = config.rangeFadeLookback || 20;           // bars defining the range
    this.rangeFadeMaxSlopeATR = config.rangeFadeMaxSlopeATR !== undefined ? config.rangeFadeMaxSlopeATR : 0.5; // flat-EMA gate (×ATR over slopeLookback)
    this.rangeFadeMinSizeATR = config.rangeFadeMinSizeATR !== undefined ? config.rangeFadeMinSizeATR : 2.0;    // min range size (×ATR)
    this.rangeFadeMaxSizeATR = config.rangeFadeMaxSizeATR !== undefined ? config.rangeFadeMaxSizeATR : 8.0;    // max range size (×ATR)
    this.rangeFadeEdgePct = config.rangeFadeEdgePct !== undefined ? config.rangeFadeEdgePct : 0.25;            // top/bottom fraction of range to fade
    this.rangeFadeTargetR = config.rangeFadeTargetR || 1.5;            // scalp R (lower than trend swings)

    // ── Brooks strong-trend shallow-pullback / breakout-pullback (BOPB, default OFF) ──
    // Complementary to EPB BY CONSTRUCTION: fires when a STRONG trend (steep EMA slope)
    // pulls back only SHALLOWLY and HOLDS ABOVE the EMA (low never reaches it) — the
    // high-momentum legs EPB (needs an EMA touch) misses. Enter on break of the pullback
    // bar's extreme. Disjoint from EPB on the low-vs-EMA test → adds non-overlapping trades.
    this.bopbEnabled = config.bopbEnabled === true;                    // master flag (default OFF)
    this.bopbTF = config.bopbTF || '5m';
    this.bopbMinSlopeATR = config.bopbMinSlopeATR !== undefined ? config.bopbMinSlopeATR : 0.5;  // steep-EMA gate (×ATR over slopeLookback)
    this.bopbMaxDistATR = config.bopbMaxDistATR !== undefined ? config.bopbMaxDistATR : 1.5;     // pullback bar low within this ×ATR above EMA (real pullback, not extended)

    // ── Brooks DOUBLE-TOP/BOTTOM reversal (2nd-entry range/reversal setup, default OFF) ──
    // The PROPER range/reversal fade: not every poke (first touch fails ~80%) but the
    // SECOND ENTRY — price revisits a prior swing extreme (double bottom/top, a W/M),
    // bounced in between, and forms a reversal bar. Enter WITH the reversal on the break
    // of the signal bar (buy-stop off a double bottom / sell-stop off a double top),
    // protective stop beyond the pattern extreme, scalp/measured target.
    this.drEnabled = config.drEnabled === true;                       // master flag (default OFF)
    this.drTF = config.drTF || '5m';
    this.drLookback = config.drLookback || 20;                        // bars to find the prior swing extreme
    this.drMinGap = config.drMinGap || 3;                             // min bars between the two extremes
    this.drTolATR = config.drTolATR !== undefined ? config.drTolATR : 0.5;   // how close the 2nd extreme must be to the 1st (×ATR)
    this.drBounceATR = config.drBounceATR !== undefined ? config.drBounceATR : 1.0; // min bounce between the two extremes (×ATR) → real W/M
    this.drMaxSlopeATR = config.drMaxSlopeATR !== undefined ? config.drMaxSlopeATR : 0; // 0=off; if >0 require |EMA slope|≤ this (range-only)
    this.drMinSlopeATR = config.drMinSlopeATR !== undefined ? config.drMinSlopeATR : 0; // 0=off; if >0 require prior trend INTO extreme ≥ this (trend-exhaustion reversal)
    this.drRequireHL = config.drRequireHL === true;                   // require higher-low (DB) / lower-high (DT): bulls/bears stepping in
    this.drTargetR = config.drTargetR || 2.0;

    // ── Post-Trade Cooldown ──
    this.cooldownBars = config.cooldownBars !== undefined ? config.cooldownBars : 6;  // 1m bars to wait after a trade

    // ── VR (VWAP Mean Reversion) Parameters ──
    this.vrEnabled = config.vrEnabled !== false;               // Default: true
    this.vrMinTime = config.vrMinTime || 510;                  // 8:30 AM PST (after PB cutoff)
    this.vrMaxTime = config.vrMaxTime || 750;                  // 12:30 PM PST (30 min before EOD close)
    this.vrMinSigma = config.vrMinSigma || 1.5;               // Min σ distance to trigger watch
    this.vrEntrySigmaMax = config.vrEntrySigmaMax || 1.0;      // Entry when price reverts inside 1σ
    this.vrStopBeyondBand = config.vrStopBeyondBand || 3;      // Stop: 3pt beyond 2σ band
    this.vrTargetMode = config.vrTargetMode || 'fixed';         // 'fixed' or 'vwap'
    this.vrTargetR = config.vrTargetR || 4;                     // R-multiple for fixed target mode
    this.vrMinBarVolRatio = config.vrMinBarVolRatio || 0.8;    // Min volume ratio on entry bar
    this.vrMaxStopPoints = config.vrMaxStopPoints || 20;       // Max stop distance for VR
    this.vrMinStopPoints = config.vrMinStopPoints || 4;        // Min stop distance for VR
    this.vrCooldownBars = config.vrCooldownBars || 10;         // Bars between VR signals

    // ── Shared Parameters ──
    this.maxStopPoints = config.maxStopPoints || 35;
    this.minStopPoints = config.minStopPoints || 5;
    this.stopBuffer = config.stopBuffer || 2;
    this.profitTargetR = config.profitTargetR !== undefined ? config.profitTargetR : 2.5;
    this.minTargetPoints = config.minTargetPoints || 20;
    this.maxLossesPerDay = config.maxLossesPerDay !== undefined ? config.maxLossesPerDay : 3;

    // ── Partial Profit Parameters ──
    this.partialProfitEnabled = config.partialProfitEnabled === true;  // Default: false
    this.partialProfitR = config.partialProfitR || 2;                  // Take partial at 2R
    this.moveStopToBE = config.moveStopToBE === true;                  // Default: false (explicit opt-in)

    // ── Confluence Parameters ──
    this.minConfluence = config.minConfluence !== undefined ? config.minConfluence : 0; // Default: 0 (V2.9 frequency sweep)
    // Per-strategy confluence thresholds (override shared minConfluence if set). Defaults preserve
    // legacy behavior: each strategy uses the shared threshold unless explicitly overridden.
    this.pbMinConfluence   = config.pbMinConfluence   !== undefined ? config.pbMinConfluence   : this.minConfluence;
    this.pb3mMinConfluence = config.pb3mMinConfluence !== undefined ? config.pb3mMinConfluence : this.minConfluence;
    this.pb2mMinConfluence = config.pb2mMinConfluence !== undefined ? config.pb2mMinConfluence : this.minConfluence;
    this.vrMinConfluence   = config.vrMinConfluence   !== undefined ? config.vrMinConfluence   : this.minConfluence;
    this.emaxMinConfluence = config.emaxMinConfluence !== undefined ? config.emaxMinConfluence : this.minConfluence;
    this.confluenceScorer = new ConfluenceScorer({
      minScore: this.minConfluence,
      volumeAvgPeriod: config.volumeAvgPeriod || 20,
      momentumBars: config.momentumBars || 3,
      priorLevelTolerance: config.priorLevelTolerance || 5,
    });

    // ── Volume Filter Parameters ──
    this.volumeFilterEnabled = config.volumeFilterEnabled === true;  // Default: false
    this.volumeFilterMin = config.volumeFilterMin !== undefined ? config.volumeFilterMin : 0.9;
    this.volumeFilterPeriod = config.volumeFilterPeriod || 20;

    // ── VWAP Engine (injected by TradovateBot, or created here) ──
    this.vwapEngine = config.vwapEngine || new VWAPEngine();

    // ── Startup log: confluence configuration (visible in deployment logs for verification) ──
    const confLog = `[Strategy:V2] Confluence thresholds: shared=${this.minConfluence}` +
      `, PB=${this.pbMinConfluence}, PB3m=${this.pb3mMinConfluence}, PB2m=${this.pb2mMinConfluence}` +
      (this.vrEnabled ? `, VR=${this.vrMinConfluence}` : '') +
      (this.emaxEnabled ? `, EMAX=${this.emaxMinConfluence}` : '');
    console.log(this.logTag + confLog);

    // ── Bar Building State ──
    this.twoMinBars = [];
    this.threeMinBars = [];
    this.fiveMinBars = [];
    this.current2mBar = null;
    this.current3mBar = null;
    this.current5mBar = null;
    this._current2mBucket = null;
    this._current3mBucket = null;
    this._current5mBucket = null;

    // ── PB Watch State (for 1m confirmation / limit entry) ──
    this._pbWatch = null;          // Pending PB setup waiting for confirmation

    // ── Tick-Triggered Armed State ──
    this._armedPB = null;          // Armed PB 5m setup waiting for tick trigger
    this._armedPB3m = null;        // Armed PB 3m setup waiting for tick trigger
    this._armedPB2m = null;        // Armed PB 2m setup waiting for tick trigger
    this._prevTickPrice = null;    // Previous tick price for direction detection
    this._tickCount = 0;           // Tick count since last armed setup (for logging)

    // ── Cooldown State ──
    this._cooldownRemaining = 0;   // 1m bars remaining before next signal allowed

    // ── VR State ──
    this._vrWatching = null;       // 'long' or 'short' when price hit 2σ
    this._vrWatchPrice = null;     // Price when we started watching
    this._vrCooldownCount = 0;     // Bars since last VR signal
    this._vrTradeCount = 0;        // VR trades today

    // ── Day State ──
    this.signalFired = false;
    this.sessionBarCount = 0;
    this.dayStarted = false;
    this._tradeCountToday = 0;     // Total trades fired today (for AI context)
    this._consecutiveLosses = 0;    // Consecutive losses (stop after maxLossesPerDay consecutive)
    this._prevTradeResult = 'none'; // 'win', 'loss', or 'none' (for AI context)

    // ── Indicator Cache ──
    this._lastRSI = null;
    this._lastATR = null;

    // Session filter reference
    this.sessionFilter = config.sessionFilter || null;

    // ── Multi-account log dedup ──
    // When true, suppress per-bar OHLCV/heartbeat prints that are pure restatements
    // of the shared data stream. Signals, orders, BE moves, watch state, etc. still
    // log normally. Set by InstrumentRunner from !isPrimaryLogger so only the first
    // account prints data-stream price lines.
    this.quietPriceLogs = config.quietPriceLogs === true;
  }

  /**
   * Reset for new trading day
   */
  resetDay() {
    // VWAP engine saves prior day levels internally on resetDay()
    this.vwapEngine.resetDay();

    // Clear raw 1m history too. Without this, this.bars carried yesterday's last
    // close into the next session, which became a stale refPrice for the onTick
    // guard and caused legitimate gap-open ticks to be silently dropped for the
    // first ~60s until a new-session 1m bar landed. Prior-day historical load
    // (InstrumentRunner._loadPriorDay) rebuilds indicators independently, so we
    // don't need to keep stale bars around across the session boundary.
    this.bars = [];
    this.twoMinBars = [];
    this.threeMinBars = [];
    this.fiveMinBars = [];
    this.current2mBar = null;
    this.current3mBar = null;
    this.current5mBar = null;
    this._current2mBucket = null;
    this._current3mBucket = null;
    this._current5mBucket = null;
    this.signalFired = false;
    this.sessionBarCount = 0;
    this.dayStarted = true;
    this._tradeCountToday = 0;
    this._consecutiveLosses = 0;
    this._prevTradeResult = 'none';
    this._pbWatch = null;
    this._armedPB = null;
    this._armedPB3m = null;
    this._armedPB2m = null;
    this._orbArmed = false;
    this._lbArmed = false;
    this._brokenLevels = new Set();
    this._lbCountToday = 0;
    // ── roll prior-day key levels from the just-ended session, then reset accumulators ──
    if (this._dayHigh != null) {
      this._pdh = this._dayHigh; this._pdl = this._dayLow; this._pdc = this._dayClose;
      // roll the just-ended RTH range into the daily-ATR buffer (no look-ahead: this
      // completed session is known before the new day's open). Drives the gap filter.
      this._dailyRanges.push(this._dayHigh - this._dayLow);
      if (this._dailyRanges.length > 60) this._dailyRanges.shift();
      const n = Math.min(this.gapAtrPeriod, this._dailyRanges.length);
      this._dailyATR = this._dailyRanges.slice(-n).reduce((a, b) => a + b, 0) / n;
    }
    this._todayGapATR = null;  // recomputed on the new session's first bar (open known)
    if (this._weekHigh != null && this._newWeek) { this._pwh = this._weekHigh; this._pwl = this._weekLow; this._weekHigh = null; this._weekLow = null; }
    this._dayHigh = null; this._dayLow = null; this._dayClose = null; this._sessionOpenPx = null;
    this._armedStop = null;
    this._prevTickPrice = null;
    this._tickCount = 0;
    this._cooldownRemaining = 0;
    this._vrWatching = null;
    this._vrWatchPrice = null;
    this._vrCooldownCount = 0;
    this._vrTradeCount = 0;
    this._lastRSI = null;
    this._lastATR = null;
  }

  /**
   * Seed prior-session levels (PDH/PDL/PDC) and the daily-ATR range buffer from
   * historical sessions at COLD START, so the PDH/PDL break setup and the opening-gap
   * filter behave identically to the backtester (which warms these over many prior days).
   * Sets only the historical buffers + prior-day levels — it does NOT touch the current
   * session's open / gap, so it is safe to call in any warmup order (resetDay preserves
   * these fields; _todayGapATR recomputes on the session's first onBar from the seeded
   * _pdc + _dailyATR). No-op if given nothing.
   * @param {Array<{high:number,low:number,close:number}>} days completed RTH sessions, chronological (oldest→newest)
   */
  seedDailyLevels(days) {
    if (!Array.isArray(days) || !days.length) return;
    // Robustness: parent-symbol historical fetches can leak calendar-SPREAD bars (prices
    // like $45 on a $7,500 index) or back-month prints into a day's H/L, producing absurd
    // ranges (observed live: dailyATR=619 on MES). Reject outlier days: range > 4× the
    // median range of the seed set. PDH/PDL/PDC come from the most recent CLEAN day.
    const valid = days.filter(d => d && isFinite(d.high) && isFinite(d.low) && d.high > d.low);
    if (!valid.length) return;
    const sorted = valid.map(d => d.high - d.low).sort((a, b) => a - b);
    const medRange = sorted[Math.floor(sorted.length / 2)];
    const clean = valid.filter(d => (d.high - d.low) <= 4 * medRange);
    const dropped = valid.length - clean.length;
    if (!clean.length) return;
    for (const d of clean) {
      this._dailyRanges.push(d.high - d.low);
      if (this._dailyRanges.length > 60) this._dailyRanges.shift();
    }
    const n = Math.min(this.gapAtrPeriod, this._dailyRanges.length);
    if (n > 0) this._dailyATR = this._dailyRanges.slice(-n).reduce((a, b) => a + b, 0) / n;
    const last = clean[clean.length - 1];
    this._pdh = last.high; this._pdl = last.low; this._pdc = last.close;
    console.log(`${this.logTag}[SEED] prior levels PDH=${this._pdh} PDL=${this._pdl} PDC=${this._pdc} | dailyATR=${this._dailyATR ? this._dailyATR.toFixed(2) : 'n/a'} over ${n} sessions (median range ${medRange.toFixed(2)}${dropped ? `, ${dropped} outlier day(s) DROPPED` : ''})`);
  }

  /**
   * Process incoming 1-minute bar
   */
  onBar(bar) {
    // ── Price-sanity filter (defense in depth against junk bars) ──
    // Mirrors the data-layer guard in SharedPriceProvider: a 1m bar is "junk" only if
    // it has BOTH very low volume (V<10, characteristic of auction prints / stale
    // back-month contract ticks / 1s bars mislabeled as 1m) AND a large deviation
    // (>50pt) from the previous 1m close. A pure deviation check is unsafe:
    // overnight gaps and CPI/FOMC opens can legitimately move MNQ hundreds of points
    // in a single bar, and those bars carry thousands of contracts of volume.
    // Requiring low volume lets real gap bars through while still catching genuine
    // junk prints. (Previously this used `deviation > 100` with no volume check,
    // which rejected every legitimate gap bar after the 2026-05-15 ~460pt overnight
    // gap and left the bot blind for hours.)
    if (this.bars.length > 0) {
      const refClose = this.bars[this.bars.length - 1].close;
      const deviation = Math.abs(bar.close - refClose);
      const vol = bar.volume || 0;
      if (vol < 10 && deviation > 50) {
        if (!this.quietPriceLogs) console.log(`${this.logTag}[1m REJECT] Junk bar: C=${bar.close} deviates ${deviation.toFixed(1)}pt from prev close ${refClose} (V=${vol}) — discarded`);
        return;
      }
    }

    // Store raw 1-min bars
    this.bars.push(bar);
    if (this.bars.length > 500) this.bars.shift();

    // ── Track current-session H/L/C for prior-day & prior-week key levels (S/D, PDH/PDL/PDC) ──
    if (this._dayHigh == null || bar.high > this._dayHigh) this._dayHigh = bar.high;
    if (this._dayLow == null || bar.low < this._dayLow) this._dayLow = bar.low;
    this._dayClose = bar.close;
    // Weekly rollover: UTC day-of-week decreasing (e.g. Mon after Fri) = new week →
    // roll last week's H/L into prior-week levels. (Replaces the never-set _newWeek flag.)
    const _dow = new Date(bar.timestamp).getUTCDay();
    if (this._lastBarDow != null && _dow < this._lastBarDow && this._weekHigh != null) {
      this._pwh = this._weekHigh; this._pwl = this._weekLow;
      this._weekHigh = null; this._weekLow = null;
    }
    this._lastBarDow = _dow;
    if (this._weekHigh == null || bar.high > this._weekHigh) this._weekHigh = bar.high;
    if (this._weekLow == null || bar.low < this._weekLow) this._weekLow = bar.low;
    if (this._sessionOpenPx == null) {
      this._sessionOpenPx = bar.open;
      if (this._pdc == null || !(this._dailyATR > 0)) {
        console.log(`${this.logTag}[GAP] gapATR pending (pdc=${this._pdc}, dailyATR=${this._dailyATR}) — will retry each bar (seed may still be loading)`);
      }
    }
    // Opening-gap regime (for the gap-skip filter): (session open − prior close) / dailyATR.
    // RETRIED every bar until computable — on a live restart the async level-seed can finish
    // AFTER the first streamed bar, so a compute-once-at-first-bar would leave the gap filter
    // silently inactive all session. Identical result in backtest (seed warm by first bar).
    if (this._todayGapATR == null && this._sessionOpenPx != null && this._pdc != null && this._dailyATR > 0) {
      this._todayGapATR = (this._sessionOpenPx - this._pdc) / this._dailyATR;
      const inSkip = (this.gapSkipHi > this.gapSkipLo && this._todayGapATR >= this.gapSkipLo && this._todayGapATR <= this.gapSkipHi);
      console.log(`${this.logTag}[GAP] open ${this._sessionOpenPx} vs PDC ${this._pdc} → gapATR=${this._todayGapATR.toFixed(2)} (dailyATR ${this._dailyATR.toFixed(2)}) ${inSkip ? `→ 🚫 DAY SKIPPED (band [${this.gapSkipLo},${this.gapSkipHi}])` : '✓ tradeable'}`);
    }

    this.sessionBarCount++;

    // ── Log 1m bar count every bar (timestamp-based, not counter-based) ──
    const _barNum = this._getSessionBarNumber(bar.timestamp);
    if (!this.quietPriceLogs) console.log(`${this.logTag}[1m #${_barNum}] O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} V=${bar.volume || 0}`);

    // ── Cooldown decrement ──
    if (this._cooldownRemaining > 0) {
      this._cooldownRemaining--;
      if (this._cooldownRemaining === 0) {
        console.log(`${this.logTag}[COOLDOWN] ✅ Cooldown expired — ready for new signals`);
      } else {
        console.log(`${this.logTag}[COOLDOWN] ${this._cooldownRemaining} bars remaining`);
      }
    }

    // ── Feed VWAP Engine ──
    this.vwapEngine.onBar(bar);

    // ── Update indicator cache every bar ──
    if (this.bars.length >= 15) {
      const closes = this.bars.map(b => b.close);
      this._lastRSI = calcRSI(closes, 14);
      this._lastATR = calcATR(this.bars, 14);
    }

    // Log every 10 bars (use timestamp-based bar number for display)
    if (_barNum % 10 === 0) {
      const vState = this.vwapEngine.isReady() ? `VWAP:${this.vwapEngine.vwap?.toFixed(1)}` : 'VWAP:warming';
      const armed = [this._armedPB ? 'PB' : null, this._armedPB3m ? 'PB3m' : null, this._armedPB2m ? 'PB2m' : null].filter(Boolean).join('+') || 'none';
      if (!this.quietPriceLogs) console.log(`${this.logTag}[Strategy:${this.name}] ${_barNum} bars | 2m:${this.twoMinBars.length} | 3m:${this.threeMinBars.length} | 5m:${this.fiveMinBars.length} | ${vState} | sig:${this.signalFired} | armed:${armed} | cd:${this._cooldownRemaining}`);
    }

    // Build 2-min, 3-min, and 5-min bars simultaneously
    this._build2mBar(bar);
    if (this.pb3mEnabled) this._build3mBar(bar);
    this._build5mBar(bar);

    // ── Check PB 1m confirmation (if watching for bounce) ──
    if (this._pbWatch && this._canSignal()) {
      this._checkPBConfirmation(bar);
    }

    // ── Check VR (VWAP Mean Reversion) on every 1-min bar ──
    if (this.vrEnabled && this._canSignal()) {
      if (this._vrCooldownCount > 0) {
        this._vrCooldownCount--;
      } else {
        this._checkVR(bar);
      }
    }
  }

  /**
   * Check if a new signal is allowed (shared guard for cooldown + all existing checks)
   */
  _canSignal() {
    return this.isActive && !this.signalFired && !this.position
      && this._consecutiveLosses < this.maxLossesPerDay
      && this._cooldownRemaining <= 0;
  }

  /**
   * Process incoming tick (real-time trade print) for intra-bar entry evaluation.
   * Called by InstrumentRunner/TradovateBot on every Databento trade event.
   */
  onTick(tick) {
    if (!this._canSignal()) return;

    const price = tick.price;

    // ── Tick sanity filter: reject corrupt/stale prices far from last known price ──
    // Databento occasionally sends auction prints or garbled prices (e.g. 214.4, 24959
    // when market is at 24730). These can cause false armed-setup invalidations.
    //
    // refPrice preference order (most-trustworthy first):
    //   1. Last accepted 1m bar close — already volume-validated by onBar's V<10/dev>50
    //      guard, so it is *always* a real market price. Survives gaps cleanly because
    //      onBar accepts high-volume gap bars and resetDay() clears stale prior-session
    //      bars so we never compare against yesterday's close.
    //   2. Last accepted tick — fallback when no 1m bar has landed yet this session
    //      (fresh start, or first ticks of a new session before the first 1m flushes).
    // If both are null (first message ever), skip the guard and let the tick through.
    const refPrice = (this.bars.length > 0 ? this.bars[this.bars.length - 1].close : null)
                   || this._prevTickPrice;
    if (refPrice !== null) {
      const deviation = Math.abs(price - refPrice);
      if (deviation > 100) {
        // Silently discard — don't update _prevTickPrice either
        return;
      }
    }

    // Evaluate armed setups against current tick
    // Re-check _canSignal after each because a trigger sets signalFired=true
    if (this._armedPB2m && this._canSignal()) this._tickCheckArmed(this._armedPB2m, price, 'PB2m');
    if (this._armedPB3m && this._canSignal()) this._tickCheckArmed(this._armedPB3m, price, 'PB3m');
    if (this._armedPB   && this._canSignal()) this._tickCheckArmed(this._armedPB,   price, 'PB');

    // Brooks stop-entry: fire on the confirmed break of the signal bar's extreme
    if (this._armedStop && this._canSignal()) this._stopCheckArmed(tick);

    // Track previous tick for direction detection
    this._prevTickPrice = price;
  }

  // ═══════════════════════════════════════════════════════════════
  //  BAR BUILDING
  // ═══════════════════════════════════════════════════════════════

  _build2mBar(bar) {
    // Clock-aligned 2m bars: minutes 0-1, 2-3, 4-5, ... etc.
    const barMin = new Date(bar.timestamp).getUTCMinutes();
    const bucket2m = Math.floor(barMin / 2);

    if (!this.current2mBar || this._current2mBucket !== bucket2m) {
      // New 2m bucket — finalize previous bar if it exists
      if (this.current2mBar) {
        this.twoMinBars.push({ ...this.current2mBar });
        if (this.twoMinBars.length > 200) this.twoMinBars.shift();

        if (this.emaxEnabled && this._canSignal()) {
          this._checkEMAX();
        }
        if (this.pbEnabled && this.pb2mEnabled && this._canSignal()) {
          this._checkPB2m();
        }
        if (this.emaPbEnabled && this.emaPbTF === '2m' && this._canSignal()) {
          this._checkEMAPullback('2m');
        }
      }
      this.current2mBar = {
        timestamp: bar.timestamp,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume || 0,
      };
      this._current2mBucket = bucket2m;
    } else {
      this.current2mBar.high = Math.max(this.current2mBar.high, bar.high);
      this.current2mBar.low = Math.min(this.current2mBar.low, bar.low);
      this.current2mBar.close = bar.close;
      this.current2mBar.volume += (bar.volume || 0);
    }
  }

  _build3mBar(bar) {
    // Clock-aligned 3m bars: minutes 0-2, 3-5, 6-8, ... etc.
    const barMin = new Date(bar.timestamp).getUTCMinutes();
    const bucket3m = Math.floor(barMin / 3);

    if (!this.current3mBar || this._current3mBucket !== bucket3m) {
      if (this.current3mBar) {
        this.threeMinBars.push({ ...this.current3mBar });
        if (this.threeMinBars.length > 200) this.threeMinBars.shift();

        if (this.pbEnabled && this._canSignal()) {
          this._checkPB3m();
        }
        if (this.emaPbEnabled && this.emaPbTF === '3m' && this._canSignal()) {
          this._checkEMAPullback('3m');
        }
        if (this.rangeFadeEnabled && this.rangeFadeTF === '3m' && this._canSignal()) {
          this._checkRangeFade('3m');
        }
        if (this.bopbEnabled && this.bopbTF === '3m' && this._canSignal()) {
          this._checkBreakoutPullback('3m');
        }
        if (this.drEnabled && this.drTF === '3m' && this._canSignal()) {
          this._checkDoubleReversal('3m');
        }
        if (this.fadeEnabled && this.fadeTF === '3m' && this._canSignal()) {
          this._checkFade('3m');
        }
      }
      this.current3mBar = {
        timestamp: bar.timestamp,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume || 0,
      };
      this._current3mBucket = bucket3m;
    } else {
      this.current3mBar.high = Math.max(this.current3mBar.high, bar.high);
      this.current3mBar.low = Math.min(this.current3mBar.low, bar.low);
      this.current3mBar.close = bar.close;
      this.current3mBar.volume += (bar.volume || 0);
    }
  }

  _build5mBar(bar) {
    // Clock-aligned 5m bars: minutes 0-4, 5-9, 10-14, 15-19, ... etc.
    // This prevents dropped 1m bars from shifting all subsequent 5m boundaries.
    const barMin = new Date(bar.timestamp).getUTCMinutes();
    const bucket5m = Math.floor(barMin / 5);

    if (!this.current5mBar || this._current5mBucket !== bucket5m) {
      // New 5m bucket — finalize previous bar if it exists
      if (this.current5mBar) {
        this.fiveMinBars.push({ ...this.current5mBar });
        if (this.fiveMinBars.length > 200) this.fiveMinBars.shift();

        // Enhancement 2: Log completed 5m bar for audit trail
        const fb = this.current5mBar;
        const _5mBarNum = this._getSession5mBarNumber(fb.timestamp);
        if (!this.quietPriceLogs) console.log(`${this.logTag}[5m #${_5mBarNum}] ${fb.timestamp} O=${fb.open} H=${fb.high} L=${fb.low} C=${fb.close} V=${fb.volume}`);

        if (this.pbEnabled && this._canSignal()) {
          this._checkPB();
        }
        if (this.emaPbEnabled && this.emaPbTF === '5m' && this._canSignal()) {
          this._checkEMAPullback('5m');
        }
        if (this.rangeFadeEnabled && this.rangeFadeTF === '5m' && this._canSignal()) {
          this._checkRangeFade('5m');
        }
        if (this.bopbEnabled && this.bopbTF === '5m' && this._canSignal()) {
          this._checkBreakoutPullback('5m');
        }
        if (this.orbEnabled && this._canSignal()) {
          this._checkORB();
        }
        if (this.fadeEnabled && this.fadeTF === '5m' && this._canSignal()) {
          this._checkFade('5m');
        }
        if (this.lbEnabled && this._canSignal()) {
          this._checkLevelBreak();
        }
        if (this.drEnabled && this.drTF === '5m' && this._canSignal()) {
          this._checkDoubleReversal('5m');
        }
      }
      this.current5mBar = {
        timestamp: bar.timestamp,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume || 0,
      };
      this._current5mBucket = bucket5m;
    } else {
      this.current5mBar.high = Math.max(this.current5mBar.high, bar.high);
      this.current5mBar.low = Math.min(this.current5mBar.low, bar.low);
      this.current5mBar.close = bar.close;
      this.current5mBar.volume += (bar.volume || 0);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  HELPER: Get PST minutes from timestamp
  // ═══════════════════════════════════════════════════════════════

  _getPSTMinutes(timestamp) {
    // DST-aware Pacific minute-of-day. The America/LA UTC offset (420 PDT / 480 PST)
    // only changes at DST boundaries, so cache it per UTC-day (cheap) instead of calling
    // Intl per tick. Matches the live bot's _getPSTTime (America/Los_Angeles).
    const ms = (timestamp instanceof Date) ? timestamp.getTime() : Date.parse(timestamp);
    if (!this._laOffCache) this._laOffCache = {};
    const k = Math.floor(ms / 86400000);
    let off = this._laOffCache[k];
    if (off === undefined) {
      const d = new Date(ms);
      const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
      const laMin = (+p.find(x => x.type === 'hour').value % 24) * 60 + (+p.find(x => x.type === 'minute').value);
      let diff = (d.getUTCHours() * 60 + d.getUTCMinutes()) - laMin;
      if (diff < 0) diff += 1440;
      off = this._laOffCache[k] = diff; // 420 (PDT) or 480 (PST)
    }
    const mins = (d => d.getUTCHours() * 60 + d.getUTCMinutes())(new Date(ms - off * 60000));
    return mins;
  }

  /**
   * Get the correct session bar number from a bar's timestamp.
   * Bar #1 = 6:30 AM PT, Bar #2 = 6:31 AM PT, etc.
   */
  _getSessionBarNumber(timestamp) {
    const pstMins = this._getPSTMinutes(timestamp);
    const sessionStartMins = 6 * 60 + 30; // 6:30 AM PT
    return Math.max(1, pstMins - sessionStartMins + 1);
  }

  /**
   * Get the correct session 5m bar number from a 5m bar's timestamp.
   * 5m Bar #1 = 6:30 AM PT, 5m Bar #2 = 6:35 AM PT, etc.
   */
  _getSession5mBarNumber(timestamp) {
    const pstMins = this._getPSTMinutes(timestamp);
    const sessionStartMins = 6 * 60 + 30; // 6:30 AM PT
    return Math.max(1, Math.floor((pstMins - sessionStartMins) / 5) + 1);
  }

  /**
   * Get the correct session 3m bar number from a 3m bar's timestamp.
   */
  _getSession3mBarNumber(timestamp) {
    const pstMins = this._getPSTMinutes(timestamp);
    const sessionStartMins = 6 * 60 + 30; // 6:30 AM PT
    return Math.max(1, Math.floor((pstMins - sessionStartMins) / 3) + 1);
  }

  /**
   * Get the correct session 2m bar number from a 2m bar's timestamp.
   */
  _getSession2mBarNumber(timestamp) {
    const pstMins = this._getPSTMinutes(timestamp);
    const sessionStartMins = 6 * 60 + 30; // 6:30 AM PT
    return Math.max(1, Math.floor((pstMins - sessionStartMins) / 2) + 1);
  }

  // ═══════════════════════════════════════════════════════════════
  //  STRATEGY 1: EMAX (EMA Cross Momentum on 2-min bars)
  //  Now uses ZLEMA for zero-lag crossover detection
  // ═══════════════════════════════════════════════════════════════

  _checkEMAX() {
    if (this.twoMinBars.length < this.emaxEmaSlow + 5) return;

    const bar = this.twoMinBars[this.twoMinBars.length - 1];
    const pstMins = this._getPSTMinutes(bar.timestamp);
    if (pstMins > this.emaxMaxTime) return;

    // Calculate current and previous EMAs (ZLEMA or standard)
    const closes = this.twoMinBars.map(b => b.close);
    const calcFn = this.emaxUseZLEMA ? calcZLEMA : calcEMA;

    const ema9 = calcFn(closes, this.emaxEmaFast);
    const ema21 = calcFn(closes, this.emaxEmaSlow);
    const prevCloses = closes.slice(0, -1);
    const prevEma9 = calcFn(prevCloses, this.emaxEmaFast);
    const prevEma21 = calcFn(prevCloses, this.emaxEmaSlow);

    if (!ema9 || !ema21 || !prevEma9 || !prevEma21) return;

    // Bar quality checks
    const range = bar.high - bar.low;
    if (range < this.emaxMinBarRange) return;
    const bodyRatio = Math.abs(bar.close - bar.open) / range;
    if (bodyRatio < this.emaxMinBodyRatio) return;

    let signal = null;
    let stopDist = 0;

    // Bullish cross
    if (prevEma9 <= prevEma21 && ema9 > ema21 && bar.close > bar.open) {
      signal = 'buy';
      stopDist = bar.close - bar.low + this.stopBuffer;
    }

    // Bearish cross
    if (prevEma9 >= prevEma21 && ema9 < ema21 && bar.close < bar.open) {
      signal = 'sell';
      stopDist = bar.high - bar.close + this.stopBuffer;
    }

    if (!signal) return;
    if (stopDist > this.maxStopPoints || stopDist < this.minStopPoints) return;

    const targetDist = stopDist * this.profitTargetR;
    if (targetDist < this.minTargetPoints) return;

    // ── Confluence Check ──
    const confluence = this.confluenceScorer.score({
      direction: signal,
      price: bar.close,
      vwapEngine: this.vwapEngine,
      emaFast: ema9,
      emaSlow: ema21,
      rsi: this._lastRSI,
      recentBars: this.bars,
      strategyType: 'EMAX',
    });

    if (confluence.score < this.emaxMinConfluence) {
      if (!this.quietPriceLogs) {
        const failedFactors = confluence.factors.filter(f => !f.passed);
        const failedNames = failedFactors.map(f => f.name).join(', ');
        console.log(`${this.logTag}[EMAX] Signal rejected: confluence ${confluence.score}/${confluence.maxScore} < ${this.emaxMinConfluence}`);
        console.log(`${this.logTag}[EMAX] FAILED: ${failedNames}`);
        failedFactors.forEach(f => {
          console.log(`${this.logTag}[EMAX]   - ${f.name}: ${f.reason}`);
        });
      }
      return;
    }

    const entryPrice = bar.close;
    const stopLoss = signal === 'buy' ? bar.low - this.stopBuffer : bar.high + this.stopBuffer;
    const targetPrice = signal === 'buy' ? entryPrice + targetDist : entryPrice - targetDist;

    // ── Volume Filter ──
    const volCheck = this._checkVolumeFilter(bar);
    if (!volCheck.passed) return;

    this.signalFired = true;
    this._tradeCountToday++;

    this.emit('signal', {
      type: signal,
      price: entryPrice,
      orderType: this.entryOrderType,
      limitBufferTicks: this.entryLimitBufferTicks,
      stopLoss,
      targetPrice,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp: new Date(bar.timestamp),
      strategy: 'EMAX',
      tradeNumToday: this._tradeCountToday,
      prevTradeResult: this._prevTradeResult,
      partialProfitEnabled: this.partialProfitEnabled,
      partialProfitR: this.partialProfitR,
      moveStopToBE: this.moveStopToBE,
      confluenceScore: confluence.score,
      vwapState: this.vwapEngine.getState(),
      filterResults: [
        { name: `${this.emaxUseZLEMA ? 'ZL' : ''}EMA Cross`, passed: true, reason: `EMA${this.emaxEmaFast} crossed EMA${this.emaxEmaSlow}` },
        { name: 'Bar Quality', passed: true, reason: `Range: ${range.toFixed(1)}pt, Body: ${(bodyRatio * 100).toFixed(0)}%` },
        { name: 'Confluence', passed: true, reason: `${confluence.score}/${confluence.maxScore} factors` },
        ...confluence.factors.map(f => ({ name: f.name, passed: f.passed, reason: f.reason })),
        { name: 'Stop', passed: true, reason: `${stopDist.toFixed(1)}pt ($${(stopDist * 2).toFixed(0)})` },
        { name: 'Target', passed: true, reason: `${targetDist.toFixed(1)}pt ($${(targetDist * 2).toFixed(0)}) = ${this.profitTargetR}R` },
      ],
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  STRATEGY 2: PB (Momentum Pullback on 5-min bars)
  // ═══════════════════════════════════════════════════════════════

  _checkPB() {
    const barIdx = this.fiveMinBars.length;
    if (barIdx < 5) return;

    const pb = this.fiveMinBars[barIdx - 1];
    const barNum = this._getSession5mBarNumber(pb.timestamp);

    const pstMins = this._getPSTMinutes(pb.timestamp);
    if (!this._timeOK(pstMins, this.pbMaxTime)) {
      console.log(`${this.logTag}[PB #${barNum}] SKIP: past cutoff (${pstMins} > ${this.pbMaxTime})`);
      return;
    }

    // Search up to pbLookbackBars back for a qualifying impulse bar
    let impulse = null;
    let impRange = 0;
    let impBody = 0;
    let isBullish = false;
    let isBearish = false;

    for (let lookback = 2; lookback <= 1 + this.pbLookbackBars; lookback++) {
      const candidate = this.fiveMinBars[barIdx - lookback];
      if (!candidate) continue;

      const candRange = candidate.high - candidate.low;
      if (candRange < this.pbMinImpulse) continue;
      if (candRange > this.pbMaxImpulse) continue;
      const candBody = Math.abs(candidate.close - candidate.open);
      if (candBody / candRange < this.pbMinImpBodyRatio) continue;

      // Found a qualifying impulse
      impulse = candidate;
      impRange = candRange;
      impBody = candBody;
      isBullish = candidate.close > candidate.open;
      isBearish = candidate.close < candidate.open;
      break; // Use the most recent qualifying impulse
    }

    if (!impulse) {
      console.log(`${this.logTag}[PB #${barNum}] SKIP: no qualifying impulse in last ${this.pbLookbackBars} bars`);
      return;
    }

    // ── Pre-compute confluence and trend filter (needed for both tick and bar-close paths) ──
    const direction = isBullish ? 'buy' : 'sell';
    const fiveMinCloses = this.fiveMinBars.map(b => b.close);
    const emaFast5m = calcEMA(fiveMinCloses, 9);
    const emaSlow5m = calcEMA(fiveMinCloses, 21);

    const confluence = this.confluenceScorer.score({
      direction,
      price: pb.close,
      vwapEngine: this.vwapEngine,
      emaFast: emaFast5m,
      emaSlow: emaSlow5m,
      rsi: this._lastRSI,
      recentBars: this.bars,
      strategyType: 'PB',
    });

    if (confluence.score < this.pbMinConfluence) {
      if (!this.quietPriceLogs) {
        const failedFactors = confluence.factors.filter(f => !f.passed);
        const failedNames = failedFactors.map(f => f.name).join(', ');
        console.log(`${this.logTag}[PB #${barNum}] SKIP: confluence ${confluence.score}/${confluence.maxScore} < ${this.pbMinConfluence}`);
        console.log(`${this.logTag}[PB #${barNum}] FAILED: ${failedNames}`);
        failedFactors.forEach(f => {
          console.log(`${this.logTag}[PB #${barNum}]   - ${f.name}: ${f.reason}`);
        });
      }
      return;
    }

    // ── Trend Filter ──
    if (this.pbTrendFilterEnabled) {
      const filterMode = this.pbTrendFilterEnabled === true ? 'both' : this.pbTrendFilterEnabled;
      const vwap = this.vwapEngine.isReady() ? this.vwapEngine.vwap : null;
      const hasVwap = vwap != null;
      const hasEma = emaFast5m != null && emaSlow5m != null;

      let vwapOk = true, emaOk = true;
      if ((filterMode === 'both' || filterMode === 'vwap_only') && hasVwap) {
        vwapOk = direction === 'buy' ? pb.close > vwap : pb.close < vwap;
      }
      if ((filterMode === 'both' || filterMode === 'ema_only') && hasEma) {
        emaOk = direction === 'buy' ? emaFast5m > emaSlow5m : emaFast5m < emaSlow5m;
      }

      const pass = filterMode === 'both' ? (vwapOk && emaOk) : (filterMode === 'vwap_only' ? vwapOk : emaOk);
      if (!pass) {
        const side = direction === 'buy' ? 'LONG' : 'SHORT';
        const reasons = [];
        if (!vwapOk && hasVwap) reasons.push(`price ${direction === 'buy' ? 'below' : 'above'} VWAP(${vwap.toFixed(1)})`);
        if (!emaOk && hasEma) reasons.push(`EMA9(${emaFast5m.toFixed(1)}) ${direction === 'buy' ? '<' : '>'} EMA21(${emaSlow5m.toFixed(1)})`);
        console.log(`${this.logTag}[PB #${barNum}] SKIP: ${side} counter-trend [${filterMode}]: ${reasons.join(', ')}`);
        return;
      }
    }

    // ── Tick entry: arm for intra-bar trigger on the NEXT forming bar ──
    if (this.pbTickEntry && !this._armedPB) {
      console.log(`${this.logTag}[PB #${barNum}] 🔫 Impulse confirmed — arming tick entry for ${direction.toUpperCase()}`);
      this._armTickEntry('PB', impulse, { isBullish, isBearish, impRange, impBody, confluence });
    }

    // ── Bar-close fallback: evaluate the closed pullback bar (existing logic) ──
    let signal = null;
    let entryPrice = 0;
    let stopLoss = 0;
    let stopDist = 0;

    if (isBullish) {
      const retrace = impulse.high - pb.low;
      // ── Pullback-structure sanity guards ──
      // pbLookbackBars > 1 means impulse may be 2-3 bars before pb. Without these
      // guards retracePct can be wildly out of [0,1] when intervening bars pushed
      // price past the impulse range — yielding confusing logs like "retrace -168%"
      // that obscure the real reason (it isn't a pullback at all).
      if (retrace <= 0) {
        console.log(`${this.logTag}[PB #${barNum}] SKIP: bull pb.low ${pb.low} >= impulse.high ${impulse.high} — continuation, not a pullback`);
        return;
      }
      if (retrace > impRange) {
        console.log(`${this.logTag}[PB #${barNum}] SKIP: bull pb.low ${pb.low} < impulse.low ${impulse.low} — impulse invalidated, not a pullback`);
        return;
      }
      const retracePct = retrace / impRange;
      if (retracePct < this.pbRetraceMin || retracePct > this.pbRetraceMax) {
        console.log(`${this.logTag}[PB #${barNum}] SKIP: bull retrace ${(retracePct*100).toFixed(1)}% outside ${(this.pbRetraceMin*100).toFixed(0)}-${(this.pbRetraceMax*100).toFixed(0)}%`);
        return;
      }
      if (pb.close <= pb.open) {
        console.log(`${this.logTag}[PB #${barNum}] SKIP: bull pb bar not bullish (C=${pb.close} <= O=${pb.open})`);
        return;
      }
      if (pb.close < impulse.close - impRange * 0.3) {
        console.log(`${this.logTag}[PB #${barNum}] SKIP: bull pb.close ${pb.close} too far below impulse`);
        return;
      }

      stopDist = pb.close - pb.low + this.stopBuffer;
      if (stopDist > this.maxStopPoints || stopDist < this.minStopPoints) {
        console.log(`${this.logTag}[PB #${barNum}] SKIP: stop ${stopDist.toFixed(1)}pt outside ${this.minStopPoints}-${this.maxStopPoints}`);
        return;
      }
      if (stopDist * this.profitTargetR < this.minTargetPoints) {
        console.log(`${this.logTag}[PB #${barNum}] SKIP: target ${(stopDist*this.profitTargetR).toFixed(1)}pt < min ${this.minTargetPoints}`);
        return;
      }

      signal = 'buy';
      entryPrice = pb.close;
      stopLoss = pb.low - this.stopBuffer;
    }

    if (!signal && isBearish) {
      const retrace = pb.high - impulse.low;
      // Pullback-structure sanity guards (mirror of bullish case)
      if (retrace <= 0) {
        console.log(`${this.logTag}[PB #${barNum}] SKIP: bear pb.high ${pb.high} <= impulse.low ${impulse.low} — continuation, not a pullback`);
        return;
      }
      if (retrace > impRange) {
        console.log(`${this.logTag}[PB #${barNum}] SKIP: bear pb.high ${pb.high} > impulse.high ${impulse.high} — impulse invalidated, not a pullback`);
        return;
      }
      const retracePct = retrace / impRange;
      if (retracePct < this.pbRetraceMin || retracePct > this.pbRetraceMax) {
        console.log(`${this.logTag}[PB #${barNum}] SKIP: bear retrace ${(retracePct*100).toFixed(1)}% outside ${(this.pbRetraceMin*100).toFixed(0)}-${(this.pbRetraceMax*100).toFixed(0)}%`);
        return;
      }
      if (pb.close >= pb.open) {
        console.log(`${this.logTag}[PB #${barNum}] SKIP: bear pb bar not bearish (C=${pb.close} >= O=${pb.open})`);
        return;
      }
      if (pb.close > impulse.close + impRange * 0.3) {
        console.log(`${this.logTag}[PB #${barNum}] SKIP: bear pb.close ${pb.close} too far above impulse`);
        return;
      }

      stopDist = pb.high - pb.close + this.stopBuffer;
      if (stopDist > this.maxStopPoints || stopDist < this.minStopPoints) {
        console.log(`${this.logTag}[PB #${barNum}] SKIP: stop ${stopDist.toFixed(1)}pt outside ${this.minStopPoints}-${this.maxStopPoints}`);
        return;
      }
      if (stopDist * this.profitTargetR < this.minTargetPoints) {
        console.log(`${this.logTag}[PB #${barNum}] SKIP: target ${(stopDist*this.profitTargetR).toFixed(1)}pt < min ${this.minTargetPoints}`);
        return;
      }

      signal = 'sell';
      entryPrice = pb.close;
      stopLoss = pb.high + this.stopBuffer;
    }

    if (!signal) return;

    // If tick entry already fired during this bar, skip bar-close firing
    if (this.signalFired) {
      console.log(`${this.logTag}[PB #${barNum}] Bar-close signal skipped — tick entry already fired`);
      return;
    }

    const targetDist = stopDist * this.profitTargetR;
    const targetPrice = signal === 'buy' ? entryPrice + targetDist : entryPrice - targetDist;

    console.log(`${this.logTag}[PB #${barNum}] ✅ BAR-CLOSE PATTERN: ${signal.toUpperCase()} @ ${entryPrice} | stop=${stopLoss} (${stopDist.toFixed(1)}pt) | target=${targetPrice.toFixed(2)} (${this.profitTargetR}R) | conf=${confluence.score}`);

    // ── Volume Filter ──
    const volCheck = this._checkVolumeFilter(this.bars[this.bars.length - 1]);
    if (!volCheck.passed) return;

    // Disarm any tick entry since bar-close is firing
    this._disarmSetup('PB');

    // Always use market entry (V2.11 — removed limit/watch modes for PB 5m)
    this._firePBSignal({
      type: signal,
      stopLoss,
      stopDistance: stopDist,
      targetDistance: targetDist,
      strategy: 'PB',
      prevTradeResult: this._prevTradeResult,
      partialProfitEnabled: this.partialProfitEnabled,
      partialProfitR: this.partialProfitR,
      moveStopToBE: this.moveStopToBE,
      confluenceScore: confluence.score,
      vwapState: this.vwapEngine.getState(),
      impulse,
      pb,
      isBullish,
      impRange,
      impBody,
      confluence,
    }, entryPrice, new Date(pb.timestamp));
  }

  // ═══════════════════════════════════════════════════════════════
  //  STRATEGY 2b: PB 3m (Momentum Pullback on 3-min bars)
  // ═══════════════════════════════════════════════════════════════

  _checkPB3m() {
    const barIdx = this.threeMinBars.length;
    if (barIdx < 5) return;

    const pb = this.threeMinBars[barIdx - 1];
    const barNum = this._getSession3mBarNumber(pb.timestamp);

    const pstMins = this._getPSTMinutes(pb.timestamp);
    if (!this._timeOK(pstMins, this.pb3mMaxTime)) return;

    // Search up to pb3mLookbackBars back for a qualifying impulse bar
    let impulse = null;
    let impRange = 0;
    let impBody = 0;
    let isBullish = false;
    let isBearish = false;

    for (let lookback = 2; lookback <= 1 + this.pb3mLookbackBars; lookback++) {
      const candidate = this.threeMinBars[barIdx - lookback];
      if (!candidate) continue;

      const candRange = candidate.high - candidate.low;
      if (candRange < this.pb3mMinImpulse) continue;
      if (candRange > this.pb3mMaxImpulse) continue;
      const candBody = Math.abs(candidate.close - candidate.open);
      if (candBody / candRange < this.pb3mMinImpBodyRatio) continue;

      impulse = candidate;
      impRange = candRange;
      impBody = candBody;
      isBullish = candidate.close > candidate.open;
      isBearish = candidate.close < candidate.open;
      break;
    }

    if (!impulse) return;

    // ── Pre-compute confluence and trend filter (needed for both tick and bar-close paths) ──
    const direction = isBullish ? 'buy' : 'sell';
    const threeMinCloses = this.threeMinBars.map(b => b.close);
    const emaFast3m = calcEMA(threeMinCloses, 9);
    const emaSlow3m = calcEMA(threeMinCloses, 21);

    const confluence = this.confluenceScorer.score({
      direction,
      price: pb.close,
      vwapEngine: this.vwapEngine,
      emaFast: emaFast3m,
      emaSlow: emaSlow3m,
      rsi: this._lastRSI,
      recentBars: this.bars,
      strategyType: 'PB',
    });

    if (confluence.score < this.pb3mMinConfluence) {
      if (!this.quietPriceLogs) {
        const failedNames = confluence.factors.filter(f => !f.passed).map(f => f.name).join(', ');
        console.log(`${this.logTag}[PB3m #${barNum}] SKIP: confluence ${confluence.score}/${confluence.maxScore} < ${this.pb3mMinConfluence} (failed: ${failedNames})`);
      }
      return;
    }

    // ── Trend Filter ──
    if (this.pbTrendFilterEnabled) {
      const filterMode = this.pbTrendFilterEnabled === true ? 'both' : this.pbTrendFilterEnabled;
      const vwap = this.vwapEngine.isReady() ? this.vwapEngine.vwap : null;
      const hasVwap = vwap != null;
      const hasEma = emaFast3m != null && emaSlow3m != null;

      let vwapOk = true, emaOk = true;
      if ((filterMode === 'both' || filterMode === 'vwap_only') && hasVwap) {
        vwapOk = direction === 'buy' ? pb.close > vwap : pb.close < vwap;
      }
      if ((filterMode === 'both' || filterMode === 'ema_only') && hasEma) {
        emaOk = direction === 'buy' ? emaFast3m > emaSlow3m : emaFast3m < emaSlow3m;
      }

      const pass = filterMode === 'both' ? (vwapOk && emaOk) : (filterMode === 'vwap_only' ? vwapOk : emaOk);
      if (!pass) return;
    }

    // ── Tick entry: arm for intra-bar trigger on the NEXT forming bar ──
    if (this.pb3mTickEntry && !this._armedPB3m) {
      console.log(`${this.logTag}[PB3m #${barNum}] 🔫 Impulse confirmed — arming tick entry for ${direction.toUpperCase()}`);
      this._armTickEntry('PB3m', impulse, { isBullish, isBearish, impRange, impBody, confluence });
    }

    // ── Bar-close fallback: evaluate the closed pullback bar (existing logic) ──
    let signal = null;
    let entryPrice = 0;
    let stopLoss = 0;
    let stopDist = 0;

    if (isBullish) {
      const retrace = impulse.high - pb.low;
      // Pullback-structure sanity (see PB 5m for full explanation)
      if (retrace <= 0 || retrace > impRange) return;
      const retracePct = retrace / impRange;
      if (retracePct < this.pb3mRetraceMin || retracePct > this.pb3mRetraceMax) return;
      if (pb.close <= pb.open) return;
      if (pb.close < impulse.close - impRange * 0.3) return;

      stopDist = pb.close - pb.low + this.stopBuffer;
      if (stopDist > this.pb3mMaxStopPoints || stopDist < this.pb3mMinStopPoints) return;
      if (stopDist * this.profitTargetR < this.pb3mMinTargetPoints) return;

      signal = 'buy';
      entryPrice = pb.close;
      stopLoss = pb.low - this.stopBuffer;
    }

    if (!signal && isBearish) {
      const retrace = pb.high - impulse.low;
      // Pullback-structure sanity
      if (retrace <= 0 || retrace > impRange) return;
      const retracePct = retrace / impRange;
      if (retracePct < this.pb3mRetraceMin || retracePct > this.pb3mRetraceMax) return;
      if (pb.close >= pb.open) return;
      if (pb.close > impulse.close + impRange * 0.3) return;

      stopDist = pb.high - pb.close + this.stopBuffer;
      if (stopDist > this.pb3mMaxStopPoints || stopDist < this.pb3mMinStopPoints) return;
      if (stopDist * this.profitTargetR < this.pb3mMinTargetPoints) return;

      signal = 'sell';
      entryPrice = pb.close;
      stopLoss = pb.high + this.stopBuffer;
    }

    if (!signal) return;

    // If tick entry already fired during this bar, skip bar-close firing
    if (this.signalFired) {
      console.log(`${this.logTag}[PB3m #${barNum}] Bar-close signal skipped — tick entry already fired`);
      return;
    }

    const targetDist = stopDist * this.profitTargetR;
    const targetPrice = signal === 'buy' ? entryPrice + targetDist : entryPrice - targetDist;

    console.log(`${this.logTag}[PB3m #${barNum}] ✅ BAR-CLOSE PATTERN: ${signal.toUpperCase()} @ ${entryPrice} | stop=${stopLoss} (${stopDist.toFixed(1)}pt) | target=${targetPrice.toFixed(2)} (${this.profitTargetR}R) | conf=${confluence.score}`);

    // ── Volume Filter ──
    const volCheck = this._checkVolumeFilter(this.bars[this.bars.length - 1]);
    if (!volCheck.passed) return;

    this._disarmSetup('PB3m');
    if (this.stopEntryEnabled) {
      this._armStopEntry({ type: signal, stopLoss, pb, impulse, isBullish, impRange, impBody, confluence, strategy: 'PB3m' }, entryPrice, new Date(pb.timestamp));
      return;
    }
    this.signalFired = true;
    this._tradeCountToday++;

    this.emit('signal', {
      type: signal,
      price: entryPrice,
      orderType: this.entryOrderType,
      limitBufferTicks: this.entryLimitBufferTicks,
      stopLoss,
      targetPrice,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp: new Date(pb.timestamp),
      strategy: 'PB3m',
      tradeNumToday: this._tradeCountToday,
      prevTradeResult: this._prevTradeResult,
      partialProfitEnabled: this.partialProfitEnabled,
      partialProfitR: this.partialProfitR,
      moveStopToBE: this.moveStopToBE,
      confluenceScore: confluence.score,
      vwapState: this.vwapEngine.getState(),
      tickTriggered: false,
      filterResults: [
        { name: 'Impulse', passed: true, reason: `${impRange.toFixed(1)}pt range, ${(impBody / impRange * 100).toFixed(0)}% body` },
        { name: 'Pullback', passed: true, reason: `${((isBullish ? impulse.high - pb.low : pb.high - impulse.low) / impRange * 100).toFixed(0)}% retrace` },
        { name: 'Confluence', passed: true, reason: `${confluence.score}/${confluence.maxScore} factors` },
        ...confluence.factors.map(f => ({ name: f.name, passed: f.passed, reason: f.reason })),
      ],
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  STRATEGY 2c: PB 2m (Momentum Pullback on 2-min bars)
  // ═══════════════════════════════════════════════════════════════

  _checkPB2m() {
    const barIdx = this.twoMinBars.length;
    if (barIdx < 5) return;

    const pb = this.twoMinBars[barIdx - 1];
    const barNum = this._getSession2mBarNumber(pb.timestamp);

    const pstMins = this._getPSTMinutes(pb.timestamp);
    if (!this._timeOK(pstMins, this.pb2mMaxTime)) return;

    // Search up to pb2mLookbackBars back for a qualifying impulse bar
    let impulse = null;
    let impRange = 0;
    let impBody = 0;
    let isBullish = false;
    let isBearish = false;

    for (let lookback = 2; lookback <= 1 + this.pb2mLookbackBars; lookback++) {
      const candidate = this.twoMinBars[barIdx - lookback];
      if (!candidate) continue;

      const candRange = candidate.high - candidate.low;
      if (candRange < this.pb2mMinImpulse) continue;
      if (candRange > this.pb2mMaxImpulse) continue;
      const candBody = Math.abs(candidate.close - candidate.open);
      if (candBody / candRange < this.pb2mMinImpBodyRatio) continue;

      impulse = candidate;
      impRange = candRange;
      impBody = candBody;
      isBullish = candidate.close > candidate.open;
      isBearish = candidate.close < candidate.open;
      break;
    }

    if (!impulse) return;

    // ── Pre-compute confluence and trend filter (needed for both tick and bar-close paths) ──
    const direction = isBullish ? 'buy' : 'sell';
    const twoMinCloses = this.twoMinBars.map(b => b.close);
    const emaFast2m = calcEMA(twoMinCloses, 9);
    const emaSlow2m = calcEMA(twoMinCloses, 21);

    const confluence = this.confluenceScorer.score({
      direction,
      price: pb.close,
      vwapEngine: this.vwapEngine,
      emaFast: emaFast2m,
      emaSlow: emaSlow2m,
      rsi: this._lastRSI,
      recentBars: this.bars,
      strategyType: 'PB',
    });

    if (confluence.score < this.pb2mMinConfluence) {
      if (!this.quietPriceLogs) {
        const failedNames = confluence.factors.filter(f => !f.passed).map(f => f.name).join(', ');
        console.log(`${this.logTag}[PB2m #${barNum}] SKIP: confluence ${confluence.score}/${confluence.maxScore} < ${this.pb2mMinConfluence} (failed: ${failedNames})`);
      }
      return;
    }

    // ── Trend Filter ──
    if (this.pbTrendFilterEnabled) {
      const filterMode = this.pbTrendFilterEnabled === true ? 'both' : this.pbTrendFilterEnabled;
      const vwap = this.vwapEngine.isReady() ? this.vwapEngine.vwap : null;
      const hasVwap = vwap != null;
      const hasEma = emaFast2m != null && emaSlow2m != null;

      let vwapOk = true, emaOk = true;
      if ((filterMode === 'both' || filterMode === 'vwap_only') && hasVwap) {
        vwapOk = direction === 'buy' ? pb.close > vwap : pb.close < vwap;
      }
      if ((filterMode === 'both' || filterMode === 'ema_only') && hasEma) {
        emaOk = direction === 'buy' ? emaFast2m > emaSlow2m : emaFast2m < emaSlow2m;
      }

      const pass = filterMode === 'both' ? (vwapOk && emaOk) : (filterMode === 'vwap_only' ? vwapOk : emaOk);
      if (!pass) return;
    }

    // ── Tick entry: arm for intra-bar trigger on the NEXT forming bar ──
    if (this.pb2mTickEntry && !this._armedPB2m) {
      console.log(`${this.logTag}[PB2m #${barNum}] 🔫 Impulse confirmed — arming tick entry for ${direction.toUpperCase()}`);
      this._armTickEntry('PB2m', impulse, { isBullish, isBearish, impRange, impBody, confluence });
      // Don't return — continue to bar-close fallback evaluation below
    }

    // ── Bar-close fallback: evaluate the closed pullback bar (existing logic) ──
    let signal = null;
    let entryPrice = 0;
    let stopLoss = 0;
    let stopDist = 0;

    if (isBullish) {
      const retrace = impulse.high - pb.low;
      // Pullback-structure sanity (see PB 5m for full explanation)
      if (retrace <= 0 || retrace > impRange) return;
      const retracePct = retrace / impRange;
      if (retracePct < this.pb2mRetraceMin || retracePct > this.pb2mRetraceMax) return;
      if (pb.close <= pb.open) return;
      if (pb.close < impulse.close - impRange * 0.3) return;

      stopDist = pb.close - pb.low + this.stopBuffer;
      if (stopDist > this.pb2mMaxStopPoints || stopDist < this.pb2mMinStopPoints) return;
      if (stopDist * this.profitTargetR < this.pb2mMinTargetPoints) return;

      signal = 'buy';
      entryPrice = pb.close;
      stopLoss = pb.low - this.stopBuffer;
    }

    if (!signal && isBearish) {
      const retrace = pb.high - impulse.low;
      // Pullback-structure sanity
      if (retrace <= 0 || retrace > impRange) return;
      const retracePct = retrace / impRange;
      if (retracePct < this.pb2mRetraceMin || retracePct > this.pb2mRetraceMax) return;
      if (pb.close >= pb.open) return;
      if (pb.close > impulse.close + impRange * 0.3) return;

      stopDist = pb.high - pb.close + this.stopBuffer;
      if (stopDist > this.pb2mMaxStopPoints || stopDist < this.pb2mMinStopPoints) return;
      if (stopDist * this.profitTargetR < this.pb2mMinTargetPoints) return;

      signal = 'sell';
      entryPrice = pb.close;
      stopLoss = pb.high + this.stopBuffer;
    }

    if (!signal) return;

    // If tick entry already fired during this bar, skip bar-close firing
    if (this.signalFired) {
      console.log(`${this.logTag}[PB2m #${barNum}] Bar-close signal skipped — tick entry already fired`);
      return;
    }

    const targetDist = stopDist * this.profitTargetR;
    const targetPrice = signal === 'buy' ? entryPrice + targetDist : entryPrice - targetDist;

    console.log(`${this.logTag}[PB2m #${barNum}] ✅ BAR-CLOSE PATTERN: ${signal.toUpperCase()} @ ${entryPrice} | stop=${stopLoss} (${stopDist.toFixed(1)}pt) | target=${targetPrice.toFixed(2)} (${this.profitTargetR}R) | conf=${confluence.score}`);

    // ── Volume Filter ──
    const volCheck = this._checkVolumeFilter(this.bars[this.bars.length - 1]);
    if (!volCheck.passed) return;

    // Disarm any tick entry since bar-close is firing
    this._disarmSetup('PB2m');

    if (this.stopEntryEnabled) {
      this._armStopEntry({ type: signal, stopLoss, pb, impulse, isBullish, impRange, impBody, confluence, strategy: 'PB2m' }, entryPrice, new Date(pb.timestamp));
      return;
    }
    this.signalFired = true;
    this._tradeCountToday++;

    this.emit('signal', {
      type: signal,
      price: entryPrice,
      orderType: this.entryOrderType,
      limitBufferTicks: this.entryLimitBufferTicks,
      stopLoss,
      targetPrice,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp: new Date(pb.timestamp),
      strategy: 'PB2m',
      tradeNumToday: this._tradeCountToday,
      prevTradeResult: this._prevTradeResult,
      partialProfitEnabled: this.partialProfitEnabled,
      partialProfitR: this.partialProfitR,
      moveStopToBE: this.moveStopToBE,
      confluenceScore: confluence.score,
      vwapState: this.vwapEngine.getState(),
      tickTriggered: false,
      filterResults: [
        { name: 'Impulse', passed: true, reason: `${impRange.toFixed(1)}pt range, ${(impBody / impRange * 100).toFixed(0)}% body` },
        { name: 'Pullback', passed: true, reason: `${((isBullish ? impulse.high - pb.low : pb.high - impulse.low) / impRange * 100).toFixed(0)}% retrace` },
        { name: 'Confluence', passed: true, reason: `${confluence.score}/${confluence.maxScore} factors` },
        ...confluence.factors.map(f => ({ name: f.name, passed: f.passed, reason: f.reason })),
      ],
    });
  }

  /**
   * Arm a Brooks stop-entry on the break of the signal (pullback) bar's extreme.
   * Buy → stop at pb.high + offset; Sell → stop at pb.low − offset. Protective stop
   * is the signal bar's opposite extreme (setup.stopLoss). The newest qualifying
   * signal bar replaces any prior arm (Brooks: H1 fails → H2 becomes the new signal).
   * @private
   */
  /**
   * Brooks EMA-pullback detector (additive with-trend setup). On a completed TF bar:
   * in a trend (rising/falling 20-EMA with a prior leg away from the EMA), if the bar
   * pulls back to/through the EMA and closes back on the trend side, arm a stop-entry
   * on the break of its extreme (protective stop beyond the signal bar). Reuses the
   * Brooks stop-entry + signal-bar quality filters. Distinct from the impulse-PB.
   * @private
   */
  _checkEMAPullback(tf) {
    const bars = tf === '3m' ? this.threeMinBars : tf === '2m' ? this.twoMinBars : this.fiveMinBars;
    const need = Math.max(this.emaPbPeriod + this.emaPbSlopeLookback + 2, this.emaPbLegLookback + 2);
    if (!bars || bars.length < need) return;
    const closes = bars.map(b => b.close);
    const n = bars.length - 1;                       // just-closed bar
    // calcEMA returns the EMA at the end of the passed series → slice for slope.
    const emaNow = calcEMA(closes, this.emaPbPeriod);
    const emaPrev = calcEMA(closes.slice(0, closes.length - this.emaPbSlopeLookback), this.emaPbPeriod);
    if (emaNow == null || emaPrev == null) return;
    const atr = calcATR(bars, 14) || 0;
    if (atr <= 0) return;
    const sb = bars[n];
    const tol = this.emaPbTouchTolATR * atr;
    const legStart = Math.max(0, n - this.emaPbLegLookback);
    let legHigh = -Infinity, legLow = Infinity;
    for (let i = legStart; i < n; i++) { if (bars[i].high > legHigh) legHigh = bars[i].high; if (bars[i].low < legLow) legLow = bars[i].low; }
    const legRange = (legHigh - legLow) || atr;

    let setup = null;
    if (emaNow > emaPrev && (legHigh - emaNow) >= this.emaPbMinLegATR * atr) {
      // bull: rising EMA, prior up-leg, bar dips to EMA and closes back above
      if (sb.low <= emaNow + tol && sb.close > emaNow) {
        setup = { type: 'buy', pb: sb, stopLoss: sb.low - this.tickSize, isBullish: true, strategy: 'EPB',
                  impulse: { high: legHigh, low: legLow }, impRange: legRange, impBody: legRange, confluence: null };
      }
    } else if (emaNow < emaPrev && (emaNow - legLow) >= this.emaPbMinLegATR * atr) {
      // bear: falling EMA, prior down-leg, bar pulls up to EMA and closes back below
      if (sb.high >= emaNow - tol && sb.close < emaNow) {
        setup = { type: 'sell', pb: sb, stopLoss: sb.high + this.tickSize, isBullish: false, strategy: 'EPB',
                  impulse: { high: legHigh, low: legLow }, impRange: legRange, impBody: legRange, confluence: null };
      }
    }
    if (!setup) return;
    // session cutoff (reuse the PB entry cutoff)
    const t = new Date(sb.timestamp);
    const pstMin = this._getPSTMinutes(t);
    if (!this._timeOK(pstMin, this.pbMaxTime)) return;
    this._armStopEntry(setup, setup.type === 'buy' ? sb.high : sb.low, new Date(sb.timestamp));
  }

  /**
   * Brooks trading-range FADE detector (counter-trend, range regime). On a completed
   * TF bar: if the EMA is flat (range) and a well-formed range exists, and the bar
   * pokes the top/bottom extreme and rejects it (bear bar at top / bull bar at bottom),
   * fade it — sell-stop on break of the bar low (top) / buy-stop on break of the high
   * (bottom), protective stop beyond the signal bar, SCALP target (lower R). Reuses
   * the Brooks stop-entry + signal-bar filters. Fires on chop days the trend setups skip.
   * @private
   */
  _checkRangeFade(tf) {
    const bars = tf === '3m' ? this.threeMinBars : tf === '2m' ? this.twoMinBars : this.fiveMinBars;
    const need = Math.max(this.emaPbPeriod + this.emaPbSlopeLookback + 2, this.rangeFadeLookback + 2);
    if (!bars || bars.length < need) return;
    const closes = bars.map(b => b.close);
    const n = bars.length - 1;
    const emaNow = calcEMA(closes, this.emaPbPeriod);
    const emaPrev = calcEMA(closes.slice(0, closes.length - this.emaPbSlopeLookback), this.emaPbPeriod);
    if (emaNow == null || emaPrev == null) return;
    const atr = calcATR(bars, 14) || 0;
    if (atr <= 0) return;
    if (Math.abs(emaNow - emaPrev) > this.rangeFadeMaxSlopeATR * atr) return; // not flat → not a range
    const start = Math.max(0, n - this.rangeFadeLookback);
    let rangeHigh = -Infinity, rangeLow = Infinity;
    for (let i = start; i < n; i++) { if (bars[i].high > rangeHigh) rangeHigh = bars[i].high; if (bars[i].low < rangeLow) rangeLow = bars[i].low; }
    const rangeSize = rangeHigh - rangeLow;
    if (rangeSize < this.rangeFadeMinSizeATR * atr || rangeSize > this.rangeFadeMaxSizeATR * atr) return;
    const sb = bars[n];
    const edge = this.rangeFadeEdgePct * rangeSize;
    let setup = null;
    if (sb.high >= rangeHigh - edge && sb.close < sb.open) {
      // fade the TOP with a bear bar → short the break of its low (scalp toward middle)
      setup = { type: 'sell', pb: sb, stopLoss: sb.high + this.tickSize, isBullish: false, strategy: 'RF',
                impulse: { high: rangeHigh, low: rangeLow }, impRange: rangeSize || atr, impBody: rangeSize || atr, confluence: null, targetR: this.rangeFadeTargetR };
    } else if (sb.low <= rangeLow + edge && sb.close > sb.open) {
      // fade the BOTTOM with a bull bar → long the break of its high
      setup = { type: 'buy', pb: sb, stopLoss: sb.low - this.tickSize, isBullish: true, strategy: 'RF',
                impulse: { high: rangeHigh, low: rangeLow }, impRange: rangeSize || atr, impBody: rangeSize || atr, confluence: null, targetR: this.rangeFadeTargetR };
    }
    if (!setup) return;
    const t = new Date(sb.timestamp);
    const pstMin = this._getPSTMinutes(t);
    if (!this._timeOK(pstMin, this.pbMaxTime)) return;
    this._armStopEntry(setup, setup.type === 'buy' ? sb.high : sb.low, new Date(sb.timestamp));
  }

  /**
   * Brooks strong-trend shallow-pullback / breakout-pullback (BOPB). On a completed TF
   * bar: in a STEEP trend (EMA slope ≥ threshold), if the bar is a shallow pullback that
   * holds ABOVE the EMA (low never reaches it) and isn't extended, enter on the break of
   * its extreme. Complementary to EPB (which requires the low to touch the EMA).
   * @private
   */
  _checkBreakoutPullback(tf) {
    const bars = tf === '3m' ? this.threeMinBars : tf === '2m' ? this.twoMinBars : this.fiveMinBars;
    const need = Math.max(this.emaPbPeriod + this.emaPbSlopeLookback + 2, this.emaPbLegLookback + 2);
    if (!bars || bars.length < need) return;
    const closes = bars.map(b => b.close);
    const n = bars.length - 1;
    if (n < 2) return;
    const emaNow = calcEMA(closes, this.emaPbPeriod);
    const emaPrev = calcEMA(closes.slice(0, closes.length - this.emaPbSlopeLookback), this.emaPbPeriod);
    if (emaNow == null || emaPrev == null) return;
    const atr = calcATR(bars, 14) || 0;
    if (atr <= 0) return;
    const slope = emaNow - emaPrev;
    const sb = bars[n];
    const prevHigh = Math.max(bars[n - 1].high, bars[n - 2].high);
    const prevLow = Math.min(bars[n - 1].low, bars[n - 2].low);
    const legStart = Math.max(0, n - this.emaPbLegLookback);
    let legHigh = -Infinity, legLow = Infinity;
    for (let i = legStart; i < n; i++) { if (bars[i].high > legHigh) legHigh = bars[i].high; if (bars[i].low < legLow) legLow = bars[i].low; }
    const legRange = (legHigh - legLow) || atr;
    let setup = null;
    if (slope >= this.bopbMinSlopeATR * atr) {
      // bull: steep up-trend; shallow pullback bar holds above EMA, not making a new high, not extended
      if (sb.high <= prevHigh && sb.low > emaNow && sb.low <= emaNow + this.bopbMaxDistATR * atr) {
        setup = { type: 'buy', pb: sb, stopLoss: sb.low - this.tickSize, isBullish: true, strategy: 'BOPB',
                  impulse: { high: legHigh, low: legLow }, impRange: legRange, impBody: legRange, confluence: null };
      }
    } else if (slope <= -this.bopbMinSlopeATR * atr) {
      // bear: steep down-trend; shallow pullback bar holds below EMA
      if (sb.low >= prevLow && sb.high < emaNow && sb.high >= emaNow - this.bopbMaxDistATR * atr) {
        setup = { type: 'sell', pb: sb, stopLoss: sb.high + this.tickSize, isBullish: false, strategy: 'BOPB',
                  impulse: { high: legHigh, low: legLow }, impRange: legRange, impBody: legRange, confluence: null };
      }
    }
    if (!setup) return;
    const t = new Date(sb.timestamp);
    const pstMin = this._getPSTMinutes(t);
    if (!this._timeOK(pstMin, this.pbMaxTime)) return;
    this._armStopEntry(setup, setup.type === 'buy' ? sb.high : sb.low, new Date(sb.timestamp));
  }

  /**
   * Brooks DOUBLE-TOP/BOTTOM (second-entry) reversal detector. On a completed TF bar:
   * if the bar revisits a prior swing extreme (within tol), there was a real bounce
   * between the two (a W/M), and the bar is a reversal bar, enter WITH the reversal on
   * the break of its extreme — buy-stop off a double bottom / sell-stop off a double top.
   * This is the proper range/reversal fade (the 2nd touch, not every poke).
   * @private
   */
  _checkDoubleReversal(tf) {
    const bars = tf === '3m' ? this.threeMinBars : tf === '2m' ? this.twoMinBars : this.fiveMinBars;
    const need = this.drLookback + this.drMinGap + 3;
    if (!bars || bars.length < need) return;
    const n = bars.length - 1;
    const sb = bars[n];
    const atr = calcATR(bars, 14) || 0;
    if (atr <= 0) return;
    let slope = null;
    if (this.drMaxSlopeATR > 0 || this.drMinSlopeATR > 0) {
      const closes = bars.map(b => b.close);
      const emaNow = calcEMA(closes, this.emaPbPeriod);
      const emaPrev = calcEMA(closes.slice(0, closes.length - this.emaPbSlopeLookback), this.emaPbPeriod);
      if (emaNow == null || emaPrev == null) return;
      slope = emaNow - emaPrev;
      if (this.drMaxSlopeATR > 0 && Math.abs(slope) > this.drMaxSlopeATR * atr) return; // range-only gate
    }
    const tol = this.drTolATR * atr;
    const from = Math.max(0, n - this.drLookback), to = n - this.drMinGap;
    let setup = null;
    // ── DOUBLE BOTTOM (buy): sb.low revisits a prior swing low, bounced in between, bull reversal bar ──
    {
      let priorLow = Infinity, j = -1;
      for (let i = from; i <= to; i++) { if (bars[i].low < priorLow) { priorLow = bars[i].low; j = i; } }
      const hlOK = this.drRequireHL ? (sb.low >= priorLow) : (sb.low >= priorLow - tol);
      const trendOK = this.drMinSlopeATR > 0 ? (slope <= -this.drMinSlopeATR * atr) : true; // prior DOWN-trend exhausting
      if (j >= 0 && Math.abs(sb.low - priorLow) <= tol && hlOK && trendOK && sb.close > sb.open) {
        let midHigh = -Infinity; for (let i = j + 1; i < n; i++) if (bars[i].high > midHigh) midHigh = bars[i].high;
        if ((midHigh - priorLow) >= this.drBounceATR * atr) {
          setup = { type: 'buy', pb: sb, stopLoss: Math.min(sb.low, priorLow) - this.tickSize, isBullish: true, strategy: 'DR',
                    impulse: { high: midHigh, low: priorLow }, impRange: (midHigh - priorLow) || atr, impBody: (midHigh - priorLow) || atr, confluence: null, targetR: this.drTargetR };
        }
      }
    }
    // ── DOUBLE TOP (sell): sb.high revisits a prior swing high, bounced down in between, bear reversal bar ──
    if (!setup) {
      let priorHigh = -Infinity, j = -1;
      for (let i = from; i <= to; i++) { if (bars[i].high > priorHigh) { priorHigh = bars[i].high; j = i; } }
      const lhOK = this.drRequireHL ? (sb.high <= priorHigh) : (sb.high <= priorHigh + tol);
      const trendOK = this.drMinSlopeATR > 0 ? (slope >= this.drMinSlopeATR * atr) : true; // prior UP-trend exhausting
      if (j >= 0 && Math.abs(sb.high - priorHigh) <= tol && lhOK && trendOK && sb.close < sb.open) {
        let midLow = Infinity; for (let i = j + 1; i < n; i++) if (bars[i].low < midLow) midLow = bars[i].low;
        if ((priorHigh - midLow) >= this.drBounceATR * atr) {
          setup = { type: 'sell', pb: sb, stopLoss: Math.max(sb.high, priorHigh) + this.tickSize, isBullish: false, strategy: 'DR',
                    impulse: { high: priorHigh, low: midLow }, impRange: (priorHigh - midLow) || atr, impBody: (priorHigh - midLow) || atr, confluence: null, targetR: this.drTargetR };
        }
      }
    }
    if (!setup) return;
    const t = new Date(sb.timestamp);
    const pstMin = this._getPSTMinutes(t);
    if (!this._timeOK(pstMin, this.pbMaxTime)) return;
    this._armStopEntry(setup, setup.type === 'buy' ? sb.high : sb.low, new Date(sb.timestamp));
  }

  /**
   * Opening Range Breakout (Zarattini). After the opening range (first orbMinutes of the
   * session) completes, on the first 5m bar that breaks the OR high/low, arm a stop-entry
   * on that break with the protective stop at the OPPOSITE OR edge and an R-target. One ORB
   * attempt per day. OR width must be within [orbMinRangeATR, orbMaxRangeATR] × ATR.
   * @private
   */
  _checkORB() {
    if (this._orbArmed) return;
    const bars = this.fiveMinBars; const n = bars.length - 1;
    if (n < 1) return;
    const sb = bars[n];
    const sbMin = this._getPSTMinutes(sb.timestamp);
    const orEnd = this.orbSessionOpen + this.orbMinutes;
    if (sbMin < orEnd) return;                 // OR still forming
    if (!this._timeOK(sbMin, this.pbMaxTime)) return; // past entry cutoff
    // build OR from bars in [open, open+orbMinutes)
    let orH = -Infinity, orL = Infinity, found = 0;
    for (let i = n; i >= 0; i--) {
      const m = this._getPSTMinutes(bars[i].timestamp);
      if (m < this.orbSessionOpen) break;
      if (m >= this.orbSessionOpen && m < orEnd) { if (bars[i].high > orH) orH = bars[i].high; if (bars[i].low < orL) orL = bars[i].low; found++; }
    }
    if (found < 1 || !isFinite(orH) || !isFinite(orL)) return;
    const orW = orH - orL;
    const atr = calcATR(bars, 14) || 0;
    if (atr <= 0) return;
    if (orW < this.orbMinRangeATR * atr || orW > this.orbMaxRangeATR * atr) return; // OR size filter
    let setup = null;
    const synth = { high: orH, low: orL, open: orL, close: orH, timestamp: sb.timestamp };
    if (sb.high > orH) {
      setup = { type: 'buy', pb: synth, stopLoss: orL - this.tickSize, isBullish: true, strategy: 'ORB',
                impulse: { high: orH, low: orL }, impRange: orW, impBody: orW, confluence: null, targetR: this.orbTargetR, skipSig: true };
    } else if (sb.low < orL) {
      setup = { type: 'sell', pb: synth, stopLoss: orH + this.tickSize, isBullish: false, strategy: 'ORB',
                impulse: { high: orH, low: orL }, impRange: orW, impBody: orW, confluence: null, targetR: this.orbTargetR, skipSig: true };
    }
    if (!setup) return;
    this._orbArmed = true;
    this._armStopEntry(setup, setup.type === 'buy' ? orH : orL, new Date(sb.timestamp));
  }

  /**
   * FADE (mean-reversion): sell pokes above VWAP+kσ / buy pokes below VWAP−kσ, with a
   * DYNAMIC target = VWAP (the intraday mean). Market entry on the rejecting bar's close,
   * stop beyond the band/extreme, time-stop after N bars. Reward/risk varies per trade.
   * @private
   */
  _checkFade(tf) {
    const bars = tf === '3m' ? this.threeMinBars : tf === '2m' ? this.twoMinBars : this.fiveMinBars;
    if (!bars || bars.length < 20) return;
    const v = this.vwapEngine;
    if (!v || (v.isReady && !v.isReady()) || v.vwap == null || !(v.stdDev > 0)) return;
    const n = bars.length - 1, sb = bars[n];
    const atr = calcATR(bars, 14) || 0; if (atr <= 0) return;
    const pstMin = this._getPSTMinutes(sb.timestamp);
    if (!this._timeOK(pstMin, this.pbMaxTime)) return;
    const rng = (sb.high - sb.low) || 0.0001;
    const rsi = (this.fadeRSIMax || this.fadeRSIMin) ? calcRSI(bars.map(b => b.close), this.fadeRSIPeriod) : null;
    const upper = v.vwap + this.fadeSigma * v.stdDev;
    const lower = v.vwap - this.fadeSigma * v.stdDev;
    let setup = null;
    // SELL: poked the upper band, RSI overbought, closed back below the high (rejection)
    if (sb.high >= upper && (!this.fadeRSIMax || (rsi != null && rsi >= this.fadeRSIMax)) &&
        (!this.fadeRequireReject || sb.close < sb.high - 0.25 * rng)) {
      const entry = sb.close;
      const target = this.fadeTargetMode === 'band1' ? v.vwap + v.stdDev : v.vwap;
      const stop = this.fadeStopMode === 'atr' ? sb.high + this.fadeStopATR * atr
                 : this.fadeStopMode === 'extreme' ? sb.high + this.tickSize
                 : v.vwap + (this.fadeSigma + this.fadeStopSigma) * v.stdDev;
      if (entry > target && stop > entry) setup = { type: 'sell', entry, stop, target };
    } else if (sb.low <= lower && (!this.fadeRSIMin || (rsi != null && rsi <= this.fadeRSIMin)) &&
        (!this.fadeRequireReject || sb.close > sb.low + 0.25 * rng)) {
      const entry = sb.close;
      const target = this.fadeTargetMode === 'band1' ? v.vwap - v.stdDev : v.vwap;
      const stop = this.fadeStopMode === 'atr' ? sb.low - this.fadeStopATR * atr
                 : this.fadeStopMode === 'extreme' ? sb.low - this.tickSize
                 : v.vwap - (this.fadeSigma + this.fadeStopSigma) * v.stdDev;
      if (entry < target && stop < entry) setup = { type: 'buy', entry, stop, target };
    }
    if (!setup) return;
    const stopDist = Math.abs(setup.entry - setup.stop), targetDist = Math.abs(setup.entry - setup.target);
    if (stopDist <= 0 || targetDist <= 0) return;
    if (this.fadeMaxStopPts && stopDist > this.fadeMaxStopPts) return;
    const tfMin = tf === '3m' ? 3 : tf === '2m' ? 2 : 5;
    this.signalFired = true; this._tradeCountToday++;
    this.emit('signal', {
      type: setup.type, price: setup.entry, orderType: this.entryOrderType, limitBufferTicks: this.entryLimitBufferTicks,
      stopLoss: setup.stop, targetPrice: setup.target, stopDistance: stopDist, targetDistance: targetDist,
      timestamp: new Date(sb.timestamp), strategy: 'FADE', tradeNumToday: this._tradeCountToday,
      prevTradeResult: this._prevTradeResult, partialProfitEnabled: false, moveStopToBE: false,
      maxHoldSec: this.fadeMaxHoldBars * tfMin * 60,
      confluenceScore: 0, vwapState: this.vwapEngine.getState(), tickTriggered: false,
      features: { strat: 'FADE', side: setup.type === 'buy' ? 'B' : 'S', sigma: this.fadeSigma, rsi: rsi, todMin: pstMin },
      filterResults: [{ name: 'VWAP-band fade', passed: true, reason: `${setup.type} @${setup.entry.toFixed(2)} → VWAP ${setup.target.toFixed(2)} (R≈${(targetDist / stopDist).toFixed(1)})` }],
    });
  }

  /**
   * PDH/PDL break-CONTINUATION (research: index futures continue ~67% after breaking the
   * prior-day high/low). Buy a break above PDH (when bias is bullish, close>PDC); sell a
   * break below PDL. Stop-entry on the break, stop back inside the level, R-target. One/day/side.
   * @private
   */
  _checkLevelBreak() {
    // Level set = injected HTF swing levels (1h/4h/daily/weekly) + intraday prior-day H/L.
    const levels = (this.injectedLevels && this.injectedLevels.length) ? this.injectedLevels.slice() : [];
    if (this._pdh != null) levels.push(this._pdh);
    if (this._pdl != null) levels.push(this._pdl);
    if (this.lbIncludePdc && this._pdc != null) levels.push(this._pdc);
    if (this.lbIncludeWeekly) {  // prior-week H/L as additional break levels (gated, default off)
      if (this._pwh != null) levels.push(this._pwh);
      if (this._pwl != null) levels.push(this._pwl);
    }
    if (!levels.length) return;
    const bars = this.fiveMinBars; const n = bars.length - 1; if (n < 1) return;
    const sb = bars[n], prevClose = bars[n - 1].close;
    if (!this._timeOK(this._getPSTMinutes(sb.timestamp), this.pbMaxTime)) return;
    const atr = calcATR(bars, 14) || 0; if (atr <= 0) return;
    const stopPts = this.lbStopATR * atr;
    if (!this._brokenLevels) this._brokenLevels = new Set();
    if (this.lbMaxPerDay && (this._lbCountToday || 0) >= this.lbMaxPerDay) return;
    // nearest level the bar CLOSED through (confirmed break), not yet traded today
    let up = null, dn = null;
    for (const lv of levels) {
      if (this._brokenLevels.has(lv)) continue;
      if (prevClose < lv && sb.high > lv) { if (up == null || lv > up) up = lv; }   // fresh upside break (wick/break entry)
      if (prevClose > lv && sb.low < lv) { if (dn == null || lv < dn) dn = lv; }
    }
    let setup = null;
    if (up != null && (!this.lbRequireBias || (this._pdc != null && sb.close > this._pdc))) {
      const lo = up - stopPts;
      setup = { type: 'buy', pb: { high: up, low: lo, open: lo, close: up, timestamp: sb.timestamp }, stopLoss: lo, isBullish: true, strategy: 'LVLB',
                impulse: { high: up, low: lo }, impRange: stopPts, impBody: stopPts, confluence: null, targetR: this.lbTargetR, skipSig: true, maxStop: Math.max(12, stopPts + 2) };
      this._brokenLevels.add(up);
    } else if (dn != null && (!this.lbRequireBias || (this._pdc != null && sb.close < this._pdc))) {
      const hi = dn + stopPts;
      setup = { type: 'sell', pb: { high: hi, low: dn, open: hi, close: dn, timestamp: sb.timestamp }, stopLoss: hi, isBullish: false, strategy: 'LVLB',
                impulse: { high: hi, low: dn }, impRange: stopPts, impBody: stopPts, confluence: null, targetR: this.lbTargetR, skipSig: true, maxStop: Math.max(12, stopPts + 2) };
      this._brokenLevels.add(dn);
    }
    if (!setup) return;
    const brokeLv = setup.type === 'buy' ? up : dn;
    const lvName = brokeLv === this._pdh ? 'PDH' : brokeLv === this._pdl ? 'PDL' : brokeLv === this._pdc ? 'PDC' : 'HTF-level';
    console.log(`${this.logTag}[LVLB] 🎯 ${setup.type.toUpperCase()} break of ${lvName} ${brokeLv.toFixed(2)} (bar hi/lo ${sb.high.toFixed(2)}/${sb.low.toFixed(2)}, close ${sb.close.toFixed(2)} vs PDC ${this._pdc}) — stopATR ${stopPts.toFixed(2)}pt`);
    this._lbCountToday = (this._lbCountToday || 0) + 1;
    this._armStopEntry(setup, setup.type === 'buy' ? up : dn, new Date(sb.timestamp));
  }

  /** Active key levels (prior-day H/L/C, prior-week H/L, session open). @private */
  _keyLevels() {
    const L = [];
    if (this._pdh != null) L.push(this._pdh);
    if (this._pdl != null) L.push(this._pdl);
    if (this._pdc != null) L.push(this._pdc);
    if (this._pwh != null) L.push(this._pwh);
    if (this._pwl != null) L.push(this._pwl);
    if (this._sessionOpenPx != null) L.push(this._sessionOpenPx);
    if (this.injectedLevels && this.injectedLevels.length) for (const lv of this.injectedLevels) L.push(lv);
    return L;
  }

  /** True if price is within tolPts of any key level (incl. round numbers). @private */
  _nearLevel(price, tolPts) {
    for (const lv of this._keyLevels()) if (Math.abs(price - lv) <= tolPts) return true;
    if (this.levelRoundStep > 0) {
      const r = Math.round(price / this.levelRoundStep) * this.levelRoundStep;
      if (Math.abs(price - r) <= tolPts) return true;
    }
    return false;
  }

  /** Entry-time gate: respects multi-window schedule if set, else the per-setup maxTime. @private */
  _timeOK(pstMins, maxTime) {
    if (this.entryWindows) return this.entryWindows.some(w => pstMins >= w[0] && pstMins < w[1]);
    return pstMins <= maxTime;
  }

  _armStopEntry(setup, entryPrice, timestamp) {
    const sb = setup.pb;
    if (!sb) return;
    if (setup.skipSig) {
      // ORB and other range-break setups: the "signal bar" is a synthetic range, so the
      // body/tail/close-loc signal-bar filters don't apply — skip straight to arming.
      const isB = setup.type === 'buy';
      const off0 = this.stopEntryOffsetTicks * this.tickSize;
      const tfMin0 = 5;
      const mx = setup.maxStop || (setup.strategy === 'ORB' ? (this.orbStopCap || this.maxStopPoints) : this.maxStopPoints);
      this._armedStop = {
        setup, isBull: isB, trigger: isB ? sb.high + off0 : sb.low - off0, protectiveStop: setup.stopLoss,
        armedAt: (timestamp instanceof Date) ? timestamp.getTime() : Date.parse(timestamp),
        maxAgeMs: this.stopEntryCancelBars * tfMin0 * 60000,
        bounds: { minStop: this.minStopPoints, maxStop: mx, minTgt: this.minTargetPoints },
      };
      console.log(`${this.logTag}[${setup.strategy} STOP-ARM] 🎯 ${isB ? 'BUY' : 'SELL'}-stop @ ${(isB ? sb.high + off0 : sb.low - off0).toFixed(2)} | stop ${setup.stopLoss.toFixed(2)}`);
      return;
    }
    const _rej = (reason) => console.log(`${this.logTag}[${setup.strategy} ARM-REJECT] ✋ ${setup.type.toUpperCase()} @ ${(+entryPrice).toFixed(2)} — ${reason}`);
    if (this.skipDows.length) {
      const d = (timestamp instanceof Date) ? timestamp : new Date(timestamp || sb.timestamp);
      if (this.skipDows.includes(d.getUTCDay())) { _rej(`skipDows weekday ${d.getUTCDay()}`); return; } // skip excluded weekday (UTC≈ET trading day)
    }
    if (this.gapSkipHi > this.gapSkipLo && this._todayGapATR != null &&
        this._todayGapATR >= this.gapSkipLo && this._todayGapATR <= this.gapSkipHi) {
      _rej(`gap regime ${this._todayGapATR.toFixed(2)} in skip band [${this.gapSkipLo},${this.gapSkipHi}]`); return; // skip net-negative gap regime
    }
    const isBull0 = setup.type === 'buy';
    if (this.levelBiasFilter && this._pdc != null) {
      if (isBull0 && entryPrice < this._pdc) { _rej(`levelBias: long below PDC ${this._pdc}`); return; }   // long only above prior-day close (bullish bias)
      if (!isBull0 && entryPrice > this._pdc) { _rej(`levelBias: short above PDC ${this._pdc}`); return; }  // short only below prior-day close
    }
    if (this.levelConfluence) {
      const atr5 = calcATR(this.fiveMinBars, 14) || this._lastATR || 0;
      if (atr5 > 0 && !this._nearLevel(entryPrice, this.levelTolATR * atr5)) { _rej(`levelConfluence: not within ${(this.levelTolATR*atr5).toFixed(2)}pt of a key level`); return; } // not near a key level
    }
    const isBull = setup.type === 'buy';
    // ── Brooks signal-bar quality gates ──
    const sbRange = sb.high - sb.low;
    if (this.sigBarMaxRangePts && sbRange > this.sigBarMaxRangePts) { _rej(`sigBar range ${sbRange.toFixed(2)} > max ${this.sigBarMaxRangePts}pt`); return; } // too big / too much risk
    if (sbRange > 0) {
      if (this.sigBarMinCloseLoc) {
        const closeLoc = isBull ? (sb.close - sb.low) / sbRange : (sb.high - sb.close) / sbRange;
        if (closeLoc < this.sigBarMinCloseLoc) { _rej(`sigBar closeLoc ${closeLoc.toFixed(2)} < min ${this.sigBarMinCloseLoc}`); return; } // weak signal bar (close not toward trade dir)
      }
      if (this.sigBarMaxBodyPct) {
        const bodyPct = Math.abs(sb.close - sb.open) / sbRange;
        if (bodyPct > this.sigBarMaxBodyPct) { _rej(`sigBar body ${bodyPct.toFixed(2)} > max ${this.sigBarMaxBodyPct}`); return; }   // big-body signal bar (robustly negative)
      }
      if (this.sigBarMinTailPct) {  // rejection tail in the trade direction
        const tail = isBull ? (Math.min(sb.open, sb.close) - sb.low) / sbRange   // lower wick for longs
                            : (sb.high - Math.max(sb.open, sb.close)) / sbRange;  // upper wick for shorts
        if (tail < this.sigBarMinTailPct) { _rej(`sigBar tail ${tail.toFixed(2)} < min ${this.sigBarMinTailPct}`); return; }
      }
    }
    // Higher-timeframe trend alignment: skip trades fighting the slower 5m EMA.
    if (this.htfAlignEnabled && this.fiveMinBars && this.fiveMinBars.length >= this.htfAlignPeriod) {
      const htfEma = calcEMA(this.fiveMinBars.map(b => b.close), this.htfAlignPeriod);
      if (htfEma != null) {
        if (isBull && sb.close < htfEma) { _rej(`htfAlign: long below 5m EMA${this.htfAlignPeriod} ${htfEma.toFixed(2)}`); return; }   // long below slow EMA = counter-trend
        if (!isBull && sb.close > htfEma) { _rej(`htfAlign: short above 5m EMA${this.htfAlignPeriod} ${htfEma.toFixed(2)}`); return; }  // short above slow EMA = counter-trend
      }
    }
    console.log(`${this.logTag}[${setup.strategy} ARM-OK] ✅ passed all gates → arming ${setup.type.toUpperCase()} stop-entry`);
    const off = this.stopEntryOffsetTicks * this.tickSize;
    const trigger = isBull ? sb.high + off : sb.low - off;
    const tfMin = setup.strategy === 'PB2m' ? 2 : setup.strategy === 'PB3m' ? 3 : 5;
    const bounds = setup.strategy === 'PB2m'
      ? { minStop: this.pb2mMinStopPoints, maxStop: this.pb2mMaxStopPoints, minTgt: this.pb2mMinTargetPoints }
      : setup.strategy === 'PB3m'
        ? { minStop: this.pb3mMinStopPoints, maxStop: this.pb3mMaxStopPoints, minTgt: this.pb3mMinTargetPoints }
        : { minStop: this.minStopPoints, maxStop: this.maxStopPoints, minTgt: this.minTargetPoints };
    // Per-setup stop-cap overrides: EPB (and DR) can legitimately carry wider stops than
    // the tight impulse-PB cap (their pullback-to-EMA / double-bottom stops are deeper).
    if (setup.strategy === 'EPB') {
      if (this.emaPbMaxStopPoints) bounds.maxStop = this.emaPbMaxStopPoints;
      if (this.emaPbMinStopPoints) bounds.minStop = this.emaPbMinStopPoints;
    }
    const armedAt = (timestamp instanceof Date) ? timestamp.getTime() : Date.parse(timestamp);
    this._armedStop = {
      setup, isBull, trigger, protectiveStop: setup.stopLoss,
      armedAt, maxAgeMs: this.stopEntryCancelBars * tfMin * 60000, bounds,
    };
    console.log(`${this.logTag}[${setup.strategy} STOP-ARM] 🎯 ${isBull ? 'BUY' : 'SELL'}-stop @ ${trigger.toFixed(2)} (break of signal-bar ${isBull ? 'high' : 'low'}) | protective stop ${setup.stopLoss.toFixed(2)} | cancel in ${this.stopEntryCancelBars}×${tfMin}m`);
  }

  /**
   * Evaluate an armed stop-entry against the current 1s bar. A native stop-MARKET
   * fills the instant price TOUCHES the trigger (the bar high/low), so we use the
   * 1s high/low (falling back to price when not provided) — exact parity with a
   * live resting stop order, never a "miss". Cancels on window expiry; invalidates
   * if the opposite extreme is touched first.
   * @private
   */
  _stopCheckArmed(tick) {
    const a = this._armedStop;
    if (!a) return;
    const price = tick.price;
    const hi = (tick.high != null) ? tick.high : price;
    const lo = (tick.low != null) ? tick.low : price;
    const op = (tick.open != null) ? tick.open : price;
    const nowMs = (tick.timestamp instanceof Date) ? tick.timestamp.getTime() : Date.parse(tick.timestamp);
    if (nowMs - a.armedAt > a.maxAgeMs) {
      console.log(`${this.logTag}[${a.setup.strategy} STOP-ARM] ⏰ CANCEL — break not triggered within window`);
      this._armedStop = null; return;
    }
    if (this.hardEntryCutoff || this.entryWindows) {
      const td = new Date(nowMs);
      const pst = this._getPSTMinutes(td);
      const blocked = this.entryWindows ? !this.entryWindows.some(w => pst >= w[0] && pst < w[1])
                                        : (pst >= this.hardEntryCutoff);
      if (blocked) { this._armedStop = null; return; } // no fills outside allowed window(s)
    }
    const triggered = a.isBull ? hi >= a.trigger : lo <= a.trigger;
    const invalidated = a.isBull ? lo <= a.protectiveStop : hi >= a.protectiveStop;
    // Both touched in one 1s bar → decide by which level the bar opened closer to
    if (triggered && invalidated) {
      const triggerFirst = Math.abs(op - a.trigger) <= Math.abs(op - a.protectiveStop);
      if (!triggerFirst) {
        console.log(`${this.logTag}[${a.setup.strategy} STOP-ARM] ❌ INVALIDATED — opposite extreme hit first (same bar)`);
        this._armedStop = null; return;
      }
    } else if (invalidated) {
      console.log(`${this.logTag}[${a.setup.strategy} STOP-ARM] ❌ INVALIDATED — opposite extreme hit before break`);
      this._armedStop = null; return;
    }
    if (!triggered) return;
    // Stop-market fill: at the trigger, or at the bar open if it gapped through.
    const entry = a.isBull ? (op > a.trigger ? op : a.trigger) : (op < a.trigger ? op : a.trigger);
    const stopDist = Math.abs(entry - a.protectiveStop);
    if (stopDist < a.bounds.minStop || stopDist > a.bounds.maxStop) {
      console.log(`${this.logTag}[${a.setup.strategy} STOP-ARM] ❌ stop ${stopDist.toFixed(1)}pt outside ${a.bounds.minStop}-${a.bounds.maxStop} on break — skip`);
      this._armedStop = null; return;
    }
    const tgtR = (a.setup.targetR && a.setup.targetR > 0) ? a.setup.targetR : this.profitTargetR;
    if (stopDist * tgtR < a.bounds.minTgt) {
      console.log(`${this.logTag}[${a.setup.strategy} STOP-ARM] ❌ target ${(stopDist*tgtR).toFixed(2)}pt (${stopDist.toFixed(1)}×${tgtR}R) < min ${a.bounds.minTgt}pt on break — skip`);
      this._armedStop = null; return;
    }
    // FIRE — emit directly at the break (entry = trigger, Brooks geometry)
    const s = a.setup;
    const targetDist = stopDist * tgtR;
    const targetPrice = a.isBull ? entry + targetDist : entry - targetDist;
    this.signalFired = true;
    this._tradeCountToday++;
    this._pbWatch = null;
    this._armedStop = null;
    this._disarmAll();
    console.log(`${this.logTag}[${s.strategy} STOP-ENTRY] 🚀 TRIGGERED ${a.isBull ? 'BUY' : 'SELL'} @ ${entry.toFixed(2)} | stop ${a.protectiveStop.toFixed(2)} (${stopDist.toFixed(1)}pt) | target ${targetPrice.toFixed(2)}`);
    this.emit('signal', {
      type: s.type, price: entry, orderType: this.entryOrderType, limitBufferTicks: this.entryLimitBufferTicks,
      stopLoss: a.protectiveStop, targetPrice, targetDistance: targetDist, stopDistance: stopDist,
      timestamp: new Date(nowMs), strategy: s.strategy, tradeNumToday: this._tradeCountToday,
      prevTradeResult: this._prevTradeResult, partialProfitEnabled: this.partialProfitEnabled,
      partialProfitR: this.partialProfitR, moveStopToBE: this.moveStopToBE,
      confluenceScore: s.confluence ? s.confluence.score : 0, vwapState: this.vwapEngine.getState(),
      tickTriggered: false, stopTriggered: true, gapATR: this._todayGapATR,
      features: this._featurePayload(s, entry, a.isBull),
      filterResults: [{ name: 'Brooks stop-entry', passed: true, reason: `break of ${s.strategy} signal-bar ${a.isBull ? 'high' : 'low'} @ ${entry.toFixed(2)}` }],
    });
  }

  /**
   * Objective feature vector for a setup (for the signal-quality / regime study).
   * All computable at fire time from the signal (pullback) bar, impulse, confluence,
   * ATR/VWAP context, and time-of-day. Used to learn which features predict expectancy.
   * @private
   */
  _featurePayload(setup, entry, isBull) {
    const pb = setup.pb, imp = setup.impulse;
    const r = (pb.high - pb.low) || 0.0001;
    const body = Math.abs(pb.close - pb.open);
    const impR = setup.impRange || 0.0001;
    const atr = this._lastATR || 0;
    let vwap = null;
    try { const st = this.vwapEngine && this.vwapEngine.getState && this.vwapEngine.getState(); if (st && st.vwap != null) vwap = st.vwap; } catch (e) {}
    const t = new Date(pb.timestamp);
    const pstMin = this._getPSTMinutes(t); // PDT minute-of-day
    return {
      strat: setup.strategy,
      side: isBull ? 'B' : 'S',
      sbBodyPct: body / r,
      sbUpWickPct: (pb.high - Math.max(pb.open, pb.close)) / r,
      sbLoWickPct: (Math.min(pb.open, pb.close) - pb.low) / r,
      sbCloseLoc: isBull ? (pb.close - pb.low) / r : (pb.high - pb.close) / r,
      sbRange: r,
      sbRangeATR: atr ? r / atr : 0,
      impRange: impR,
      impBodyPct: (setup.impBody || 0) / impR,
      pullbackDepth: isBull ? (imp.high - pb.low) / impR : (pb.high - imp.low) / impR,
      confluence: setup.confluence ? setup.confluence.score : 0,
      vwapDist: vwap != null ? (entry - vwap) : null,
      atr,
      todMin: pstMin,
    };
  }

  /**
   * Fire the actual PB signal (used by both immediate and confirmed entries)
   * @private
   */
  _firePBSignal(setup, entryPrice, timestamp) {
    // ── Brooks STOP-ENTRY: don't enter at the signal-bar close; arm a stop entry
    //    on the break of the signal (pullback) bar's extreme. Fires only on the
    //    confirmed break (see _stopCheckArmed); else cancels. ──
    if (this.stopEntryEnabled && !setup._stopTriggered) {
      this._armStopEntry(setup, entryPrice, timestamp);
      return;
    }
    const { type: signal, stopLoss, stopDistance: stopDist, confluence, impulse, pb, isBullish, impRange, impBody } = setup;
    const targetDist = stopDist * this.profitTargetR;
    const targetPrice = signal === 'buy' ? entryPrice + targetDist : entryPrice - targetDist;

    this.signalFired = true;
    this._tradeCountToday++;
    this._pbWatch = null;

    console.log(`${this.logTag}[PB] 🚀 BAR-CLOSE SIGNAL FIRED: ${signal.toUpperCase()} @ ${entryPrice} | stop=${stopLoss} (${stopDist.toFixed(1)}pt) | target=${targetPrice.toFixed(2)} (${this.profitTargetR}R)`);

    this.emit('signal', {
      type: signal,
      price: entryPrice,
      orderType: this.entryOrderType,
      limitBufferTicks: this.entryLimitBufferTicks,
      stopLoss,
      targetPrice,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp,
      strategy: 'PB',
      tradeNumToday: this._tradeCountToday,
      prevTradeResult: setup.prevTradeResult,
      partialProfitEnabled: setup.partialProfitEnabled,
      partialProfitR: setup.partialProfitR,
      moveStopToBE: setup.moveStopToBE,
      confluenceScore: confluence.score,
      vwapState: setup.vwapState,
      tickTriggered: false,
      stopTriggered: !!setup._stopTriggered,
      filterResults: [
        { name: 'Impulse', passed: true, reason: `${impRange.toFixed(1)}pt range, ${(impBody / impRange * 100).toFixed(0)}% body` },
        { name: 'Pullback', passed: true, reason: `${((isBullish ? impulse.high - pb.low : pb.high - impulse.low) / impRange * 100).toFixed(0)}% retrace` },
        { name: 'Confluence', passed: true, reason: `${confluence.score}/${confluence.maxScore} factors` },
        ...confluence.factors.map(f => ({ name: f.name, passed: f.passed, reason: f.reason })),
      ],
    });
  }

  /**
   * Check 1m bars for PB confirmation bounce or limit fill zone.
   * Called on every 1m bar while _pbWatch is active.
   * @private
   */
  _checkPBConfirmation(bar) {
    const w = this._pbWatch;
    if (!w) return;

    w.barsWaited++;
    const isLong = w.type === 'buy';

    // Track 1m swing extremes for potential tighter stop
    if (bar.low < w.swingLow) w.swingLow = bar.low;
    if (bar.high > w.swingHigh) w.swingHigh = bar.high;

    // ── Check for invalidation: price moved too far against us ──
    // If price breaks beyond the stop level, the setup is dead
    if (isLong && bar.low <= w.stopLoss) {
      console.log(`${this.logTag}[PB WATCH] ❌ INVALIDATED: price ${bar.low} broke below stop ${w.stopLoss}`);
      this._pbWatch = null;
      return;
    }
    if (!isLong && bar.high >= w.stopLoss) {
      console.log(`${this.logTag}[PB WATCH] ❌ INVALIDATED: price ${bar.high} broke above stop ${w.stopLoss}`);
      this._pbWatch = null;
      return;
    }

    // ── Limit modes: check if price dipped to limit zone ──
    if (w.mode === 'limit' || w.mode === 'limit_structural') {
      const hitZone = isLong
        ? bar.low <= w.limitPrice && bar.close > w.limitPrice
        : bar.high >= w.limitPrice && bar.close < w.limitPrice;

      if (hitZone) {
        const entryPrice = w.limitPrice;
        const savedPts = Math.abs(w.signalEntryPrice - entryPrice);
        if (w.mode === 'limit_structural') {
          // Keep original structural stop + original stopDistance for target calc
          // Better entry = more room to target, same stop = same structural level
          console.log(`${this.logTag}[PB WATCH] ✅ LIMIT+STRUCTURAL: ${w.type.toUpperCase()} @ ${entryPrice.toFixed(2)} (saved ${savedPts.toFixed(1)}pt) | stop=${w.stopLoss} (orig) | target uses orig ${w.stopDistance.toFixed(1)}pt R`);
          this._firePBSignal(w, entryPrice, new Date(bar.timestamp));
        } else {
          // Recalculate stop distance from the better entry (tighter stop = smaller target)
          const newStopDist = Math.abs(entryPrice - w.stopLoss);
          console.log(`${this.logTag}[PB WATCH] ✅ LIMIT ZONE HIT: ${w.type.toUpperCase()} @ ${entryPrice.toFixed(2)} (saved ${savedPts.toFixed(1)}pt vs 5m close)`);
          const improvedSetup = { ...w, stopDistance: newStopDist };
          this._firePBSignal(improvedSetup, entryPrice, new Date(bar.timestamp));
        }
        return;
      }
    }

    // ── Confirm1m mode: check for bounce confirmation ──
    if (w.mode === 'confirm1m') {
      const barBody = bar.close - bar.open;
      const barRange = bar.high - bar.low;
      const bodyRatio = barRange > 0 ? Math.abs(barBody) / barRange : 0;

      // Confirmation: 1m bar closes in trade direction with decent body
      const confirmed = isLong
        ? (bar.close > bar.open && bodyRatio >= 0.4 && bar.close > (bar.high + bar.low) / 2)
        : (bar.close < bar.open && bodyRatio >= 0.4 && bar.close < (bar.high + bar.low) / 2);

      if (confirmed) {
        // Use 1m close as entry — typically better than 5m close
        const entryPrice = bar.close;
        // Use 1m swing as tighter stop if better than 5m stop
        let newStop = w.stopLoss;
        if (isLong && w.swingLow > w.stopLoss + 1) {
          // Tighter stop at 1m swing low + buffer (only if meaningfully better)
          newStop = w.swingLow - this.stopBuffer;
          console.log(`${this.logTag}[PB WATCH] Tighter stop: 5m=${w.stopLoss.toFixed(2)} → 1m swing=${newStop.toFixed(2)}`);
        }
        if (!isLong && w.swingHigh < w.stopLoss - 1) {
          newStop = w.swingHigh + this.stopBuffer;
          console.log(`${this.logTag}[PB WATCH] Tighter stop: 5m=${w.stopLoss.toFixed(2)} → 1m swing=${newStop.toFixed(2)}`);
        }

        const newStopDist = Math.abs(entryPrice - newStop);
        // Validate tighter stop still meets min/max constraints
        if (newStopDist < this.minStopPoints || newStopDist > this.maxStopPoints) {
          console.log(`${this.logTag}[PB WATCH] ✅ CONFIRMED but stop ${newStopDist.toFixed(1)}pt outside ${this.minStopPoints}-${this.maxStopPoints}, using original`);
          newStop = w.stopLoss;
        }

        const finalStopDist = Math.abs(entryPrice - newStop);
        console.log(`${this.logTag}[PB WATCH] ✅ 1m CONFIRMED: ${w.type.toUpperCase()} @ ${entryPrice.toFixed(2)} | bar ${w.barsWaited}/${w.maxBars}`);
        const improvedSetup = { ...w, stopLoss: newStop, stopDistance: finalStopDist };
        this._firePBSignal(improvedSetup, entryPrice, new Date(bar.timestamp));
        return;
      }
    }

    // ── Timeout: no confirmation within max bars ──
    if (w.barsWaited >= w.maxBars) {
      console.log(`${this.logTag}[PB WATCH] ⏰ TIMEOUT after ${w.barsWaited} bars — no ${w.mode} confirmation`);
      this._pbWatch = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  STRATEGY 3: VR (VWAP Mean Reversion on 1-min bars)
  //  Fills the 8:30 AM - 12:30 PM "dead time" window
  // ═══════════════════════════════════════════════════════════════

  _checkVR(bar) {
    if (!this.vwapEngine.isReady()) return;
    if (this.bars.length < 30) return; // Need enough bars for volume avg

    const pstMins = this._getPSTMinutes(bar.timestamp);
    if (pstMins < this.vrMinTime || pstMins > this.vrMaxTime) return;

    const price = bar.close;
    const sigmaDistance = this.vwapEngine.getVWAPDistance(price);

    // Log VR state every 10 bars during VR window
    const _vrBarNum = this._getSessionBarNumber(bar.timestamp);
    if (_vrBarNum % 10 === 0) {
      const vwap = this.vwapEngine.vwap;
      const u2 = this.vwapEngine.upperBand2;
      const l2 = this.vwapEngine.lowerBand2;
      console.log(`${this.logTag}[VR] σ=${sigmaDistance?.toFixed(2)} | price=${price} | VWAP=${vwap?.toFixed(1)} | bands=[${l2?.toFixed(1)}..${u2?.toFixed(1)}] | watching=${this._vrWatching || 'none'}`);
    }

    // ── Phase 1: Watch for overextension (price hits ±2σ or beyond) ──
    if (!this._vrWatching) {
      if (sigmaDistance >= this.vrMinSigma) {
        this._vrWatching = 'short'; // Price above 2σ → watch for short reversion
        this._vrWatchPrice = price;
        console.log(`${this.logTag}[VR] 🔍 WATCH SHORT: price=${price} σ=${sigmaDistance.toFixed(2)} >= ${this.vrMinSigma}`);
      } else if (sigmaDistance <= -this.vrMinSigma) {
        this._vrWatching = 'long'; // Price below -2σ → watch for long reversion
        this._vrWatchPrice = price;
        console.log(`${this.logTag}[VR] 🔍 WATCH LONG: price=${price} σ=${sigmaDistance.toFixed(2)} <= -${this.vrMinSigma}`);
      }
      return;
    }

    // ── Phase 2: Wait for reversion confirmation ──
    // Entry: candle opens AND closes between 1σ band and VWAP
    const vwap = this.vwapEngine.vwap;
    const upper1 = this.vwapEngine.upperBand1;
    const lower1 = this.vwapEngine.lowerBand1;
    const upper2 = this.vwapEngine.upperBand2;
    const lower2 = this.vwapEngine.lowerBand2;

    let signal = null;
    let entryPrice = 0;
    let stopLoss = 0;
    let stopDist = 0;
    let targetPrice = 0;
    let targetDist = 0;

    if (this._vrWatching === 'long') {
      // We're watching for a LONG reversion (price was below -2σ, now reverting up)
      // Entry: bar opens below lower1 and closes between lower1 and VWAP
      const barInZone = bar.open <= lower1 && bar.close > lower1 && bar.close < vwap;
      const barBullish = bar.close > bar.open; // Bullish candle

      if (barInZone && barBullish) {
        signal = 'buy';
        entryPrice = bar.close;
        stopLoss = lower2 - this.vrStopBeyondBand;
        stopDist = entryPrice - stopLoss;

        // Target: fixed R-multiple or VWAP line
        if (this.vrTargetMode === 'fixed') {
          targetPrice = entryPrice + stopDist * this.vrTargetR;
        } else if (this.vrTargetMode === 'vwap') {
          targetPrice = vwap;
        } else {
          targetPrice = upper1;
        }
        targetDist = targetPrice - entryPrice;
        console.log(`${this.logTag}[VR] LONG entry zone HIT: O=${bar.open} C=${bar.close} | lower1=${lower1.toFixed(1)} VWAP=${vwap.toFixed(1)} | stop=${stopDist.toFixed(1)}pt`);
      } else {
        if (sigmaDistance > 0) {
          console.log(`${this.logTag}[VR] LONG watch cancelled: price crossed above VWAP (σ=${sigmaDistance.toFixed(2)})`);
          this._vrWatching = null;
          this._vrWatchPrice = null;
          return;
        }
        // Log why entry didn't trigger
        if (this.sessionBarCount % 5 === 0) {
          const reasons = [];
          if (bar.open > lower1) reasons.push(`O=${bar.open} > lower1=${lower1.toFixed(1)}`);
          if (bar.close <= lower1) reasons.push(`C=${bar.close} <= lower1=${lower1.toFixed(1)}`);
          if (bar.close >= vwap) reasons.push(`C=${bar.close} >= VWAP=${vwap.toFixed(1)}`);
          if (bar.close <= bar.open) reasons.push(`bearish bar`);
          if (reasons.length > 0) console.log(`${this.logTag}[VR] LONG waiting: ${reasons.join(', ')} | σ=${sigmaDistance.toFixed(2)}`);
        }
      }
    }

    if (this._vrWatching === 'short') {
      // We're watching for a SHORT reversion (price was above +2σ, now reverting down)
      const barInZone = bar.open >= upper1 && bar.close < upper1 && bar.close > vwap;
      const barBearish = bar.close < bar.open;

      if (barInZone && barBearish) {
        signal = 'sell';
        entryPrice = bar.close;
        stopLoss = upper2 + this.vrStopBeyondBand;
        stopDist = stopLoss - entryPrice;

        if (this.vrTargetMode === 'fixed') {
          targetPrice = entryPrice - stopDist * this.vrTargetR;
        } else if (this.vrTargetMode === 'vwap') {
          targetPrice = vwap;
        } else {
          targetPrice = lower1;
        }
        targetDist = entryPrice - targetPrice;
        console.log(`${this.logTag}[VR] SHORT entry zone HIT: O=${bar.open} C=${bar.close} | upper1=${upper1.toFixed(1)} VWAP=${vwap.toFixed(1)} | stop=${stopDist.toFixed(1)}pt`);
      } else {
        if (sigmaDistance < 0) {
          console.log(`${this.logTag}[VR] SHORT watch cancelled: price crossed below VWAP (σ=${sigmaDistance.toFixed(2)})`);
          this._vrWatching = null;
          this._vrWatchPrice = null;
          return;
        }
        if (this.sessionBarCount % 5 === 0) {
          const reasons = [];
          if (bar.open < upper1) reasons.push(`O=${bar.open} < upper1=${upper1.toFixed(1)}`);
          if (bar.close >= upper1) reasons.push(`C=${bar.close} >= upper1=${upper1.toFixed(1)}`);
          if (bar.close <= vwap) reasons.push(`C=${bar.close} <= VWAP=${vwap.toFixed(1)}`);
          if (bar.close >= bar.open) reasons.push(`bullish bar`);
          if (reasons.length > 0) console.log(`${this.logTag}[VR] SHORT waiting: ${reasons.join(', ')} | σ=${sigmaDistance.toFixed(2)}`);
        }
      }
    }

    if (!signal) return;

    // Validate stop/target distances
    if (stopDist > this.vrMaxStopPoints || stopDist < this.vrMinStopPoints) {
      console.log(`${this.logTag}[VR] SKIP: stop ${stopDist.toFixed(1)}pt outside ${this.vrMinStopPoints}-${this.vrMaxStopPoints}`);
      this._vrWatching = null;
      return;
    }
    if (targetDist < 5) { // Minimum 5pt target for VR
      console.log(`${this.logTag}[VR] SKIP: target ${targetDist.toFixed(1)}pt < 5pt min`);
      this._vrWatching = null;
      return;
    }

    // ── Volume check on entry bar ──
    const avgVol = this.bars.slice(-20).reduce((s, b) => s + (b.volume || 0), 0) / 20;
    const barVol = bar.volume || 0;
    if (avgVol > 0 && barVol / avgVol < this.vrMinBarVolRatio) {
      console.log(`${this.logTag}[VR] SKIP: low volume ${barVol} / avg ${avgVol.toFixed(0)} = ${(barVol/avgVol).toFixed(2)} < ${this.vrMinBarVolRatio}`);
      return; // Low volume — don't enter, keep watching
    }

    // ── Confluence Check (inverted for mean reversion) ──
    const oneMinCloses = this.bars.map(b => b.close);
    const emaFast1m = calcEMA(oneMinCloses, 9);
    const emaSlow1m = calcEMA(oneMinCloses, 21);

    const confluence = this.confluenceScorer.score({
      direction: signal,
      price: entryPrice,
      vwapEngine: this.vwapEngine,
      emaFast: emaFast1m,
      emaSlow: emaSlow1m,
      rsi: this._lastRSI,
      recentBars: this.bars,
      strategyType: 'VR',
    });

    if (confluence.score < this.vrMinConfluence) {
      if (!this.quietPriceLogs) {
        const failedFactors = confluence.factors.filter(f => !f.passed);
        const failedNames = failedFactors.map(f => f.name).join(', ');
        console.log(`${this.logTag}[VR] Signal rejected: confluence ${confluence.score}/${confluence.maxScore} < ${this.vrMinConfluence}`);
        console.log(`${this.logTag}[VR] FAILED: ${failedNames}`);
        failedFactors.forEach(f => {
          console.log(`${this.logTag}[VR]   - ${f.name}: ${f.reason}`);
        });
      }
      return; // Keep watching, don't reset
    }

    // ── Volume Filter ──
    const volCheck = this._checkVolumeFilter(bar);
    if (!volCheck.passed) return;

    // ── Emit Signal ──
    this.signalFired = true;
    this._vrWatching = null;
    this._vrWatchPrice = null;
    this._vrCooldownCount = this.vrCooldownBars;
    this._vrTradeCount++;
    this._tradeCountToday++;

    const rMultiple = targetDist / stopDist;

    this.emit('signal', {
      type: signal,
      price: entryPrice,
      orderType: this.entryOrderType,
      limitBufferTicks: this.entryLimitBufferTicks,
      stopLoss,
      targetPrice,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp: new Date(bar.timestamp),
      strategy: 'VR',
      tradeNumToday: this._tradeCountToday,
      prevTradeResult: this._prevTradeResult,
      partialProfitEnabled: false, // VR targets VWAP directly, no partial
      moveStopToBE: false,
      confluenceScore: confluence.score,
      vwapState: this.vwapEngine.getState(),
      filterResults: [
        { name: 'VWAP Reversion', passed: true, reason: `${sigmaDistance.toFixed(2)}σ → reverting to VWAP` },
        { name: 'Entry Zone', passed: true, reason: `Between 1σ and VWAP` },
        { name: 'Volume', passed: true, reason: `${(barVol / avgVol).toFixed(2)}x avg` },
        { name: 'Confluence', passed: true, reason: `${confluence.score}/${confluence.maxScore} factors` },
        ...confluence.factors.map(f => ({ name: f.name, passed: f.passed, reason: f.reason })),
        { name: 'Stop', passed: true, reason: `${stopDist.toFixed(1)}pt ($${(stopDist * 2).toFixed(0)})` },
        { name: 'Target', passed: true, reason: `${targetDist.toFixed(1)}pt (${rMultiple.toFixed(1)}R) → ${this.vrTargetMode === 'vwap' ? 'VWAP' : '1σ band'}` },
      ],
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  TICK-TRIGGERED ENTRY (Intra-Bar Evaluation)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Arm a setup for tick-triggered entry. Called when a qualifying impulse bar is detected.
   * Stores all pre-computed data so tick evaluation is lightweight.
   * @param {string} strategy - 'PB', 'PB3m', or 'PB2m'
   * @param {Object} impulse - The confirmed impulse bar
   * @param {Object} preComputed - Pre-computed filters: { confluence, trendOk, volumeOk, isBullish, isBearish, impRange, impBody, pstMins }
   */
  _armTickEntry(strategy, impulse, preComputed) {
    const { isBullish, isBearish, impRange, impBody, confluence } = preComputed;

    // Determine stop and retrace params based on strategy
    let retraceMin, retraceMax, minStop, maxStop, minTarget;
    if (strategy === 'PB2m') {
      retraceMin = this.pb2mRetraceMin; retraceMax = this.pb2mRetraceMax;
      minStop = this.pb2mMinStopPoints; maxStop = this.pb2mMaxStopPoints;
      minTarget = this.pb2mMinTargetPoints;
    } else if (strategy === 'PB3m') {
      retraceMin = this.pb3mRetraceMin; retraceMax = this.pb3mRetraceMax;
      minStop = this.pb3mMinStopPoints; maxStop = this.pb3mMaxStopPoints;
      minTarget = this.pb3mMinTargetPoints;
    } else {
      retraceMin = this.pbRetraceMin; retraceMax = this.pbRetraceMax;
      minStop = this.minStopPoints; maxStop = this.maxStopPoints;
      minTarget = this.minTargetPoints;
    }

    const armed = {
      strategy,
      impulse,
      isBullish,
      isBearish,
      impRange,
      impBody,
      confluence,
      retraceMin,
      retraceMax,
      minStop,
      maxStop,
      minTarget,
      armedAt: Date.now(),
      ticksSeen: 0,
      // Time-based expiry: 2x the bar timeframe in seconds
      maxAgeMs: strategy === 'PB2m' ? 120000 : strategy === 'PB3m' ? 180000 : 300000,
      // Zone-exit bounce + consecutive tick state
      enteredZone: false,       // Has price entered the retrace zone?
      exitedZone: false,        // Has price exited zone toward trade direction?
      consecTicks: 0,           // Consecutive ticks in trade direction after zone exit
    };

    if (strategy === 'PB2m') this._armedPB2m = armed;
    else if (strategy === 'PB3m') this._armedPB3m = armed;
    else this._armedPB = armed;

    console.log(`${this.logTag}[${strategy} TICK-ARM] 🔫 ARMED ${isBullish ? 'LONG' : 'SHORT'} | impulse: O=${impulse.open} H=${impulse.high} L=${impulse.low} C=${impulse.close} (${impRange.toFixed(1)}pt, ${(impBody/impRange*100).toFixed(0)}% body) | retrace zone: ${(retraceMin*100).toFixed(0)}-${(retraceMax*100).toFixed(0)}% | stop bounds: ${minStop}-${maxStop}pt`);
  }

  /**
   * Evaluate a tick against an armed setup. If conditions met, fire signal immediately.
   * @param {Object} armed - Armed setup object from _armTickEntry
   * @param {number} price - Current tick price
   * @param {string} label - Strategy label for logging
   */
  _tickCheckArmed(armed, price, label) {
    armed.ticksSeen++;
    const { impulse, isBullish, isBearish, impRange } = armed;

    // Log every 50th tick for monitoring (avoid log spam)
    if (armed.ticksSeen % 50 === 0) {
      console.log(`${this.logTag}[${label} TICK] #${armed.ticksSeen} price=${price} | impulse H=${impulse.high} L=${impulse.low} | armed ${((Date.now() - armed.armedAt)/1000).toFixed(1)}s ago`);
    }

    // ── Time-based expiry ──
    const ageMs = Date.now() - armed.armedAt;
    if (ageMs > armed.maxAgeMs) {
      console.log(`${this.logTag}[${label} TICK-ARM] ⏰ EXPIRED after ${(ageMs/1000).toFixed(0)}s (max ${armed.maxAgeMs/1000}s) — disarming`);
      this._disarmSetup(label);
      return;
    }

    // ── Invalidation: price broke the impulse extreme (setup dead) ──
    if (isBullish && price < impulse.low - this.stopBuffer) {
      console.log(`${this.logTag}[${label} TICK-ARM] ❌ INVALIDATED: price ${price} broke below impulse low ${impulse.low}`);
      this._disarmSetup(label);
      return;
    }
    if (isBearish && price > impulse.high + this.stopBuffer) {
      console.log(`${this.logTag}[${label} TICK-ARM] ❌ INVALIDATED: price ${price} broke above impulse high ${impulse.high}`);
      this._disarmSetup(label);
      return;
    }

    // ── Extension invalidation: price ran too far beyond impulse (no pullback coming) ──
    if (isBullish && price > impulse.high + impRange * 2) {
      console.log(`${this.logTag}[${label} TICK-ARM] ❌ EXTENDED: price ${price} ran ${(price - impulse.high).toFixed(1)}pt above impulse high ${impulse.high} (>2x range) — disarming`);
      this._disarmSetup(label);
      return;
    }
    if (isBearish && price < impulse.low - impRange * 2) {
      console.log(`${this.logTag}[${label} TICK-ARM] ❌ EXTENDED: price ${price} ran ${(impulse.low - price).toFixed(1)}pt below impulse low ${impulse.low} (>2x range) — disarming`);
      this._disarmSetup(label);
      return;
    }

    // ── Check retrace zone ──
    let retracePct;
    if (isBullish) {
      // Bullish impulse: price should pull back from impulse.high
      retracePct = (impulse.high - price) / impRange;
    } else {
      // Bearish impulse: price should pull back (bounce) from impulse.low
      retracePct = (price - impulse.low) / impRange;
    }

    const inZone = retracePct >= armed.retraceMin && retracePct <= armed.retraceMax;

    // ── Phase 1: Track zone entry ──
    if (!armed.enteredZone) {
      if (inZone) {
        armed.enteredZone = true;
        if (armed.ticksSeen % 50 === 0) {
          console.log(`${this.logTag}[${label} TICK] Entered retrace zone at ${(retracePct*100).toFixed(1)}% (price=${price})`);
        }
      }
      return; // Must enter zone before anything else
    }

    // ── Phase 2: Track zone exit (bounce toward trade direction) ──
    if (!armed.exitedZone) {
      // Zone exit = price moved past the zone boundary toward impulse direction by margin
      // For bullish: retracePct drops below retraceMin - zoneExitMargin (price recovering upward)
      // For bearish: retracePct drops below retraceMin - zoneExitMargin (price recovering downward)
      const exitThreshold = armed.retraceMin - this.zoneExitMargin;
      if (retracePct <= exitThreshold) {
        armed.exitedZone = true;
        armed.consecTicks = 0; // Reset consecutive tick counter
        console.log(`${this.logTag}[${label} TICK] Zone EXIT confirmed at retrace=${(retracePct*100).toFixed(1)}% (threshold=${(exitThreshold*100).toFixed(1)}%) price=${price} — waiting for ${this.consecTicksRequired} consecutive ticks`);
      }
      return; // Must exit zone before counting ticks
    }

    // ── Phase 3: Count consecutive directional ticks after zone exit ──
    if (this._prevTickPrice === null) return; // Need at least 2 ticks
    const tickDirection = price - this._prevTickPrice;

    if (isBullish && tickDirection > 0) {
      armed.consecTicks++;
    } else if (isBearish && tickDirection < 0) {
      armed.consecTicks++;
    } else if (tickDirection !== 0) {
      // Tick went against trade direction — reset counter
      armed.consecTicks = 0;
      return;
    } else {
      return; // No price change, skip
    }

    if (armed.consecTicks < this.consecTicksRequired) {
      return; // Not enough consecutive ticks yet
    }

    // ── Calculate stop using impulse bar extreme ──
    let stopLoss, stopDist;
    if (isBullish) {
      stopLoss = impulse.low - this.stopBuffer;
      stopDist = price - stopLoss;
    } else {
      stopLoss = impulse.high + this.stopBuffer;
      stopDist = stopLoss - price;
    }

    // ── Validate stop distance ──
    if (stopDist < armed.minStop || stopDist > armed.maxStop) {
      // Log once every 20 ticks in zone to avoid spam
      if (armed.ticksSeen % 20 === 0) {
        console.log(`${this.logTag}[${label} TICK] In zone but stop ${stopDist.toFixed(1)}pt outside ${armed.minStop}-${armed.maxStop}pt`);
      }
      return;
    }

    // ── Validate minimum target ──
    const targetDist = stopDist * this.profitTargetR;
    if (targetDist < armed.minTarget) {
      return;
    }

    // ── Check bar direction confirmation (forming bar should be in trade direction) ──
    // For bullish: current price should be above the forming bar's open
    // For bearish: current price should be below the forming bar's open
    let formingBar;
    if (label === 'PB2m') formingBar = this.current2mBar;
    else if (label === 'PB3m') formingBar = this.current3mBar;
    else formingBar = this.current5mBar;

    if (formingBar) {
      if (isBullish && price <= formingBar.open) return;  // Forming bar not bullish
      if (isBearish && price >= formingBar.open) return;  // Forming bar not bearish
    }

    // ── All checks passed — FIRE SIGNAL ──
    const signal = isBullish ? 'buy' : 'sell';
    const entryPrice = price;
    const targetPrice = isBullish ? entryPrice + targetDist : entryPrice - targetDist;

    console.log(`${this.logTag}[${label} TICK-ENTRY] 🎯 TRIGGERED ${signal.toUpperCase()} @ ${entryPrice} | stop=${stopLoss.toFixed(2)} (${stopDist.toFixed(1)}pt) | target=${targetPrice.toFixed(2)} (${this.profitTargetR}R) | retrace=${(retracePct*100).toFixed(1)}% | tick #${armed.ticksSeen} | armed for ${((Date.now() - armed.armedAt)/1000).toFixed(1)}s | tick direction: ${tickDirection > 0 ? 'UP' : 'DOWN'} ${Math.abs(tickDirection).toFixed(2)}pt`);

    // Volume check on impulse bar (it's closed — volume is final)
    const volCheck = this._checkVolumeFilter(armed.impulse);
    if (!volCheck.passed) {
      console.log(`${this.logTag}[${label} TICK-ENTRY] ❌ Volume filter failed on impulse bar — rejecting tick entry`);
      return;
    }

    this.signalFired = true;
    this._tradeCountToday++;
    this._disarmAll(); // Clear all armed setups

    this.emit('signal', {
      type: signal,
      price: entryPrice,
      orderType: this.entryOrderType,
      limitBufferTicks: this.entryLimitBufferTicks,
      stopLoss,
      targetPrice,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp: new Date(),
      strategy: label,
      tradeNumToday: this._tradeCountToday,
      prevTradeResult: this._prevTradeResult,
      partialProfitEnabled: this.partialProfitEnabled,
      partialProfitR: this.partialProfitR,
      moveStopToBE: this.moveStopToBE,
      confluenceScore: armed.confluence.score,
      vwapState: this.vwapEngine.getState(),
      tickTriggered: true, // Flag for logging/analysis
      ticksSeen: armed.ticksSeen,
      armedDurationMs: Date.now() - armed.armedAt,
      filterResults: [
        { name: 'Impulse', passed: true, reason: `${armed.impRange.toFixed(1)}pt range, ${(armed.impBody / armed.impRange * 100).toFixed(0)}% body` },
        { name: 'Tick Entry', passed: true, reason: `Tick @ ${entryPrice} | retrace ${(retracePct*100).toFixed(1)}% | direction confirmed` },
        { name: 'Impulse Stop', passed: true, reason: `${stopDist.toFixed(1)}pt to impulse ${isBullish ? 'low' : 'high'}` },
        { name: 'Confluence', passed: true, reason: `${armed.confluence.score}/${armed.confluence.maxScore} factors` },
        ...armed.confluence.factors.map(f => ({ name: f.name, passed: f.passed, reason: f.reason })),
      ],
    });
  }

  /**
   * Disarm a specific strategy's armed setup
   */
  _disarmSetup(strategy) {
    if (strategy === 'PB2m') this._armedPB2m = null;
    else if (strategy === 'PB3m') this._armedPB3m = null;
    else if (strategy === 'PB') this._armedPB = null;
  }

  /**
   * Disarm all armed setups (called when a signal fires or position opens)
   */
  _disarmAll() {
    this._armedPB = null;
    this._armedPB3m = null;
    this._armedPB2m = null;
    this._armedStop = null;
    this._prevTickPrice = null;
  }

  // ═══════════════════════════════════════════════════════════════
  //  VOLUME FILTER
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if current bar volume passes the volume filter.
   * Returns { passed, ratio, avgVol } or { passed: true } if filter disabled.
   */
  _checkVolumeFilter(bar) {
    if (!this.volumeFilterEnabled) return { passed: true, ratio: null, avgVol: null };
    if (this.bars.length < this.volumeFilterPeriod) return { passed: true, ratio: null, avgVol: null };

    const recentVols = this.bars.slice(-this.volumeFilterPeriod).map(b => b.volume || 0);
    const avgVol = recentVols.reduce((s, v) => s + v, 0) / recentVols.length;
    const currentVol = bar.volume || 0;
    const ratio = avgVol > 0 ? currentVol / avgVol : 0;
    const passed = ratio >= this.volumeFilterMin;

    if (!passed) {
      console.log(`${this.logTag}[VOL_FILTER] Signal rejected: volume ratio ${ratio.toFixed(2)}x < ${this.volumeFilterMin}x (bar=${currentVol}, avg=${avgVol.toFixed(0)})`);
    }

    return { passed, ratio, avgVol };
  }

  // ═══════════════════════════════════════════════════════════════
  //  OVERRIDES
  // ═══════════════════════════════════════════════════════════════

  setPosition(position) {
    super.setPosition(position);
    if (position) {
      this.signalFired = true;
      this._pbWatch = null;
      this._disarmAll();
    } else {
      this.signalFired = false;
      this._pbWatch = null;
      this._disarmAll();
      // Start cooldown when position closes
      if (this.cooldownBars > 0) {
        this._cooldownRemaining = this.cooldownBars;
        console.log(`${this.logTag}[COOLDOWN] 🕐 Trade closed — ${this.cooldownBars}-bar cooldown started`);
      }
      // Reset VR watch state when position closes (allow new VR setups)
      this._vrWatching = null;
      this._vrWatchPrice = null;
    }
  }

  /**
   * Called by SignalHandler when a signal was emitted but the trade was rejected
   * (risk too high, AI rejection, etc). Resets signalFired so new signals can fire.
   */
  onSignalRejected() {
    this.signalFired = false;
    this._pbWatch = null;
    this._disarmAll();
    // Also undo the _tradeCountToday increment since no trade was actually placed
    if (this._tradeCountToday > 0) this._tradeCountToday--;
  }

  /**
   * Called by PositionHandler when a trade closes.
   * Updates _prevTradeResult for AI context on next signal.
   * @param {'win'|'loss'} result
   */
  onTradeResult(result) {
    this._prevTradeResult = result;
    if (result === 'loss') {
      this._consecutiveLosses++;
      if (this._consecutiveLosses >= this.maxLossesPerDay) {
        console.log(`${this.logTag}[Strategy:${this.name}] 🛑 ${this._consecutiveLosses} consecutive losses — done for the day (max ${this.maxLossesPerDay})`);
      }
    } else if (result === 'win') {
      this._consecutiveLosses = 0;
    }
    // breakeven: don't change consecutive count
  }

  analyze() {
    // No-op: analysis is triggered by bar building
  }

  getCurrentPrice() {
    if (this.currentQuote?.last) return this.currentQuote.last;
    if (this.twoMinBars.length > 0) return this.twoMinBars[this.twoMinBars.length - 1].close;
    if (this.bars.length > 0) return this.bars[this.bars.length - 1].close;
    return null;
  }

  hasEnoughData() {
    return this.twoMinBars.length >= this.emaxEmaSlow + 5;
  }

  getStatus() {
    return {
      name: this.name,
      active: this.isActive,
      barsCount1m: this.bars.length,
      barsCount2m: this.twoMinBars.length,
      barsCount3m: this.threeMinBars.length,
      barsCount5m: this.fiveMinBars.length,
      inPosition: !!this.position,
      signalFired: this.signalFired,
      position: this.position,
      maxStopPoints: this.maxStopPoints,
      profitTargetR: this.profitTargetR,
      // Tick entry state
      armedPB: this._armedPB ? `${this._armedPB.isBullish ? 'LONG' : 'SHORT'} (${this._armedPB.ticksSeen} ticks)` : null,
      armedPB3m: this._armedPB3m ? `${this._armedPB3m.isBullish ? 'LONG' : 'SHORT'} (${this._armedPB3m.ticksSeen} ticks)` : null,
      armedPB2m: this._armedPB2m ? `${this._armedPB2m.isBullish ? 'LONG' : 'SHORT'} (${this._armedPB2m.ticksSeen} ticks)` : null,
      cooldownRemaining: this._cooldownRemaining,
      tradeCountToday: this._tradeCountToday,
      consecutiveLosses: this._consecutiveLosses,
      vrEnabled: this.vrEnabled,
      vrWatching: this._vrWatching,
      vrTradeCount: this._vrTradeCount,
      vwap: this.vwapEngine.vwap ? +this.vwapEngine.vwap.toFixed(2) : null,
      vwapReady: this.vwapEngine.isReady(),
      priorDayHigh: this.vwapEngine.priorDayHigh,
      priorDayLow: this.vwapEngine.priorDayLow,
      confluenceMin: this.minConfluence,
      pbConfluenceMin: this.pbMinConfluence,
      pb3mConfluenceMin: this.pb3mMinConfluence,
      pb2mConfluenceMin: this.pb2mMinConfluence,
      volumeFilterEnabled: this.volumeFilterEnabled,
      volumeFilterMin: this.volumeFilterMin,
      rsi: this._lastRSI ? +this._lastRSI.toFixed(1) : null,
      atr: this._lastATR ? +this._lastATR.toFixed(2) : null,
    };
  }
}

module.exports = MNQMomentumStrategyV2;
