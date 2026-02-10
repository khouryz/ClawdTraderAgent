# ClawdTraderAgent - System Architecture

> **Generated**: 2026-02-05  
> **Last Updated**: 2026-02-10 (V2.3 — 9 Bug Fixes + Telegram)  
> **Source**: Derived directly from codebase analysis  
> **Version**: 2.3.0 — MNQ Momentum (EMAX + PB + VR), Databento data, Tradovate execution

---

## 1. High-Level System Overview

ClawdTraderAgent is an **automated MNQ futures trading bot** using a **dual-system architecture**: **Databento** for real-time 1-minute OHLCV bars and historical data, and **Tradovate** for bracket order execution. It runs the **MNQ Momentum Strategy V2** with three sub-strategies (EMAX, Pullback, VWAP Mean Reversion), a shared VWAP engine, break-even stop management, and Telegram notifications for every trade event.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           CLAWDTRADERAGENT V2.3                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────┐    ┌──────────────────────────────────┐   │
│  │     DATABENTO (Data)         │    │     TRADOVATE (Execution)        │   │
│  │  ┌────────┐  ┌────────────┐ │    │  ┌──────────┐  ┌─────────────┐  │   │
│  │  │ Live   │  │ Historical │ │    │  │  Order   │  │  WebSocket  │  │   │
│  │  │ 1m OHLCV│  │   Warmup  │ │    │  │   API    │  │  (Fills)    │  │   │
│  │  └───┬────┘  └─────┬──────┘ │    │  └────┬─────┘  └──────┬──────┘  │   │
│  └──────┼─────────────┼────────┘    └───────┼───────────────┼─────────┘   │
│         │             │                     │               │             │
│         ▼             ▼                     ▼               ▼             │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                    TradovateBot (Orchestrator)                       │ │
│  │  _isInSession() gate │ _warmingUp flag │ _onBar() │ _onSignal()     │ │
│  └──────────┬───────────┴────────┬────────┴──────────┬─────────────────┘ │
│             │                    │                    │                   │
│             ▼                    ▼                    ▼                   │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────┐    │
│  │ MNQ Momentum V2 │  │  VWAP Engine     │  │  Session Manager     │    │
│  │ ┌─────┐ ┌────┐  │  │  (shared state)  │  │  6:29 reset          │    │
│  │ │EMAX │ │ PB │  │  │  sigma bands     │  │  12:55 EOD close     │    │
│  │ └─────┘ └────┘  │  │  prior day levels│  │  1:00 daily report   │    │
│  │ ┌────┐           │  └──────────────────┘  └──────────────────────┘    │
│  │ │ VR │           │                                                    │
│  │ └────┘           │                                                    │
│  └────────┬─────────┘                                                    │
│           │ signal                                                       │
│           ▼                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │   Signal    │  │    Risk     │  │   Loss   │  │  Profit Manager  │  │
│  │   Handler   │──│  Manager    │──│  Limits  │  │  (BE stop @ 2.5R)│  │
│  └──────┬──────┘  └─────────────┘  └──────────┘  └──────────────────┘  │
│         │                                                               │
│         ▼                                                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────────┐ │
│  │  Position   │  │   Trade     │  │  Telegram Notifications         │ │
│  │  Handler    │  │  Analyzer   │  │  entry│stop│exit│EOD report     │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
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
| **MNQMomentumStrategyV2** | `mnq_momentum_strategy_v2.js` | **Active strategy** — EMAX + PB + VR sub-strategies, builds 2m/5m bars from 1m input, emits signals with filter results |
| **MNQMomentumStrategy** | `mnq_momentum_strategy.js` | V1 strategy (EMAX + PB only, no VR). Kept for reference. |
| **OpeningRangeBreakoutStrategy** | `opening_range_breakout.js` | Legacy MES ORB strategy. Still loadable via `STRATEGY=opening_range_breakout` |

### 2.4b Indicators (`src/indicators/`)

