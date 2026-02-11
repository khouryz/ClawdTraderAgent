# ClawdTraderAgent - Engineering Workflow & AI Rules

> **Generated**: 2026-02-05  
> **Last Updated**: 2026-02-10 (V2.3 — MNQ Momentum + 9 Bug Fixes)  
> **Purpose**: Development guidelines, safety boundaries, and AI modification rules  
> **Derived From**: Codebase structure and patterns analysis  
> **Version**: 2.3.0 — MNQ Momentum (PB + VR), Databento data, Tradovate execution

---

## 1. Project Structure Overview

```
ClawdTraderAgent/
├── src/
│   ├── ai/                 # AI confirmation module (currently OFF)
│   ├── analytics/          # Performance tracking & trade analysis
│   ├── api/                # Tradovate API client & WebSocket (EXECUTION ONLY)
│   ├── bot/                # Core bot components (PROTECTED)
│   │   ├── TradovateBot.js       # Main orchestrator, session manager, EOD close
│   │   ├── SignalHandler.js       # Signal validation, order placement, position init
│   │   └── PositionHandler.js     # Exit fills, P&L calculation, cleanup
│   ├── data/               # Databento price provider & Python bridge
│   │   ├── DatabentoPriceProvider.js  # Live stream + historical fetch + bar dedup
│   │   └── databento_stream.py        # Python live stream bridge (ohlcv-1m)
│   ├── filters/            # Session & time filters
│   │   └── session_filter.js      # Trading hours, lunch avoidance, holidays
│   ├── indicators/         # Technical indicators
│   │   ├── VWAPEngine.js          # Session VWAP, sigma bands, prior day levels
│   │   ├── ConfluenceScorer.js    # Multi-factor signal scoring
│   │   └── index.js               # EMA, ZLEMA, ATR, RSI, etc.
│   ├── orders/             # Order & position management (PROTECTED)
│   │   ├── profit_manager.js      # Break-even stop at 2.5R
│   │   ├── trailing_stop.js       # Trailing stops (currently OFF)
│   │   └── order_manager.js       # Order lifecycle, auto-cleanup
│   ├── risk/               # Risk management (PROTECTED)
│   │   ├── manager.js             # Position sizing, zero-division guard
│   │   └── loss_limits.js         # Daily/weekly/consecutive limits, sync save
│   ├── strategies/         # Trading strategies
│   │   ├── mnq_momentum_strategy_v2.js  # ACTIVE: EMAX + PB + VR
│   │   ├── mnq_momentum_strategy.js     # V1 (EMAX + PB only)
│   │   └── opening_range_breakout.js    # Legacy MES ORB
│   ├── utils/              # Utilities & helpers
│   │   ├── notifications.js       # Telegram: entry, stop, exit, daily report
│   │   ├── market_hours.js        # CME Globex hours + holiday calendar
│   │   ├── constants.js           # MNQ/MES contract specs (tick, pointValue)
│   │   └── logger.js, config_validator.js, etc.
│   └── index.js            # Main entry point
├── data/                   # Runtime data (trades, state, loss limits)
├── logs/                   # Daily report JSON files
├── backtest/               # Backtest data files (JSON)
├── .env                    # V2.3 configuration (SENSITIVE)
├── package.json            # Node.js dependencies
├── requirements.txt        # Python dependencies (databento)
├── ecosystem.config.js     # PM2 configuration
├── architecture.md         # System architecture doc
└── windsurf.md             # This file
```

---

## 2. Development Workflow

### 2.1 Setup

```bash
# 1. Clone repository
git clone <repo-url>
cd ClawdTraderAgent

# 2. Install Node.js dependencies
npm install

# 3. Install Python dependencies (requires Python 3.10+)
pip install -r requirements.txt

# 4. Configure environment
cp .env.example .env
# Edit .env with your Tradovate AND Databento credentials

# 5. Validate configuration
npm run validate
```

