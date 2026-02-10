/**
 * AI Confirmation Service
 * 
 * Provides AI-powered trade signal confirmation using OpenAI or Anthropic APIs.
 * The AI analyzes all available market data, indicators, and context to provide
 * a CONFIRM or REJECT decision with confidence score and reasoning.
 * 
 * Features:
 * - Supports both OpenAI (GPT-4) and Anthropic (Claude) APIs
 * - Comprehensive market data analysis
 * - Configurable confidence thresholds
 * - Timeout fallback to prevent blocking trades
 * - Full logging for performance analysis
 */

const axios = require('axios');
const logger = require('../utils/logger');

class AIConfirmation {
  /**
   * @param {Object} config - Configuration options
   * @param {boolean} config.enabled - Whether AI confirmation is enabled
   * @param {string} config.provider - 'openai' or 'anthropic'
   * @param {string} config.apiKey - API key for the provider
   * @param {string} config.model - Model to use (e.g., 'gpt-4', 'claude-3-opus-20240229')
   * @param {number} config.confidenceThreshold - Minimum confidence to reject (0-100)
   * @param {number} config.timeout - Timeout in ms before fallback to CONFIRM
   * @param {string} config.defaultAction - Action on timeout/error: 'confirm' or 'reject'
   */
  constructor(config = {}) {
    this.enabled = config.enabled || false;
    this.provider = config.provider || 'anthropic';
    this.apiKey = config.apiKey || '';
    this.model = config.model || this._getDefaultModel();
    this.confidenceThreshold = config.confidenceThreshold || 70;
    this.timeout = config.timeout || 5000; // 5 seconds default
    this.defaultAction = config.defaultAction || 'confirm';
    
    // API endpoints
    this.endpoints = {
      openai: 'https://api.openai.com/v1/chat/completions',
      anthropic: 'https://api.anthropic.com/v1/messages'
    };

    // Track statistics
    this.stats = {
      totalCalls: 0,
      confirms: 0,
      rejects: 0,
      timeouts: 0,
      errors: 0,
      avgLatency: 0
    };

    if (this.enabled && !this.apiKey) {
      logger.warn('[AI] AI Confirmation enabled but no API key provided');
      this.enabled = false;
    }
  }

  /**
   * Get default model based on provider
   * @private
   */
  _getDefaultModel() {
    return this.provider === 'openai' ? 'gpt-4-turbo-preview' : 'claude-3-5-sonnet-20241022';
  }

  /**
   * Check if AI confirmation is enabled
   * @returns {boolean}
   */
  isEnabled() {
    return this.enabled && !!this.apiKey;
  }

  /**
   * Analyze a trade signal and return confirmation decision
   * @param {Object} params - All data for AI analysis
   * @param {Object} params.signal - The trade signal (type, price, stopLoss)
   * @param {Object} params.marketStructure - Current market structure
   * @param {Object} params.position - Calculated position details
   * @param {Object} params.filterResults - Results from strategy filters
   * @param {Array} params.recentBars - Recent price bars (last 50-100)
   * @param {Object} params.indicators - Current indicator values
   * @param {Object} params.accountInfo - Account balance and risk info
   * @param {Object} params.sessionInfo - Trading session information
   * @returns {Promise<AIDecision>}
   */
  async analyzeSignal(params) {
    if (!this.isEnabled()) {
      return this._createDecision('CONFIRM', 100, 'AI confirmation disabled', 0);
    }

    const startTime = Date.now();
    this.stats.totalCalls++;

    try {
      // Build comprehensive prompt
      const prompt = this._buildPrompt(params);
      
      // HIGH-5 FIX: Remove redundant Promise.race timeout - axios already has timeout configured
      // This prevents double-timeout issues where both could hang
      let response;
      try {
        response = await this._callAI(prompt);
      } catch (axiosError) {
        // Handle axios timeout specifically
        if (axiosError.code === 'ECONNABORTED' || axiosError.message?.includes('timeout')) {
          const latency = Date.now() - startTime;
          this.stats.timeouts++;
          logger.warn(`[AI] Timeout after ${this.timeout}ms - using default action: ${this.defaultAction}`);
          return this._createDecision(
            this.defaultAction.toUpperCase(),
            50,
            `AI timeout - defaulting to ${this.defaultAction}`,
            latency
          );
        }
        throw axiosError; // Re-throw non-timeout errors
      }

      const latency = Date.now() - startTime;
      this._updateLatency(latency);

      // Parse AI response
      const decision = this._parseResponse(response);
      decision.latency = latency;

      // Update stats
      if (decision.action === 'CONFIRM') {
        this.stats.confirms++;
      } else {
        this.stats.rejects++;
      }

      logger.info(`[AI] Decision: ${decision.action} (${decision.confidence}%) in ${latency}ms`);
      logger.debug(`[AI] Reasoning: ${decision.reasoning}`);

      return decision;

    } catch (error) {
      this.stats.errors++;
      const latency = Date.now() - startTime;
      logger.error(`[AI] Error: ${error.message}`);
      
      return this._createDecision(
        this.defaultAction.toUpperCase(),
        50,
        `AI error: ${error.message} - defaulting to ${this.defaultAction}`,
        latency
      );
    }
  }

