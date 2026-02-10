# ClawdTraderAgent

Automated futures trading bot using **Databento** for market data and **Tradovate** for order execution. Designed for small accounts trading Micro E-mini contracts (MES, MNQ, MYM).

## Architecture

- **Databento** — Real-time and historical market data (CME Globex MDP 3.0)
- **Tradovate** — Order execution, account management, position tracking

## Features

- ✅ Databento live streaming via Python bridge (institutional-grade data)
- ✅ Tradovate order execution (REST + WebSocket)
- ✅ Enhanced breakout strategy with trend/volume/RSI filters
- ✅ AI-powered trade confirmation (OpenAI / Anthropic)
- ✅ Position sizing based on risk parameters ($30-$60)
- ✅ 2R+ profit targets with trailing stops
- ✅ OCO bracket orders (stop-loss + take-profit)
- ✅ Telegram trade notifications
- ✅ Demo/Live environment switching
- ✅ Comprehensive risk management (daily/weekly loss limits)

## Setup

### 1. Install Dependencies

```bash
npm install
pip install -r requirements.txt   # Python 3.10+ required
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Tradovate (order execution)
TRADOVATE_ENV=demo
TRADOVATE_USERNAME=your_username
TRADOVATE_PASSWORD=your_password
TRADOVATE_CID=your_client_id
TRADOVATE_SECRET=your_api_secret

# Databento (market data)
DATABENTO_API_KEY=db-your_api_key
DATABENTO_SYMBOL=MES.FUT
```

### 3. Run the Bot

```bash
npm start
```

The bot will:
1. Authenticate with Tradovate
2. Connect Databento live data stream (Python subprocess)
3. Load historical bars for strategy warm-up
4. Connect Tradovate order WebSocket
5. Monitor market and execute trades based on strategy signals

## Project Structure

```
ClawdTraderAgent/
├── src/
│   ├── api/                # Tradovate API (execution only)
│   │   ├── auth.js         # Authentication & token management
│   │   ├── client.js       # REST API client (orders, accounts)
│   │   └── websocket.js    # WebSocket (order fills & positions)
│   ├── data/               # Market data (Databento)
│   │   ├── DatabentoPriceProvider.js  # Node.js data client
│   │   └── databento_stream.py        # Python live stream bridge
│   ├── bot/                # Core bot components
│   │   ├── TradovateBot.js # Main orchestrator
│   │   ├── SignalHandler.js # Signal processing & order placement
│   │   └── PositionHandler.js # Position & P&L management
│   ├── strategies/         # Trading strategies
│   ├── risk/               # Risk management & loss limits
│   ├── orders/             # Order, trailing stop, profit management
│   ├── ai/                 # AI trade confirmation
│   ├── analytics/          # Performance tracking
│   ├── filters/            # Session & time filters
│   ├── indicators/         # Technical indicators
│   └── utils/              # Logging, notifications, config
├── config/contracts.json   # Contract specifications
├── presets/                # Trading presets
├── requirements.txt        # Python dependencies
└── package.json            # Node.js dependencies
```

## Documentation

- **[architecture.md](architecture.md)** — Full system architecture, data flows, component map
- **[windsurf.md](windsurf.md)** — Engineering workflow, safety rules, modification guidelines

## Safety Features

- **Demo mode first** — Test everything on demo before going live
- **Risk limits** — Configurable per-trade risk ($30-$60)
- **Loss limits** — Daily ($150) and weekly ($300) loss caps
- **Position lock** — Only 1 position at a time, race condition prevention
- **Stop-loss required** — Every trade has a stop via bracket orders
- **Position sync** — Automatic state reconciliation after WebSocket reconnect

## Disclaimer

**This is for educational purposes. Trading futures involves substantial risk. Only trade with risk capital you can afford to lose. Past performance is not indicative of future results.**
