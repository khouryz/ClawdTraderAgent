# ClawdTraderAgent - Engineering Workflow & AI Rules

> **Generated**: 2026-02-05  
> **Purpose**: Development guidelines, safety boundaries, and AI modification rules  
> **Derived From**: Codebase structure and patterns analysis

---

## 1. Project Structure Overview

```
ClawdTraderAgent/
├── src/
│   ├── ai/                 # AI confirmation module
│   ├── analytics/          # Performance tracking & trade analysis
│   ├── api/                # Tradovate API client & WebSocket
│   ├── backtest/           # Backtesting engines
│   ├── bot/                # Core bot components (PROTECTED)
│   ├── cli/                # CLI command handlers
│   ├── data/               # Data buffers & transformers
│   ├── filters/            # Session & time filters
│   ├── indicators/         # Technical indicators
│   ├── orders/             # Order & position management (PROTECTED)
│   ├── risk/               # Risk management (PROTECTED)
│   ├── strategies/         # Trading strategies
│   ├── types/              # TypeScript-style JSDoc types
│   ├── utils/              # Utilities & helpers
│   ├── index.js            # Main entry point
│   └── main.js             # Alternative entry point
├── config/
│   └── contracts.json      # Contract specifications
├── presets/                # Trading presets (conservative, balanced, aggressive)
├── tests/                  # Test files
├── data/                   # Runtime data (trades, state)
├── logs/                   # Log files
├── docs/                   # Documentation
├── .env                    # Environment configuration (SENSITIVE)
├── .env.example            # Environment template
├── package.json            # Dependencies
└── ecosystem.config.js     # PM2 configuration
```

---

## 2. Development Workflow

### 2.1 Setup

```bash
# 1. Clone repository
git clone <repo-url>
cd ClawdTraderAgent

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your credentials

# 4. Validate configuration
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

| Module | File | Risk Level |
|--------|------|------------|
| **SignalHandler** | `src/bot/SignalHandler.js` | 🔴 CRITICAL |
| **PositionHandler** | `src/bot/PositionHandler.js` | 🔴 CRITICAL |
| **TradovateBot** | `src/bot/TradovateBot.js` | 🔴 CRITICAL |
| **OrderManager** | `src/orders/order_manager.js` | 🔴 CRITICAL |

**Modification Rules:**
- Never modify order placement logic without thorough testing
- Always validate P&L calculations with manual verification
- Test all changes in demo mode first
- Require code review for any changes

### 3.2 Risk Management (HIGH RISK)

| Module | File | Risk Level |
|--------|------|------------|
| **RiskManager** | `src/risk/manager.js` | 🔴 CRITICAL |
| **LossLimitsManager** | `src/risk/loss_limits.js` | 🔴 CRITICAL |

**Modification Rules:**
- Never weaken loss limits without explicit user approval
- Position sizing changes require mathematical verification
- Halt conditions must never be bypassed
- Test edge cases (zero balance, max drawdown, etc.)

### 3.3 Capital Handling (HIGH RISK)

| Module | File | Risk Level |
|--------|------|------------|
| **TradovateClient** | `src/api/client.js` | 🟠 HIGH |
| **TradovateAuth** | `src/api/auth.js` | 🟠 HIGH |

**Modification Rules:**
- Never log or expose API credentials
- Rate limiting must not be disabled
- Retry logic changes require careful testing

### 3.4 Medium Risk Modules

| Module | File | Risk Level |
|--------|------|------------|
| **EnhancedBreakoutStrategy** | `src/strategies/enhanced_breakout.js` | 🟡 MEDIUM |
| **TrailingStopManager** | `src/orders/trailing_stop.js` | 🟡 MEDIUM |
| **ProfitManager** | `src/orders/profit_manager.js` | 🟡 MEDIUM |
| **SessionFilter** | `src/filters/session_filter.js` | 🟡 MEDIUM |

### 3.5 Low Risk Modules

| Module | File | Risk Level |
|--------|------|------------|
| **Notifications** | `src/utils/notifications.js` | 🟢 LOW |
| **Logger** | `src/utils/logger.js` | 🟢 LOW |
| **Indicators** | `src/indicators/index.js` | 🟢 LOW |
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

### 4.4 Code Style Rules

```javascript
// ✅ DO: Add null checks before property access
if (!signal || !signal.type || signal.price === undefined) {
  return { executed: false, reason: 'Invalid signal' };
}

// ✅ DO: Use consistent property names
const fillQty = fill.qty || fill.quantity || 1;

// ✅ DO: Include tick value in P&L calculations
const pnl = (exitPrice - entryPrice) * quantity * tickValue;

// ✅ DO: Log important state changes
logger.trade(`📊 Signal received: ${signal.type.toUpperCase()}`);

// ❌ DON'T: Hardcode values that should be configurable
const risk = 45; // BAD - should use config

// ❌ DON'T: Suppress errors silently
try { ... } catch (e) { } // BAD - log the error

// ❌ DON'T: Bypass safety checks
// if (lossLimits.isHalted) return; // Never remove this
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
| P&L incorrect | Missing tick value multiplier | Multiply by `tickValue` |
| Trades not executing | Loss limits halted | Check `data/loss_limits_state.json` |
| WebSocket disconnects | Network issues | Check reconnect logic |
| AI always confirms | Hardcoded response | Check actual API response |

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
| Signal processing | `src/bot/SignalHandler.js` |
| Position management | `src/bot/PositionHandler.js` |
| Risk calculations | `src/risk/manager.js` |
| Loss limits | `src/risk/loss_limits.js` |
| Strategy | `src/strategies/enhanced_breakout.js` |
| AI confirmation | `src/ai/AIConfirmation.js` |
| Notifications | `src/utils/notifications.js` |
| Constants | `src/utils/constants.js` |

### 10.2 Contract Specifications

| Contract | Tick Size | Tick Value | Point Value |
|----------|-----------|------------|-------------|
| MES | 0.25 | $1.25 | $5.00 |
| MNQ | 0.25 | $0.50 | $2.00 |
| MYM | 1.00 | $0.50 | $0.50 |

### 10.3 Default Risk Parameters

| Parameter | Default |
|-----------|---------|
| Risk per trade | $30-$60 |
| Profit target | 2R |
| Daily loss limit | $150 |
| Weekly loss limit | $300 |
| Max consecutive losses | 3 |
| Max drawdown | 10% |

---

*This document defines the engineering workflow and safety boundaries for ClawdTraderAgent development.*
