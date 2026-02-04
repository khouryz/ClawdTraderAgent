# Tradovate Bot Setup Guide

## Quick Start

### 1. Get Tradovate Demo Account

If you don't have a Tradovate account yet:

1. Go to https://trader.tradovate.com/
2. Click "Sign Up" or "Open Account"
3. Complete registration
4. You'll automatically get access to DEMO environment
5. Login credentials will be your email + password

### 2. Configure Bot

Edit the `.env` file in this directory:

```bash
nano .env
```

Replace these values:
```env
TRADOVATE_USERNAME=your_email@example.com
TRADOVATE_PASSWORD=your_password
```

### 3. Choose Your Contract

The bot defaults to **MES** (Micro E-mini S&P 500).

To trade **MNQ** instead, change:
```env
CONTRACT_SYMBOL=MNQM5
```

**Important:** Contract months:
- H = March
- M = June  
- U = September
- Z = December

Use the **current or next** month. Check Tradovate for active contracts.

### 4. Run the Bot

```bash
npm start
```

You should see:
```
🤖 Tradovate Trading Bot Starting...
Environment: DEMO
Contract: MESM5
✓ Account: Demo Account (ID: 12345)
✓ Contract: Micro E-mini S&P 500 (ID: 67890)
✓ Risk Manager initialized
✓ Strategy initialized
✓ WebSockets connected
✓ Subscribed to Micro E-mini S&P 500 quotes
✓ Loaded 100 historical bars
✅ Bot is now LIVE and monitoring the market
```

## What the Bot Does

1. **Monitors market** - Real-time price updates via WebSocket
2. **Detects breakouts** - Buys when price breaks above recent highs
3. **Calculates risk** - Position sizing based on your $30-$60 risk
4. **Places orders** - Bracket orders with stop-loss + profit target (2R)
5. **Logs everything** - All actions saved to `logs/` directory

## Safety Features

- ✅ Demo environment by default
- ✅ Risk limits enforced ($30-$60 per trade)
- ✅ Automatic stop-loss on every trade
- ✅ 2R profit targets
- ✅ No revenge trading (one position at a time)

## Monitoring

Watch the logs:
```bash
tail -f logs/bot-*.log
```

Stop the bot:
- Press `Ctrl+C`

## Troubleshooting

### "Authentication failed"
- Check your username/password in `.env`
- Make sure you're using your Tradovate credentials
- Verify you can login at https://demo.tradovateapi.com

### "Contract not found"
- Update CONTRACT_SYMBOL to current month
- Check Tradovate for active contracts
- Example: If it's June 2026, use MESM6 or MNQM6

### "No accounts found"
- Make sure your Tradovate account is activated
- Check that you have a demo account enabled

### WebSocket connection issues
- Check your internet connection
- Verify firewall isn't blocking WebSocket connections

## Going Live

⚠️ **DO NOT SWITCH TO LIVE WITHOUT THOROUGH TESTING**

When you're ready (after weeks of demo testing):

1. Update `.env`:
```env
TRADOVATE_ENV=live
```

2. Use your LIVE account credentials
3. Start with minimal risk
4. Monitor closely

## API Rate Limits

Tradovate has rate limits. The bot is designed to be efficient, but avoid:
- Running multiple instances
- Rapidly restarting
- Making excessive manual API calls

## Support

- Tradovate API docs: https://github.com/tradovate/example-api-js
- Tradovate support: https://tradovate.zendesk.com/
- Community: https://community.tradovate.com/

## Next Steps

After testing the basic breakout strategy:
1. Customize strategy parameters in `.env`
2. Build your own strategy in `src/strategies/`
3. Add Telegram notifications
4. Implement trailing stops
5. Create a backtest system

Good luck! 📈