| Component | File | Responsibility |
|-----------|------|----------------|
| **VWAPEngine** | `VWAPEngine.js` | Session VWAP, sigma bands (±1σ, ±2σ), prior day levels (HOD/LOD/Close/VWAP/POC), volume profile |
| **ConfluenceScorer** | `ConfluenceScorer.js` | Scores signals based on VWAP position, prior day levels, volume, momentum |
| **Indicators** | `index.js` | SMA, EMA, ZLEMA, ATR, RSI, Bollinger Bands, MACD, Stochastic, ADX |

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

### 3.1 Market Data Flow (Live)

```
Databento Live API (TCP) — ohlcv-1m schema
         │
         ▼
  databento_stream.py (Python subprocess)
         │ (JSON lines via stdout)
         ▼
  DatabentoPriceProvider._handleOHLCV()
         │
         ├──► Dedup: MNQ.FUT delivers bars from front + back month
         │    at same timestamp. Keep highest-volume bar only.
         │    (3-second flush timer for late arrivals)
         │
         ▼
  TradovateBot._onBar(bar)
         │
         ├──► _isInSession(bar.timestamp)?  ← 6:30 AM - 1:00 PM PST
         │    NO → silently drop (pre/post-market)
         │    YES ↓
         │
         ├──► _warmingUp? → block (historical replay in progress)
         │
         ▼
  MNQMomentumStrategyV2.onBar(bar)
         │
         ├──► Feed to VWAPEngine (updates VWAP, sigma bands, volume profile)
         ├──► Update 1m bar buffer
         ├──► Build 2m bars (aggregate pairs of 1m bars)
         │    └──► On 2m close: _checkEMAX() — EMA9/21 crossover
         ├──► Build 5m bars (aggregate groups of 5x 1m bars)
         │    └──► On 5m close: _checkPB() — impulse + retrace + bounce
         ├──► Every 1m bar: _checkVR() — VWAP mean reversion ±σ
         │
         ▼
  Emit 'signal' Event (with strategy name, filterResults, vwapState)
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
1. **Databento** streams 1-minute OHLCV bars via Python subprocess
2. **Session gate** (`_isInSession`) drops pre/post-market bars
3. **Strategy** builds 2m bars (EMAX) and 5m bars (PB) from 1m input
4. **VWAP Engine** updates session VWAP, sigma bands, volume profile
5. **Sub-strategy checks** run on their respective timeframes:
   - **EMAX**: EMA9/21 crossover on 2m bars, body≥50%, range≥5pt, cutoff 8:00 AM
   - **PB**: 5m impulse≥15pt, 20-60% retrace, bounce confirmation, cutoff 9:30 AM
   - **VR**: Price at ±1.3σ from VWAP, reversal bar, 8:30-11:00 AM window
6. **Signal emitted** with strategy name, filterResults, vwapState, confluenceScore

### Phase 2: Signal Validation (TradovateBot._onSignal → SignalHandler)
1. **Warmup check**: `_warmingUp` flag blocks signals during historical replay
2. **Thursday block**: Optional (DISABLE_THURSDAY env var)
3. **Entry cutoff**: Past 11:00 AM PST? Block.
4. **Processing lock**: `_processingSignal` prevents race conditions
5. **Position check**: Already in a trade? Block.
6. **Market hours**: CME Globex open? Holiday calendar check.
7. **Loss limits**: Daily/weekly/consecutive limits not exceeded?
8. **Session filter**: Trading hours, lunch avoidance

### Phase 3: Position Sizing & Execution
1. **Risk calculation**: `dollarRiskPerContract = (priceRisk / tickSize) × tickValue`
2. **Size**: `contracts = floor(maxRisk / dollarRiskPerContract)`, min 1
3. **Validation**: Stop too wide? Target too close (<60pt)? Reject.
4. **Bracket order**: Market entry + stop + target via Tradovate API
5. **State**: `currentPosition` stored with `orderId`, `stopOrderId`, `strategyName`, `entryTime`
6. **ProfitManager**: Initialized with entry order ID for BE stop tracking
7. **Telegram**: Entry notification with strategy name, levels, filters

### Phase 4: Position Management (every 1m bar)
1. **ProfitManager.update()**: Checks if price reached 2.5R → MOVE_STOP action
2. **BE stop**: Modifies stop order on exchange to entry + $1 via `client.modifyOrder()`
3. **Telegram**: Stop moved notification with R-multiple

### Phase 5: Exit & Recording
1. **Fill event** from Tradovate WebSocket
2. **P&L**: `(exitPrice - entryPrice) × quantity × pointValue` (MNQ: $2.00/pt)
3. **R-multiple**: `pnl / riskAmount`
4. **Exit reason**: Target hit, stop hit, EOD close, manual
5. **Record**: PerformanceTracker, TradeAnalyzer, LossLimits (sync save)
6. **Telegram**: Exit notification with P&L, R-multiple, duration
7. **Cleanup**: `strategy.setPosition(null)`, `signalHandler.clearPosition()`, `profitManager.closePosition(entryOrderId)`

### Phase 6: EOD Close (12:55 PM PST)
1. **Cancel all bracket orders** (stop + target) via `client.cancelAllOrders()`
2. **Flatten position** via market order
3. **Clean up local state** (strategy, signalHandler, profitManager, trailingStop)
4. **Telegram**: EOD close notification

### Phase 7: Daily Report (1:00 PM PST)
1. **Always fires** — win, loss, or no trades
2. **Telegram**: Compact summary with trade list, W/L, P&L, PF
3. **Log file**: `logs/daily_YYYY-MM-DD.json`

---

## 5. AI Confirmation (Currently OFF)

AI confirmation is **disabled** in V2.3 (`AI_CONFIRMATION_ENABLED=false`). Backtest data shows it costs -$232 on 3-week live and only +$85 on 12-month. The strategy's built-in filters are sufficient.

When enabled, the AI scores signals 1-10 and rejects scores <4. It receives VWAP state, sigma bands, trade count today, prior trade result, and day of week. Supports OpenAI and Anthropic providers.

---

## 6. Risk Management Behavior

### 6.1 Position Sizing

```javascript
// From RiskManager.calculatePositionSize()
priceRisk = |entryPrice - stopLoss|
dollarRiskPerContract = (priceRisk / tickSize) × tickValue  // = priceRisk × pointValue
// MNQ: 10pt stop = 10 × $2.00 = $20 risk per contract

