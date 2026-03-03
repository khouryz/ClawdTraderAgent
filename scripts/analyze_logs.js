/**
 * Log Analyzer — Parses production logs to extract:
 * - All PB SKIP reasons with counts
 * - All VR SKIP reasons with counts
 * - Trade entries and exits with P&L
 * - Daily summaries
 * - Filter rejection breakdown
 * - Time-of-day analysis
 */

const fs = require('fs');
const path = require('path');

const LOG_FILE = process.argv[2] || 'C:\\Users\\zaidf\\.windsurf\\worktrees\\ClawdTraderAgent\\ClawdTraderAgent-ec103658\\logs\\logs.txt';

if (!fs.existsSync(LOG_FILE)) {
  console.error(`Log file not found: ${LOG_FILE}`);
  process.exit(1);
}

console.log(`Reading ${LOG_FILE}...`);
const raw = fs.readFileSync(LOG_FILE, 'utf-8');
const lines = raw.split('\n');
console.log(`Total lines: ${lines.length}\n`);

// ═══════════════════════════════════════════════════════════════
//  SKIP REASON ANALYSIS
// ═══════════════════════════════════════════════════════════════

const pbSkips = {};
const vrSkips = {};
const emaxSkips = {};
const pbSignals = [];
const vrSignals = [];
const emaxSignals = [];
const pbWatchEvents = [];
const tradeEntries = [];
const tradeExits = [];
const dailyReports = [];
const fillEvents = [];
const errors = [];

