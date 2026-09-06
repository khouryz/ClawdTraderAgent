/**
 * TelegramCommandHandler — execution-only remote control
 *
 * Polls Telegram for commands and dispatches them to the ExecutionBot.
 * No multi-instrument/multi-account support — single bot, single account.
 *
 * Commands:
 *   /start       — show help
 *   /pause       — pause trading (no new entries)
 *   /resume      — resume from /pause
 *   /forceresume — force resume from any halt (loss limits)
 *   /halt        — emergency halt (stops until tomorrow)
 *   /flatten     — close open position immediately
 *   /status      — current bot state
 *   /positions   — open positions + working orders
 *   /balance     — account balance
 *   /report      — today's performance report
 */

const https = require('https');
const logger = require('./logger');

class TelegramCommandHandler {
  /**
   * @param {Object} bot - ExecutionBot instance
   * @param {Object} notifications - Notifications instance
   */
  constructor(bot, notifications) {
    this.bot = bot;
    this.notifications = notifications;
    this.telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    this.authorizedChatId = process.env.TELEGRAM_CHAT_ID;
    this.pollingInterval = null;
    this.offset = 0;
    this.isRunning = false;

    if (!this.telegramToken || !this.authorizedChatId) {
      logger.warn('TelegramCommandHandler: Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    }
  }

  start() {
    if (this.isRunning) return;
    if (!this.telegramToken || !this.authorizedChatId) {
      logger.error('TelegramCommandHandler: Cannot start — missing credentials');
      return;
    }

    // Telegram allows exactly ONE getUpdates poller per bot token. With one
    // process per instrument, the second instance otherwise 409s forever
    // ("terminated by other getUpdates request") and its commands never work.
    // First instance to claim the lock owns commands; the others stay silent
    // but still SEND notifications, which are unaffected by this.
    if (!this._claimPollerLock()) {
      logger.warn(
        'TelegramCommandHandler: another instance owns command polling — ' +
        'not polling here. Notifications still send; /commands are handled by that instance.'
      );
      return;
    }

    this.isRunning = true;
    logger.info('TelegramCommandHandler: Started polling for commands (owns the poller lock)');
    this._poll();
  }

  /**
   * Claim the single-poller lock, or report that someone else holds it.
   * The holder refreshes its mtime while polling, so a crashed owner's lock
   * goes stale and the next instance to start can take over.
   */
  _claimPollerLock() {
    const fs = require('fs');
    const { FILES } = require('../utils/constants');
    const dir = process.env.LOSS_LIMITS_DIR || FILES.DATA_DIR;
    this._pollerLockPath = `${dir}/.telegram_poller.lock`;
    const STALE_MS = 60000;
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        fs.writeFileSync(this._pollerLockPath, String(process.pid), { flag: 'wx' });
        return true;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const age = Date.now() - fs.statSync(this._pollerLockPath).mtimeMs;
        if (age > STALE_MS) {
          // Previous owner died without releasing it.
          fs.writeFileSync(this._pollerLockPath, String(process.pid));
          logger.warn(`TelegramCommandHandler: took over a stale poller lock (${Math.round(age / 1000)}s old)`);
          return true;
        }
        return false;
      }
    } catch (err) {
      // Never let lock trouble disable commands outright on a single-bot setup.
      logger.warn(`TelegramCommandHandler: poller lock unavailable (${err.message}) — polling anyway`);
      return true;
    }
  }

  /** Keep the lock fresh so a live owner is never mistaken for a dead one. */
  _touchPollerLock() {
    if (!this._pollerLockPath) return;
    try {
      const now = new Date();
      require('fs').utimesSync(this._pollerLockPath, now, now);
    } catch (_) { /* lock removed by hand — not worth failing a poll over */ }
  }

  stop() {
    const wasRunning = this.isRunning;
    this.isRunning = false;
    if (this.pollingInterval) {
      clearTimeout(this.pollingInterval);
      this.pollingInterval = null;
    }
    // Release the lock so a sibling can take over commands immediately rather
    // than waiting out the staleness window.
    if (wasRunning && this._pollerLockPath) {
      try { require('fs').unlinkSync(this._pollerLockPath); } catch (_) {}
    }
    logger.info('TelegramCommandHandler: Stopped');
  }