// Guard: reject if 1 contract > max risk
if (dollarRiskPerContract > riskPerTrade.max) → REJECT

contracts = max(1, floor(riskPerTrade.max / dollarRiskPerContract))
```

### 6.2 Loss Limits (V2.3 Defaults)

| Limit | Default | Behavior |
|-------|---------|----------|
| Daily Loss | $150 | Halt trading for day |
| Weekly Loss | $300 | Halt trading for week |
| Max Consecutive Losses | 3 | Halt trading for day |
| Max Drawdown | 10% | Halt trading |

### 6.3 Halt Conditions

Halts are persisted to `data/loss_limits_state.json` (sync save) and survive restarts.
- Daily limits: Reset at midnight PST
- Weekly limits: Reset on Sunday
- Consecutive losses: Reset on next trading day

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

## 8. Configuration & Environment Variables (V2.3)

### 8.1 Required Variables

| Variable | Description |
|----------|-------------|
| `TRADOVATE_ENV` | `demo` or `live` |
| `TRADOVATE_USERNAME` | Account username |
| `TRADOVATE_PASSWORD` | Account password |
| `CONTRACT_SYMBOL` | `MNQH6` (March 2026 MNQ) |
| `DATABENTO_API_KEY` | Databento API key (starts with `db-`) |
| `DATABENTO_SYMBOL` | `MNQ.FUT` (parent symbol) |

### 8.2 Strategy Configuration (V2.3)

| Variable | Value | Description |
|----------|-------|-------------|
| `STRATEGY` | `mnq_momentum_v2` | Active strategy |
| `EMAX_ENABLED` | `false` | EMAX sub-strategy (PF 0.80-0.89) |
| `EMAX_EMA_FAST/SLOW` | `9/21` | EMA periods for 2m bars |
| `EMAX_MAX_TIME` | `480` | 8:00 AM PST cutoff |
| `PB_MIN_IMPULSE` | `15` | Min 5m impulse move (points) |
| `PB_MAX_TIME` | `570` | 9:30 AM PST cutoff |
| `VR_ENABLED` | `true` | VWAP Mean Reversion |
| `VR_MIN_SIGMA` | `1.3` | Min sigma distance for entry |
| `VR_MIN_TIME` | `510` | 8:30 AM PST window start |
| `VR_MAX_TIME` | `660` | 11:00 AM PST window end |
| `VR_TARGET_R` | `4` | VR target (fixed 4R) |
| `PROFIT_TARGET_R` | `5` | PB target (5R) |
| `MAX_STOP_POINTS` | `25` | Max stop distance |
| `MIN_TARGET_POINTS` | `60` | Min target distance |
| `STOP_BUFFER` | `2` | Points added to stop |

### 8.3 Risk Configuration

| Variable | Value | Description |
|----------|-------|-------------|
| `RISK_PER_TRADE_MIN` | `10` | Min risk per trade ($) |
| `RISK_PER_TRADE_MAX` | `50` | Max risk per trade ($) |
| `DAILY_LOSS_LIMIT` | `150` | Daily loss limit ($) |
| `WEEKLY_LOSS_LIMIT` | `300` | Weekly loss limit ($) |
| `MAX_CONSECUTIVE_LOSSES` | `3` | Halt after 3 consecutive losses |

### 8.4 Session Configuration (PST)

| Variable | Value | Description |
|----------|-------|-------------|
| `TRADING_START_HOUR` | `6` | 6:30 AM PST session start |
| `TRADING_START_MINUTE` | `30` | |
| `TRADING_END_HOUR` | `13` | 1:00 PM PST session end |
| `TRADING_END_MINUTE` | `0` | |
| `LAST_ENTRY_HOUR` | `11` | 11:00 AM PST last entry |
| `TIMEZONE` | `America/Los_Angeles` | All times in PST/PDT |

### 8.5 Order Management

| Variable | Value | Description |
|----------|-------|-------------|
| `TRAILING_STOP_ENABLED` | `false` | Trailing stops OFF (hurts MNQ) |
| `MOVE_STOP_TO_BE` | `true` | Break-even stop ON |
| `BE_ACTIVATION_R` | `2.5` | Move stop at 2.5R |
| `PARTIAL_PROFIT_ENABLED` | `false` | Partials OFF |
| `AI_CONFIRMATION_ENABLED` | `false` | AI OFF (costs P&L) |

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

| Notification | Method | Trigger |
|--------------|--------|---------|
| **Trade Entry** | `tradeEntryDetailed()` | Signal executed — shows strategy (PB/VR/EMAX), levels, filters, VWAP |
| **Stop Moved** | `notifications.send()` | BE stop triggered at 2.5R — shows new stop, R-multiple |
| **Trade Exit** | `tradeExitDetailed()` | Fill received — shows entry→exit, P&L, R-multiple, duration |
| **EOD Close** | `notifications.send()` | 12:55 PM force-close — shows action and quantity |
| **Daily Report** | `dailyPerformanceReport()` | 1:00 PM — compact summary with trade list, W/L, P&L |
| **Bot Started** | `botStarted()` | Initialization complete |
| **Bot Stopped** | `botStopped()` | Graceful shutdown |
| **Trading Halted** | `tradingHalted()` | Loss limit reached |
| **Error** | `error()` | Critical errors |
| **AI Rejection** | `aiTradeRejected()` | AI rejects trade (only when AI enabled) |

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

## 13. Bug Fixes Applied

### V2.3 Fixes (2026-02-10) — 9 Bugs

| # | Severity | Bug | Fix | File |
|---|----------|-----|-----|------|
| 1 | CRITICAL | ProfitManager position ID mismatch — BE stop never triggered | Use `pos.orderId` to match SignalHandler init | TradovateBot.js |
| 2 | CRITICAL | `stopOrderId` not stored on position — exchange order never modified | Added to `currentPosition` in SignalHandler | SignalHandler.js |
| 3 | CRITICAL | `modifyOrder` called with 3 params, API takes 2 | Removed extra `accountId` param | TradovateBot.js |
| 4 | CRITICAL | `closePosition` used exit `fill.orderId` instead of entry | Use `currentPosition.orderId` | PositionHandler.js |
| 5 | HIGH | Signals fired during historical warmup | `_warmingUp` flag + `signalFired` reset | TradovateBot.js |
| 6 | MEDIUM | `profitTargetR` default was 4, should be 5 | Changed default | TradovateBot.js |
| 7 | LOW | Schedule banner hardcoded wrong times | Reads from `.env` | TradovateBot.js |
| 8 | HIGH | EOD close didn't cancel brackets or clean state | Cancel all orders + cleanup | TradovateBot.js |
| 9 | HIGH | DST time bomb: hardcoded UTC-8 in historical fetch | Wide UTC window + PST filter | TradovateBot.js |

### Earlier Fixes (2026-02-05)

| ID | Issue | Fix |
|----|-------|-----|
| CRITICAL-2 | Race condition on rapid signals | `_processingSignal` lock in SignalHandler |
| CRITICAL-3 | Wrong tickValue for non-MES | Contract-specific lookup from CONTRACTS |
| CRITICAL-4 | Async state saves could lose data | `saveStateSync()` for critical operations |
| HIGH-1 | Zero division in position sizing | Guard for invalid `dollarRiskPerContract` |
| HIGH-4 | No position sync on reconnect | `_syncPositionState()` after WebSocket reconnect |
| HIGH-7 | Trailing stop cosmetic only | Now calls `client.modifyOrder()` |
| P&L | Used `tickValue` ($0.50) instead of `pointValue` ($2.00) | Fixed in PositionHandler |

---

## 14. Session Lifecycle

```
Overnight: Databento stream stays connected, bars arrive but _isInSession drops them
  │
  ▼
