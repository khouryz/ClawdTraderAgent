/**
 * analyze_results.js — Phase 5 Context Analysis
 * 
 * Reads JSONL setup files and segments results by:
 * - price_location_vs_prior_value (above_VAH / inside_value / below_VAL)
 * - atr_percentile bucket (low / normal / high)
 * - session_time bucket (early / mid / late)
 * - impulse_range bucket
 * - direction (long / short)
 * 
 * Usage:
 *   node research/analyze_results.js --file research/results/<experiment>_setups.jsonl
 *   node research/analyze_results.js --dir research/results   (analyzes all JSONL files)
 */

const fs = require('fs');
const path = require('path');

function loadSetups(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  return lines.map(l => JSON.parse(l));
}

function segmentStats(setups, label) {
  const filled = setups.filter(s => s.fill_type === 'market' || s.fill_type === 'limit');
  const wins = filled.filter(s => s.realized_R > 0);
  const losses = filled.filter(s => s.realized_R < 0);
  const totalR = filled.reduce((sum, s) => sum + (s.realized_R || 0), 0);
  const grossWin = wins.reduce((s, x) => s + x.realized_R, 0);
  const grossLoss = losses.reduce((s, x) => s + Math.abs(x.realized_R), 0);

  return {
    segment: label,
    setups: setups.length,
    trades: filled.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: filled.length > 0 ? (wins.length / filled.length * 100).toFixed(1) + '%' : 'N/A',
    profit_factor: grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 'Inf' : '0'),
    expectancy_R: filled.length > 0 ? (totalR / filled.length).toFixed(3) : 'N/A',
    exp_per_setup: setups.length > 0 ? (totalR / setups.length).toFixed(3) : 'N/A',
    avg_MAE: filled.length > 0 ? (filled.reduce((s, x) => s + (x.mae || 0), 0) / filled.length).toFixed(3) : 'N/A',
    avg_MFE: filled.length > 0 ? (filled.reduce((s, x) => s + (x.mfe || 0), 0) / filled.length).toFixed(3) : 'N/A',
  };
}

function printSegmentTable(title, segments) {
  console.log(`\n  ${title}`);
  console.log(`  ${'─'.repeat(110)}`);
  console.log(`  ${'Segment'.padEnd(22)} | ${'Sets'.padEnd(5)} | ${'Trds'.padEnd(5)} | ${'WR'.padEnd(7)} | ${'PF'.padEnd(6)} | ${'ExpR'.padEnd(7)} | ${'Exp/Set'.padEnd(7)} | ${'MAE'.padEnd(7)} | ${'MFE'.padEnd(7)}`);
  console.log(`  ${'─'.repeat(110)}`);
  for (const s of segments) {
    console.log(`  ${s.segment.padEnd(22)} | ${String(s.setups).padEnd(5)} | ${String(s.trades).padEnd(5)} | ${String(s.win_rate).padEnd(7)} | ${String(s.profit_factor).padEnd(6)} | ${String(s.expectancy_R).padEnd(7)} | ${String(s.exp_per_setup).padEnd(7)} | ${String(s.avg_MAE).padEnd(7)} | ${String(s.avg_MFE).padEnd(7)}`);
  }
  console.log(`  ${'─'.repeat(110)}`);
}

