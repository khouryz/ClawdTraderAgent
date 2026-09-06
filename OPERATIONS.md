# OPERATIONS — how to actually run this system

Read this together with `BRIEF.md` (what the job is and the trading rules) and
your memory files (`MEMORY.md` plus everything it links). This file is the
*operating* manual: how to stay alive for a whole session, how to fix yourself,
and the mistakes that have already cost real money or real downtime.

---

## 1. The loop. This is the single most important thing.

Long sessions die quietly. Every method that *looks* like it should work has
failed here except one.

**What failed, and how:**
- `CronCreate` — fired **0 times in 3 hours**. No error. The day was simply missed.
- `ScheduleWakeup` with short delays — unreliable; wake-ups silently did not fire.
- Assuming a long `delaySeconds` is fine — a ~3600s delay meant the market moved
  for an hour unattended.

**What works: a `Monitor` tick loop.** Arm a Monitor with `persistent: true`.
Its events arrive as `<task-notification>` messages and wake you immediately.
Pair it with a **long** `ScheduleWakeup` (1200–1800s) as a fallback heartbeat
only — never as the primary clock.

**Cadence:**
- Flat, hunting for setups: check every few minutes.
- **Setup armed or in a position: every 60 seconds.**
- Scan **bar extremes**, not last price. A wick through your stop is a stop-out
  even if the close is fine.

**Every single wake-up, say a heartbeat** — one line stating the time (PST), what
you looked at, and that nothing is broken. Zaid has explicitly asked for this:
silence is indistinguishable from being stuck, and he has had to ask "are you
still watching??" more than once. Report substance only on a fill, a stop-out, a
management point, a setup arming or dying, or a precondition change.

**Ending the loop** is a per-turn decision, not a default. Stop at the EOD
flatten, or when the user says so.

---

## 2. Self-fixing — your standing authority and its limits

Zaid has given standing permission to **repair problems and keep the trading day
going**. Do not stop the day to ask about a broken script, a dead socket, a
wedged indicator, or a service that needs restarting. Fix it and continue.

**Two carve-outs, absolute:**
1. **Never weaken a guardrail.** Do not widen a risk cap, raise a trade limit,
   disable a check, or move a stop to make a trade fit. If the structural stop is
   too wide, *there is no trade* — that is the correct outcome, not a problem to
   engineer around.
2. **Never trade blind.** If you cannot read prices from the chart, you do not
   trade. Fix the chart first.

**Recovery runbook:**

| Symptom | Fix |
|---|---|
| Chart unreadable / CDP dead | `systemctl restart tradingview`, wait ~35s, re-check `http://127.0.0.1:9223/json` |
| TradingView asks to sign in | `bash /root/tvtools/tv_auth.sh`, then finish over VNC with **"copy the secret key"** — the `tradingview://` redirect burns the key |
| A study is stuck loading (`status().type === 1`) | Reload the **page**, not the app |
| Bot not answering | `systemctl restart clawd-mnq` (or `clawd-mes`); confirm with `signal_cli.py --port <p> status` |
| Bot halted unexpectedly | Read `haltReason` first. Only `/forceresume` if you understand why it halted |
| Telegram commands dead | Exactly one instance polls; check the poller lock. **Never set a webhook** — it 409s the poller |
| Something looks impossible | Check `hostname` — it must be `srv1335033`. There is a second VPS |

---

## 3. Verify by running, not by reading

Nearly every serious defect in this system was found by executing something, not
by reading code or trusting a green suite:

- A WebSocket handler bound to a stale socket **killed the whole process** on
  reconnect. Invisible to review.
- A closed trade reported **+$75.00 / 0.53R** for a +$150 / 1.06R trade — it sized
  off *remaining* quantity.
- A test "passed" because an unrelated error did not contain the string being
  asserted. **Asserting on the absence of a string passes for every wrong reason.**
- Bar timestamps are **seconds**; treating them as ms dated every bar to 1970.
- `_primitivesDataById` is a **Map** — `Object.keys()` returns `[]`, so the level
  reader silently reported **zero levels** on a chart covered in them. A silent
  empty list is the dangerous failure: it looks like "no levels", not "broken".

So: after any fix, run the thing and read the actual output. `npm test` must be
green *before* you rely on it, and a green suite is not proof the live path works.

---

## 4. Command cheatsheet