### 2.2 Development Commands

| Command | Purpose |
|---------|---------|
| `npm start` | Start bot in production mode |
| `npm run dev` | Start with file watching |
| `npm run test` | Run unit tests |
| `npm run backtest` | Run strategy backtest |
| `npm run replay` | Run market replay backtest |
| `npm run validate` | Validate configuration |

### 2.3 Testing Before Deployment

1. **Unit Tests**: `npm run test`
2. **Configuration Validation**: `npm run validate`
3. **Backtest**: `npm run backtest` (verify strategy performance)
4. **Demo Mode**: Set `TRADOVATE_ENV=demo` and run live
5. **Signal Check**: `node src/index.js --check` (one-shot test)

### 2.4 Deployment

```bash
# Using PM2 for production
pm2 start ecosystem.config.js

# Monitor
pm2 logs tradovate-bot
pm2 monit

# Restart
pm2 restart tradovate-bot

# Stop
pm2 stop tradovate-bot
```

---

## 3. Protected Modules

> ⚠️ **CRITICAL**: The following modules handle real money and must be modified with extreme caution.

### 3.1 Execution Layer (HIGH RISK)

| Module | File | Risk Level | Key Safeguards |
|--------|------|------------|----------------|
| **TradovateBot** | `src/bot/TradovateBot.js` | 🔴 CRITICAL | `_isInSession` gate, `_warmingUp` flag, EOD close + cancel brackets, position sync on reconnect |
| **SignalHandler** | `src/bot/SignalHandler.js` | 🔴 CRITICAL | `_processingSignal` lock, stores `stopOrderId` on position, `entryTime` tracking |
| **PositionHandler** | `src/bot/PositionHandler.js` | 🔴 CRITICAL | Uses `pointValue` (not tickValue) for P&L, uses `entryOrderId` for cleanup |
| **OrderManager** | `src/orders/order_manager.js` | 🔴 CRITICAL | Auto-cleanup, partial fill retry with remaining qty |
| **ProfitManager** | `src/orders/profit_manager.js` | 🔴 CRITICAL | BE stop at 2.5R, uses `pos.orderId` to match SignalHandler init |

**Modification Rules:**
- Never modify order placement logic without thorough testing
- Always validate P&L calculations with manual verification
- Test all changes in demo mode first
- **Never remove the `_processingSignal` lock** — prevents race conditions
- **Never bypass position check** at start of `handleSignal()`
- **Never change P&L from `pointValue` back to `tickValue`** — MNQ pointValue=$2.00, tickValue=$0.50
- **Never remove `_warmingUp` flag** — prevents signals during historical replay
- **Always use `entryOrderId` (not fill.orderId)** for ProfitManager/TrailingStop cleanup

### 3.2 Risk Management (HIGH RISK)

| Module | File | Risk Level |
|--------|------|------------|
| **RiskManager** | `src/risk/manager.js` | 🔴 CRITICAL | Has zero-division guard |
| **LossLimitsManager** | `src/risk/loss_limits.js` | 🔴 CRITICAL | Uses `saveStateSync()` |

**Modification Rules:**
- Never weaken loss limits without explicit user approval
- Position sizing changes require mathematical verification
- Halt conditions must never be bypassed
- Test edge cases (zero balance, max drawdown, etc.)
- **Always use `saveStateSync()` for critical state changes** (trade recording, halts)
- **Never remove the zero-division guard** in `calculatePositionSize()`

### 3.3 Capital Handling & Data (HIGH RISK)

| Module | File | Risk Level |
|--------|------|------------|
| **TradovateClient** | `src/api/client.js` | 🟠 HIGH | Order execution only |
| **TradovateAuth** | `src/api/auth.js` | 🟠 HIGH |
| **DatabentoPriceProvider** | `src/data/DatabentoPriceProvider.js` | 🟠 HIGH | Market data source |
| **databento_stream.py** | `src/data/databento_stream.py` | 🟠 HIGH | Python bridge for live data |