  /**
   * Build comprehensive prompt with all market data
   * @private
   */
  _buildPrompt(params) {
    const { signal, marketStructure, position, filterResults, recentBars, indicators, accountInfo, sessionInfo } = params;

    // Format recent bars for context (last 20 bars summary)
    const barsContext = this._formatBarsContext(recentBars);
    
    // Format indicators
    const indicatorsContext = this._formatIndicators(indicators, marketStructure);
    
    // Format filter results
    const filtersContext = this._formatFilters(filterResults);

    // V2-specific context
    const stratName = signal.strategy || 'unknown';
    const vwapState = signal.vwapState || {};
    const confluenceScore = signal.confluenceScore || 0;
    const tradeNum = signal.tradeNumToday || 1;
    const prevTradeResult = signal.prevTradeResult || 'none';
    const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long' });

    const systemPrompt = `You are an elite MNQ (Micro E-mini Nasdaq-100) futures day trader scoring a signal from an automated momentum strategy.

STRATEGY CONTEXT: This bot runs two sub-strategies on MNQ:
1. PB (Momentum Pullback): 5-min impulse bar ≥20pt → 20-60% retrace → bounce entry. 5R target. Window: 6:30-8:30 AM PST.
2. VR (VWAP Mean Reversion): Price stretches to ±1.5σ VWAP band → reversion candle entry. 4R target. Window: 8:30-11:00 AM PST.

BACKTEST STATISTICS (12 months, 286 trades):
- Overall: 29% WR, PF 1.75, $152 avg win, $34 avg loss
- PB: 31% WR, PF 1.75, $152 avg win — the workhorse
- VR: 30% WR, PF 1.69, $137 avg win — fills mid-session
- 32% of losing trades went 20+ pts favorable before reversing to stop
- Trade #4+ per day: 10% WR, -$301 → ALWAYS REJECT
- After a winning trade: 18% WR, -$180 → be very cautious
- Thursday/Friday: 22-24% WR → require stronger setup
- 7:30-8:00 AM is best window (PF 2.31), 10:30+ AM is weakest (PF 0.77-0.89)

YOUR JOB: Score this signal's quality from 1-10. You are NOT a binary gate — you are a quality scorer.
- Score 1-3: REJECT — clear red flags, poor market structure, overtrading
- Score 4-6: CONFIRM — acceptable setup, normal execution
- Score 7-10: CONFIRM — high conviction, strong alignment

REJECT (score 1-3) when you see:
- This is trade #4+ today (almost always loses)
- Previous trade was a winner AND this setup is marginal (overconfidence trap)
- Price is in a tight range with no clear direction (chop)
- Volume is drying up on the entry bar
- Multiple prior day levels are clustered against the trade direction
- It's after 10:30 AM and the setup is only marginal

DEFAULT TO CONFIRM (score 4+) when:
- The setup matches the strategy rules (impulse + retrace for PB, sigma stretch for VR)
- Volume confirms the move
- VWAP alignment supports the direction
- It's early in the session with momentum

Respond ONLY with this exact JSON format:
{
  "action": "CONFIRM" or "REJECT",
  "score": <number 1-10>,
  "confidence": <number 0-100>,
  "reasoning": "<2-3 sentence explanation>",
  "keyFactors": ["<factor1>", "<factor2>", "<factor3>"],
  "riskAssessment": "LOW" or "MEDIUM" or "HIGH"
}`;

    const stopDist = Math.abs(signal.price - signal.stopLoss);
    const targetDist = position.targetPrice ? Math.abs(position.targetPrice - signal.price) : stopDist * 4;

    const userPrompt = `MNQ V2 SIGNAL SCORING REQUEST

═══ SIGNAL ═══
Strategy: ${stratName.toUpperCase()}
Direction: ${signal.type.toUpperCase()} (${signal.type === 'buy' ? 'LONG' : 'SHORT'})
Entry: $${signal.price} | Stop: $${signal.stopLoss} | Target: $${position.targetPrice?.toFixed(2) || 'N/A'}
Stop Distance: ${stopDist.toFixed(1)} pts ($${(stopDist * 2).toFixed(2)} risk)
Target Distance: ${targetDist.toFixed(1)} pts | R-Multiple: ${(targetDist / stopDist).toFixed(1)}R
Confluence Score: ${confluenceScore}/7

═══ VWAP STATE ═══
VWAP: $${vwapState.vwap?.toFixed(2) || 'N/A'}
Price vs VWAP: ${vwapState.vwap ? (signal.price - vwapState.vwap).toFixed(1) + ' pts ' + (signal.price > vwapState.vwap ? 'ABOVE' : 'BELOW') : 'N/A'}
Sigma Position: ${vwapState.sigmaDistance?.toFixed(2) || 'N/A'}σ
Upper 1σ: $${vwapState.upper1?.toFixed(2) || 'N/A'} | Lower 1σ: $${vwapState.lower1?.toFixed(2) || 'N/A'}
Session High: $${vwapState.sessionHigh?.toFixed(2) || 'N/A'} | Session Low: $${vwapState.sessionLow?.toFixed(2) || 'N/A'}

═══ PRIOR DAY LEVELS ═══
Prior High: $${vwapState.priorHigh?.toFixed(2) || 'N/A'}
Prior Low: $${vwapState.priorLow?.toFixed(2) || 'N/A'}
Prior Close: $${vwapState.priorClose?.toFixed(2) || 'N/A'}
Prior VWAP: $${vwapState.priorVWAP?.toFixed(2) || 'N/A'}
Prior POC: $${vwapState.priorPOC?.toFixed(2) || 'N/A'}

═══ CONTEXT ═══
Trade # Today: ${tradeNum} ${tradeNum >= 4 ? '⚠️ HIGH RISK — 4th+ trade (10% WR historically)' : ''}
Previous Trade: ${prevTradeResult} ${prevTradeResult === 'win' ? '⚠️ CAUTION — after-win trades have 18% WR' : ''}
Day of Week: ${dayOfWeek} ${['Thursday', 'Friday'].includes(dayOfWeek) ? '⚠️ Thu/Fri have lower WR (22-24%)' : ''}
Daily P&L: $${accountInfo?.dailyPnL?.toFixed(2) || '0.00'}
Account Balance: $${accountInfo?.balance?.toFixed(2) || 'N/A'}

═══ INDICATORS ═══
${indicatorsContext}

═══ RECENT PRICE ACTION ═══
${barsContext}

═══ SCORING REQUEST ═══
Score this ${stratName.toUpperCase()} ${signal.type.toUpperCase()} signal from 1-10.
${stratName === 'PB' ? 'For PB: Is the impulse bar strong? Is the retrace clean (20-60%)? Does the bounce bar confirm direction? Is volume supporting?' : ''}
${stratName === 'VR' ? 'For VR: Did price genuinely stretch to 1.3σ+? Is the reversion candle convincing? Is volume confirming the reversal? Is VWAP trending or flat?' : ''}

Provide your decision in the required JSON format.`;

    return { systemPrompt, userPrompt };
  }