  _poll() {
    if (!this.isRunning) return;
    this._touchPollerLock();

    const myGen = (this._pollGen = (this._pollGen || 0) + 1);
    let settled = false;
    const scheduleNext = (delayMs) => {
      if (settled) return;
      settled = true;
      if (!this.isRunning || myGen !== this._pollGen) return;
      clearTimeout(this.pollingInterval);
      this.pollingInterval = setTimeout(() => this._poll(), delayMs);
    };

    const url = `https://api.telegram.org/bot${this.telegramToken}/getUpdates?offset=${this.offset}&timeout=30`;

    const req = https.request(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let delay = 2000;
        if (res.statusCode === 200) {
          this._conflictStreak = 0;
          try {
            const data = JSON.parse(body);
            if (data.ok && data.result) this._processUpdates(data.result);
          } catch (err) {
            logger.error(`TelegramCommandHandler: Parse error: ${err.message}`);
          }
        } else if (res.statusCode === 409) {
          this._conflictStreak = (this._conflictStreak || 0) + 1;
          delay = Math.min(60000, 5000 * this._conflictStreak);
          // Surface Telegram's own explanation. This used to log only
          // "409 conflict xN", which hid the actual cause for days: a webhook
          // was registered on the bot, and getUpdates is forbidden while one is
          // active. The description says so in plain words.
          let why = '';
          try {
            const d = JSON.parse(body);
            if (d && d.description) why = ` — ${d.description}`;
          } catch (_) { /* body may not be JSON */ }
          if (why && /webhook/i.test(why) && !this._warnedWebhook) {
            this._warnedWebhook = true;
            logger.error(
              `TelegramCommandHandler: a WEBHOOK is registered on this bot, so polling can never work${why}. ` +
              `Commands will not be received until it is removed (deleteWebhook).`
            );
          } else if (this._conflictStreak === 1 || this._conflictStreak % 20 === 0) {
            logger.warn(`TelegramCommandHandler: 409 conflict x${this._conflictStreak} — backing off ${delay / 1000}s${why}`);
          }
        } else {
          let why = '';
          try {
            const d = JSON.parse(body);
            if (d && d.description) why = ` — ${d.description}`;
          } catch (_) { /* body may not be JSON */ }
          logger.error(`TelegramCommandHandler: API error ${res.statusCode}${why}`);
        }
        scheduleNext(delay);
      });
    });

    req.on('error', (err) => {
      if (!settled) logger.error(`TelegramCommandHandler: Request failed: ${err.message}`);
      scheduleNext(5000);
    });

    req.setTimeout(35000, () => {
      scheduleNext(2000);
      req.destroy();
    });

    req.end();
  }

  async _processUpdates(updates) {
    for (const update of updates) {
      this.offset = update.update_id + 1;
      if (!update.message || !update.message.text) continue;
      const message = update.message;
      if (message.chat.id.toString() !== this.authorizedChatId.toString()) {
        logger.warn(`TelegramCommandHandler: Unauthorized from chat ${message.chat.id}`);
        continue;
      }
      logger.info(`TelegramCommandHandler: Command: ${message.text}`);
      try {
        await this._handleCommand(message.text);
      } catch (err) {
        logger.error(`TelegramCommandHandler: Command failed: ${err.message}`);
        await this._reply('❌ Command failed.').catch(() => {});
      }
    }
  }

  async _handleCommand(text) {
    const command = text.trim().split(' ')[0].toLowerCase();

    if (this.bot && !this.bot.isRunning && command !== '/start') {
      await this._reply('⚠️ Bot is shutting down.');
      return;
    }

    switch (command) {
      case '/start':       await this._handleStart(); break;
      case '/pause':       await this._handlePause(); break;
      case '/resume':      await this._handleResume(); break;
      case '/forceresume': await this._handleForceResume(); break;
      case '/halt':        await this._handleHalt(); break;
      case '/flatten':     await this._handleFlatten(); break;
      case '/status':      await this._handleStatus(); break;
      case '/positions':   await this._handlePositions(); break;
      case '/balance':     await this._handleBalance(); break;
      case '/report':      await this._handleReport(); break;
      default:             await this._reply('❓ Unknown command. /start for help.'); break;
    }
  }

  async _reply(message) {
    if (!this.telegramToken || !this.authorizedChatId) return;
    try {
      await this.notifications.send(message);
    } catch (err) {
      logger.error(`TelegramCommandHandler: Reply failed: ${err.message}`);
    }
  }

  /**
   * Every live instance, this one included.
   *
   * Only ONE process polls Telegram (one getUpdates poller per bot token), so
   * a command handled locally reached ONE instrument. /flatten was the
   * dangerous case: it replied "FLATTENED" having closed only the poller's
   * contract, while the other instrument stayed open and the operator believed
   * they were flat.
   */
  _instances() {
    const sibs = (this.bot && typeof this.bot._siblings === 'function') ? this.bot._siblings() : [];
    if (sibs.length) return sibs;
    // Single-instrument, or the registry is unavailable: act on ourselves.
    return [{
      symbol: this.bot?.contract?.name || this.bot?.config?.contractSymbol || 'this bot',
      port: Number(process.env.WEBHOOK_PORT) || 8787,
    }];
  }

  /** Call one instance's HTTP API. */
  _callInstance(port, method, path) {
    return new Promise((resolve, reject) => {
      const req = require('http').request(
        { host: '127.0.0.1', port, path, method,
          headers: { 'x-signal-token': process.env.WEBHOOK_TOKEN || '' } },
        res => {
          let b = '';
          res.on('data', d => { b += d; });
          res.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({ raw: b }); } });
        }
      );
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
      req.end();
    });
  }

  /** Run one call against EVERY instance and collect per-instrument results. */
  async _fanOut(method, path) {
    const list = this._instances();
    return Promise.all(list.map(async (i) => {
      try {
        return { symbol: i.symbol, port: i.port, ok: true, data: await this._callInstance(i.port, method, path) };
      } catch (e) {
        return { symbol: i.symbol, port: i.port, ok: false, error: e.message };
      }
    }));
  }

  async _handleStart() {
    await this._reply(
      `<b>🤖 Execution Bot Commands</b>\n\n` +
      `<b>Control:</b>\n` +
      `/start — show this help\n` +
      `/pause — pause trading (no new entries)\n` +
      `/resume — resume from /pause\n` +
      `/forceresume — force resume from any halt\n` +
      `/halt — emergency halt (stops until tomorrow)\n` +
      `/flatten — close open position now\n\n` +
      `<b>Status:</b>\n` +
      `/status — current bot state\n` +
      `/positions — open positions + orders\n` +
      `/balance — account balance\n` +
      `/report — today's performance`
    );
  }

  async _handlePause() {
    if (!this.bot) return await this._reply('❌ Bot not available');
    if (this.bot.lossLimits?.getStatus?.().isHalted) {
      return await this._reply('🛑 Trading is already HALTED by loss limits.');
    }
    // Pause EVERY instrument. Setting the flag locally paused only the process
    // holding the Telegram poller lock; the other kept taking entries.
    const results = await this._fanOut('POST', '/pause');
    const lines = ['⏸️ <b>Paused — no new entries</b>'];
    let failed = 0;
    for (const r of results) {
      if (!r.ok) { failed++; lines.push(`❌ ${r.symbol}: NOT PAUSED (${r.error})`); }
      else lines.push(`✓ ${r.symbol}${r.data?.alreadyPaused ? ' (was already paused)' : ''}`);
    }
    if (failed) lines.push(`⚠️ ${failed} instrument(s) may still take entries.`);
    lines.push('Use /resume to continue.');
    await this._reply(lines.join('\n'));
  }

  async _handleResume() {
    if (!this.bot) return await this._reply('❌ Bot not available');
    const results = await this._fanOut('POST', '/resume');
    const lines = ['▶️ <b>Resume</b>'];
    for (const r of results) {
      if (!r.ok) lines.push(`❌ ${r.symbol}: ${r.error}`);
      else if (r.data?.resumed) lines.push(`✓ ${r.symbol}: cleared ${r.data.clearedHalt}`);
      else lines.push(`✓ ${r.symbol}: active (${r.data?.reason || 'unpaused'})`);
    }
    // The loss halt is shared, so one instance clearing it frees them all.
    const ls = this.bot.lossLimits?.getStatus?.() || {};
    if (ls.isHalted) lines.push(`🛑 Still halted by loss limits (${ls.haltReason}). Use /forceresume.`);
    await this._reply(lines.join('\n'));
  }

  async _handleForceResume() {
    if (!this.bot) return await this._reply('❌ Bot not available');
    const before = this.bot.lossLimits?.getStatus?.() || {};
    const results = await this._fanOut('POST', '/resume');
    const lines = ['⚠️ <b>FORCE RESUME</b>'];
    if (before.isHalted) lines.push(`Cleared shared halt: ${before.haltReason}`);
    for (const r of results) {
      lines.push(r.ok ? `✓ ${r.symbol}: active` : `❌ ${r.symbol}: ${r.error}`);
    }
    lines.push('Trading is active on every instrument. Use with caution.');
    await this._reply(lines.join('\n'));
  }

  async _handleHalt() {
    if (!this.bot) return await this._reply('❌ Bot not available');
    const status = this.bot.lossLimits.getStatus();
    if (status.isHalted) {
      return await this._reply(`🛑 Already halted: ${status.haltReason}\nResumes tomorrow or /forceresume.`);
    }
    this.bot.lossLimits.halt('MANUAL', 'Emergency halt via Telegram');
    logger.warn('Telegram: Emergency halt');
    await this._reply('🛑 <b>Emergency halt triggered.</b>\nNo new positions until tomorrow or /forceresume.');
  }

  async _handleFlatten() {
    if (!this.bot) return await this._reply('❌ Bot not available');
    const results = await this._fanOut('POST', '/flatten');

    const lines = ['📤 <b>FLATTEN — all instruments</b>'];
    let failed = 0;
    for (const r of results) {
      if (!r.ok) {
        failed++;
        lines.push(`❌ ${r.symbol}: NOT REACHED (${r.error}) — check the broker by hand`);
      } else if (r.data?.flattened && r.data?.cancelledEntry) {
        lines.push(`✓ ${r.symbol}: resting entry cancelled (was flat)`);
      } else if (r.data?.flattened) {
        lines.push(`✓ ${r.symbol}: closed ${r.data.qty ?? ''} at market`);
      } else {
        lines.push(`• ${r.symbol}: nothing to flatten`);
      }
    }
    // Never let a partial flatten read as success.
    if (failed) lines.push(`⚠️ ${failed} instrument(s) did not respond — YOU MAY STILL BE EXPOSED.`);
    await this._reply(lines.join('\n'));
  }

  async _handleStatus() {
    if (!this.bot) return await this._reply('❌ Bot not available');
    try {
      const results = await this._fanOut('GET', '/status');
      const first = results.find(r => r.ok && r.data)?.data;
      if (!first) return await this._reply('❌ No instance answered /status');

      const acct = first.account || {};
      const state = acct.halted ? '🛑 HALTED' : (results.some(r => r.data?.paused) ? '⏸️ PAUSED' : '▶️ ACTIVE');

      const lines = [
        `<b>📊 Status — ${state}</b>`,
        // Account-wide facts stated ONCE. Repeating them per instrument made a
        // shared $300 budget look like $300 each.
        `Account: ${acct.tradesToday ?? 0} trade(s) today · P&L $${(acct.dailyPnl ?? 0).toFixed(2)} · $${(acct.lossLimitRemaining ?? 0).toFixed(2)} loss budget left`,
        `Market: ${first.marketOpen ? 'OPEN' : 'closed'}${first.pastEntryCutoff ? ' · past entry cutoff' : ''}`,
        '',
      ];
      if (acct.halted) lines.splice(2, 0, `Halt reason: ${acct.haltReason}`);

      for (const r of results) {
        if (!r.ok) { lines.push(`❌ ${r.symbol} :${r.port} — NOT RESPONDING (${r.error})`); continue; }
        const d = r.data;
        const pos = d.openPositions
          ? `${d.positionSide === 'Buy' ? 'LONG' : 'SHORT'} ${d.positionQty} @ ${Number(d.positionEntry).toFixed(2)}` +
            (d.positionStop ? ` · stop ${Number(d.positionStop).toFixed(2)}` : '')
          : 'flat';
        const flags = [d.paused ? 'paused' : null].filter(Boolean).join(', ');
        lines.push(`• <b>${d.instrument}</b> :${r.port} — ${pos} · ${d.tradesToday}/${d.maxTrades} trades${flags ? ' · ' + flags : ''}`);
      }
      await this._reply(lines.join('\n'));
    } catch (err) {
      await this._reply(`❌ Status failed: ${err.message}`);
    }
  }

  async _handlePositions() {
    if (!this.bot) return await this._reply('❌ Bot not available');
    try {
      const results = await this._fanOut('GET', '/positions');
      const lines = ['<b>📋 Positions — whole account</b>'];
      let any = false;

      for (const r of results) {
        if (!r.ok) { lines.push(`❌ ${r.symbol}: NOT RESPONDING (${r.error})`); continue; }
        const pos = r.data?.positions || [];
        const ords = r.data?.workingOrders || [];
        if (!pos.length && !ords.length) { lines.push(`• ${r.symbol}: flat`); continue; }
        any = true;
        for (const p of pos) lines.push(`• <b>${r.symbol}</b>: ${p.netPos > 0 ? 'LONG' : 'SHORT'} ${Math.abs(p.netPos)} @ ${Number(p.netPrice).toFixed(2)}`);
        for (const o of ords) {
          const price = o.stopPrice ?? o.price;
          lines.push(`   ${o.action} ${o.orderType} ${o.orderQty} @ ${price != null ? Number(price).toFixed(2) : '?'} (${o.ordStatus})`);
        }
      }

      // Anything on the account that no instance claims — a stray from a crash
      // or a hand-placed order — would otherwise be invisible here.
      const seen = new Set(results.flatMap(r => (r.data?.positions || []).map(p => p.contractId)));
      const strays = (results.find(r => r.ok)?.data?.accountPositions || [])
        .filter(p => !seen.has(p.contractId));
      for (const p of strays) {
        any = true;
        lines.push(`⚠️ UNCLAIMED contract ${p.contractId}: netPos ${p.netPos} @ ${Number(p.netPrice).toFixed(2)} — not managed by any instance`);
      }

      if (!any) lines.push('Nothing open anywhere.');
      await this._reply(lines.join('\n'));
    } catch (err) {
      await this._reply(`❌ Positions failed: ${err.message}`);
    }
  }

  async _handleBalance() {
    if (!this.bot || !this.bot.client || !this.bot.account) {
      return await this._reply('❌ Bot not initialized');
    }
    try {
      const balance = await this.bot.client.getRealTimeBalance(this.bot.account.id);
      await this._reply(
        `<b>💰 Account Balance</b>\n\n` +
        `Equity: $${balance.equity?.toFixed(2) || '0.00'}\n` +
        `Cash: $${balance.cashBalance?.toFixed(2) || '0.00'}\n` +
        `Open P&L: $${balance.openPnL?.toFixed(2) || '0.00'}\n` +
        `Realized P&L: $${balance.realizedPnL?.toFixed(2) || '0.00'}\n` +
        `Margin: $${balance.margin?.toFixed(2) || '0.00'}`
      );
    } catch (err) {
      logger.error(`Telegram: Balance failed: ${err.message}`);
      await this._reply('❌ Failed to get balance');
    }
  }

  async _handleReport() {
    if (!this.bot) return await this._reply('❌ Bot not available');
    try {
      const results = await this._fanOut('GET', '/report');

      const lines = ['<b>📈 Today’s Performance</b>', ''];
      let trades = 0, wins = 0, losses = 0, be = 0, summed = 0;

      for (const r of results) {
        if (!r.ok) { lines.push(`❌ ${r.symbol}: no report (${r.error})`); continue; }
        const d = r.data || {};
        if (d.error) { lines.push(`❌ ${r.symbol}: ${d.error}`); continue; }
        trades += d.trades || 0;
        wins += d.wins || 0;
        losses += d.losses || 0;
        be += d.breakeven || 0;
        summed += d.pnl || 0;
        const icon = (d.pnl || 0) > 0 ? '🟢' : (d.pnl || 0) < 0 ? '🔴' : '⚪';
        lines.push(
          `${icon} <b>${d.instrument || r.symbol}</b>  ${(d.pnl || 0) >= 0 ? '+' : '-'}$${Math.abs(d.pnl || 0).toFixed(2)}` +
          `  ·  ${d.trades || 0} trade(s)  ·  ${d.wins || 0}W/${d.losses || 0}L${d.breakeven ? '/' + d.breakeven + 'BE' : ''}`
        );
      }

      // ONE account line. P&L comes from the SHARED ledger rather than summing
      // the per-instrument figures: the ledger is the number that actually
      // governs trading, and a divergence between them is worth seeing.
      const ls = this.bot.lossLimits?.getStatus?.() || {};
      const acctPnl = Number.isFinite(ls.dailyPnL) ? ls.dailyPnL : summed;
      const wr = trades > 0 ? (wins / trades) * 100 : 0;
      const icon = acctPnl > 0 ? '🟢' : acctPnl < 0 ? '🔴' : '⚪';
      lines.push('');
      lines.push(
        `${icon} <b>ACCOUNT</b>  ${acctPnl >= 0 ? '+' : '-'}$${Math.abs(acctPnl).toFixed(2)}` +
        `  ·  ${trades} trade(s)  ·  ${wins}W/${losses}L${be ? '/' + be + 'BE' : ''}` +
        `  ·  ${wr.toFixed(0)}% win  ·  $${(ls.dailyLossRemaining ?? 0).toFixed(2)} budget left`
      );
      // Surface a mismatch rather than quietly preferring one source.
      if (Number.isFinite(ls.dailyPnL) && Math.abs(ls.dailyPnL - summed) > 0.01) {
        lines.push(`⚠️ ledger $${ls.dailyPnL.toFixed(2)} vs instruments $${summed.toFixed(2)} — a trade may not have been recorded`);
      }

      await this._reply(lines.join('\n'));
    } catch (err) {
      logger.error(`Telegram: Report failed: ${err.message}`);
      await this._reply(`❌ Failed to generate report: ${err.message}`);
    }
  }

}

module.exports = TelegramCommandHandler;