// Regex patterns
const pbSkipRe = /\[PB #(\d+)\] SKIP: (.+)/;
const vrSkipRe = /\[VR\] SKIP: (.+)/;
const vrWatchRe = /\[VR\] .+ WATCH (LONG|SHORT)/;
const vrWaitRe = /\[VR\] (LONG|SHORT) (waiting|watch cancelled)/;
const pbSignalRe = /\[PB #(\d+)\] ✅ PATTERN: (BUY|SELL) @ ([\d.]+)/;
const pbFireRe = /\[PB\] 🚀 SIGNAL FIRED: (BUY|SELL) @ ([\d.]+)/;
const pbWatchRe = /\[PB WATCH\] (.+)/;
const fillRe = /Entry filled.*?@ ([\d.]+)/i;
const exitRe = /(Stop Loss|Take Profit|Breakeven|Target|EOD|BE stop)/i;
const pnlRe = /P&L[:\s]*\$?([-+]?[\d.]+)/i;
const dailyReportRe = /DAILY REPORT/;
const errorRe = /\[ERROR\]|Error:|CRITICAL|🚨/i;
const confluenceSkipRe = /\[PB #(\d+)\] SKIP: confluence (\d+)\/(\d+) < (\d+)/;
const trendSkipRe = /\[PB #(\d+)\] SKIP: (LONG|SHORT) counter-trend/;
const volFilterRe = /\[VOL_FILTER\] Signal rejected/;
const lossLimitRe = /losses today.*done for the day|halted/i;
const signalRejectedRe = /Signal rejected|risk too high|AI rejected/i;

// Detailed skip sub-categories
const skipCategories = {
  'impulse_range': 0,
  'impulse_body_ratio': 0,
  'retrace_pct': 0,
  'stop_distance': 0,
  'target_distance': 0,
  'pb_bar_direction': 0,
  'pb_close_position': 0,
  'past_cutoff': 0,
  'confluence': 0,
  'counter_trend': 0,
  'volume_filter': 0,
  'loss_limit': 0,
};

for (const line of lines) {
  // PB Skips
  const pbMatch = pbSkipRe.exec(line);
  if (pbMatch) {
    const reason = pbMatch[2].trim();
    let cat = 'other';
    if (reason.includes('impulse range')) cat = 'impulse_range';
    else if (reason.includes('impulse body ratio')) cat = 'impulse_body_ratio';
    else if (reason.includes('retrace')) cat = 'retrace_pct';
    else if (reason.includes('stop ')) cat = 'stop_distance';
    else if (reason.includes('target ')) cat = 'target_distance';
    else if (reason.includes('pb bar not')) cat = 'pb_bar_direction';
    else if (reason.includes('pb.close')) cat = 'pb_close_position';
    else if (reason.includes('past cutoff')) cat = 'past_cutoff';
    else if (reason.includes('confluence')) cat = 'confluence';
    
    skipCategories[cat] = (skipCategories[cat] || 0) + 1;
    
    if (!pbSkips[reason]) pbSkips[reason] = { count: 0, examples: [] };
    pbSkips[reason].count++;
    if (pbSkips[reason].examples.length < 3) pbSkips[reason].examples.push(line.trim().slice(0, 200));
  }
  
  // Counter-trend skips
  if (trendSkipRe.test(line)) {
    skipCategories['counter_trend']++;
  }
  
  // Volume filter
  if (volFilterRe.test(line)) {
    skipCategories['volume_filter']++;
  }
  
  // Loss limit
  if (lossLimitRe.test(line)) {
    skipCategories['loss_limit']++;
  }
  
  // VR Skips
  const vrMatch = vrSkipRe.exec(line);
  if (vrMatch) {
    const reason = vrMatch[1].trim();
    if (!vrSkips[reason]) vrSkips[reason] = 0;
    vrSkips[reason]++;
  }
  
  // PB Signals (pattern detected)
  if (pbSignalRe.test(line)) {
    pbSignals.push(line.trim());
  }
  
  // PB Signal Fired (actual entry)
  if (pbFireRe.test(line)) {
    const m = pbFireRe.exec(line);
    tradeEntries.push({ line: line.trim(), side: m[1], price: parseFloat(m[2]) });
  }
  
  // PB Watch events
  if (pbWatchRe.test(line)) {
    pbWatchEvents.push(line.trim());
  }
  
  // Confluence rejections
  const confMatch = confluenceSkipRe.exec(line);
  if (confMatch) {
    skipCategories['confluence']++;
  }
  
  // Errors
  if (errorRe.test(line)) {
    errors.push(line.trim().slice(0, 200));
  }
}

// Also extract actual trade P&L from signal fired + exit patterns
// Look for paired entry→exit sequences
const tradePattern = /SIGNAL FIRED.*?(BUY|SELL) @ ([\d.]+).*?stop=([\d.]+).*?target=([\d.]+)/;
const entryFilledPattern = /Entry filled.*?@ ([\d.]+)/;
const exitPattern = /Exit.*?reason[=:]\s*(\w+).*?P&L[=:]\s*\$?([-+]?[\d.]+)/i;
const positionClosedPattern = /Position closed.*?(win|loss|breakeven|be)/i;
const bracketPattern = /OCO.*?stop.*?target|bracket/i;

// Extract daily report data
const dailyPnLPattern = /TOTAL:.*?(\d+)t.*?(\d+)W\/(\d+)L\/(\d+)BE.*?([-+]\$[\d.]+)/;
for (const line of lines) {
  const dm = dailyPnLPattern.exec(line);
  if (dm) {
    dailyReports.push({
      trades: parseInt(dm[1]),
      wins: parseInt(dm[2]),
      losses: parseInt(dm[3]),
      be: parseInt(dm[4]),
      pnl: dm[5],
    });
  }
}

// ═══════════════════════════════════════════════════════════════
//  DEEP SKIP ANALYSIS: Extract numeric values from skip reasons
// ═══════════════════════════════════════════════════════════════

const impulseRanges = [];
const bodyRatios = [];
const retracePcts = [];
const stopDistances = [];
const targetDistances = [];

for (const line of lines) {
  // impulse range X < Y
  let m = /impulse range ([\d.]+) < ([\d.]+)/.exec(line);
  if (m) impulseRanges.push({ actual: parseFloat(m[1]), threshold: parseFloat(m[2]) });
  
  // impulse body ratio X < Y
  m = /impulse body ratio ([\d.]+) < ([\d.]+)/.exec(line);
  if (m) bodyRatios.push({ actual: parseFloat(m[1]), threshold: parseFloat(m[2]) });
  
  // retrace X% outside Y-Z%
  m = /retrace ([\d.]+)% outside ([\d.]+)-([\d.]+)%/.exec(line);
  if (m) retracePcts.push({ actual: parseFloat(m[1]), min: parseFloat(m[2]), max: parseFloat(m[3]) });
  
  // stop Xpt outside Y-Z
  m = /stop ([\d.]+)pt outside ([\d.]+)-([\d.]+)/.exec(line);
  if (m) stopDistances.push({ actual: parseFloat(m[1]), min: parseFloat(m[2]), max: parseFloat(m[3]) });
  
  // target Xpt < min Y
  m = /target ([\d.]+)pt < min ([\d.]+)/.exec(line);
  if (m) targetDistances.push({ actual: parseFloat(m[1]), min: parseFloat(m[2]) });
}

// ═══════════════════════════════════════════════════════════════
//  PRINT RESULTS
// ═══════════════════════════════════════════════════════════════

console.log('═'.repeat(70));
console.log('  PB SKIP REASON SUMMARY (Categorized)');
console.log('═'.repeat(70));

const totalSkips = Object.values(skipCategories).reduce((a, b) => a + b, 0);
const sortedCats = Object.entries(skipCategories).sort((a, b) => b[1] - a[1]);
for (const [cat, count] of sortedCats) {
  if (count === 0) continue;
  const pct = ((count / totalSkips) * 100).toFixed(1);
  console.log(`  ${cat.padEnd(25)} ${String(count).padStart(6)} (${pct}%)`);
}
console.log(`  ${'TOTAL'.padEnd(25)} ${String(totalSkips).padStart(6)}`);

console.log('\n' + '═'.repeat(70));
console.log('  PB SKIP DETAIL — Top 15 Unique Reasons');
console.log('═'.repeat(70));

const sortedSkips = Object.entries(pbSkips).sort((a, b) => b[1].count - a[1].count);
for (const [reason, data] of sortedSkips.slice(0, 15)) {
  console.log(`  [${data.count}x] ${reason}`);
}

// ── Numeric distributions ──
console.log('\n' + '═'.repeat(70));
console.log('  NUMERIC DISTRIBUTIONS OF REJECTED VALUES');
console.log('═'.repeat(70));

if (impulseRanges.length > 0) {
  const vals = impulseRanges.map(v => v.actual).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  const p75 = vals[Math.floor(vals.length * 0.75)];
  const p90 = vals[Math.floor(vals.length * 0.90)];
  const nearMiss = vals.filter(v => v >= vals[0] && v >= impulseRanges[0].threshold * 0.8).length;
  console.log(`\n  Impulse Range (rejected): ${vals.length} total`);
  console.log(`    Threshold: >= ${impulseRanges[0].threshold}pt`);
  console.log(`    Min=${vals[0].toFixed(1)} | Median=${median.toFixed(1)} | P75=${p75.toFixed(1)} | P90=${p90.toFixed(1)} | Max=${vals[vals.length-1].toFixed(1)}`);
  console.log(`    Near-miss (within 20%): ${nearMiss} trades would pass with threshold=${(impulseRanges[0].threshold * 0.8).toFixed(0)}pt`);
}

if (bodyRatios.length > 0) {
  const vals = bodyRatios.map(v => v.actual).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  const p75 = vals[Math.floor(vals.length * 0.75)];
  const wouldPassAt15 = vals.filter(v => v >= 0.15).length;
  const wouldPassAt10 = vals.filter(v => v >= 0.10).length;
  console.log(`\n  Body Ratio (rejected): ${vals.length} total`);
  console.log(`    Current threshold: >= ${bodyRatios[0].threshold}`);
  console.log(`    Min=${vals[0].toFixed(3)} | Median=${median.toFixed(3)} | P75=${p75.toFixed(3)} | Max=${vals[vals.length-1].toFixed(3)}`);
  console.log(`    Would pass at 0.15: ${wouldPassAt15}/${vals.length} (${(wouldPassAt15/vals.length*100).toFixed(0)}%)`);
  console.log(`    Would pass at 0.10: ${wouldPassAt10}/${vals.length} (${(wouldPassAt10/vals.length*100).toFixed(0)}%)`);
}

if (retracePcts.length > 0) {
  const vals = retracePcts.map(v => v.actual).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  const tooDeep = vals.filter(v => v > retracePcts[0].max).length;
  const tooShallow = vals.filter(v => v < retracePcts[0].min).length;
  const wouldPassMax80 = vals.filter(v => v >= retracePcts[0].min && v <= 80).length;
  const wouldPassMax90 = vals.filter(v => v >= retracePcts[0].min && v <= 90).length;
  console.log(`\n  Retrace % (rejected): ${vals.length} total`);
  console.log(`    Current range: ${retracePcts[0].min}% - ${retracePcts[0].max}%`);
  console.log(`    Min=${vals[0].toFixed(1)}% | Median=${median.toFixed(1)}% | Max=${vals[vals.length-1].toFixed(1)}%`);
  console.log(`    Too shallow (<${retracePcts[0].min}%): ${tooShallow}`);
  console.log(`    Too deep (>${retracePcts[0].max}%): ${tooDeep}`);
  console.log(`    Would pass with max=80%: ${wouldPassMax80} more trades`);
  console.log(`    Would pass with max=90%: ${wouldPassMax90} more trades`);
}

if (stopDistances.length > 0) {
  const vals = stopDistances.map(v => v.actual).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  const tooLarge = vals.filter(v => v > stopDistances[0].max).length;
  const tooSmall = vals.filter(v => v < stopDistances[0].min).length;
  const wouldPassMax32 = vals.filter(v => v >= stopDistances[0].min && v <= 32).length;
  const wouldPassMax40 = vals.filter(v => v >= stopDistances[0].min && v <= 40).length;
  const wouldPassMax45 = vals.filter(v => v >= stopDistances[0].min && v <= 45).length;
  console.log(`\n  Stop Distance (rejected): ${vals.length} total`);
  console.log(`    Current range: ${stopDistances[0].min} - ${stopDistances[0].max}pt`);
  console.log(`    Min=${vals[0].toFixed(1)}pt | Median=${median.toFixed(1)}pt | Max=${vals[vals.length-1].toFixed(1)}pt`);
  console.log(`    Too large (>${stopDistances[0].max}pt): ${tooLarge}`);
  console.log(`    Too small (<${stopDistances[0].min}pt): ${tooSmall}`);
  console.log(`    Would pass with max=32pt: ${wouldPassMax32} more`);
  console.log(`    Would pass with max=40pt: ${wouldPassMax40} more`);
  console.log(`    Would pass with max=45pt: ${wouldPassMax45} more`);
}

if (targetDistances.length > 0) {
  const vals = targetDistances.map(v => v.actual).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  const wouldPassMin40 = vals.filter(v => v >= 40).length;
  const wouldPassMin30 = vals.filter(v => v >= 30).length;
  console.log(`\n  Target Distance (rejected): ${vals.length} total`);
  console.log(`    Current min: ${targetDistances[0].min}pt`);
  console.log(`    Min=${vals[0].toFixed(1)}pt | Median=${median.toFixed(1)}pt | Max=${vals[vals.length-1].toFixed(1)}pt`);
  console.log(`    Would pass with min=40pt: ${wouldPassMin40} more`);
  console.log(`    Would pass with min=30pt: ${wouldPassMin30} more`);
}

// ── VR Skips ──
console.log('\n' + '═'.repeat(70));
console.log('  VR SKIP REASONS');
console.log('═'.repeat(70));
const sortedVR = Object.entries(vrSkips).sort((a, b) => b[1] - a[1]);
for (const [reason, count] of sortedVR) {
  console.log(`  [${count}x] ${reason}`);
}
if (sortedVR.length === 0) console.log('  (none found)');

// ── Trade Activity ──
console.log('\n' + '═'.repeat(70));
console.log('  TRADE ACTIVITY SUMMARY');
console.log('═'.repeat(70));
console.log(`  PB Patterns detected:   ${pbSignals.length}`);
console.log(`  PB Signals fired:       ${tradeEntries.length}`);
console.log(`  PB Watch events:        ${pbWatchEvents.length}`);
console.log(`  Daily reports found:     ${dailyReports.length}`);

// Breakdown of watch outcomes
const watchConfirmed = pbWatchEvents.filter(l => l.includes('CONFIRMED') || l.includes('LIMIT ZONE HIT') || l.includes('LIMIT+STRUCTURAL')).length;
const watchTimeout = pbWatchEvents.filter(l => l.includes('TIMEOUT')).length;
const watchInvalidated = pbWatchEvents.filter(l => l.includes('INVALIDATED')).length;
console.log(`\n  PB Watch outcomes:`);
console.log(`    Confirmed entries:  ${watchConfirmed}`);
console.log(`    Timeouts:           ${watchTimeout}`);
console.log(`    Invalidated:        ${watchInvalidated}`);

// ── Daily Reports ──
if (dailyReports.length > 0) {
  console.log('\n' + '═'.repeat(70));
  console.log('  DAILY REPORT DATA');
  console.log('═'.repeat(70));
  let totalT = 0, totalW = 0, totalL = 0, totalBE = 0;
  for (const r of dailyReports) {
    console.log(`  ${r.trades}t ${r.wins}W/${r.losses}L/${r.be}BE ${r.pnl}`);
    totalT += r.trades;
    totalW += r.wins;
    totalL += r.losses;
    totalBE += r.be;
  }
  console.log(`  ────────────────────────────`);
  console.log(`  TOTAL: ${totalT}t ${totalW}W/${totalL}L/${totalBE}BE`);
  if (totalT > 0) {
    const wr = totalBE < totalT ? ((totalW / (totalT - totalBE)) * 100).toFixed(1) : '0';
    console.log(`  Win Rate (excl BE): ${wr}%`);
  }
}

// ── Errors ──
if (errors.length > 0) {
  console.log('\n' + '═'.repeat(70));
  console.log(`  ERRORS & CRITICAL EVENTS (${errors.length} total, showing last 20)`);
  console.log('═'.repeat(70));
  for (const e of errors.slice(-20)) {
    console.log(`  ${e}`);
  }
}

// ── Signal conversion rate ──
console.log('\n' + '═'.repeat(70));
console.log('  FILTER FUNNEL');
console.log('═'.repeat(70));
const totalPBChecks = totalSkips + pbSignals.length;
console.log(`  5m bars checked for PB:   ~${totalPBChecks}`);
console.log(`  → Passed all filters:     ${pbSignals.length} (${(pbSignals.length/Math.max(totalPBChecks,1)*100).toFixed(1)}%)`);
console.log(`  → PB Watch started:       ${pbWatchEvents.filter(l => l.includes('waiting for')).length}`);
console.log(`  → Confirmed + fired:      ${tradeEntries.length}`);
console.log(`  → Timeout/invalidated:    ${watchTimeout + watchInvalidated}`);

console.log('\n✅ Analysis complete');
