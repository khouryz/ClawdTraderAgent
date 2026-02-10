# ClawdTraderAgent - System Architecture

> **Generated**: 2026-02-05  
> **Last Updated**: 2026-02-09 (Databento Integration)  
> **Source**: Derived directly from codebase analysis  
> **Version**: 2.0.0 - Dual-system architecture: Databento (data) + Tradovate (execution)

---

## 1. High-Level System Overview

ClawdTraderAgent is an **automated futures trading bot** using a **dual-system architecture**: **Databento** for real-time and historical market data, and **Tradovate** for order execution. Designed for trading Micro E-mini contracts (MES, MNQ, MYM) with breakout strategies, AI-powered trade validation, comprehensive risk management, and real-time notifications.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLAWDTRADERAGENT                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────────────────┐    ┌──────────────────────────────────┐  │
│  │     DATABENTO (Data)         │    │     TRADOVATE (Execution)        │  │
│  │  ┌────────┐  ┌────────────┐ │    │  ┌──────────┐  ┌─────────────┐  │  │
│  │  │ Live   │  │ Historical │ │    │  │  Order   │  │  WebSocket  │  │  │
│  │  │ Stream │  │   Bars     │ │    │  │   API    │  │  (Orders)   │  │  │
│  │  └───┬────┘  └─────┬──────┘ │    │  └────┬─────┘  └──────┬──────┘  │  │
│  └──────┼─────────────┼────────┘    └───────┼───────────────┼─────────┘  │
│         │             │                     │               │            │
│         ▼             ▼                     ▼               ▼            │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌──────────┐  │
│  │   Strategy  │    │   Signal    │    │    Risk     │    │   Loss   │  │
│  │   Engine    │◄──►│   Handler   │◄──►│  Management │◄──►│  Limits  │  │
│  └─────────────┘    └─────────────┘    └─────────────┘    └──────────┘  │
│         │                  │                                             │
│         ▼                  ▼                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                  │
│  │     AI      │    │   Trade     │    │  Telegram   │                  │
│  │ Confirmation│    │  Analyzer   │    │ Notifications│                  │
│  └─────────────┘    └─────────────┘    └─────────────┘                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Component Map

### 2.1 Core Bot Components (`src/bot/`)

| Component | File | Responsibility |
|-----------|------|----------------|
| **TradovateBot** | `TradovateBot.js` | Main orchestrator - initializes all components, manages lifecycle, handles events, **position sync on reconnect** |
| **SignalHandler** | `SignalHandler.js` | Processes trading signals, validates trades, integrates AI confirmation, places orders, **position lock to prevent race conditions** |
| **PositionHandler** | `PositionHandler.js` | Manages trade exits, calculates P&L with **contract-specific tick values**, records trades, updates loss limits |

### 2.2 Data Layer (`src/data/`)

| Component | File | Responsibility |
|-----------|------|----------------|
| **DatabentoPriceProvider** | `DatabentoPriceProvider.js` | Live streaming and historical data via Databento API, manages Python subprocess bridge |
| **databento_stream.py** | `databento_stream.py` | Python bridge script - streams live data from Databento TCP API, outputs JSON lines to stdout |

### 2.3 Execution Layer (`src/api/`)

| Component | File | Responsibility |
|-----------|------|----------------|
| **TradovateAuth** | `auth.js` | Authentication, token management, auto-refresh |
| **TradovateClient** | `client.js` | REST API client for order execution, account management, rate limiting, retry logic |
| **TradovateWebSocket** | `websocket.js` | Order updates WebSocket only (fills, positions, order status), auto-reconnect, **position sync flag on reconnect** |

### 2.4 Strategy Layer (`src/strategies/`)

| Component | File | Responsibility |
|-----------|------|----------------|
| **BaseStrategy** | `base.js` | Abstract base class for all strategies, **analyzes only on bar close** (not every tick) |
| **EnhancedBreakoutStrategy** | `enhanced_breakout.js` | Primary strategy - breakout detection with trend/volume/RSI filters, **volume uses completed bars** |
| **SimpleBreakoutStrategy** | `simple_breakout.js` | Simplified breakout strategy |

### 2.5 Risk Management (`src/risk/`)

| Component | File | Responsibility |
|-----------|------|----------------|
| **RiskManager** | `manager.js` | Position sizing with **zero-division guard**, stop loss/target calculation, trade validation |
| **LossLimitsManager** | `loss_limits.js` | Daily/weekly loss limits, consecutive loss tracking, drawdown monitoring, trading halts, **synchronous state saves** |

