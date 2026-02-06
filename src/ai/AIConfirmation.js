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
      
      // Call AI with timeout
      const response = await Promise.race([
        this._callAI(prompt),
        this._timeoutPromise()
      ]);

      const latency = Date.now() - startTime;
      this._updateLatency(latency);

      if (response.timeout) {
        this.stats.timeouts++;
        logger.warn(`[AI] Timeout after ${this.timeout}ms - using default action: ${this.defaultAction}`);
        return this._createDecision(
          this.defaultAction.toUpperCase(),
          50,
          `AI timeout - defaulting to ${this.defaultAction}`,
          latency
        );
      }

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

    const systemPrompt = `You are an expert futures trader and technical analyst specializing in E-mini S&P 500 Micro futures (MES). Your role is to analyze trade signals and provide a CONFIRM or REJECT decision.

IMPORTANT RULES:
1. You are a FILTER, not a signal generator. Only reject trades with clear problems.
2. Be decisive - provide a clear CONFIRM or REJECT.
3. Consider risk/reward, market context, and technical setup quality.
4. A trade doesn't need to be perfect to CONFIRM - just reasonable.
5. REJECT only if you see significant red flags.

Your response MUST be in this exact JSON format:
{
  "action": "CONFIRM" or "REJECT",
  "confidence": <number 0-100>,
  "reasoning": "<brief explanation>",
  "keyFactors": ["<factor1>", "<factor2>", "<factor3>"],
  "riskAssessment": "LOW" or "MEDIUM" or "HIGH"
}`;

    const userPrompt = `TRADE SIGNAL ANALYSIS REQUEST

═══════════════════════════════════════════════════════════
SIGNAL DETAILS
═══════════════════════════════════════════════════════════
Type: ${signal.type.toUpperCase()} (${signal.type === 'buy' ? 'LONG' : 'SHORT'})
Entry Price: $${signal.price}
Stop Loss: $${signal.stopLoss}
Risk per Point: $${Math.abs(signal.price - signal.stopLoss).toFixed(2)}

═══════════════════════════════════════════════════════════
POSITION SIZING
═══════════════════════════════════════════════════════════
Contracts: ${position.contracts}
Total Risk: $${position.totalRisk?.toFixed(2) || 'N/A'}
Target Price: $${position.targetPrice?.toFixed(2) || 'N/A'}
Risk/Reward Ratio: 1:${position.targetPrice ? ((Math.abs(position.targetPrice - signal.price) / Math.abs(signal.price - signal.stopLoss)).toFixed(1)) : '2.0'}

═══════════════════════════════════════════════════════════
ACCOUNT INFO
═══════════════════════════════════════════════════════════
Balance: $${accountInfo?.balance?.toFixed(2) || 'N/A'}
Risk %: ${accountInfo?.balance ? ((position.totalRisk / accountInfo.balance) * 100).toFixed(1) : 'N/A'}%
Daily P&L: $${accountInfo?.dailyPnL?.toFixed(2) || '0.00'}

═══════════════════════════════════════════════════════════
TECHNICAL INDICATORS
═══════════════════════════════════════════════════════════
${indicatorsContext}

═══════════════════════════════════════════════════════════
STRATEGY FILTER RESULTS
═══════════════════════════════════════════════════════════
${filtersContext}

═══════════════════════════════════════════════════════════
MARKET STRUCTURE
═══════════════════════════════════════════════════════════
Trend: ${marketStructure?.trend || 'N/A'}
Session: ${sessionInfo?.session || marketStructure?.session || 'Regular'}
Breakout High: $${marketStructure?.breakoutHigh?.toFixed(2) || 'N/A'}
Breakout Low: $${marketStructure?.breakoutLow?.toFixed(2) || 'N/A'}
Distance from EMA: ${marketStructure?.emaDistance?.toFixed(2) || 'N/A'} points

═══════════════════════════════════════════════════════════
RECENT PRICE ACTION (Last 20 bars)
═══════════════════════════════════════════════════════════
${barsContext}

═══════════════════════════════════════════════════════════
ANALYSIS REQUEST
═══════════════════════════════════════════════════════════
Based on ALL the data above, should this ${signal.type.toUpperCase()} trade be executed?

Consider:
1. Is the trend aligned with the trade direction?
2. Is the entry at a good price level (not chasing)?
3. Is the stop loss placement reasonable (not too tight/wide)?
4. Are the technical indicators supportive?
5. Is the risk/reward acceptable?
6. Are there any red flags in the price action?

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
