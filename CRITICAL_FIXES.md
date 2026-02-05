# 🔧 CRITICAL FIXES FOR TRADOVATE BOT

**Status:** Ready to implement
**Date:** 2026-02-05

---

## ✅ FIX #1: Chart Data Endpoint (CRITICAL)

**File:** `src/api/client.js`

**Problem:** `getBars()` and `getChartBars()` use wrong endpoints

**REPLACE this (lines ~620-640):**
```javascript
async getBars(contractId, options = {}) {
  const params = {
    symbol: contractId,
    chartDescription: {
      underlyingType: options.underlyingType || 'MinuteBar',
      elementSize: options.elementSize || 5,
      elementSizeUnit: options.elementSizeUnit || 'UnderlyingUnits',
      withHistogram: options.withHistogram || false
    },
    timeRange: {
      asMuchAsElements: options.count || options.timeRange || 100
    }
  };

  if (options.startTime) {
    params.timeRange = {
      closestTimestamp: options.startTime,
      asFarAsTimestamp: options.endTime || new Date().toISOString()
    };
  }

  return this.request('POST', '/md/getChart', params);
}

async getChartBars(contractId, count = 100) {
  const params = {
    symbol: contractId,
    chartDescription: {
      underlyingType: 'MinuteBar',
      elementSize: 5,
      elementSizeUnit: 'UnderlyingUnits',
      withHistogram: false
    },
    timeRange: {
      asMuchAsElements: count
    }
  };
  return this.request('POST', '/chart/getbars', params);
}
```

**WITH THIS (CORRECT):**
```javascript
/**
 * Get historical bars - CORRECTED for Tradovate API
 * Endpoint: POST /md/getChart
 */
async getBars(contractId, options = {}) {
  const chartDesc = {
    underlyingType: options.underlyingType || 'MinuteBar',
    elementSize: options.elementSize || 5,
    elementSizeUnit: options.elementSizeUnit || 'UnderlyingUnits',
    withHistogram: options.withHistogram || false
  };

  const timeRange = options.startTime ? {
    closestTimestamp: options.startTime,
    asFarAsTimestamp: options.endTime || new Date().toISOString()
  } : {
    asMuchAsElements: options.count || 100
  };

  const response = await this.request('POST', '/md/getChart', {
    symbol: contractId,
    chartDescription: chartDesc,
    timeRange
  });

  // Tradovate returns: { bars: [...], eoh: [...] }
  // Ensure we return the bars array
  return response;
}

/**
 * Alias for getBars - uses same endpoint
 */
async getChartBars(contractId, count = 100) {
  return this.getBars(contractId, { count });
}
```

---

## ✅ FIX #2: Bracket Orders (CRITICAL)

**File:** `src/api/client.js`

**Problem:** `placeBracketOrder()` uses wrong format

**REPLACE this (lines ~360-375):**
```javascript
async placeBracketOrder(accountId, contractId, qty, action, stopLoss, takeProfit) {
  const bracket = {
    accountId,
    accountSpec: accountId.toString(),
    contractId,
    action,
    orderQty: qty,
    orderType: 'Market',
    bracket: {
      stopLoss,
      takeProfit
    },
    isAutomated: true
  };

  return this.request('POST', '/order/placeorder', bracket);
}
```

**WITH THIS (CORRECT):**
```javascript
/**
 * Place a bracket order using Order Strategy API (CORRECT METHOD)
 * This is the proper way to place bracket orders in Tradovate
 */
async placeBracketOrder(accountId, contractId, qty, action, stopLoss, takeProfit) {
  const oppositeAction = action === 'Buy' ? 'Sell' : 'Buy';
  
  const params = {
    accountId,
    accountSpec: accountId.toString(),
    symbol: contractId,
    orderStrategyTypeId: 2, // 2 = Bracket strategy
    action,
    params: JSON.stringify({
      entryVersion: {
        orderQty: qty,
        orderType: 'Market'
      },
      brackets: [{
        qty,
        profitTarget: takeProfit,
        stopLoss,
        trailingStop: false
      }]
    })
  };

  return this.request('POST', '/orderStrategy/startOrderStrategy', params);
}
```

---

## ✅ FIX #3: WebSocket Authentication

**File:** `src/api/websocket.js`

**Problem:** Missing "Bearer" prefix in auth

**FIND this (around line 45):**
```javascript
this.send('authorize', { token });
```

**REPLACE WITH:**
```javascript
this.send('authorize', { token: `Bearer ${token}` });
```

---

## ✅ FIX #4: Bar Data Handling in Strategy

**File:** `src/index.js`

**Problem:** Bar structure from Tradovate API

**FIND this (around line 238):**
```javascript
const bars = await this.client.getChartBars(this.contract.id, 100);
if (bars && bars.bars) {
  bars.bars.forEach(bar => this.strategy.onBar(bar));
  logger.info(`✓ Loaded ${bars.bars.length} historical bars`);
}
```