**Modification Rules:**
- Never log or expose API credentials
- Rate limiting must not be disabled
- Retry logic changes require careful testing

### 3.4 Medium Risk Modules

| Module | File | Risk Level | Notes |
|--------|------|------------|-------|
| **MNQMomentumStrategyV2** | `src/strategies/mnq_momentum_strategy_v2.js` | 🟡 MEDIUM | Active strategy — EMAX + PB + VR |
| **VWAPEngine** | `src/indicators/VWAPEngine.js` | 🟡 MEDIUM | Session VWAP, sigma bands, prior day levels |
| **TrailingStopManager** | `src/orders/trailing_stop.js` | 🟡 MEDIUM | Currently OFF, but modifies exchange orders when enabled |
| **SessionFilter** | `src/filters/session_filter.js` | 🟡 MEDIUM | 6:30 AM - 1:00 PM PST |
| **MarketHours** | `src/utils/market_hours.js` | 🟡 MEDIUM | CME holiday calendar 2025-2026 |
| **AIConfirmation** | `src/ai/AIConfirmation.js` | 🟡 MEDIUM | Currently OFF (AI_CONFIRMATION_ENABLED=false) |
| **DatabentoPriceProvider** | `src/data/DatabentoPriceProvider.js` | 🟡 MEDIUM | Live dedup + historical dedup |

### 3.5 Low Risk Modules

| Module | File | Risk Level |
|--------|------|------------|
| **Notifications** | `src/utils/notifications.js` | 🟢 LOW | Telegram entry/stop/exit/daily report |
| **Logger** | `src/utils/logger.js` | 🟢 LOW |
| **Indicators** | `src/indicators/index.js` | 🟢 LOW | EMA, ZLEMA, ATR, RSI |
| **ConfluenceScorer** | `src/indicators/ConfluenceScorer.js` | 🟢 LOW |
| **TradeAnalyzer** | `src/analytics/trade_analyzer.js` | 🟢 LOW |
| **PerformanceTracker** | `src/analytics/performance.js` | 🟢 LOW |

---

## 4. AI Modification Rules

### 4.1 Allowed Modifications (Without Approval)

✅ **Safe to modify:**
- Logging messages and formats
- Notification text and formatting
- Documentation and comments
- Test files
- Indicator calculations (with tests)
- Analytics and reporting
- UI/display formatting

### 4.2 Requires Explicit Approval

⚠️ **Ask before modifying:**
- Strategy entry/exit logic
- Filter conditions
- Trailing stop behavior
- Partial profit logic
- Session filter rules
- AI confirmation prompts

### 4.3 Never Modify Without Review

🚫 **Do not modify without thorough review:**
- Order placement code
- Position sizing calculations
- P&L calculations
- Loss limit thresholds
- Halt conditions
- API authentication
- Rate limiting
- **`_processingSignal` lock in SignalHandler** (CRITICAL-2 fix)
- **`saveStateSync()` calls in LossLimitsManager** (CRITICAL-4 fix)
- **Zero-division guard in RiskManager** (HIGH-1 fix)
- **Position sync in TradovateBot** (HIGH-4 fix)
- **Exchange order modification in TrailingStopManager** (HIGH-7 fix)

### 4.4 Code Style Rules