### 2.6 Order Management (`src/orders/`)

| Component | File | Responsibility |
|-----------|------|----------------|
| **OrderManager** | `order_manager.js` | Order lifecycle, state tracking, retry logic with **remaining quantity**, partial fills, **auto-cleanup** |
| **TrailingStopManager** | `trailing_stop.js` | Dynamic stop-loss adjustment based on ATR, **actually modifies exchange orders via API** |
| **ProfitManager** | `profit_manager.js` | Partial profit taking, break-even stops, time-based exits |

### 2.7 AI Integration (`src/ai/`)

| Component | File | Responsibility |
|-----------|------|----------------|
| **AIConfirmation** | `AIConfirmation.js` | AI-powered trade signal validation using OpenAI or Anthropic, **proper timeout handling** |

### 2.8 Analytics (`src/analytics/`)

| Component | File | Responsibility |
|-----------|------|----------------|
| **PerformanceTracker** | `performance.js` | Trade recording, win rate, P&L tracking, report generation |
| **TradeAnalyzer** | `trade_analyzer.js` | Market structure capture, trade explanations, feedback loop |

### 2.9 Utilities (`src/utils/`)

| Component | File | Responsibility |
|-----------|------|----------------|
| **Notifications** | `notifications.js` | Telegram bot integration for trade alerts |
| **Logger** | `logger.js` | Colored console logging with levels (info, warn, error, debug, success, trade) |
| **ConfigValidator** | `config_validator.js` | Environment variable validation and sanitization, **AI settings validation** |
| **ErrorHandler** | `error_handler.js` | Centralized error handling with recovery strategies |
| **RateLimiter** | `rate_limiter.js` | API rate limiting to prevent bans |
| **MarketHours** | `market_hours.js` | Market open/close detection, **CME holiday calendar** |
| **DynamicSizing** | `dynamic_sizing.js` | Performance-based position sizing adjustment |
| **FileOps** | `file_ops.js` | JSON file read/write operations |
| **Constants** | `constants.js` | Centralized constants and contract specifications |

### 2.9.1 Filters (`src/filters/`)

| Component | File | Responsibility |
|-----------|------|----------------|
| **SessionFilter** | `session_filter.js` | Trading hours, lunch avoidance, holiday calendar |

### 2.10 Technical Indicators (`src/indicators/`)

| Component | File | Responsibility |
|-----------|------|----------------|
| **Indicators** | `index.js` | SMA, EMA, ATR, RSI, Bollinger Bands, MACD, Stochastic, ADX |

---

## 3. Data Flow Paths

### 3.1 Market Data Flow

```
Databento Live API (TCP)
         │
         ▼
  databento_stream.py (Python subprocess)
         │ (JSON lines via stdout)
         ▼
  DatabentoPriceProvider (Node.js)
         │
         ├──► 'quote' event (trade price → strategy)
         ├──► 'bar' event (OHLCV → strategy)
         │
         ▼
  TradovateBot._onQuote()
         │
         ▼
  Strategy.onQuote()
         │
         ▼
  [Quote stored - NO analysis on tick]
         │
         ▼
    Bar Event (on bar close)
         │
         ▼
  Strategy.onBar()
         │
         ▼
  Strategy.analyze()  ◄── Only on bar close (HIGH-2 FIX)
         │
         ├──► Calculate Indicators (ATR, EMA, RSI, Volume)
         │
         ├──► Check Breakout Levels
         │
         ├──► Apply Filters (Trend, Volume, RSI, Session)
         │
         ▼
  Emit 'signal' Event (if conditions met)
```

### 3.2 Signal Processing Flow