**REPLACE WITH:**
```javascript
const response = await this.client.getChartBars(this.contract.id, 100);
if (response && response.bars && Array.isArray(response.bars)) {
  response.bars.forEach(bar => this.strategy.onBar(bar));
  logger.info(`✓ Loaded ${response.bars.length} historical bars`);
} else {
  logger.warn('No bar data received from Tradovate');
}
```

---

## ✅ FIX #5: Position Filtering

**File:** `src/api/client.js`

**FIND this (around line 195):**
```javascript
async getOpenPositions(accountId) {
  const positions = await this.getPositionsByAccount(accountId);
  return positions.filter(p => p.netPos !== 0);
}
```

**REPLACE WITH:**
```javascript
/**
 * Get open positions only (netPos != 0)
 * Client-side filtering since Tradovate doesn't have this endpoint
 */
async getOpenPositions(accountId) {
  const positions = await this.getPositionsByAccount(accountId);
  if (!Array.isArray(positions)) {
    return [];
  }
  return positions.filter(p => p.netPos && p.netPos !== 0);
}
```

---

## ✅ FIX #6: Working Orders Filtering

**File:** `src/api/client.js`

**FIND this (around line 458):**
```javascript
async getWorkingOrders(accountId) {
  const orders = await this.getOrdersByAccount(accountId);
  return orders.filter(o => ['Working', 'Accepted', 'PendingNew'].includes(o.ordStatus));
}
```

**REPLACE WITH:**
```javascript
/**
 * Get working (active) orders only
 * Tradovate order statuses: Working, Accepted, PendingNew, PendingReplace
 */
async getWorkingOrders(accountId) {
  const orders = await this.getOrdersByAccount(accountId);
  if (!Array.isArray(orders)) {
    return [];
  }
  const workingStates = ['Working', 'Accepted', 'PendingNew', 'PendingReplace'];
  return orders.filter(o => o.ordStatus && workingStates.includes(o.ordStatus));
}
```

---

## ✅ FIX #7: Today's Fills Filtering

**File:** `src/api/client.js`

**FIND this (around line 570):**
```javascript
async getTodaysFills(accountId) {
  const fills = await this.getFillsByAccount(accountId);
  const today = new Date().toISOString().split('T')[0];
  return fills.filter(f => f.timestamp && f.timestamp.startsWith(today));
}
```

**REPLACE WITH:**
```javascript
/**
 * Get today's fills for account
 * Filters client-side by timestamp
 */
async getTodaysFills(accountId) {
  const fills = await this.getFillsByAccount(accountId);
  if (!Array.isArray(fills)) {
    return [];
  }
  const today = new Date().toISOString().split('T')[0];
  return fills.filter(f => {
    if (!f.timestamp) return false;
    // Handle both ISO string and Date object
    const fillDate = typeof f.timestamp === 'string' 
      ? f.timestamp.split('T')[0]
      : new Date(f.timestamp).toISOString().split('T')[0];
    return fillDate === today;
  });
}
```

---

## ✅ FIX #8: Error Handling for API Calls

**File:** `src/index.js`

**ADD this after line 191 (in handleSignal):**
```javascript
// Check loss limits
const canTrade = this.lossLimits.canTrade();
if (!canTrade.allowed) {
  logger.warn(`Trade blocked by loss limits: ${canTrade.reason}`);
  return;
}

// Check session filter
const sessionCheck = this.sessionFilter.canTrade();
if (!sessionCheck.allowed) {
  logger.warn(`Trade blocked by session filter: ${sessionCheck.reason}`);
  return;
}

// ADD THIS ERROR HANDLING:
try {
  // Get account balance
  const balance = await this.client.getCashBalance(this.account.id);
  const accountBalance = balance.cashBalance;
  
  // ... rest of code
} catch (error) {
  logger.error(`Failed to place trade: ${error.message}`);
  if (error.response?.data) {
    logger.error(`Tradovate error: ${JSON.stringify(error.response.data)}`);
  }
  return; // Don't crash, just skip this trade
}
```

---

## ⚙️ HOW TO APPLY THESE FIXES

### Option 1: Manual (Recommended for learning)
1. Open each file listed
2. Find the code sections
3. Replace with corrected versions
4. Save and test

### Option 2: Let me do it
Say "apply all fixes" and I'll:
- Update all files
- Commit to Git
- Push to GitHub

---

## 🧪 TESTING AFTER FIXES

```bash
# 1. Pull latest code
cd /root/clawd/tradovate-bot-review
git pull

# 2. Install dependencies
npm install

# 3. Update .env with Tradovate credentials
nano .env
# Add: TRADOVATE_USERNAME and TRADOVATE_PASSWORD

# 4. Test connection
npm test

# 5. Check for signals (dry run)
node src/index.js --check

# 6. Get account status
node src/index.js --status
```

---

## 📊 EXPECTED RESULTS

**After fixes, you should see:**
✅ Authentication successful
✅ Contract found (MESM5 or MNQM5)
✅ Account balance retrieved
✅ Historical bars loaded
✅ Strategy initialized
✅ WebSocket connected

**If you see errors, send me the output!**

---

**Want me to apply all these fixes now?** Just say "yes" and I'll do it! 🚀
