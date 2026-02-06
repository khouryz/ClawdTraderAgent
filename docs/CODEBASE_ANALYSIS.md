# Codebase Analysis & Restructuring Plan

## Current Structure Overview

```
src/
├── api/
│   ├── auth.js          (153 lines) - Authentication
│   ├── client.js        (961 lines) - REST API client ⚠️ LARGE
│   └── websocket.js     (331 lines) - WebSocket handling
├── analytics/
│   ├── performance.js   - Trade performance tracking
│   └── trade_analyzer.js - AI learning system
├── backtest/
│   └── backtester.js    - Static backtesting
├── filters/
│   └── session_filter.js - Trading hours filter
├── orders/
│   ├── order_manager.js  - Order lifecycle
│   ├── profit_manager.js - Partial profits, break-even
│   └── trailing_stop.js  - Trailing stop management
├── risk/
│   ├── loss_limits.js   - Daily/weekly loss limits
│   └── manager.js       - Position sizing, risk calc
├── strategies/
│   ├── base.js          - Base strategy class
│   ├── enhanced_breakout.js - Main strategy
│   └── simple_breakout.js   - Simple version
├── utils/
│   ├── config_validator.js
│   ├── constants.js
│   ├── dynamic_sizing.js
│   ├── error_handler.js
│   ├── file_ops.js
│   ├── logger.js
│   ├── market_hours.js
│   ├── notifications.js
│   └── rate_limiter.js
└── index.js             (769 lines) - Main bot ⚠️ VERY LARGE
```

---

## Issues Identified

### 1. **index.js is a God Class** ⚠️ CRITICAL
The main `index.js` file is 769 lines and handles:
- Configuration loading
- Bot initialization
- Signal handling
- Order execution
- Fill handling
- Position management
- CLI commands
- Graceful shutdown

**Solution**: Split into separate modules:
- `src/bot/TradovateBot.js` - Core bot class
- `src/bot/SignalHandler.js` - Signal processing
- `src/bot/PositionHandler.js` - Position management
- `src/cli/commands.js` - CLI command handlers

### 2. **client.js is Too Large** ⚠️ HIGH
961 lines handling all API endpoints.

**Solution**: Split by domain:
- `src/api/client/base.js` - Base request handling
- `src/api/client/accounts.js` - Account operations
- `src/api/client/orders.js` - Order operations
- `src/api/client/market-data.js` - Market data operations
- `src/api/client/index.js` - Aggregated export

### 3. **No Data Buffer Abstraction** ⚠️ MEDIUM
Bar/tick data handling is scattered across:
- `strategies/base.js` (bars array)
- `strategies/enhanced_breakout.js` (indicator calculations)
- `backtest/backtester.js` (duplicate indicator logic)

**Solution**: Create `src/data/DataBuffer.js` with transformers

### 4. **Duplicate Indicator Calculations** ⚠️ MEDIUM
ATR, EMA, RSI calculations exist in:
- `enhanced_breakout.js`
- `backtester.js`

**Solution**: Create `src/indicators/` module:
- `src/indicators/atr.js`
- `src/indicators/ema.js`
- `src/indicators/rsi.js`
- `src/indicators/index.js`

### 5. **No Replay/Simulation Support** ⚠️ HIGH
Current backtester uses static historical data.
Tradovate offers Market Replay API for realistic simulation.

**Solution**: Port `ReplaySocket` from example repo

### 6. **Inconsistent Event Handling**
Some modules use EventEmitter, others use callbacks.

**Solution**: Standardize on EventEmitter pattern

### 7. **Too Many Root-Level Markdown Files** ⚠️ LOW
```
CHECKLIST.md, CLAWDBOT_GUIDE.md, COMPLETE.txt, CRITICAL_FIXES.md,
DEPLOY.md, IMPROVEMENTS.md, QUICKSTART.md, README.md, SETUP.md, STATUS.md
```

**Solution**: Consolidate into `docs/` folder:
- Keep only `README.md` at root
- Move others to `docs/`

### 8. **Missing TypeScript/JSDoc Types** ⚠️ LOW
No type definitions for better IDE support.

**Solution**: Add JSDoc comments or migrate to TypeScript

---

## Restructuring Plan

### Phase 1: Port High-Priority Features ✅ COMPLETE
1. ✅ Create `src/data/DataBuffer.js` - Data buffering with transformers
2. ✅ Create `src/api/websocket/ReplaySocket.js` - Market Replay support
3. ✅ Create `src/indicators/index.js` - Centralized indicator calculations
4. ✅ Create `src/backtest/ReplayBacktester.js` - Live replay backtesting

### Phase 2: Refactor Large Files ✅ COMPLETE
1. ✅ Split `index.js` into modular components:
   - `src/bot/TradovateBot.js` - Core bot class
   - `src/bot/SignalHandler.js` - Signal processing
   - `src/bot/PositionHandler.js` - Position management
   - `src/cli/commands.js` - CLI command handlers
   - `src/main.js` - New entry point
2. ✅ `client.js` kept as-is (already well-organized with sections)
3. ✅ Consolidated documentation into `docs/` folder

### Phase 3: Code Quality ✅ COMPLETE
1. ✅ Add JSDoc types - `src/types/index.js`
2. ✅ Standardize error handling - `src/utils/errors.js`
3. ✅ Add unit tests structure - `tests/unit/*.test.js`

---

## New Structure (Implemented)

```
src/
├── api/
│   ├── auth.js              - Authentication
│   ├── client.js            - REST API client (well-organized)
│   ├── websocket.js         - Main WebSocket
│   └── websocket/
│       └── ReplaySocket.js  - Market Replay WebSocket
├── bot/                     ← NEW MODULE
│   ├── index.js             - Module exports
│   ├── TradovateBot.js      - Core bot class (refactored)
│   ├── SignalHandler.js     - Signal processing
│   └── PositionHandler.js   - Position management
├── data/                    ← NEW MODULE
│   ├── index.js             - Module exports
│   └── DataBuffer.js        - Data buffering with transformers
├── indicators/              ← NEW MODULE
│   └── index.js             - All indicators (SMA, EMA, ATR, RSI, etc.)
├── types/                   ← NEW MODULE
│   └── index.js             - JSDoc type definitions
├── cli/                     ← NEW MODULE
│   └── commands.js          - CLI command handlers
├── backtest/
│   ├── backtester.js        - Static backtesting
│   └── ReplayBacktester.js  - Live replay backtesting
├── analytics/
├── filters/
├── orders/
├── risk/
├── strategies/
├── utils/
│   ├── errors.js            ← NEW: Standardized error classes
│   └── ... (other utils)
├── index.js                 - Original entry point (kept for compatibility)
└── main.js                  - New modular entry point
```

---

## Implementation Priority

| Priority | Task | Effort |
|----------|------|--------|
| 1 | Create DataBuffer with transformers | Medium |
| 2 | Create centralized indicators module | Medium |
| 3 | Port ReplaySocket for backtesting | High |
| 4 | Split index.js into modules | High |
| 5 | Split client.js into modules | Medium |
| 6 | Consolidate documentation | Low |
| 7 | Add JSDoc types | Low |