function analyzeFile(filePath) {
  const setups = loadSetups(filePath);
  const fileName = path.basename(filePath, '.jsonl').replace('_setups', '');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  CONTEXT ANALYSIS: ${fileName}`);
  console.log(`  ${setups.length} total setups`);
  console.log(`${'='.repeat(60)}`);

  // Only analyze filled trades for most segments
  const filled = setups.filter(s => s.fill_type === 'market' || s.fill_type === 'limit');

  // 1. Price location vs prior day value area
  const pdLocations = {};
  for (const s of setups) {
    const loc = s.price_location_vs_prior_value || 'no_data';
    if (!pdLocations[loc]) pdLocations[loc] = [];
    pdLocations[loc].push(s);
  }
  printSegmentTable('PRICE LOCATION vs PRIOR DAY VALUE',
    Object.entries(pdLocations).map(([k, v]) => segmentStats(v, k))
  );

  // 2. Volatility regime
  const volRegimes = {};
  for (const s of setups) {
    const regime = s.volatility_regime_label || 'unknown';
    if (!volRegimes[regime]) volRegimes[regime] = [];
    volRegimes[regime].push(s);
  }
  printSegmentTable('VOLATILITY REGIME',
    Object.entries(volRegimes).map(([k, v]) => segmentStats(v, k))
  );

  // 3. Session time buckets
  const timeBuckets = { 'early_630_730': [], 'mid_730_830': [], 'late_830_930': [], 'after_930': [] };
  for (const s of setups) {
    const time = s.session_time || '';
    const parts = time.split(':');
    const hour = parseInt(parts[0]) || 0;
    const min = parseInt(parts[1]) || 0;
    const totalMin = hour * 60 + min;
    if (totalMin < 450) timeBuckets['early_630_730'].push(s);      // 6:30-7:30
    else if (totalMin < 510) timeBuckets['mid_730_830'].push(s);   // 7:30-8:30
    else if (totalMin < 570) timeBuckets['late_830_930'].push(s);  // 8:30-9:30
    else timeBuckets['after_930'].push(s);                          // 9:30+
  }
  printSegmentTable('SESSION TIME BUCKET',
    Object.entries(timeBuckets).map(([k, v]) => segmentStats(v, k))
  );

  // 4. Impulse range buckets (PB only)
  const pbSetups = setups.filter(s => s.sub_strategy === 'PB');
  if (pbSetups.length > 0) {
    const impBuckets = { '15-20': [], '20-30': [], '30-50': [], '50+': [] };
    for (const s of pbSetups) {
      const r = s.impulse_range || 0;
      if (r < 20) impBuckets['15-20'].push(s);
      else if (r < 30) impBuckets['20-30'].push(s);
      else if (r < 50) impBuckets['30-50'].push(s);
      else impBuckets['50+'].push(s);
    }
    printSegmentTable('IMPULSE RANGE (PB only)',
      Object.entries(impBuckets).map(([k, v]) => segmentStats(v, k))
    );
  }

  // 5. Direction
  const directions = {};
  for (const s of setups) {
    const dir = s.direction || 'unknown';
    if (!directions[dir]) directions[dir] = [];
    directions[dir].push(s);
  }
  printSegmentTable('DIRECTION',
    Object.entries(directions).map(([k, v]) => segmentStats(v, k))
  );

  // 6. Sub-strategy
  const subStrategies = {};
  for (const s of setups) {
    const ss = s.sub_strategy || 'unknown';
    if (!subStrategies[ss]) subStrategies[ss] = [];
    subStrategies[ss].push(s);
  }
  if (Object.keys(subStrategies).length > 1) {
    printSegmentTable('SUB-STRATEGY',
      Object.entries(subStrategies).map(([k, v]) => segmentStats(v, k))
    );
  }

  // 7. Fill type distribution
  const fillTypes = {};
  for (const s of setups) {
    const ft = s.fill_type || 'unknown';
    fillTypes[ft] = (fillTypes[ft] || 0) + 1;
  }
  console.log(`\n  FILL TYPE DISTRIBUTION`);
  console.log(`  ${'─'.repeat(40)}`);
  for (const [type, count] of Object.entries(fillTypes)) {
    console.log(`  ${type.padEnd(15)} : ${count} (${(count / setups.length * 100).toFixed(1)}%)`);
  }

  // 8. Exit reason distribution (filled trades only)
  const exitReasons = {};
  for (const s of filled) {
    const er = s.exit_reason || 'unknown';
    exitReasons[er] = (exitReasons[er] || 0) + 1;
  }
  console.log(`\n  EXIT REASON DISTRIBUTION (filled trades)`);
  console.log(`  ${'─'.repeat(40)}`);
  for (const [reason, count] of Object.entries(exitReasons)) {
    console.log(`  ${reason.padEnd(15)} : ${count} (${(count / filled.length * 100).toFixed(1)}%)`);
  }

  // Write CSV summary
  const csvPath = filePath.replace('_setups.jsonl', '_context_analysis.csv');
  const allSegments = [];

  // Collect all segment results
  for (const [k, v] of Object.entries(pdLocations)) allSegments.push({ category: 'pd_location', ...segmentStats(v, k) });
  for (const [k, v] of Object.entries(volRegimes)) allSegments.push({ category: 'vol_regime', ...segmentStats(v, k) });
  for (const [k, v] of Object.entries(timeBuckets)) allSegments.push({ category: 'time_bucket', ...segmentStats(v, k) });
  for (const [k, v] of Object.entries(directions)) allSegments.push({ category: 'direction', ...segmentStats(v, k) });

  const csvHeader = 'category,segment,setups,trades,wins,losses,win_rate,profit_factor,expectancy_R,exp_per_setup,avg_MAE,avg_MFE';
  const csvRows = allSegments.map(s =>
    `${s.category},${s.segment},${s.setups},${s.trades},${s.wins},${s.losses},${s.win_rate},${s.profit_factor},${s.expectancy_R},${s.exp_per_setup},${s.avg_MAE},${s.avg_MFE}`
  );
  fs.writeFileSync(csvPath, csvHeader + '\n' + csvRows.join('\n') + '\n');
  console.log(`\n  [CSV] Context analysis written to ${csvPath}`);
}

// CLI
const args = process.argv.slice(2);
const fileIdx = args.indexOf('--file');
const dirIdx = args.indexOf('--dir');

if (fileIdx !== -1 && args[fileIdx + 1]) {
  analyzeFile(args[fileIdx + 1]);
} else if (dirIdx !== -1 && args[dirIdx + 1]) {
  const dir = args[dirIdx + 1];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('_setups.jsonl'));
  if (files.length === 0) {
    console.log('No *_setups.jsonl files found in', dir);
    process.exit(1);
  }
  for (const f of files) {
    analyzeFile(path.join(dir, f));
  }
} else {
  console.log('Usage:');
  console.log('  node research/analyze_results.js --file research/results/<experiment>_setups.jsonl');
  console.log('  node research/analyze_results.js --dir research/results');
  process.exit(1);
}
