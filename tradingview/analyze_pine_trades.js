// Analyze Pine Script trade export to identify patterns and issues
const fs = require('fs');

const raw = fs.readFileSync('C:\\Users\\zaidf\\Downloads\\MNQ_pine_List_of_trades.csv', 'utf8');
const lines = raw.trim().split('\n');
const header = lines[0].split(',');

// Parse trades (entry+exit pairs)
const trades = [];
for (let i = 1; i < lines.length; i += 2) {
  const exit = lines[i].split(',');
  const entry = lines[i + 1]?.split(',');
  if (!entry) break;
  
  trades.push({
    num: parseInt(exit[0]),
    type: entry[1].replace('Entry ', ''),  // long or short
    entryTime: entry[2],
    exitTime: exit[2],
    signal: entry[3],       // PB_Long, PB_Short, VR_Long, VR_Short
    exitSignal: exit[3],    // PB_Exit, VR_Exit, Session End
    entryPrice: parseFloat(entry[4]),
    exitPrice: parseFloat(exit[4]),
    pnl: parseFloat(exit[7]),
    pnlPct: parseFloat(exit[8]),
    favExcursion: parseFloat(exit[9]),
    advExcursion: parseFloat(exit[11]),
    cumPnl: parseFloat(exit[13]),
  });
}

console.log(`\n${'='.repeat(70)}`);
console.log(`  MNQ MOMENTUM V2 PINE SCRIPT — TRADE ANALYSIS`);
console.log(`${'='.repeat(70)}\n`);

// ── Basic Stats ──
const wins = trades.filter(t => t.pnl > 0);
const losses = trades.filter(t => t.pnl <= 0);
console.log(`Total Trades: ${trades.length}`);
console.log(`Winners: ${wins.length} (${(wins.length/trades.length*100).toFixed(1)}%)`);
console.log(`Losers: ${losses.length} (${(losses.length/trades.length*100).toFixed(1)}%)`);
console.log(`Net P&L: $${trades[trades.length-1].cumPnl.toFixed(2)}`);
console.log(`Avg Win: $${(wins.reduce((s,t) => s+t.pnl, 0)/wins.length).toFixed(2)}`);
console.log(`Avg Loss: $${(losses.reduce((s,t) => s+t.pnl, 0)/losses.length).toFixed(2)}`);
console.log(`Profit Factor: ${(wins.reduce((s,t) => s+t.pnl, 0) / Math.abs(losses.reduce((s,t) => s+t.pnl, 0))).toFixed(2)}`);

// ── Strategy Breakdown ──
console.log(`\n── Strategy Breakdown ──`);
const pbTrades = trades.filter(t => t.signal.startsWith('PB'));
const vrTrades = trades.filter(t => t.signal.startsWith('VR'));
const pbWins = pbTrades.filter(t => t.pnl > 0);
const vrWins = vrTrades.filter(t => t.pnl > 0);
console.log(`PB: ${pbTrades.length} trades, ${pbWins.length} wins (${(pbWins.length/pbTrades.length*100).toFixed(1)}%), P&L: $${pbTrades.reduce((s,t) => s+t.pnl, 0).toFixed(2)}`);
console.log(`VR: ${vrTrades.length} trades, ${vrWins.length} wins (${vrTrades.length > 0 ? (vrWins.length/vrTrades.length*100).toFixed(1) : 0}%), P&L: $${vrTrades.reduce((s,t) => s+t.pnl, 0).toFixed(2)}`);

// ── Direction Breakdown ──
console.log(`\n── Direction Breakdown ──`);
const longs = trades.filter(t => t.type === 'long');
const shorts = trades.filter(t => t.type === 'short');
const longWins = longs.filter(t => t.pnl > 0);
const shortWins = shorts.filter(t => t.pnl > 0);
console.log(`Long:  ${longs.length} trades, ${longWins.length} wins (${(longWins.length/longs.length*100).toFixed(1)}%), P&L: $${longs.reduce((s,t) => s+t.pnl, 0).toFixed(2)}`);
console.log(`Short: ${shorts.length} trades, ${shortWins.length} wins (${(shortWins.length/shorts.length*100).toFixed(1)}%), P&L: $${shorts.reduce((s,t) => s+t.pnl, 0).toFixed(2)}`);

// ── Duration Analysis ──
console.log(`\n── Trade Duration (minutes) ──`);
const durations = trades.map(t => {
  const entry = new Date(t.entryTime);
  const exit = new Date(t.exitTime);
  return (exit - entry) / 60000;
});
const winDurations = trades.filter(t => t.pnl > 0).map(t => (new Date(t.exitTime) - new Date(t.entryTime)) / 60000);
const lossDurations = trades.filter(t => t.pnl <= 0).map(t => (new Date(t.exitTime) - new Date(t.entryTime)) / 60000);
console.log(`Avg: ${(durations.reduce((s,d)=>s+d,0)/durations.length).toFixed(1)} min`);
console.log(`Avg Win:  ${(winDurations.reduce((s,d)=>s+d,0)/winDurations.length).toFixed(1)} min`);
console.log(`Avg Loss: ${(lossDurations.reduce((s,d)=>s+d,0)/lossDurations.length).toFixed(1)} min`);

// ── Same-minute / 1-minute entries ──
const quickExits = trades.filter(t => {
  const dur = (new Date(t.exitTime) - new Date(t.entryTime)) / 60000;
  return dur <= 2;
});
console.log(`\n── Quick Exits (≤2 min) ──`);
console.log(`Count: ${quickExits.length} / ${trades.length} (${(quickExits.length/trades.length*100).toFixed(1)}%)`);
console.log(`Quick Exit P&L: $${quickExits.reduce((s,t)=>s+t.pnl,0).toFixed(2)}`);
const qWins = quickExits.filter(t => t.pnl > 0);
console.log(`Quick Exit WR: ${(qWins.length/quickExits.length*100).toFixed(1)}%`);