```javascript
// ✅ DO: Add null checks before property access
if (!signal || !signal.type || signal.price === undefined) {
  return { executed: false, reason: 'Invalid signal' };
}

// ✅ DO: Use consistent property names
const fillQty = fill.qty || fill.quantity || 1;

// ✅ DO: Use pointValue (NOT tickValue) for P&L calculations
const { CONTRACTS } = require('../utils/constants');
const baseSymbol = (contract?.name || 'MNQ').substring(0, 3);
const contractSpecs = CONTRACTS[baseSymbol] || CONTRACTS.MNQ;
const pointValue = contractSpecs.pointValue; // MNQ=$2.00, MES=$5.00
const pnl = (exitPrice - entryPrice) * quantity * pointValue;

 // ✅ DO: Log important state changes
logger.trade(`📊 Signal received: ${signal.type.toUpperCase()}`);

// ✅ DO: Use position lock pattern (CRITICAL-2 FIX)
if (this._processingSignal) {
  return { executed: false, reason: 'Already processing signal' };
}
this._processingSignal = true;
try {
  // ... process signal
} finally {
  this._processingSignal = false;
}

// ✅ DO: Use sync saves for critical state (CRITICAL-4 FIX)
this.saveStateSync(); // Not this.saveState()

// ❌ DON'T: Hardcode values that should be configurable
const risk = 45; // BAD - should use config

// ❌ DON'T: Suppress errors silently
try { ... } catch (e) { } // BAD - log the error

// ❌ DON'T: Bypass safety checks
// if (lossLimits.isHalted) return; // Never remove this

// ❌ DON'T: Hardcode tickValue fallback
const tickValue = 5; // BAD - use contract-specific lookup
```

---

## 5. Testing Expectations

### 5.1 Required Tests for Changes

| Change Type | Required Tests |
|-------------|----------------|
| Strategy logic | Backtest + Demo trading |
| Risk calculations | Unit tests + Manual verification |
| Order handling | Demo mode integration test |
| P&L calculations | Unit tests with known values |
| API changes | Integration tests |
| Filter changes | Unit tests + Backtest |

### 5.2 Test File Locations

```
tests/
├── run-tests.js              # Test runner
├── test-ai-confirmation.js   # AI confirmation tests
└── unit/
    └── *.test.js             # Unit tests
```

### 5.3 Writing Tests

```javascript
// Example test structure
async function testPositionSizing() {
  const riskManager = new RiskManager({
    riskPerTrade: { min: 45, max: 45 },
    profitTargetR: 2
  });
  
  const position = riskManager.calculatePositionSize(
    10000,    // balance
    5000,     // entry price
    4990,     // stop loss
    0.25,     // tick size
    1.25      // tick value
  );
  
  assert(position.contracts === 1, 'Should calculate 1 contract');
  assert(position.totalRisk <= 45, 'Risk should not exceed max');
}
```

---

## 6. Safety Checklist Before Merging

### 6.1 Pre-Merge Checklist

- [ ] All unit tests pass (`npm run test`)
- [ ] Configuration validates (`npm run validate`)
- [ ] Backtest shows no regression (`npm run backtest`)
- [ ] Demo mode tested (if touching execution code)
- [ ] No hardcoded credentials or API keys
- [ ] No disabled safety checks
- [ ] P&L calculations verified manually
- [ ] Error handling present for all API calls
- [ ] Logging added for debugging
- [ ] No console.log in production code (use logger)

### 6.2 Critical Path Review

For changes to protected modules:

1. **Identify all affected code paths**
2. **Trace data flow from input to output**
3. **Verify edge cases:**
   - Zero/null values
   - Maximum values
   - Network failures
   - Timeout scenarios
4. **Test in demo mode with real market data**
5. **Monitor first live session closely**

### 6.3 Rollback Plan

Always have a rollback plan:

```bash
# Quick rollback
git stash
git checkout main

# Or revert specific commit
git revert <commit-hash>

# Emergency stop
pm2 stop tradovate-bot
```

---

## 7. Environment Configuration Safety

### 7.1 Sensitive Variables

| Variable | Sensitivity | Notes |
|----------|-------------|-------|
| `TRADOVATE_PASSWORD` | 🔴 HIGH | Never log |
| `TRADOVATE_SECRET` | 🔴 HIGH | Never log |
| `DATABENTO_API_KEY` | 🔴 HIGH | Never log |
| `AI_API_KEY` | 🔴 HIGH | Never log |
| `TELEGRAM_BOT_TOKEN` | 🟠 MEDIUM | Don't expose |

