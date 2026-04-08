# Telegram Commands - Remote Bot Control

This document describes the two-way Telegram command system for ClawdTraderAgent, allowing remote control of the trading bot via Telegram messages.

## Overview

The Telegram command system provides real-time remote control and monitoring capabilities without requiring any new npm dependencies. It uses Node.js built-in `https` module for communication with the Telegram Bot API.

## Setup

### 1. Create a Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` to create a new bot
3. Follow the prompts to name your bot and get a username
4. BotFather will provide a **BOT TOKEN** - save this securely

### 2. Get Your Chat ID

1. Start a chat with your new bot
2. Send any message (e.g., `/start`)
3. Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
4. Find your `chat.id` in the response - this is your **CHAT ID**

### 3. Configure Environment Variables

Add to your `.env` file:
```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
```

## Available Commands

### Control Commands

| Command | Description | Effect |
|---------|-------------|--------|
| `/start` | Show help menu | Displays all available commands |
| `/pause` | Pause trading | Blocks new signals, existing positions continue to be managed |
| `/resume` | Resume trading | Allows new signals to be processed |
| `/stop` | Shutdown bot | Gracefully stops the bot (use with caution) |
| `/halt` | Emergency halt | Triggers loss limits halt (manual override) |

### Status Commands

| Command | Description | Example Output |
|---------|-------------|----------------|
| `/status` | Current trading status | Balance, positions, P&L, pause state |
| `/positions` | Open positions | Lists all current positions with P&L |
| `/balance` | Account balance | Cash balance, equity, buying power |
| `/report` | Today's performance | Daily P&L, win rate, trade count |

## Command Details

### /pause
- Prevents NEW trading signals from being executed
- Existing positions continue normal management (stop loss, take profit, trailing)
- Strategy continues to run but signals are blocked
- Can be toggled with `/resume`

### /resume
- Lifts user-initiated pause
- If loss limits are still active, will warn user
- Loss limits halt must be resolved separately (daily reset or manual)

### /halt
- Triggers emergency halt via loss limits system
- Same effect as hitting daily loss limits
- Will not resume until next trading day unless manually intervened
- Use only in emergencies

### /stop
- Completely shuts down the bot
- Closes all connections gracefully
- Process exits - requires manual restart
- Use when you want to stop trading for the day

## Security

- Only processes messages from the configured `TELEGRAM_CHAT_ID`
- All unauthorized messages are logged but ignored
- No sensitive data (API keys, passwords) is ever sent in responses
- Commands during shutdown are safely ignored

## Multi-Instrument Mode

In multi-instrument mode:
- `/pause` and `/resume` affect ALL instruments
- `/status` shows aggregated data across all instruments
- `/report` shows combined performance with per-instrument breakdown
- `/halt` triggers halt on all instruments simultaneously

## Error Handling

The system is designed to be resilient:
- Network failures trigger automatic retries (5-second backoff)
- Invalid commands return helpful error messages
- Bot state is checked before executing commands
- Never crashes - all errors are caught and logged

## Troubleshooting

### Commands Not Working
1. Check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are correct
2. Ensure bot has been started (check logs for "TelegramCommandHandler: Started polling")
3. Verify your chat ID matches the configured one exactly

### Bot Not Responding
1. Check bot logs for any errors
2. Ensure bot is still running (`isRunning = true`)
3. Try sending `/start` to verify connection

### Pause/Resume Issues
- Check logs for "Signal blocked: Trading paused by user" to verify pause is active
- If resume doesn't work, check if loss limits are halted
- Loss limits halt takes precedence over user pause

## Integration Points

The Telegram command system integrates with:

1. **TradovateBot** - Single instrument trading
2. **MultiInstrumentBot** - Multi-instrument orchestration
3. **InstrumentRunner** - Individual instrument management
4. **LossLimitsManager** - Risk management and halts
5. **Notifications** - Consistent message formatting

## Implementation Notes

- Uses long polling with 2-second intervals
- Maintains message offset to avoid reprocessing
- Leverages existing notification system for replies
- No external dependencies - pure Node.js implementation
- Follows existing code patterns and error handling

## Testing

To test the implementation:
1. Run the verification script: `node test_telegram_commands.js`
2. Start the bot in a safe environment
3. Test each command starting with `/start`
4. Verify pause functionality with logs
5. Check status commands return valid data

⚠️ **Warning**: `/stop` and `/halt` will stop trading. Use with caution in production!
