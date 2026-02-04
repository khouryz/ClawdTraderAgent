# Tradovate Trading Bot

Automated futures trading bot for small accounts (MES/MNQ).

## Features

- ✅ Tradovate API integration (REST + WebSocket)
- ✅ Real-time market data streaming
- ✅ Position sizing based on risk parameters ($30-$60)
- ✅ 2R+ profit targets
- ✅ Bracket orders (stop-loss + take-profit)
- ✅ Demo/Live environment switching
- 🔧 Customizable strategy engine

## Risk Management

- **Risk per trade:** $30-$60
- **Profit target:** 2R ($60-$120)
- **Contracts:** MES (Micro E-mini S&P 500) or MNQ (Micro E-mini Nasdaq)

## Setup

### 1. Install Dependencies

```bash
cd /root/clawd/tradovate-bot
npm install
```

### 2. Configure API Credentials

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` and add your Tradovate credentials:

```env
TRADOVATE_ENV=demo
TRADOVATE_USERNAME=your_username
TRADOVATE_PASSWORD=your_password
```

### 3. Get API Credentials from Tradovate

1. Log into [Tradovate Demo](https://demo.tradovateapi.com) or [Tradovate Live](https://trader.tradovate.com)
2. Go to **Settings → API**
3. Generate API credentials (optional, username/password also works)
4. Update your `.env` file

### 4. Run the Bot

**Demo mode (recommended first):**

```bash
npm start
```

The bot will:
1. Authenticate with Tradovate
2. Connect to market data WebSocket
3. Start monitoring your chosen contract (MES/MNQ)
4. Execute trades based on strategy signals

## Project Structure

```
tradovate-bot/
├── src/
│   ├── index.js              # Main entry point
│   ├── api/
│   │   ├── client.js         # Tradovate REST API client
│   │   ├── websocket.js      # WebSocket manager (market data + orders)
│   │   └── auth.js           # Authentication handler
│   ├── strategies/
│   │   ├── base.js           # Base strategy class
│   │   └── breakout.js       # Example breakout strategy
│   ├── risk/
│   │   └── manager.js        # Position sizing & risk management
│   └── utils/
│       └── logger.js         # Logging utility
├── config/
│   └── contracts.json        # Contract specs (MES, MNQ)
├── .env.example              # Environment template
└── package.json
```

## API Endpoints Used

### Authentication
- `POST /auth/accessTokenRequest` - Get access token

### Account & Positions
- `GET /account/list` - List accounts
- `GET /position/list` - Get current positions
- `GET /order/list` - Get order history

### Market Data
- `GET /contract/find` - Find contract by symbol
- `GET /chart/getBars` - Historical bars
- WebSocket: Real-time tick data

### Trading
- `POST /order/placeorder` - Place market/limit order
- `POST /order/placeOCO` - Place bracket order (stop + target)
- `POST /order/cancelorder` - Cancel order

## Strategy Development

Create your own strategy by extending the base class:

```javascript
// src/strategies/my_strategy.js
const BaseStrategy = require('./base');

class MyStrategy extends BaseStrategy {
  async onTick(tick) {
    // Your logic here
    if (this.shouldBuy(tick)) {
      await this.buy();
    }
  }
}
```

## Safety Features

- **Demo mode first** - Test everything on demo before going live
- **Risk limits** - Max $60 risk per trade
- **Position limits** - Only 1 position at a time (configurable)
- **Stop-loss required** - Every trade must have a stop

## Tradovate API Documentation

- GitHub Examples: https://github.com/tradovate/example-api-js
- Trading Strategy Example: https://github.com/tradovate/example-api-trading-strategy

## TODO

- [ ] Add multiple strategy support
- [ ] Implement trailing stops
- [ ] Add Telegram notifications
- [ ] Backtest engine using Market Replay
- [ ] Performance analytics/logging

## Disclaimer

**This is for educational purposes. Trading futures involves substantial risk. Only trade with risk capital you can afford to lose. Past performance is not indicative of future results.**