  /**
   * Format recent bars into readable context
   * @private
   */
  _formatBarsContext(bars) {
    if (!bars || bars.length === 0) {
      return 'No bar data available';
    }

    // Take last 20 bars
    const recentBars = bars.slice(-20);
    
    // Calculate summary statistics
    const highs = recentBars.map(b => b.high);
    const lows = recentBars.map(b => b.low);
    const closes = recentBars.map(b => b.close);
    const volumes = recentBars.map(b => b.volume || 0);
    
    const highestHigh = Math.max(...highs);
    const lowestLow = Math.min(...lows);
    const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const lastClose = closes[closes.length - 1];
    const firstClose = closes[0];
    const priceChange = lastClose - firstClose;
    const priceChangePercent = ((priceChange / firstClose) * 100).toFixed(2);

    // Identify patterns
    const bullishBars = recentBars.filter(b => b.close > b.open).length;
    const bearishBars = recentBars.length - bullishBars;

    let context = `Summary (${recentBars.length} bars):
- Range: $${lowestLow.toFixed(2)} - $${highestHigh.toFixed(2)} (${(highestHigh - lowestLow).toFixed(2)} pts)
- Price Change: ${priceChange >= 0 ? '+' : ''}$${priceChange.toFixed(2)} (${priceChangePercent}%)
- Bar Composition: ${bullishBars} bullish, ${bearishBars} bearish
- Avg Volume: ${Math.round(avgVolume)}

Last 5 bars (newest first):`;

    // Add last 5 bars detail
    const last5 = recentBars.slice(-5).reverse();
    last5.forEach((bar, i) => {
      const direction = bar.close > bar.open ? '▲' : '▼';
      const range = (bar.high - bar.low).toFixed(2);
      context += `\n  ${i + 1}. ${direction} O:${bar.open.toFixed(2)} H:${bar.high.toFixed(2)} L:${bar.low.toFixed(2)} C:${bar.close.toFixed(2)} (range: ${range})`;
    });

    return context;
  }

