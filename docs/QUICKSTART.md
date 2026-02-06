# 🚀 Tradovate Bot - Quick Start

## 30-Second Setup

### 1. Configure Credentials

```bash
cd /root/clawd/tradovate-bot
nano .env
```

Change these two lines:
```
TRADOVATE_USERNAME=your_email@example.com
TRADOVATE_PASSWORD=your_password
```

Save (`Ctrl+X`, then `Y`, then `Enter`)

### 2. Validate

```bash
npm test
```

Should see: ✅ All tests passed!

### 3. Run

```bash
npm start
```

## That's It!

The bot is now:
- ✅ Monitoring MES (Micro E-mini S&P 500)
- ✅ Looking for breakout signals
- ✅ Calculating risk ($30-$60 per trade)
- ✅ Placing bracket orders (stop + target)

## Stop the Bot

Press `Ctrl+C`

## Check Logs

```bash
ls logs/
cat logs/bot-*.log
```

## Need Help?

- **Full guide:** Read `SETUP.md`
- **Checklist:** See `CHECKLIST.md`
- **Details:** Check `README.md`
- **Status:** View `STATUS.md`

## Contract Months

If contract not found, update in `.env`:

- **March:** `CONTRACT_SYMBOL=MESH5`
- **June:** `CONTRACT_SYMBOL=MESM5`
- **September:** `CONTRACT_SYMBOL=MESU5`
- **December:** `CONTRACT_SYMBOL=MESZ5`

(Change `5` to current year: `6` for 2026, `7` for 2027, etc.)

For **MNQ**, replace `MES` with `MNQ`.

## Trading MNQ Instead?

In `.env`:
```
CONTRACT_SYMBOL=MNQM5
```

Done! 🎯