// ── Session End exits ──
const sessionEndExits = trades.filter(t => t.exitSignal === 'Session End');
console.log(`\n── Session End Exits ──`);
console.log(`Count: ${sessionEndExits.length}`);
sessionEndExits.forEach(t => console.log(`  #${t.num}: ${t.entryTime} → ${t.exitTime} | ${t.signal} | P&L: $${t.pnl.toFixed(2)}`));

// ── Entry Time Distribution (PST) ──
console.log(`\n── Entry Hour Distribution (Exchange/CT times shown) ──`);
const hourBuckets = {};
trades.forEach(t => {
  const h = parseInt(t.entryTime.split(' ')[1].split(':')[0]);
  if (!hourBuckets[h]) hourBuckets[h] = { count: 0, wins: 0, pnl: 0 };
  hourBuckets[h].count++;
  if (t.pnl > 0) hourBuckets[h].wins++;
  hourBuckets[h].pnl += t.pnl;
});
Object.keys(hourBuckets).sort((a,b) => a-b).forEach(h => {
  const b = hourBuckets[h];
  console.log(`  ${String(h).padStart(2,'0')}:xx CT | ${String(b.count).padStart(3)} trades | WR ${(b.wins/b.count*100).toFixed(0).padStart(3)}% | P&L $${b.pnl.toFixed(0).padStart(6)}`);
});

// ── Trades Per Day Analysis ──
console.log(`\n── Trades Per Day ──`);
const dayBuckets = {};
trades.forEach(t => {
  const day = t.entryTime.split(' ')[0];
  if (!dayBuckets[day]) dayBuckets[day] = [];
  dayBuckets[day].push(t);
});
const tpd = Object.values(dayBuckets).map(d => d.length);
console.log(`Avg trades/day: ${(tpd.reduce((s,v)=>s+v,0)/tpd.length).toFixed(1)}`);
console.log(`Max trades/day: ${Math.max(...tpd)}`);
const daysWithMany = Object.entries(dayBuckets).filter(([,d]) => d.length >= 3);
console.log(`Days with 3+ trades: ${daysWithMany.length}`);

// Check max losses per day compliance
console.log(`\n── Daily Loss Limit Compliance (max 2 losses/day) ──`);
let violations = 0;
Object.entries(dayBuckets).forEach(([day, dayTrades]) => {
  let lossCount = 0;
  let tradesAfterLimit = [];
  dayTrades.forEach(t => {
    if (lossCount >= 2) {
      tradesAfterLimit.push(t);
    }
    if (t.pnl < 0) lossCount++;
  });
  if (tradesAfterLimit.length > 0) {
    violations++;
    console.log(`  VIOLATION ${day}: ${dayTrades.length} trades, ${lossCount} losses, ${tradesAfterLimit.length} trades after limit`);
  }
});
if (violations === 0) console.log(`  ✓ No violations found`);

// ── Favorable Excursion Analysis (missed profits) ──
console.log(`\n── Favorable Excursion vs Actual P&L (missed profits) ──`);
const missedProfits = losses.map(t => ({ num: t.num, pnl: t.pnl, fav: t.favExcursion, missed: t.favExcursion - t.pnl }));
const bigMissed = missedProfits.filter(t => t.fav >= 40).sort((a,b) => b.fav - a.fav).slice(0, 10);
console.log(`Losses that had $40+ favorable excursion:`);
bigMissed.forEach(t => console.log(`  #${t.num}: P&L $${t.pnl.toFixed(2)} but saw $${t.fav.toFixed(2)} favorable (missed $${t.missed.toFixed(2)})`));

// ── Consecutive Loss Streaks ──
console.log(`\n── Consecutive Loss Streaks ──`);
let maxStreak = 0, curStreak = 0;
trades.forEach(t => {
  if (t.pnl <= 0) { curStreak++; maxStreak = Math.max(maxStreak, curStreak); }
  else curStreak = 0;
});
console.log(`Max consecutive losses: ${maxStreak}`);

// ── Monthly Breakdown ──
console.log(`\n── Monthly P&L ──`);
const months = {};
trades.forEach(t => {
  const m = t.entryTime.substring(0, 7);
  if (!months[m]) months[m] = { count: 0, pnl: 0, wins: 0 };
  months[m].count++;
  months[m].pnl += t.pnl;
  if (t.pnl > 0) months[m].wins++;
});
Object.keys(months).sort().forEach(m => {
  const d = months[m];
  console.log(`  ${m} | ${String(d.count).padStart(3)} trades | WR ${(d.wins/d.count*100).toFixed(0).padStart(3)}% | P&L $${d.pnl.toFixed(0).padStart(7)}`);
});

// ── Equity Curve Key Points ──
console.log(`\n── Equity Curve Milestones ──`);
let peak = 0, maxDD = 0, maxDDTrade = 0;
trades.forEach(t => {
  if (t.cumPnl > peak) peak = t.cumPnl;
  const dd = peak - t.cumPnl;
  if (dd > maxDD) { maxDD = dd; maxDDTrade = t.num; }
});
console.log(`Peak equity: $${(1000 + peak).toFixed(2)} (at trade producing cumPnl $${peak.toFixed(2)})`);
console.log(`Max drawdown: $${maxDD.toFixed(2)} (at trade #${maxDDTrade})`);
console.log(`Final equity: $${(1000 + trades[trades.length-1].cumPnl).toFixed(2)}`);

console.log(`\n${'='.repeat(70)}`);