### 7.2 Configuration Validation

The system validates configuration on startup via `ConfigValidator`:

- Required fields present
- Numeric ranges valid
- Risk limits sensible
- Session times valid

### 7.3 Environment Switching

```bash
# Demo mode (safe for testing)
TRADOVATE_ENV=demo

# Live mode (real money!)
TRADOVATE_ENV=live
```

> ⚠️ **Always test in demo mode first!**

---

## 8. Common Patterns

### 8.1 Event-Driven Architecture

```javascript
// Components communicate via events
strategy.on('signal', (signal) => signalHandler.handleSignal(signal));
orderWs.on('fill', (fill) => positionHandler.handleFill(fill));
lossLimits.on('halt', (data) => notifications.tradingHalted(data));
```

### 8.2 Error Handling Pattern

```javascript
try {
  const result = await riskyOperation();
  return result;
} catch (error) {
  const errorInfo = ErrorHandler.handle(error, { 
    component: 'ComponentName', 
    action: 'actionName' 
  });
  
  if (errorInfo.recovery.action === 'HALT') {
    await this.halt(errorInfo.code);
  }
  
  throw error;
}
```

### 8.3 Null Safety Pattern

```javascript
// Always check before accessing nested properties
const value = obj?.nested?.property ?? defaultValue;

// Validate function inputs
if (!input || typeof input !== 'object') {
  return { success: false, error: 'Invalid input' };
}
```

### 8.4 Async/Await Pattern

```javascript
// Use async/await consistently
async function processSignal(signal) {
  const validation = await validateSignal(signal);
  if (!validation.valid) return;
  
  const position = await calculatePosition(signal);
  const order = await placeOrder(position);
  
  return order;
}
```

---

## 9. Debugging Guide

### 9.1 Enable Debug Logging

```javascript
// Use logger.debug() for verbose output
logger.debug(`[AI] Processing signal: ${JSON.stringify(signal)}`);
```

### 9.2 Common Issues

| Issue | Likely Cause | Solution |
|-------|--------------|----------|
| "logger.X is not a function" | Missing method in logger | Add method to `src/utils/logger.js` |
| P&L incorrect | Missing tick value multiplier | Use contract-specific lookup (CRITICAL-3) |
| Trades not executing | Loss limits halted | Check `data/loss_limits_state.json` |
| WebSocket disconnects | Network issues | Position sync happens on reconnect (HIGH-4) |
| AI always confirms | Hardcoded response | Check actual API response |
| Duplicate positions | Race condition | Check `_processingSignal` lock (CRITICAL-2) |
| Trailing stop not moving | Not modifying exchange | Check `setClient()` called (HIGH-7) |
| State lost after crash | Async saves | Use `saveStateSync()` (CRITICAL-4) |
| Infinite contracts | Zero division | Check stop distance (HIGH-1) |

### 9.3 Log Locations

```
logs/
├── pm2-out.log    # Standard output
└── pm2-error.log  # Error output

data/
├── trades.json           # Trade history
├── loss_limits_state.json # Loss limits state
└── trade_analysis.json   # Trade analysis
```

---

## 10. Quick Reference

### 10.1 Key Files to Know

| Purpose | File |
|---------|------|
| Main entry | `src/index.js` |
| Bot orchestrator | `src/bot/TradovateBot.js` |
| **Active strategy** | `src/strategies/mnq_momentum_strategy_v2.js` |
| **VWAP engine** | `src/indicators/VWAPEngine.js` |
| Market data provider | `src/data/DatabentoPriceProvider.js` |
| Python data bridge | `src/data/databento_stream.py` |
| Signal processing | `src/bot/SignalHandler.js` |
| Position management | `src/bot/PositionHandler.js` |
| BE stop management | `src/orders/profit_manager.js` |
| Risk calculations | `src/risk/manager.js` |
| Loss limits | `src/risk/loss_limits.js` |
| Notifications | `src/utils/notifications.js` |
| Constants | `src/utils/constants.js` |

