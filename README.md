# ClawdTraderAgent

Automated MNQ futures trading bot using **Databento** for market data and **Tradovate** for order execution. Runs the **MNQ Momentum V2** strategy with multi-timeframe pullback entries (5m, 3m, 2m) and tick-triggered intra-bar execution.

---

## Prerequisites

Before starting, you need accounts with three services:

| Service | What It Does | Sign Up |
|---------|-------------|---------|
| **Tradovate** | Order execution & account management | [tradovate.com](https://www.tradovate.com) |
| **Databento** | Real-time market data (CME Globex) | [databento.com](https://databento.com) |
| **Telegram** (optional) | Trade notifications to your phone | [telegram.org](https://telegram.org) |

You also need:
- **Node.js** 18+ — [nodejs.org](https://nodejs.org)
- **Python** 3.10+ — [python.org](https://www.python.org)

---

## Setup (Step by Step)

### Step 1: Clone & Install Dependencies

```bash
git clone https://github.com/your-repo/ClawdTraderAgent.git
cd ClawdTraderAgent
npm install
pip install -r requirements.txt
```

This installs:
- **Node.js**: `axios`, `ws`, `dotenv`
- **Python**: `databento` (market data SDK)

### Step 2: Get Your Tradovate API Credentials

1. Log in to [Tradovate Trader](https://trader.tradovate.com)
2. Go to **Settings → API Access**
3. Click **Create API Key**
4. You will receive:
   - **Client ID** (a number like `9783`) — this is your `TRADOVATE_CID`
   - **API Secret** (a UUID like `3b1eecd8-3d0c-...`) — this is your `TRADOVATE_SECRET`
5. Your **username** and **password** are your normal Tradovate login credentials
6. Your **account name** is the number shown in the top-right of Tradovate Trader (e.g. `1699181`)

### Step 3: Get Your Databento API Key

1. Go to [databento.com/portal/keys](https://databento.com/portal/keys)
2. Create a new API key
3. Copy the key (starts with `db-...`) — this is your `DATABENTO_API_KEY`

### Step 4: Set Up Telegram Notifications (Optional)

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a name (e.g. "ClawdTrader Bot") and a username (e.g. `clawdtrader_bot`)
4. BotFather replies with your **bot token** (e.g. `8245973327:AAG5O4ZK...`) — save this
5. Open a chat with your new bot in Telegram and send it any message (e.g. "hello")
6. Open this URL in your browser (replace `YOUR_TOKEN` with the token from step 4):
   ```
   https://api.telegram.org/botYOUR_TOKEN/getUpdates
   ```
   **Important:** The word `bot` must appear before the token in the URL, with no space.
7. In the JSON response, find `"chat":{"id":1234567890}` — that number is your **chat ID**

If the `result` is empty, go back to Telegram, send another message to the bot, then refresh the URL.

### Step 5: Create Your `.env` File

```bash
cp .env.example .env
```

Open `.env` and fill in your credentials from the steps above:

```env
# Tradovate (from Step 2)
TRADOVATE_ENV=demo                        # Start with "demo", change to "live" when ready
TRADOVATE_USERNAME=your_username
TRADOVATE_PASSWORD=your_password
TRADOVATE_CID=your_client_id
TRADOVATE_SECRET=your_api_secret
TRADOVATE_ACCOUNT_NAME=your_account_name

# Databento (from Step 3)
DATABENTO_API_KEY=db-your_api_key

# Telegram (from Step 4, leave blank to disable)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Python path (adjust if python is not on your PATH)
PYTHON_PATH=python                        # Linux/Mac: python3, Windows: full path if needed
```

All other settings in `.env.example` are pre-configured with production-tested values. Only change them if you know what you're doing.

### Step 6: Start the Bot

```bash
npm start
```

The bot will:
1. Authenticate with Tradovate (REST API)
2. Resolve the MNQ contract (find `MNQM6` on the exchange)
3. Connect the Tradovate order WebSocket (fills, positions, orders)
4. Start the Databento market data stream (Python subprocess → 1-min OHLCV bars)
5. Fetch historical bars for strategy warm-up
6. Begin monitoring for trade signals

You should see output like:
```
[INFO] Multi-instrument mode detected (INSTRUMENTS env var set)
[INFO] [MIB] Tradovate auth successful
[INFO] [MIB] Order WebSocket connected
[INFO] [MNQ] Contract resolved: MNQM6 (id: 123456)
[INFO] [MNQ] Databento stream connected — receiving 1m bars
[INFO] [MNQ] Historical bars loaded (50 bars)
[INFO] [MNQ] Strategy active — monitoring for signals
```

### Step 7: Go Live

When you're satisfied with demo testing:

1. Change `TRADOVATE_ENV=demo` to `TRADOVATE_ENV=live` in `.env`
2. Verify `TRADOVATE_ACCOUNT_NAME` is your **live** account number (may differ from demo)
3. Restart the bot

---

## How It Works

### Strategy: MNQ Momentum V2 (Multi-Timeframe Pullback)

The bot builds 2-min, 3-min, and 5-min bars from Databento 1-min OHLCV data and looks for:

1. **Impulse** — A strong directional move on a higher timeframe bar
2. **Pullback** — Price retraces into the impulse range (10–85%)
3. **Entry** — Tick-triggered: enters on the first qualifying tick in the retrace zone (or bar-close fallback)

Three sub-strategies run simultaneously:
- **PB 5m** — Pullbacks on 5-minute bars (15–40pt impulse)
- **PB 3m** — Pullbacks on 3-minute bars (10–30pt impulse)
- **PB 2m** — Pullbacks on 2-minute bars (8–25pt impulse)

Every trade gets:
- **OCO bracket** — Stop-loss + take-profit placed immediately after fill
- **Break-even stop** — Stop moves to entry price at 1.2R profit
- **Slippage guard** — Rejects entry if tick price deviates too far from signal

### Risk Management

| Control | Value |
|---------|-------|
| Risk per trade | $10–$60 |
| Max contracts | 3 |
| Daily loss limit | $150 (halt) |
| Weekly loss limit | $400 (halt) |
| Max consecutive losses | 3 (halt) |
| Daily profit target | $750 (halt) |
| Profit protection | Ratcheting floor ($50 giveback per $100 tier) |
| Post-trade cooldown | 6 bars (6 minutes) |
| Volume filter | Rejects signals below 0.9× 20-bar avg volume |

### Session Schedule (Pacific Time)

| Time | Event |
|------|-------|
| 6:29 AM | Daily reset (clear halts, reset P&L tracking) |
| 6:30 AM | Trading starts |
| 12:55 PM | EOD close (force-close any open position) |
| 1:00 PM | Trading ends, daily report sent |

---

## Project Structure

```
ClawdTraderAgent/
├── src/
│   ├── api/                  # Tradovate API layer
│   │   ├── auth.js           # Token lifecycle & renewal
│   │   ├── client.js         # REST API (orders, OCO, positions)
│   │   └── websocket.js      # WebSocket (fills, order updates)
│   ├── bot/                  # Core bot orchestration
│   │   ├── MultiInstrumentBot.js  # Multi-instrument coordinator
│   │   ├── InstrumentRunner.js    # Per-instrument lifecycle manager
│   │   ├── SignalHandler.js       # Signal → order placement
│   │   └── PositionHandler.js     # Fill handling, exit detection
│   ├── data/                 # Market data (Databento)
│   │   ├── SharedPriceProvider.js     # Multi-symbol data router
│   │   ├── DatabentoPriceProvider.js  # Single-symbol fallback
│   │   └── databento_stream.py        # Python bridge to Databento API
│   ├── strategies/           # Trading strategies
│   │   └── mnq_momentum_strategy_v2.js  # MNQ Momentum V2
│   ├── risk/                 # Risk management
│   │   ├── manager.js        # Position sizing & contract calculation
│   │   └── loss_limits.js    # Daily/weekly limits & profit protection
│   ├── orders/               # Order management
│   │   ├── profit_manager.js # Break-even stop logic
│   │   └── trailing_stop.js  # Trailing stop (currently disabled)
│   ├── filters/              # Time & session filters
│   │   └── session_filter.js # Trading hours, holidays, lunch
│   └── utils/                # Utilities
│       ├── logger.js         # Console + file logging
│       ├── notifications.js  # Telegram notifications
│       ├── market_hours.js   # CME Globex hours & holidays
│       ├── file_ops.js       # Async/sync file operations
│       └── rate_limiter.js   # API rate limiting
├── config/contracts.json     # Contract specs (tick size, value)
├── requirements.txt          # Python: databento
└── package.json              # Node.js: axios, ws, dotenv
```

---

## Safety Features

- **Demo mode first** — Always test on demo before switching to live
- **OCO brackets** — Every trade has a stop-loss and take-profit on the exchange
- **Daily loss limit** — Bot halts at -$150/day, persisted to disk (survives restarts)
- **Weekly loss limit** — Bot halts at -$400/week
- **Profit protection** — Ratcheting floor locks in gains (max $50 giveback per tier)
- **Position sync** — Reconciles bot state with exchange every 60 seconds
- **Startup sync** — On restart, detects and re-adopts any open position with its bracket orders
- **Fill watchdog** — If a fill isn't received within 5 seconds, polls the REST API
- **Bracket watchdog** — If bracket orders aren't confirmed within 7 seconds, emergency closes
- **WebSocket reconnect** — Auto-reconnects with exponential backoff; halts after 10 failures
- **Slippage guard** — Rejects entries if live tick price deviates from signal price

---

## Disclaimer

**This is for educational purposes. Trading futures involves substantial risk. Only trade with risk capital you can afford to lose. Past performance is not indicative of future results.**