```
Strategy 'signal' Event
         │
         ▼
  SignalHandler.handleSignal()
         │
         ├──► CRITICAL-2 FIX: Check _processingSignal lock
         │         └──► Reject if already processing
         │
         ├──► CRITICAL-2 FIX: Check currentPosition
         │         └──► Reject if already in position
         │
         ├──► Acquire _processingSignal lock
         │
         ├──► Validate Signal (null checks)
         │
         ├──► Check Market Hours (MarketHours.getStatus())
         │         └──► Now includes holiday calendar (MED-5 FIX)
         │
         ├──► Check Loss Limits (LossLimitsManager.canTrade())
         │
         ├──► Check Session Filter (SessionFilter.canTrade())
         │
         ├──► Get Account Balance (API)
         │
         ├──► Calculate Position Size (RiskManager)
         │         └──► HIGH-1 FIX: Zero-division guard
         │
         ├──► Validate Trade (RiskManager.validateTrade())
         │
         ├──► [OPTIONAL] AI Confirmation (AIConfirmation.analyze())
         │         │
         │         ├──► Build Prompt with Market Data
         │         │
         │         ├──► Call OpenAI/Anthropic API (HIGH-5 FIX: proper timeout)
         │         │
         │         ├──► Parse Response (CONFIRM/REJECT)
         │         │
         │         └──► Check Confidence Threshold
         │
         ├──► Place Bracket Order (API)
         │
         ├──► Record Trade Entry (TradeAnalyzer)
         │
         ├──► Send Telegram Notification
         │
         ├──► Initialize Trailing Stop (with stopOrderId for exchange modification)
         │
         ├──► Initialize Profit Manager
         │
         └──► FINALLY: Release _processingSignal lock
```

### 3.3 Order Fill Flow

```
Tradovate WebSocket (Order)
         │
         ▼
    Fill Event
         │
         ▼
  PositionHandler.handleFill()
         │
         ├──► Determine if Entry or Exit Fill
         │
         ▼ (Exit Fill)
  PositionHandler._processExitFill()
         │
         ├──► CRITICAL-3 FIX: Get contract-specific tickValue
         │         └──► Uses CONTRACTS lookup, not hardcoded default
         │
         ├──► Calculate P&L (with tick value multiplier)
         │
         ├──► Calculate R-Multiple
         │
         ├──► Determine Exit Reason
         │
         ├──► Record Trade (PerformanceTracker)
         │
         ├──► Update Loss Limits (LossLimitsManager.recordTrade())
         │         └──► CRITICAL-4 FIX: Uses saveStateSync()
         │
         ├──► Record Exit (TradeAnalyzer)
         │
         ├──► Send Exit Notification (Telegram)
         │
         ├──► Update Dynamic Sizing
         │
         └──► Clean Up (Strategy, TrailingStop, ProfitManager)
```

---

## 4. Trade Lifecycle

### Phase 1: Signal Generation
1. **Data Collection**: Databento streams real-time trades/quotes via Python bridge
2. **Bar Formation**: Quotes aggregated into OHLCV bars
3. **Indicator Calculation**: ATR, EMA, RSI, Volume computed
4. **Breakout Detection**: Price vs 20-bar high/low
5. **Filter Application**: Trend, Volume, RSI, Session filters
6. **Signal Emission**: Buy/Sell signal with stop loss

### Phase 2: Signal Validation
1. **Basic Validation**: Signal object integrity check
2. **Market Hours Check**: Is market open?
3. **Loss Limits Check**: Daily/weekly limits not exceeded?
4. **Session Filter Check**: Not during lunch, first/last minutes?
5. **Position Check**: Not already in a position?

### Phase 3: AI Confirmation (Optional)
1. **Data Assembly**: Market structure, indicators, filters, account info
2. **Prompt Construction**: Comprehensive trading context
3. **API Call**: OpenAI GPT-4 or Anthropic Claude
4. **Response Parsing**: Extract action, confidence, reasoning
5. **Threshold Check**: Confidence >= configured threshold?
6. **Decision**: CONFIRM or REJECT

### Phase 4: Order Execution
1. **Position Sizing**: Calculate contracts based on risk
2. **Price Calculation**: Entry, stop loss, take profit
3. **Order Placement**: Bracket order via API
4. **Confirmation**: Wait for order acknowledgment
5. **Position Tracking**: Store position details

### Phase 5: Position Management
1. **Trailing Stop**: Adjust stop based on favorable price movement
2. **Partial Profit**: Take 50% at 2R target
3. **Break-Even**: Move stop to entry after profit threshold
4. **Time Exit**: Close after max duration (if configured)

### Phase 6: Exit & Recording
1. **Fill Detection**: WebSocket fill event
2. **P&L Calculation**: (Exit - Entry) × Quantity × Tick Value
3. **Trade Recording**: Performance tracker, trade analyzer
4. **Loss Limits Update**: Daily/weekly P&L, consecutive losses
5. **Notification**: Telegram exit alert with analysis
6. **Cleanup**: Reset position, remove trailing stop

---

## 5. AI Confirmation Logic

### 5.1 Supported Providers

| Provider | Models | Default |
|----------|--------|---------|
| **OpenAI** | gpt-4-turbo-preview, gpt-4, gpt-3.5-turbo | gpt-4-turbo-preview |
| **Anthropic** | claude-3-5-sonnet-20241022, claude-3-opus-20240229 | claude-3-5-sonnet-20241022 |