### 10.2 Contract Specifications

| Contract | Tick Size | Tick Value | Point Value | Current Symbol |
|----------|-----------|------------|-------------|----------------|
| **MNQ** | 0.25 | $0.50 | **$2.00** | MNQH6 (Mar 2026) |
| MES | 0.25 | $1.25 | $5.00 | - |
| MYM | 1.00 | $0.50 | $0.50 | - |

> ⚠️ **P&L uses `pointValue`, NOT `tickValue`**. MNQ: 10pt move = $20 (not $5).

### 10.3 V2.3 Risk Parameters

| Parameter | Value |
|-----------|-------|
| Risk per trade | $10-$50 |
| PB profit target | 5R |
| VR profit target | 4R |
| Max stop | 25 points |
| Min target | 60 points |
| BE stop activation | 2.5R |
| Daily loss limit | $150 |
| Weekly loss limit | $300 |
| Max consecutive losses | 3 |
| Trailing stop | OFF |
| Partial profits | OFF |
| AI confirmation | OFF |

---

## 11. Safeguards — NEVER REMOVE

These are critical fixes that prevent real-money bugs. Never remove or weaken them.

| Safeguard | Location | What It Does |
|-----------|----------|--------------|
| `_processingSignal` lock | `SignalHandler.handleSignal()` | Prevents race conditions on rapid signals |
| `_warmingUp` flag | `TradovateBot._onSignal()` | Blocks signals during historical replay |
| `_isInSession()` gate | `TradovateBot._onBar()` | Drops pre/post-market bars |
| `pointValue` for P&L | `PositionHandler._processExitFill()` | MNQ=$2.00/pt (not tickValue=$0.50) |
| `entryOrderId` cleanup | `PositionHandler._processExitFill()` | Uses entry orderId, not exit fill orderId |
| `stopOrderId` on position | `SignalHandler` lines 253, 306 | Stored so BE stop can modify exchange order |
| `saveStateSync()` | `LossLimitsManager` | Sync saves prevent data loss on crash |
| Zero-division guard | `RiskManager.calculatePositionSize()` | Prevents infinite contracts |
| Position sync | `TradovateBot._syncPositionState()` | Syncs state after WebSocket reconnect |
| EOD cancel + cleanup | `TradovateBot._startSessionManager()` | Cancels brackets, flattens, cleans local state |
| DST-safe time | `TradovateBot._loadInitialData()` | Wide UTC window + PST filter (no hardcoded offsets) |
| `signalFired` reset | `TradovateBot._loadInitialData()` | Reset after warmup so first live trade isn't blocked |

---

## 12. V2.3 Bug Fixes (2026-02-10)

| # | Severity | Bug | Fix |
|---|----------|-----|-----|
| 1 | CRITICAL | ProfitManager position ID mismatch | Use `pos.orderId` |
| 2 | CRITICAL | `stopOrderId` not stored on position | Added in SignalHandler |
| 3 | CRITICAL | `modifyOrder` called with 3 params | Removed extra `accountId` |
| 4 | CRITICAL | `closePosition` used wrong orderId | Use `currentPosition.orderId` |
| 5 | HIGH | Signals fired during warmup | `_warmingUp` flag |
| 6 | MEDIUM | `profitTargetR` default was 4 | Changed to 5 |
| 7 | LOW | Schedule banner hardcoded | Reads from `.env` |
| 8 | HIGH | EOD didn't cancel brackets | Cancel all + cleanup |
| 9 | HIGH | DST time bomb in historical fetch | Wide UTC window + PST filter |

---

*This document defines the engineering workflow and safety boundaries for ClawdTraderAgent development.*
*Last updated: 2026-02-10 — V2.3 with MNQ Momentum strategy, 9 bug fixes, Telegram notifications.*