```bash
node scripts/preflight.js                         # exit 0 = safe to trade
python3 scripts/signal_cli.py --port 8787 status  # MNQ   (8788 = MES)
python3 scripts/signal_cli.py --port 8787 positions
systemctl restart tradingview | clawd-mnq | clawd-mes
tmux attach -t clawd                              # this session, from SSH
bash /root/tvtools/start_trading_day.sh           # start/restart the day
bash /root/tvtools/tv_auth.sh                     # re-auth TradingView
```

A bare `curl /status` returns `{"error":"unauthorized"}` — the endpoint needs the
webhook token. Use `signal_cli.py`, which reads it from `.env`.

---

## 5. Gotchas that have bitten, in this environment

- **`pkill -f <pattern>` over SSH kills your own session** — the remote shell is
  `bash -lc '<entire script>'`, so the script text is in its own cmdline. Use
  `pkill -x`, or kill by pid, or match the resolved `/proc/<pid>/exe`.
- **`pkill -x firefox` matches nothing** — the real binary's comm is `firefox-bin`.
- **TradingView needs `--disable-gpu`** on this box or Electron crash-loops on
  every reboot with a fatal GPU abort. Already in the unit file; do not remove it.
- **Minimising the TradingView window can throttle Electron's rendering.** Leave
  it mapped.
- **The chart layout `Trading Setup` is shared with Zaid's laptop.** Changing the
  symbol/timeframe live is fine; **ask before saving**.
- **Read levels on the 5m chart only.** A 1H chart returns a different, wrong set.
- Pane and drawing tools can return `success: true` while silently doing nothing.
  Verify with `pane_list` / `draw_list`.
- `pine_smart_compile` and `pine_new` write into whatever editor tab is open and
  can destroy a saved script. Be careful.

---

## 6. Start of day

1. `node scripts/preflight.js` — fix anything it flags.
2. Confirm the chart is **MNQ 5m** and the Pivot-Open Levels indicator is loaded.
3. Check both bots: connected, not halted, trades used vs 3 each.
4. Build the pre-market plan (the `premarket-plan` skill).
5. Arm the Monitor loop and start calling out heartbeats.
6. **No new entries after 12:30 PST. Ensure flat by 12:55 PST**, then post the day
   summary and append it to the `trading-day-log` memory file.

---

## 7. Reading the chart correctly — four traps

These all produce *plausible-looking wrong answers*, which is worse than an error.

**a. The chart lazy-loads ~300 bars, and `setVisibleRange` alone will NOT load more.**
It clamps to what is already in the model. 300 5m bars is ~1.5 sessions, which
gives `__tfBucketed` only ~26 hourly bars and it returns
`"too few hourly bars - widen the visible range"`. Page history in explicitly:

```js
// repeat until you have enough bars, or requestMoreDataAvailable() is false
mainSeries().requestMoreData(1000);   // then wait ~1.8s and re-check the count
```
Rule of thumb: the bucketed hourly needs **7+ RTH sessions** of 5m — 550 bars
minimum, ~1600 is comfortable. Always confirm `lastSession` comes back as
`["09:30","10:30","11:30","12:30","13:30","14:30","15:30"]` (S6.1, 7 candles).
If it does not, the trend read is invalid — stop, do not report it.

**b. Read the indicator's APPLIED input values. Never infer them from labels.**
`in_3` (includeToday) and `in_4` (liveInvalidate) are the planning flags and both
must be true for a between-sessions read. Seeing an "Open ####" label on the
chart does **not** prove they are on — that inference has already produced a
level map read in the wrong state. Query the study's inputs, and when you flip
them, run the **diff** so you can say what `in_4` actually removed.

**c. Cross-check the level set on a second timeframe.** Read on 5m, then confirm
the same set appears on 15m. If they disagree, the map is not trustworthy.

**d. Check the study's `pineVersion`.** The gap-invalidation fix shipped as
**v15**. On v14 a level that was gapped over is silently deleted — and a silent
empty result looks like "no levels", not "broken". Confirm the version before
trusting the map in a live session.

**Swing length:** the skill's examples use `N:2`, but the calibrated value is
**N=3** and the two disagree on *direction* — on 6 Sep 2026 data, N=2 read the
weekly as range/daily down/hourly up while N=3 read weekly up/daily range/hourly
range. Always use N=3, and say so.

**Engine labels compress the sequence.** `__tf` compares only the last two swings
of each type, so a broken downtrend can be labelled "range HH+LL". Read the raw
swing sequence before accepting a state label, and check whether a "lower low" is
structural or noise — 9 points against a 31.86 ATR is a double bottom, not a
lower low.
