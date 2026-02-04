# ClawdTraderAgent - Clawdbot Integration Guide

## Overview

This trading bot is designed to work with **Clawdbot** for automated futures trading on Tradovate. All commands output JSON for easy parsing by Clawdbot.

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your Tradovate credentials

# Test configuration
npm test

# Run bot commands
node src/index.js --status    # Get current status
node src/index.js --balance   # Get account balance
node src/index.js --positions # Get open positions
node src/index.js --report    # Get performance report
node src/index.js --check     # Check for trade signals
node src/index.js             # Start continuous trading mode
```

## Clawdbot Cron Job Examples

### Check Status Every 5 Minutes
```
openclaw cron add \
  --name "Trading Status" \
  --cron "*/5 * * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Run: node /path/to/ClawdTraderAgent/src/index.js --status"
```

### Check for Signals During Market Hours
```
openclaw cron add \
  --name "Signal Check" \
  --cron "*/5 9-16 * * 1-5" \
  --tz "America/New_York" \
  --session isolated \
  --message "Run: node /path/to/ClawdTraderAgent/src/index.js --check"
```

### Daily Performance Report at 4:30 PM
```
openclaw cron add \
  --name "Daily Report" \
  --cron "30 16 * * 1-5" \
  --tz "America/New_York" \
  --session isolated \
  --message "Run: node /path/to/ClawdTraderAgent/src/index.js --report"
```

### Morning Balance Check at 9:00 AM
```
openclaw cron add \
  --name "Morning Balance" \
  --cron "0 9 * * 1-5" \
  --tz "America/New_York" \
  --session isolated \
  --message "Run: node /path/to/ClawdTraderAgent/src/index.js --balance"
```

## Command Output Examples

### --status
```json
{
  "timestamp": "2026-02-04T23:41:00.000Z",
  "environment": "demo",
  "account": { "id": 12345, "name": "Demo Account" },
  "balance": { "cash": 5000, "realizedPnL": 150, "openPnL": 0 },
  "positions": { "open": [], "count": 0 },
  "orders": { "working": [], "count": 0 },
  "session": { "canTrade": true, "session": "REGULAR" },
  "lossLimits": { "dailyPnL": -50, "isHalted": false }
}
```

### --balance
```json
{
  "timestamp": "2026-02-04T23:41:00.000Z",
  "accountId": 12345,
  "accountName": "Demo Account",
  "cashBalance": 5000.00,
  "realizedPnL": 150.00,
  "openPnL": 0.00
}
```

### --positions
```json
{
  "timestamp": "2026-02-04T23:41:00.000Z",
  "accountId": 12345,
  "positions": [],
  "count": 0
}
```

### --report
```json
{
  "timestamp": "2026-02-04T23:41:00.000Z",
  "accountBalance": 5000.00,
  "session": { "trades": 3, "pnl": 75.00 },
  "today": { "trades": 3, "wins": 2, "losses": 1, "winRate": 66.7, "pnl": 75.00 },
  "overall": { "totalTrades": 50, "winRate": 55.0, "totalPnL": 450.00 }
}
```

### --check
```json
{
  "canTrade": true,
  "session": { "allowed": true, "session": "REGULAR" },
  "strategyStatus": { "barsCount": 100, "recentHigh": 5250.00, "recentLow": 5200.00 },
  "barsLoaded": 100
}
```

## Project Structure

```
ClawdTraderAgent/
├── src/
│   ├── index.js              # Main entry point with CLI commands
│   ├── api/
│   │   ├── auth.js           # Tradovate authentication
│   │   ├── client.js         # REST API client (comprehensive)
│   │   └── websocket.js      # WebSocket with exponential backoff
│   ├── analytics/
│   │   └── performance.js    # Trade performance tracking
│   ├── filters/
│   │   └── session_filter.js # Trading session restrictions
│   ├── orders/
│   │   ├── order_manager.js  # Order lifecycle management
│   │   ├── profit_manager.js # Partial profits, break-even
│   │   └── trailing_stop.js  # ATR-based trailing stops
│   ├── risk/
│   │   ├── loss_limits.js    # Daily/weekly loss limits
│   │   └── manager.js        # Position sizing
│   ├── strategies/
│   │   ├── base.js           # Base strategy class
│   │   ├── enhanced_breakout.js  # Main strategy with filters
│   │   └── simple_breakout.js    # Simple reference strategy
│   └── utils/
│       └── logger.js         # Logging utility
├── config/
│   └── contracts.json        # Contract specifications
├── data/                     # Persisted data (auto-created)
│   ├── trades.json           # Trade history
│   ├── daily_stats.json      # Daily statistics
│   └── loss_limits_state.json # Loss limit state
├── logs/                     # Log files (auto-created)
├── .env                      # Your configuration
├── .env.example              # Configuration template
└── package.json
```

## Configuration Options

| Variable | Description | Default |
|----------|-------------|---------|
| `TRADOVATE_ENV` | `demo` or `live` | `demo` |
| `TRADOVATE_USERNAME` | Your email | *required* |
| `TRADOVATE_PASSWORD` | Your password | *required* |
| `CONTRACT_SYMBOL` | Contract to trade | `MESM5` |
| `AUTO_ROLLOVER` | Auto-switch to front month | `false` |
| `RISK_PER_TRADE_MIN` | Minimum risk per trade | `30` |
| `RISK_PER_TRADE_MAX` | Maximum risk per trade | `60` |
| `PROFIT_TARGET_R` | Profit target (R multiple) | `2` |
| `DAILY_LOSS_LIMIT` | Max daily loss before halt | `150` |
| `WEEKLY_LOSS_LIMIT` | Max weekly loss before halt | `300` |
| `MAX_CONSECUTIVE_LOSSES` | Halt after N losses | `3` |
| `MAX_DRAWDOWN_PERCENT` | Max drawdown % before halt | `10` |
| `USE_TREND_FILTER` | Require trend alignment | `true` |
| `USE_VOLUME_FILTER` | Require volume spike | `true` |
| `USE_RSI_FILTER` | Require RSI confirmation | `true` |
| `AVOID_LUNCH` | Skip 12-2 PM trading | `true` |
| `TRAILING_STOP_ENABLED` | Use trailing stops | `false` |
| `PARTIAL_PROFIT_ENABLED` | Take partial profits | `false` |

## Safety Features

- **Demo mode by default** - Test before going live
- **Daily/weekly loss limits** - Automatic trading halt
- **Consecutive loss protection** - Pause after losing streak
- **Max drawdown protection** - Halt at X% drawdown
- **Session filters** - Only trade during optimal hours
- **Trend/volume/RSI filters** - Reduce false signals
- **Bracket orders** - Every trade has stop-loss + target

## Troubleshooting

### Authentication Failed
- Check your Tradovate username/password in `.env`
- Ensure you're using the correct environment (demo vs live)

### No Trades Executing
- Check session filter: `node src/index.js --status`
- Check loss limits: Look at `lossLimits.isHalted` in status
- Verify market hours and contract symbol

### WebSocket Disconnects
- Bot auto-reconnects with exponential backoff
- Max 10 reconnect attempts before giving up
- Check logs for connection errors

## Support

For issues with:
- **Tradovate API**: https://community.tradovate.com/
- **Clawdbot**: https://docs.openclaw.ai/