### 5.2 Configuration Flags

```env
AI_CONFIRMATION_ENABLED=true|false    # Master toggle
AI_PROVIDER=openai|anthropic          # Provider selection
AI_API_KEY=sk-...                     # API key
AI_MODEL=gpt-4-turbo-preview          # Model override
AI_CONFIDENCE_THRESHOLD=70            # Min confidence to reject (0-100)
AI_TIMEOUT=5000                       # Timeout in ms
AI_DEFAULT_ACTION=confirm|reject      # Fallback on timeout/error
```

### 5.3 Prompt Structure

The AI receives:
- **Signal Details**: Type (buy/sell), price, stop loss
- **Technical Indicators**: ATR, RSI, EMA, SMA, Volume ratio, Bollinger Bands, MACD
- **Market Structure**: Breakout levels, recent bars, trend direction
- **Filter Results**: Which filters passed/failed
- **Account Info**: Balance, daily P&L
- **Session Info**: Current session, time until close

### 5.4 Response Format

```json
{
  "action": "CONFIRM" | "REJECT",
  "confidence": 0-100,
  "reasoning": "Explanation of decision",
  "keyFactors": ["Factor 1", "Factor 2"],
  "riskAssessment": "LOW" | "MEDIUM" | "HIGH"
}
```

### 5.5 Decision Logic

```
IF AI_CONFIRMATION_ENABLED = false:
    → Execute trade (bypass AI)

IF AI call succeeds:
    IF action = "REJECT" AND confidence >= AI_CONFIDENCE_THRESHOLD:
        → Reject trade
    ELSE:
        → Execute trade

IF AI call times out OR errors:
    IF AI_DEFAULT_ACTION = "confirm":
        → Execute trade
    ELSE:
        → Reject trade
```

---

## 6. Risk Management Behavior

### 6.1 Position Sizing

```javascript
// From RiskManager.calculatePositionSize()
priceRisk = |entryPrice - stopLoss|
ticksRisk = priceRisk / tickSize
dollarRiskPerContract = ticksRisk × tickValue
targetRisk = (RISK_PER_TRADE_MIN + RISK_PER_TRADE_MAX) / 2
contracts = max(1, floor(targetRisk / dollarRiskPerContract))
```

### 6.2 Loss Limits

| Limit | Default | Behavior |
|-------|---------|----------|
| Daily Loss | $150 | Halt trading for day |
| Weekly Loss | $300 | Halt trading for week |
| Max Consecutive Losses | 3 | Halt trading |
| Max Drawdown | 10% | Halt trading |

### 6.3 Halt Conditions

Trading is halted when:
1. Daily loss limit exceeded
2. Weekly loss limit exceeded
3. Consecutive losses reached
4. Drawdown percentage exceeded
5. Critical error occurs

Halts are persisted to `data/loss_limits_state.json` and reset:
- Daily limits: Reset at midnight
- Weekly limits: Reset on Sunday

---

## 7. Execution Layer Behavior

### 7.1 Order Types

| Type | Usage |
|------|-------|
| **Market** | Entry orders |
| **Bracket** | Entry + Stop + Target (primary method) |
| **Stop** | Stop loss orders |
| **Limit** | Take profit orders |
| **OCO** | One-cancels-other for SL/TP |

### 7.2 Retry Logic

```javascript
// From TradovateClient.request()
retryableCodes = [429, 500, 502, 503, 504]
maxRetries = 3
retryDelay = 1000ms × 2^(attempt-1)  // Exponential backoff
```

### 7.3 Rate Limiting

```javascript
// From constants.js
RATE_LIMIT_PER_SECOND = 10
RATE_LIMIT_PER_MINUTE = 200
BURST_LIMIT = 20
```

---

## 8. Configuration & Environment Variables

### 8.1 Required Variables

| Variable | Description |
|----------|-------------|
| `TRADOVATE_ENV` | `demo` or `live` |
| `TRADOVATE_USERNAME` | Account username |
| `TRADOVATE_PASSWORD` | Account password |
| `CONTRACT_SYMBOL` | e.g., `MESH6` |
| `DATABENTO_API_KEY` | Databento API key (starts with `db-`) |