12:00 AM PST — _todayResetDone flag resets (midnight)
  │
  ▼
 6:29 AM PST — Daily reset: strategy.resetDay(), clear flags, VWAP resets
  │
  ▼
 6:30 AM PST — Session start: live 1m bars flow through _isInSession → strategy
  │
  ├── 6:30-8:00 AM — EMAX window (if enabled)
  ├── 6:30-9:30 AM — PB window
  ├── 8:30-11:00 AM — VR window
  │
  ▼
12:55 PM PST — EOD: cancel brackets, flatten position, clean state
  │
  ▼
 1:00 PM PST — Daily report (Telegram + logs/daily_YYYY-MM-DD.json)
  │
  ▼
 1:00 PM+ — Post-session: bars still arrive, _isInSession drops them. Bot idle.
```

---

## 15. Notes

- **Dual-provider architecture**: Databento (data) + Tradovate (execution). No Tradovate market data used.
- **Python subprocess**: Databento live stream runs as `databento_stream.py` spawned by Node.js. Communicates via JSON lines on stdout.
- **Single-position trading**: Max 1 trade at a time, multiple per day. `_processingSignal` lock + `signalFired` flag enforce this.
- **DST-safe**: All time calculations use `America/Los_Angeles` timezone via `Intl.DateTimeFormat`. Historical data fetch uses wide UTC windows filtered by PST time.
- **Contract**: MNQH6 expires March 20, 2026. `AUTO_ROLLOVER=true` available for auto-switching.
- **Python 3.10+** with `databento` package required. Run `pip install -r requirements.txt`.

---

*Last updated: 2026-02-10 — V2.3 with 9 bug fixes, Telegram notifications, MNQ Momentum strategy.*
