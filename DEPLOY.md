# Server Deployment Guide

Run your trading bot 24/7 on any VPS without Clawdbot.

## Quick Start (5 minutes)

### 1. Get a VPS
Recommended providers:
- **Hostinger** - $5/mo (cheapest)
- **DigitalOcean** - $6/mo
- **Vultr** - $6/mo
- **AWS Lightsail** - $5/mo

Requirements: Ubuntu 22.04, 1GB RAM, 1 CPU

### 2. Connect to Your Server
```bash
ssh root@your-server-ip
```

### 3. Install Node.js
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version  # Should show v20.x
```

### 4. Install PM2 (Process Manager)
```bash
npm install -g pm2
```

### 5. Clone Your Bot
```bash
cd /home
git clone https://github.com/YOUR_USERNAME/ClawdTraderAgent.git
cd ClawdTraderAgent
npm install
```

### 6. Configure Environment
```bash
cp .env.example .env
nano .env
```

Fill in your credentials:
```
TRADOVATE_ENV=demo          # Change to 'live' for real trading
TRADOVATE_USERNAME=your_username
TRADOVATE_PASSWORD=your_password
```

Save: `Ctrl+X`, then `Y`, then `Enter`

### 7. Test the Bot
```bash
node test.js
```

You should see:
```
✓ Authentication successful
✓ Found 1 account(s)
✓ Contract MESM5 found
```

### 8. Start the Bot
```bash
pm2 start ecosystem.config.js
```

### 9. Make it Survive Reboots
```bash
pm2 save
pm2 startup
```

---

## Managing Your Bot

### Check Status
```bash
pm2 status
```

### View Logs
```bash
pm2 logs tradovate-bot
```

### View Real-time Logs
```bash
pm2 logs tradovate-bot --lines 100
```

### Stop Bot
```bash
pm2 stop tradovate-bot
```

### Restart Bot
```bash
pm2 restart tradovate-bot
```

### Check Bot Health
```bash
node src/index.js --status
```

### Check Balance
```bash
node src/index.js --balance
```

### Check Positions
```bash
node src/index.js --positions
```

### Get Performance Report
```bash
node src/index.js --report
```

---

## Scheduling (Optional)

If you want the bot to only run during market hours:

### Using Cron
```bash
crontab -e
```

Add these lines:
```bash
# Start bot at 9:25 AM ET (Mon-Fri)
25 9 * * 1-5 cd /home/ClawdTraderAgent && pm2 start ecosystem.config.js

# Stop bot at 4:05 PM ET (Mon-Fri)
5 16 * * 1-5 pm2 stop tradovate-bot
```

---

## Monitoring & Alerts

### Option 1: PM2 Plus (Free tier available)
```bash
pm2 plus
```
Get email/Slack alerts when bot crashes.

### Option 2: Simple Email Alerts
Create `/home/ClawdTraderAgent/scripts/health-check.sh`:
```bash
#!/bin/bash
if ! pm2 show tradovate-bot | grep -q "online"; then
  echo "Bot is down!" | mail -s "Trading Bot Alert" your@email.com
  pm2 restart tradovate-bot
fi
```

Add to cron (check every 5 minutes):
```bash
*/5 * * * * /home/ClawdTraderAgent/scripts/health-check.sh
```

---

## Security Best Practices

### 1. Create Non-Root User
```bash
adduser trader
usermod -aG sudo trader
su - trader
```

### 2. Set Up Firewall
```bash
sudo ufw allow ssh
sudo ufw enable
```

### 3. Protect Your .env File
```bash
chmod 600 .env
```

### 4. Use SSH Keys (No Passwords)
```bash
# On your local machine:
ssh-keygen -t ed25519
ssh-copy-id trader@your-server-ip
```

---

## Updating the Bot

```bash
cd /home/ClawdTraderAgent
pm2 stop tradovate-bot
git pull
npm install
pm2 start tradovate-bot
```

---

## Troubleshooting

### Bot Won't Start
```bash
# Check for errors
pm2 logs tradovate-bot --err --lines 50

# Check if .env exists
cat .env
```

### Authentication Failed
- Verify username/password in .env
- Check if using correct env (demo vs live)
- Tradovate may require 2FA - disable it or use API key

### No Trades Executing
- Check if market is open
- Run `node src/index.js --status` to see session status
- Check logs for "Session filter" messages

### High Memory Usage
```bash
pm2 monit
```
If memory > 400MB, restart: `pm2 restart tradovate-bot`

---

## Cost Breakdown

| Item | Monthly Cost |
|------|-------------|
| VPS (Hostinger) | $5 |
| Domain (optional) | $1 |
| **Total** | **$5-6/mo** |

---

## Quick Reference

| Command | Description |
|---------|-------------|
| `pm2 start ecosystem.config.js` | Start bot |
| `pm2 stop tradovate-bot` | Stop bot |
| `pm2 restart tradovate-bot` | Restart bot |
| `pm2 logs tradovate-bot` | View logs |
| `pm2 status` | Check status |
| `node src/index.js --status` | Bot health check |
| `node src/index.js --balance` | Check balance |
| `node src/index.js --positions` | Check positions |
| `node src/index.js --report` | Performance report |