### 8.1b Databento Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABENTO_API_KEY` | - | API key from databento.com/portal/keys |
| `DATABENTO_SYMBOL` | `MES.FUT` | Parent symbol (e.g., `ES.FUT`, `NQ.FUT`) |
| `DATABENTO_SCHEMA` | `trades` | Data schema (`trades`, `ohlcv-1s`, `ohlcv-1m`, `mbp-1`) |
| `DATABENTO_DATASET` | `GLBX.MDP3` | CME Globex dataset |
| `PYTHON_PATH` | `python` | Path to Python with `databento` package |

### 8.2 Risk Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RISK_PER_TRADE_MIN` | 30 | Min risk per trade ($) |
| `RISK_PER_TRADE_MAX` | 60 | Max risk per trade ($) |
| `PROFIT_TARGET_R` | 2 | Profit target in R-multiples |
| `DAILY_LOSS_LIMIT` | 150 | Daily loss limit ($) |
| `WEEKLY_LOSS_LIMIT` | 300 | Weekly loss limit ($) |
| `MAX_CONSECUTIVE_LOSSES` | 3 | Max consecutive losses |
| `MAX_DRAWDOWN_PERCENT` | 10 | Max drawdown (%) |

### 8.3 Strategy Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `STRATEGY` | enhanced_breakout | Strategy name |
| `LOOKBACK_PERIOD` | 20 | Breakout lookback bars |
| `ATR_MULTIPLIER` | 1.5 | ATR multiplier for stops |
| `TREND_EMA_PERIOD` | 50 | EMA period for trend |
| `USE_TREND_FILTER` | true | Enable trend filter |
| `USE_VOLUME_FILTER` | true | Enable volume filter |
| `USE_RSI_FILTER` | true | Enable RSI filter |

### 8.4 Session Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TRADING_START_HOUR` | 9 | Trading start hour |
| `TRADING_START_MINUTE` | 30 | Trading start minute |
| `TRADING_END_HOUR` | 16 | Trading end hour |
| `TRADING_END_MINUTE` | 0 | Trading end minute |
| `AVOID_LUNCH` | true | Skip 12:00-14:00 |
| `TIMEZONE` | America/New_York | Timezone |

### 8.5 Order Management

| Variable | Default | Description |
|----------|---------|-------------|
| `TRAILING_STOP_ENABLED` | true | Enable trailing stops |
| `TRAILING_STOP_ATR_MULTIPLIER` | 2.0 | Trailing stop ATR mult |
| `PARTIAL_PROFIT_ENABLED` | true | Enable partial profits |
| `PARTIAL_PROFIT_PERCENT` | 50 | % to take at target |
| `PARTIAL_PROFIT_R` | 2 | R-multiple for partial |

### 8.6 Notifications

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Telegram chat ID |

---

## 9. Logging & Notifications Architecture

### 9.1 Logger Levels

| Level | Method | Color | Usage |
|-------|--------|-------|-------|
| INFO | `logger.info()` | Cyan | General information |
| WARN | `logger.warn()` | Yellow | Warnings |
| ERROR | `logger.error()` | Red | Errors |
| DEBUG | `logger.debug()` | Magenta | Debug info |
| SUCCESS | `logger.success()` | Green | Success messages |
| TRADE | `logger.trade()` | Blue | Trade-specific logs |

### 9.2 Telegram Notification Types

| Notification | Trigger |
|--------------|---------|
| Bot Started | Initialization complete |
| Bot Stopped | Graceful shutdown |
| Trade Entry | Order filled (entry) |
| Trade Exit | Order filled (exit) |
| AI Rejection | AI rejects trade |
| Trading Halted | Loss limit reached |
| Error | Critical errors |
| Feedback Summary | Every 10 trades |

---

## 10. Failure Handling & Safeguards

### 10.1 Error Recovery Strategies

| Error Code | Action | Retryable | Delay |
|------------|--------|-----------|-------|
| `INSUFFICIENT_BALANCE` | HALT | No | - |
| `MARKET_CLOSED` | WAIT | Yes | 60s |
| `RATE_LIMITED` | BACKOFF | Yes | 60s |
| `AUTH_FAILED` | REAUTH | Yes | 5s |
| `INVALID_ORDER` | SKIP | No | - |
| `RISK_LIMIT_EXCEEDED` | HALT | No | - |
| `CONNECTION_FAILED` | RETRY | Yes | 5s |

### 10.2 Connection Safeguards

**Tradovate Order WebSocket:**
- **Auto-reconnect**: Exponential backoff (1s → 60s max)
- **Max reconnect attempts**: 10
- **Heartbeat**: Every 2.5 seconds

