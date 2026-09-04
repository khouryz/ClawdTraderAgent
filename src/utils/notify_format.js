/**
 * Notification wording.
 *
 * One place that turns bot state into a message a human can act on at a glance.
 * The rules these follow, from Zaid's feedback on 2 Sep 2026:
 *
 *   - Never make the reader resolve an ID. "Order #634602920614" means nothing;
 *     "leg 2 of 2 stop" does.
 *   - Always say what CHANGED, not just the new value: "29166 → 29150".
 *   - Money and risk, not just prices. A stop move should say what the risk is
 *     now, because that is the thing being decided.
 *   - Show every target, not only the first.
 *   - 3-5 lines. Informative, not a wall.
 *
 * These are pure functions — no I/O — so they are unit-testable.
 */

const px = (v) => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(2);
const pts = (v) => (v == null || !Number.isFinite(v)) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}pt`;
const usd = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = Math.abs(v) >= 100 ? Math.round(Math.abs(v)).toString() : Math.abs(v).toFixed(2);
  return `${v < 0 ? '-' : v > 0 ? '+' : ''}$${s}`;
};
const money = (v) => (v == null || !Number.isFinite(v)) ? '—' : `$${Math.abs(v) >= 100 ? Math.round(v) : v.toFixed(2)}`;
const side = (s) => (s === 'Buy' ? 'LONG' : s === 'Sell' ? 'SHORT' : String(s || '?'));

/** R multiple of a target given entry and stop. */
function rMultiple(entry, stop, target) {
  const risk = Math.abs(entry - stop);
  if (!risk) return null;
  return Math.abs(target - entry) / risk;
}

/** Human label for an order id: which leg, and is it the stop or the target. */
function describeOrder(orderId, position) {
  const legs = (position && position.bracketLegs) || [];
  const n = legs.length;
  for (let i = 0; i < n; i++) {
    const leg = legs[i];
    if (leg.orderId === orderId) {
      return { role: 'stop', legNo: i + 1, legCount: n, qty: leg.qty, current: leg.stopPrice ?? position.stopLoss, target: leg.targetPrice };
    }
    if (leg.ocoId === orderId) {
      return { role: 'target', legNo: i + 1, legCount: n, qty: leg.qty, current: leg.targetPrice, target: leg.targetPrice };
    }
  }
  if (position && position.stopOrderId === orderId) {
    return { role: 'stop', legNo: 1, legCount: n || 1, qty: position.quantity, current: position.stopLoss, target: position.target };
  }
  if (position && position.targetOrderId === orderId) {
    return { role: 'target', legNo: 1, legCount: n || 1, qty: position.quantity, current: position.target, target: position.target };
  }
  return { role: 'order', legNo: null, legCount: n, qty: null, current: null, target: null };
}

/** "leg 2 of 2" — omitted entirely when there is only one leg. */
function legLabel(d) {
  if (!d.legNo || !d.legCount || d.legCount < 2) return '';
  return ` (leg ${d.legNo} of ${d.legCount})`;
}

/**
 * Every target STILL WORKING, as "T1 29094.50 · T2 29012.25".
 * Legs already filled are numbered but excluded, so a message never claims a
 * target is live after it has been hit.
 */
function targetList(position) {
  const legs = (position && position.bracketLegs) || [];
  const withT = legs.filter(l => l.targetPrice != null);
  if (withT.length) {
    const live = withT.map((l, i) => ({ ...l, n: i + 1 })).filter(l => !l.filled);
    if (!live.length) return 'all targets filled';
    return live.map(l => `T${l.n} ${px(l.targetPrice)}${l.qty > 1 ? ` (${l.qty})` : ''}`).join(' · ');
  }
  if (position && position.target != null) return `T1 ${px(position.target)}`;
  return 'no target set';
}

/**
 * Dollars still at risk if every remaining stop is hit from the entry.
 *
 * Signed from the trader's view: a stop past breakeven is money LOCKED IN, not
 * risk, so it contributes negatively. Filled legs are excluded — they are no
 * longer exposed. Without this the message could say "risk now ZERO" on one
 * line and "total open risk $81" on the next.
 */
function openRisk(position, pointValue) {
  if (!position || !Number.isFinite(pointValue)) return null;
  const entry = position.entryPrice;
  if (!entry) return null;
  const isLong = position.side === 'Buy';
  const legs = (position.bracketLegs || [])
    .filter(l => !l.filled && (l.stopPrice ?? position.stopLoss) != null);
  if (legs.length) {
    return legs.reduce((sum, l) => {
      const s = l.stopPrice ?? position.stopLoss;
      const risk = isLong ? (entry - s) : (s - entry);   // >0 = real risk, <0 = locked profit
      return sum + risk * (l.qty || 1) * pointValue;
    }, 0);
  }
  if (position.stopLoss == null) return null;
  const risk = isLong ? (entry - position.stopLoss) : (position.stopLoss - entry);
  return risk * (position.quantity || 1) * pointValue;
}

/**
 * The exit plan as a per-leg table — the numbers that actually exist at the
 * broker, with the money each leg is worth.
 *
 * Replaces two separate messages that between them showed a target that was
 * never placed (an auto-2.5R price) and a "Reward" computed as risk x 2.5
 * rather than from the real legs. On 2 Sep that claimed $200 on a plan whose
 * legs were actually worth $389.
 */
function exitTable({ entry, stop, exits, qty, pointValue, side: s }) {
  const rows = [];
  const legs = (exits && exits.length) ? exits : null;
  let totalReward = 0;
  if (legs) {
    legs.forEach((l, i) => {
      const movePts = Math.abs(entry - l.targetPrice);
      const money$ = movePts * (l.qty || 1) * pointValue;
      totalReward += money$;
      const r = rMultiple(entry, stop, l.targetPrice);
      rows.push(`T${i + 1}  ${l.qty || 1} @ ${px(l.targetPrice)}   +$${Math.round(money$)}${r ? `  (${r.toFixed(1)}R)` : ''}`);
    });
  }
  const riskPts = Math.abs(entry - stop);
  const riskUsd = riskPts * qty * pointValue;
  rows.push(`Stop  ${px(stop)}   -$${Math.round(riskUsd)}  (${riskPts.toFixed(2)}pt)`);
  return { table: rows.join('\n'), totalReward, riskUsd };
}

// ── Messages ────────────────────────────────────────────────────────

/** A resting entry order is working — the setup is armed but not filled. */
function setupArmed({ symbol, side: s, entry, stop, exits, qty, pointValue, timeoutSec, orderType }) {
  const dir = side(s);
  const { table, totalReward, riskUsd } = exitTable({ entry, stop, exits, qty, pointValue, side: s });
  const trigger = orderType === 'Stop'
    ? `${dir === 'LONG' ? 'Buy' : 'Sell'} stop ${px(entry)} — fills only if price trades through it`
    : `${orderType || 'Market'} entry ${px(entry)}`;
  const rr = riskUsd ? (totalReward / riskUsd) : null;
  return `🎯 <b>Setup armed — ${symbol} ${dir} ${qty}</b>\n` +
         `${trigger}\n\n` +
         `${table}\n\n` +
         (totalReward ? `Max reward $${Math.round(totalReward)} vs $${Math.round(riskUsd)} risk${rr ? ` · ${rr.toFixed(1)}:1` : ''}\n` : '') +
         `Auto-cancels in ${Math.round((timeoutSec || 900) / 60)}m if it never triggers`;
}

/** Entry filled and brackets are live. */
function positionOpened({ symbol, side: s, qty, fillPrice, stop, position, pointValue, slippage }) {
  const ok = Number.isFinite(fillPrice) && Number.isFinite(stop);
  if (!ok) {
    return `✅ <b>Filled — ${symbol} ${side(s)} ${qty} @ ${px(fillPrice)}</b>\n` +
           `Stop ${px(stop)} · ⚠️ risk unknown\n${targetList(position)}`;
  }
  // Everything priced off the ACTUAL fill, and only against legs that exist.
  const exits = (position?.bracketLegs || []).filter(l => l.targetPrice != null)
    .map(l => ({ qty: l.qty, targetPrice: l.targetPrice }));
  const { table, totalReward, riskUsd } = exitTable({
    entry: fillPrice, stop, exits: exits.length ? exits : null, qty, pointValue, side: s,
  });

  // If it filled where it was supposed to, the numbers are identical to the
  // "Setup armed" message that went out minutes earlier — repeating the whole
  // table is noise. Confirm the fill in two lines instead, and only re-print
  // the table when slippage actually moved the maths.
  const moved = Number.isFinite(slippage) && Math.abs(slippage) >= 0.25;
  if (!moved) {
    const tLine = exits.length
      ? exits.map((l, i) => `T${i + 1} ${px(l.targetPrice)}`).join(' · ')
      : targetList(position);
    return `✅ <b>Filled — ${symbol} ${side(s)} ${qty} @ ${px(fillPrice)}</b>\n` +
           `Brackets live as planned — ${tLine} · stop ${px(stop)}\n` +
           `Risk $${Math.round(riskUsd)}${totalReward ? ` · max reward $${Math.round(totalReward)}` : ''}`;
  }
  return `✅ <b>Filled — ${symbol} ${side(s)} ${qty} @ ${px(fillPrice)}</b>  (${pts(slippage)} slip)\n` +
         `Slippage moved the maths — recalculated from the fill:\n\n` +
         `${table}` +
         (totalReward ? `\n\nMax reward $${Math.round(totalReward)} vs $${Math.round(riskUsd)} risk` : '');
}

/** A stop was moved. The headline number is the new risk, not the price. */
function stopMoved({ symbol, position, from, to, desc, pointValue }) {
  const entry = position?.entryPrice;
  const qty = desc?.qty || position?.quantity || 1;
  const known = Number.isFinite(entry) && Number.isFinite(to);
  const newRiskPts = known ? Math.abs(entry - to) : null;
  const newRiskUsd = (newRiskPts != null && Number.isFinite(pointValue)) ? newRiskPts * qty * pointValue : null;
  const isBE = known && Math.abs(to - entry) < 0.01;
  const beyondBE = known && (position?.side === 'Buy' ? to > entry : to < entry);

  let riskLine;
  if (!known) riskLine = '⚠️ Risk unknown — entry or stop price missing';
  else if (isBE) riskLine = 'Risk now ZERO — stop is at breakeven';
  else if (beyondBE) riskLine = `Locked in ${money(newRiskUsd)} on ${qty} — stop is past breakeven`;
  else riskLine = `Risk now ${newRiskPts.toFixed(2)}pt · ${money(newRiskUsd)} on ${qty}`;

  // Only add a portfolio line when it tells the reader something the leg line
  // did not — repeating "zero risk" twice is noise, not clarity.
  const total = openRisk(position, pointValue);
  const legIsFlat = isBE || beyondBE;
  const totalIsFlat = total != null && total <= 0.005;
  let totalLine = '';
  if (desc?.legCount > 1 && total != null && !(legIsFlat && totalIsFlat)) {
    totalLine = total > 0.005
      ? `\nTotal still at risk: ${money(total)}`
      : `\nTotal locked in: ${money(-total)}`;
  }

  return `🛡 <b>Stop moved — ${symbol} ${side(position?.side)}</b>${legLabel(desc)}\n` +
         `${px(from)} → ${px(to)}\n` +
         `${riskLine}${totalLine}`;
}

/** A target was moved (rare — targets come from levels). */
function targetMoved({ symbol, position, from, to, desc }) {
  const r = position?.entryPrice != null && position?.stopLoss != null
    ? rMultiple(position.entryPrice, position.stopLoss, to) : null;
  return `🎯 <b>Target moved — ${symbol} ${side(position?.side)}</b>${legLabel(desc)}\n` +
         `${px(from)} → ${px(to)}${r ? ` (${r.toFixed(1)}R)` : ''}\n` +
         `${targetList(position)}`;
}

/** Generic modify that is neither a stop nor a target price. */
function orderModified({ symbol, desc, changes }) {
  const bits = [];
  if (changes.orderQty != null) bits.push(`quantity → ${changes.orderQty}`);
  const what = desc?.role === 'order' ? 'An order' : `The ${desc.role}${legLabel(desc)}`;
  return `🔧 <b>Order updated — ${symbol}</b>\n${what} changed: ${bits.join(', ') || 'updated'}`;
}

/**
 * @param orderStillLive false when the order is gone (filled/cancelled).
 *   Saying "the original order is still working" about a CANCELLED order is
 *   worse than saying nothing — it implies protection that is not there.
 */
function modifyFailed({ symbol, desc, reason, orderStillLive = true, ordStatus }) {
  const what = desc?.role === 'order' ? 'an order' : `the ${desc.role}${legLabel(desc)}`;
  const tail = orderStillLive
    ? 'Nothing changed — the original order is still working.'
    : `Nothing was changed. That order is ${ordStatus ? ordStatus.toLowerCase() : 'gone'}, so there is nothing at the broker to move — check the position before assuming it is protected.`;
  return `⚠️ <b>Could not move ${what} — ${symbol}</b>\n${reason}\n${tail}`;
}

/** Part of the position closed at a target. */
function partialExit({ symbol, position, legNo, qty, price, pnlUsd, pnlPts, remainingQty, stopNow, movingToBE }) {
  const beNote = (position?.entryPrice != null && stopNow != null && Math.abs(stopNow - position.entryPrice) < 0.01)
    ? ' (breakeven)' : '';
  const stopLine = movingToBE
    ? `${remainingQty} left · moving stop to breakeven`
    : stopNow != null
      ? `${remainingQty} left · stop ${px(stopNow)}${beNote}`
      : `${remainingQty} left`;
  return `🎯 <b>T${legNo} hit — ${symbol} ${side(position?.side)}</b>\n` +
         `Closed ${qty} @ ${px(price)} · ${pts(pnlPts)} · ${usd(pnlUsd)}\n` +
         `${stopLine}\n` +
         `Still working: ${targetList(position)}`;
}

/**
 * Part of the position was STOPPED OUT (a loss), not taken at a target.
 *
 * This must never render as "🎯 T1 hit". Observed live 2 Sep: a stop fill was
 * labelled T1 on a losing trade, which reads as good news and also triggered
 * the move-to-breakeven that is meant to follow a target.
 */
function partialStopOut({ symbol, position, qty, price, pnlUsd, pnlPts, remainingQty }) {
  return `🛑 <b>Stopped out — ${symbol} ${side(position?.side)}</b>\n` +
         `Closed ${qty} @ ${px(price)} · ${pts(pnlPts)} · ${usd(pnlUsd)}\n` +
         `${remainingQty} still open · stop unchanged at ${px(position?.stopLoss)}\n` +
         `Still working: ${targetList(position)}`;
}

/**
 * Whole position closed.
 *
 * When legs filled separately (T1 target then T2 stopped, or both stopped),
 * `legs` is an array of { kind, legNo, qty, price, pnl } so the message can
 * show what each leg did instead of a single blended average the reader has
 * to unpick. When there is only one exit (single contract, or both legs
 * filled at the same price), `legs` is omitted and the message stays compact.
 */
function positionClosed({ symbol, position, qty, avgExit, pnlUsd, pnlPts, rMult, reason, dayTrades, maxTrades, dayPnl, lossBudgetLeft, legs, commission }) {
  const verdict = pnlUsd > 0 ? '🟢' : pnlUsd < 0 ? '🔴' : '⚪';
  const reasonLine = reason ? `${reason}` : 'closed';

  // Per-leg breakdown — only when more than one leg filled at DIFFERENT prices.
  // A single-contract close, or both legs stopped at the same price, stays on
  // one line.
  let legLines = '';
  if (Array.isArray(legs) && legs.length > 1) {
    const distinctPrices = new Set(legs.map(l => l.price));
    if (distinctPrices.size > 1) {
      legLines = legs.map(l => {
        const label = l.kind === 'target' ? `T${l.legNo} hit` : `T${l.legNo} stopped`;
        return `${label} ${usd(l.pnl)}`;
      }).join(' · ');
      legLines += '\n';
    }
  }

  return `${verdict} <b>Closed — ${symbol} ${side(position?.side)} ${qty}</b>\n` +
         `${legLines}` +
         `${px(position?.entryPrice)} → ${px(avgExit)} · ${pts(pnlPts)} · ${usd(pnlUsd)}${rMult != null ? ` · ${rMult.toFixed(2)}R` : ''}\n` +
         // Show the fee when there is one, so net never reads as a maths error
         // against the points. Gross-of-fees P&L overstated 4 Sep by $9.10.
         (Number.isFinite(commission) && commission > 0
           ? `after ${money(commission)} commission` + String.fromCharCode(10) : '') +
         `${reasonLine}\n` +
         `Day: ${dayTrades}/${maxTrades} trades · ${usd(dayPnl)} · ${money(lossBudgetLeft)} loss budget left`;
}

/** The broker refused the entry — no position was opened. */
function entryRejected({ symbol, side: s, reason, tradesToday, maxTrades }) {
  return `❌ <b>Entry rejected — ${symbol} ${side(s)}</b>\n` +
         `The broker refused the order: ${reason}\n` +
         `No position opened. Trade budget refunded (${tradesToday}/${maxTrades} used).`;
}

/** A resting entry was pulled before it ever filled. */
function entryCancelled({ symbol, side: s, entry, why, tradesToday, maxTrades }) {
  return `📤 <b>Setup cancelled — ${symbol} ${side(s)}</b>\n` +
         `The ${px(entry)} entry never triggered — ${why}.\n` +
         `Nothing was opened. ${tradesToday}/${maxTrades} trades used.`;
}

function botOnline({ symbol, env, windowStart, windowEnd, entryCutoff, tradesToday, maxTrades, lossBudget, uncleanRestart, openPosition }) {
  const warn = uncleanRestart
    ? `\n⚠️ Previous shutdown was not clean (crash, kill, or sleep) — check for stray orders.`
    : '';
  const posLine = openPosition
    ? `\n⚠️ Re-adopted an open position: ${side(openPosition.side)} ${openPosition.quantity} @ ${px(openPosition.entryPrice)}`
    : '';
  return `🟢 <b>Bot online — ${symbol}${env ? ` · ${env}` : ''}</b>\n` +
         `Trading ${windowStart}–${windowEnd} PST, entries until ${entryCutoff}\n` +
         `${tradesToday}/${maxTrades} trades used · ${money(lossBudget)} loss budget${warn}${posLine}`;
}

function botOffline({ reason, flat, workingOrders }) {
  const state = flat
    ? 'Flat, no open orders.'
    : `⚠️ NOT FLAT — ${workingOrders || 0} order(s) still at the broker. Check manually.`;
  return `🔴 <b>Bot offline</b>\n${reason || 'Shutting down'} — no signals will be processed.\n${state}`;
}

/** Startup re-adoption. Must list EVERY target, not just the first. */
function startupAdopted({ symbol, position, hasStop, pointValue }) {
  const risk = openRisk(position, pointValue);
  const stopLine = hasStop
    ? `Stop ${px(position.stopLoss)}${risk != null ? ` · risk ${money(risk)}` : ''}`
    : `🚨 NO STOP — this position is unprotected`;
  return `🔄 <b>Recovered open position — ${symbol}</b>\n` +
         `${side(position.side)} ${position.quantity} @ ${px(position.entryPrice)}\n` +
         `${stopLine}\n` +
         `${targetList(position)}`;
}

module.exports = {
  px, pts, usd, money, side, rMultiple,
  describeOrder, legLabel, targetList, openRisk,
  setupArmed, positionOpened, stopMoved, targetMoved, orderModified, modifyFailed,
  partialExit, partialStopOut, positionClosed, entryRejected, entryCancelled,
  botOnline, botOffline, startupAdopted,
};
