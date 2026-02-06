# Pre-Launch Checklist

Before running the bot, make sure you've completed these steps:

## ✅ Setup Tasks

### 1. Tradovate Account
- [ ] Signed up for Tradovate account
- [ ] Can login to https://demo.tradovateapi.com
- [ ] Have demo account with funds

### 2. Bot Configuration
- [ ] Copied `.env.example` to `.env` (or edited existing `.env`)
- [ ] Updated `TRADOVATE_USERNAME` with your email
- [ ] Updated `TRADOVATE_PASSWORD` with your password
- [ ] Set `TRADOVATE_ENV=demo` (for testing)
- [ ] Verified `CONTRACT_SYMBOL` is current month (e.g., MESM5, MNQM5)

### 3. Risk Parameters
- [ ] `RISK_PER_TRADE_MIN=30` (or your preferred min)
- [ ] `RISK_PER_TRADE_MAX=60` (or your preferred max)
- [ ] `PROFIT_TARGET_R=2` (2x risk = 2R profit target)

### 4. Dependencies
- [ ] Ran `npm install`
- [ ] No errors during installation

### 5. Validation
- [ ] Ran `npm test` successfully
- [ ] Bot authenticated with Tradovate
- [ ] Bot found your account
- [ ] Bot found the contract
- [ ] Bot retrieved account balance

## 🚀 Launch

Once all checks pass, start the bot:

```bash
npm start
```

## 📋 What to Expect

When the bot starts, you should see:

```
🤖 Tradovate Trading Bot Starting...
Environment: DEMO
Contract: MESM5
Risk: $30-$60 per trade
Strategy: simple_breakout
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ Account: Demo Account (ID: 12345)
✓ Contract: Micro E-mini S&P 500 (ID: 67890)
✓ Risk Manager initialized
✓ Strategy initialized
✓ WebSockets connected
✓ Subscribed to Micro E-mini S&P 500 quotes
✓ Loaded 100 historical bars
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Bot is now LIVE and monitoring the market
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

The bot will then:
1. Monitor real-time price data
2. Calculate 20-period highs/lows
3. Generate BUY signals on breakouts above highs
4. Generate SELL signals on breakdowns below lows
5. Calculate position size based on your risk parameters
6. Place bracket orders (entry + stop + target)

## 🛑 Stopping the Bot

Press `Ctrl+C` to gracefully shut down the bot.

## 📊 Monitoring

- **Live output:** Watch the terminal
- **Log files:** Check `logs/bot-YYYY-MM-DD.log`
- **Tradovate platform:** View orders/positions at https://demo.tradovateapi.com

## ⚠️ Important Notes

- **Demo only** - Do NOT switch to live until thoroughly tested
- **One position at a time** - Bot will only trade when no position is open
- **Stop-loss required** - Every trade has automatic stop-loss
- **Risk limits enforced** - Max $60 risk per trade (configurable)
- **Market hours** - Bot only trades when market is open
- **Internet required** - Bot needs stable connection for WebSockets

## 🆘 If Something Goes Wrong

1. Press `Ctrl+C` to stop bot
2. Check `logs/` for error details
3. Verify credentials in `.env`
4. Run `npm test` again
5. Check Tradovate platform for any manual issues

## 📈 Next Steps After Testing

Once comfortable with demo:
1. Test for at least 1-2 weeks in demo
2. Review all trades in logs
3. Verify risk management is working
4. Understand the strategy behavior
5. Then (and only then) consider going live with small size

Good luck! 🚀