**Databento Price Stream:**
- **Auto-reconnect**: Linear backoff (5s → 30s max)
- **Max reconnect attempts**: 10
- **Python subprocess**: Automatically respawned on crash

### 10.3 Data Persistence

| File | Purpose |
|------|---------|
| `data/loss_limits_state.json` | Loss limits state |
| `data/trades.json` | Trade history |
| `data/daily_stats.json` | Daily statistics |
| `data/trade_analysis.json` | Trade analysis data |
| `data/algorithm_feedback.json` | Learning feedback |

### 10.4 Graceful Shutdown

1. Set `isRunning = false`
2. Send Telegram notification
3. Stop strategy
4. Disconnect WebSockets
5. Exit process

---

## 11. Entry Points

| Command | File | Description |
|---------|------|-------------|
| `npm start` | `src/index.js` | Continuous trading mode |
| `npm run start:new` | `src/main.js` | New entry point |
| `node src/index.js --status` | - | Get status (JSON) |
| `node src/index.js --balance` | - | Get balance (JSON) |
| `node src/index.js --positions` | - | Get positions (JSON) |
| `node src/index.js --report` | - | Get performance report |
| `node src/index.js --check` | - | Check for signal once |
| `npm run backtest` | `backtest.js` | Run backtest |
| `npm run replay` | `replay-backtest.js` | Market replay backtest |

---

## 12. Dependencies

### Node.js (package.json)
```json
{
  "axios": "^1.6.0",      // HTTP client for Tradovate REST API
  "ws": "^8.14.0",        // WebSocket client for Tradovate order updates
  "dotenv": "^16.3.0"     // Environment variable loading
}
```

### Python (requirements.txt)
```
databento>=0.41.0          # Databento market data client
```

---

## 13. Audit Fixes Applied (2026-02-05)

### Critical Fixes
| ID | Issue | Fix |
|----|-------|-----|
| CRITICAL-1 | Duplicate TradovateBot class | Removed from `src/index.js`, now uses modular version only |
| CRITICAL-2 | Race condition on rapid signals | Added `_processingSignal` lock in SignalHandler |
| CRITICAL-3 | Wrong tickValue for non-MES | Contract-specific lookup from CONTRACTS |
| CRITICAL-4 | Async state saves could lose data | Added `saveStateSync()` for critical operations |

### High-Risk Fixes
| ID | Issue | Fix |
|----|-------|-----|
| HIGH-1 | Zero division in position sizing | Guard for invalid `dollarRiskPerContract` |
| HIGH-2 | Signal spam on every tick | Analysis only on bar close |
| HIGH-3 | Retry uses full quantity after partial | Uses `remainingQuantity` |
| HIGH-4 | No position sync on reconnect | `_syncPositionState()` after WebSocket reconnect |
| HIGH-5 | Double timeout in AI | Removed redundant Promise.race |
| HIGH-6 | Volume filter uses incomplete bar | Uses previous completed bar |
| HIGH-7 | Trailing stop cosmetic only | Now calls `client.modifyOrder()` |

### Medium Fixes
| ID | Issue | Fix |
|----|-------|-----|
| MED-1 | Volume avg includes current bar | Excludes current bar |
| MED-5 | No holiday calendar | Added CME holidays 2025-2026 |
| MED-6 | No AI config validation | Added AI settings validation |
| MED-7 | OrderManager memory leak | Added `startAutoCleanup()` |

---

## 14. Notes

> ℹ️ **Note**: The system uses a **dual-provider architecture**: Databento for market data, Tradovate for order execution. This separation provides institutional-grade data quality while maintaining reliable trade execution.

> ℹ️ **Note**: The Databento live stream runs as a **Python subprocess** spawned by Node.js. The Python process communicates via JSON lines on stdout. This approach leverages Databento's official Python client (no official JS client exists).

> ℹ️ **Note**: The system is designed for single-position trading (one trade at a time). The `_processingSignal` lock enforces this.

> ℹ️ **Note**: The AI confirmation feature is optional and can be completely disabled via `AI_CONFIRMATION_ENABLED=false`.

> ℹ️ **Note**: The system supports both demo and live environments, controlled by `TRADOVATE_ENV`.

> ℹ️ **Note**: Trailing stops now actually modify exchange orders - ensure `stopOrderId` is passed when initializing trails.

> ℹ️ **Note**: Python 3.10+ with the `databento` package must be installed. Run `pip install -r requirements.txt`.

---

*This document was generated by analyzing the complete codebase structure and source files.*
*Last updated: 2026-02-09 after Databento integration.*