  /**
   * Format indicators into readable context
   * @private
   */
  _formatIndicators(indicators, marketStructure) {
    const ind = { ...indicators, ...marketStructure };
    
    let context = '';
    
    if (ind.atr !== undefined) context += `ATR (14): ${ind.atr?.toFixed(2) || 'N/A'} points\n`;
    if (ind.rsi !== undefined) context += `RSI (14): ${ind.rsi?.toFixed(1) || 'N/A'} ${this._getRSIZone(ind.rsi)}\n`;
    if (ind.ema !== undefined) context += `EMA (50): $${ind.ema?.toFixed(2) || 'N/A'}\n`;
    if (ind.sma !== undefined) context += `SMA (20): $${ind.sma?.toFixed(2) || 'N/A'}\n`;
    if (ind.volumeRatio !== undefined) context += `Volume Ratio: ${ind.volumeRatio?.toFixed(2) || 'N/A'}x average\n`;
    
    if (ind.bollingerBands) {
      context += `Bollinger Bands: Upper $${ind.bollingerBands.upper?.toFixed(2)}, Mid $${ind.bollingerBands.middle?.toFixed(2)}, Lower $${ind.bollingerBands.lower?.toFixed(2)}\n`;
    }
    
    if (ind.macd) {
      context += `MACD: ${ind.macd.macd?.toFixed(2)}, Signal: ${ind.macd.signal?.toFixed(2)}, Histogram: ${ind.macd.histogram?.toFixed(2)}\n`;
    }

    return context || 'No indicator data available';
  }

  /**
   * Get RSI zone description
   * @private
   */
  _getRSIZone(rsi) {
    if (!rsi) return '';
    if (rsi >= 70) return '(OVERBOUGHT)';
    if (rsi <= 30) return '(OVERSOLD)';
    if (rsi >= 60) return '(bullish zone)';
    if (rsi <= 40) return '(bearish zone)';
    return '(neutral)';
  }

  /**
   * Format filter results
   * @private
   */
  _formatFilters(filterResults) {
    if (!filterResults) return 'No filter data available';

    let context = '';
    
    if (filterResults.trendFilter !== undefined) {
      context += `Trend Filter: ${filterResults.trendFilter ? '✅ PASSED' : '❌ FAILED'}\n`;
    }
    if (filterResults.volumeFilter !== undefined) {
      context += `Volume Filter: ${filterResults.volumeFilter ? '✅ PASSED' : '❌ FAILED'}\n`;
    }
    if (filterResults.rsiFilter !== undefined) {
      context += `RSI Filter: ${filterResults.rsiFilter ? '✅ PASSED' : '❌ FAILED'}\n`;
    }
    if (filterResults.sessionFilter !== undefined) {
      context += `Session Filter: ${filterResults.sessionFilter ? '✅ PASSED' : '❌ FAILED'}\n`;
    }

    const passedCount = Object.values(filterResults).filter(v => v === true).length;
    const totalCount = Object.keys(filterResults).filter(k => typeof filterResults[k] === 'boolean').length;
    
    context += `\nOverall: ${passedCount}/${totalCount} filters passed`;

    return context;
  }

  /**
   * Call AI API
   * @private
   */
  async _callAI(prompt) {
    if (this.provider === 'openai') {
      return this._callOpenAI(prompt);
    } else {
      return this._callAnthropic(prompt);
    }
  }

  /**
   * Call OpenAI API
   * @private
   */
  async _callOpenAI(prompt) {
    const response = await axios.post(
      this.endpoints.openai,
      {
        model: this.model,
        messages: [
          { role: 'system', content: prompt.systemPrompt },
          { role: 'user', content: prompt.userPrompt }
        ],
        temperature: 0.3, // Lower temperature for more consistent decisions
        max_tokens: 500,
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: this.timeout
      }
    );

    return response.data.choices[0].message.content;
  }

  /**
   * Call Anthropic API
   * @private
   */
  async _callAnthropic(prompt) {
    const response = await axios.post(
      this.endpoints.anthropic,
      {
        model: this.model,
        max_tokens: 500,
        system: prompt.systemPrompt,
        messages: [
          { role: 'user', content: prompt.userPrompt }
        ]
      },
      {
        headers: {
          'x-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01'
        },
        timeout: this.timeout
      }
    );

    return response.data.content[0].text;
  }

  /**
   * Create timeout promise
   * @private
   */
  _timeoutPromise() {
    return new Promise(resolve => {
      setTimeout(() => resolve({ timeout: true }), this.timeout);
    });
  }

  /**
   * Parse AI response into decision object
   * @private
   */
  _parseResponse(response) {
    try {
      // Handle string response
      let data = response;
      if (typeof response === 'string') {
        // Try to extract JSON from response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          data = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('No JSON found in response');
        }
      }

      // Validate required fields
      const action = (data.action || '').toUpperCase();
      if (!['CONFIRM', 'REJECT'].includes(action)) {
        throw new Error(`Invalid action: ${data.action}`);
      }

      return {
        action,
        score: Math.min(10, Math.max(1, parseInt(data.score) || 5)),
        confidence: Math.min(100, Math.max(0, parseInt(data.confidence) || 50)),
        reasoning: data.reasoning || 'No reasoning provided',
        keyFactors: data.keyFactors || [],
        riskAssessment: data.riskAssessment || 'MEDIUM',
        raw: data
      };

    } catch (error) {
      logger.warn(`[AI] Failed to parse response: ${error.message}`);
      // Default to confirm on parse error
      return {
        action: this.defaultAction.toUpperCase(),
        confidence: 50,
        reasoning: `Parse error: ${error.message}`,
        keyFactors: [],
        riskAssessment: 'MEDIUM'
      };
    }
  }

  /**
   * Create decision object
   * @private
   */
  _createDecision(action, confidence, reasoning, latency) {
    return {
      action,
      confidence,
      reasoning,
      keyFactors: [],
      riskAssessment: 'MEDIUM',
      latency
    };
  }

  /**
   * Update average latency
   * @private
   */
  _updateLatency(latency) {
    const total = this.stats.totalCalls;
    if (total <= 1) {
      this.stats.avgLatency = latency;
    } else {
      this.stats.avgLatency = ((this.stats.avgLatency * (total - 1)) + latency) / total;
    }
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return {
      ...this.stats,
      confirmRate: this.stats.totalCalls > 0 
        ? ((this.stats.confirms / this.stats.totalCalls) * 100).toFixed(1) + '%'
        : 'N/A',
      rejectRate: this.stats.totalCalls > 0
        ? ((this.stats.rejects / this.stats.totalCalls) * 100).toFixed(1) + '%'
        : 'N/A',
      errorRate: this.stats.totalCalls > 0
        ? ((this.stats.errors / this.stats.totalCalls) * 100).toFixed(1) + '%'
        : 'N/A'
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalCalls: 0,
      confirms: 0,
      rejects: 0,
      timeouts: 0,
      errors: 0,
      avgLatency: 0
    };
  }

  /**
   * Should the trade be executed based on AI decision?
   * @param {AIDecision} decision - AI decision object
   * @returns {boolean}
   */
  shouldExecute(decision) {
    // Score-based: score < 4 = reject (regardless of action label)
    if (decision.score !== undefined && decision.score < 4) {
      return false;
    }

    if (decision.action === 'CONFIRM') {
      return true;
    }
    
    // Only reject if confidence is above threshold
    if (decision.action === 'REJECT' && decision.confidence >= this.confidenceThreshold) {
      return false;
    }
    
    // Low confidence rejection - proceed with trade
    return true;
  }
}

/**
 * @typedef {Object} AIDecision
 * @property {'CONFIRM'|'REJECT'} action - The decision
 * @property {number} confidence - Confidence level 0-100
 * @property {string} reasoning - Explanation for the decision
 * @property {string[]} keyFactors - Key factors in the decision
 * @property {'LOW'|'MEDIUM'|'HIGH'} riskAssessment - Risk assessment
 * @property {number} latency - API call latency in ms
 */

module.exports = AIConfirmation;
