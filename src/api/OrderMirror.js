/**
 * OrderMirror - Mirror-trading fanout at the order layer.
 *
 * One Tradovate login can hold several sub-accounts (e.g. TRADOVATE_ACCOUNT_NAME=
 * "1699181,1699182"). The PRIMARY sub-account runs the full, unchanged execution
 * stack (InstrumentRunner + SignalHandler + PositionHandler + trailing/profit
 * managers). This wrapper sits in front of the shared TradovateClient and
 * REPLICATES every order-mutating call the primary makes onto each SECONDARY
 * sub-account, with identical parameters — only accountId/accountSpec swapped.
 *
 * Design guarantees:
 *   • N == 1 (no secondaries): the factory returns the REAL client untouched, so
 *     single-sub-account behavior is byte-for-byte identical to before this file
 *     existed. The OrderMirror class is never even instantiated.
 *   • "Same exact orders": secondaries receive the same action / symbol / qty /
 *     prices / orderType as the primary. The only differences are the account
 *     binding (accountId, accountSpec) — which is what mirror trading means.
 *   • Primary latency unchanged: the primary call is awaited and returned to the
 *     caller immediately; secondary placements fire in the BACKGROUND. The
 *     primary never blocks on, and never fails because of, a secondary.
 *   • Never over-place: secondaries are fired only AFTER the primary call
 *     resolves successfully. If the primary order is rejected/throws, the
 *     exception propagates before any secondary is touched.
 *
 * Order-id correspondence:
 *   Tradovate's modify/cancel are keyed by orderId, and each account has its OWN
 *   orderId for "the same" logical order. We therefore keep a map from each
 *   primary orderId -> the matching secondary orderId(s). Because modifyOrder
 *   modifies in place (the orderId is stable across BE/trailing modifies), a map
 *   built once at placement time stays valid for the life of the order.
 *
 * Fill routing:
 *   The order WebSocket is synced to ALL sub-accounts, so fills for SECONDARY
 *   orders arrive on the same stream. Fills carry orderId + contractId but NO
 *   accountId (verified against Tradovate's OpenAPI spec), so the primary runner
 *   must NOT process secondary fills. ownerOfOrder() lets AccountInstance route a
 *   fill to the primary runner only when its orderId is the primary's (or unknown
 *   — preserving today's "all fills go to the runner" default for manual orders).
 *
 * Protection policy (each sub-account is independently protected; NO halt):
 *   Every sub-account is treated like the primary — it gets the same entry, the
 *   same OCO bracket, and the same BE/stop modifies, and it is protected by its
 *   OWN bracket. We do NOT halt the others when one drifts, because each open
 *   position is already protected by its own stop/target. Instead we SELF-HEAL
 *   per account:
 *     • placeOCO brackets only a secondary that actually ENTERED (holds a
 *       position) — never places opening orders on a flat account.
 *     • reconcileSecondaries() (run after every OCO, on the 60s heartbeat, after
 *       WS reconnect, and at EOD) reads exchange truth per secondary and: cancels
 *       stray orders on a flat account, re-places a missing bracket at the
 *       primary's current stop/target, flattens a position it cannot protect or
 *       that the primary already exited, and re-syncs a lagging BE stop.
 *   setDivergenceHandler() is an ALERT sink only (Telegram notify; no halt).
 */

const logger = require('../utils/logger');

class OrderMirror {
  /**
   * @param {Object} realClient - The underlying TradovateClient (one auth token,
   *   already authorized for every sub-account under this login).
   * @param {Array<{id:number,name:string}>} subAccounts - Resolved sub-accounts,
   *   PRIMARY first. Must contain at least 2 entries (else use the real client).
   */
  constructor(realClient, subAccounts) {
    if (!Array.isArray(subAccounts) || subAccounts.length < 2) {
      throw new Error('OrderMirror requires >= 2 sub-accounts; use the real client for single-account configs');
    }
    this._real = realClient;
    this._primary = subAccounts[0];
    this._secondaries = subAccounts.slice(1).map(a => ({ id: a.id, name: a.name }));
    this._tag = `[mirror:${this._primary.name}]`;

    // primary orderId (string) -> [{ accountId, accountSpec, orderId }]
    this._orderMap = new Map();
    // every primary orderId we've placed (string set) — for fill classification
    this._primaryOrderIds = new Set();
    // every secondary orderId we've placed (string) -> { accountId, accountSpec }
    this._secondaryOrderIds = new Map();
    // primary orderId (string) -> Promise that resolves once the BACKGROUND
    // secondary placement for that order has finished recording its mapping.
    // Lets modifyOrder/cancelOrder wait for an in-flight placement so they never
    // read an empty map in the (narrow) race where a modify/cancel is issued
    // before the secondary's place* HTTP ack lands. Self-clears on settle.
    this._pendingFanout = new Map();

    this._divergenceHandler = null;
  }

  /** Register a callback invoked (once per failure) when a sub-account diverges. */
  setDivergenceHandler(fn) {
    this._divergenceHandler = typeof fn === 'function' ? fn : null;
  }

  _reportDivergence(info) {
    logger.error(`${this._tag} 🚨 DIVERGENCE ${info.method} acct=${info.accountId} (${info.accountSpec}): ${info.error}${info.naked ? ' [NAKED POSITION FLATTENED]' : ''}`);
    if (this._divergenceHandler) {
      try { this._divergenceHandler(info); } catch (e) { logger.error(`${this._tag} divergence handler threw: ${e.message}`); }
    }
  }

  /**
   * Classify an orderId seen on the WebSocket fill stream.
   * @returns {{kind:'primary'}|{kind:'secondary',accountId:number,accountSpec:string}|null}
   *   null === unknown (not placed through this mirror; caller should default to
   *   the primary runner, matching pre-mirror behavior).
   */
  ownerOfOrder(orderId) {
    if (orderId == null) return null;
    const key = String(orderId);
    const sec = this._secondaryOrderIds.get(key);
    if (sec) return { kind: 'secondary', accountId: sec.accountId, accountSpec: sec.accountSpec };
    if (this._primaryOrderIds.has(key)) return { kind: 'primary' };
    return null;
  }

  // ── internal bookkeeping ────────────────────────────────────────────────
  _recordPrimaryId(orderId) {
    if (orderId != null) {
      this._primaryOrderIds.add(String(orderId));
      this._pruneIfNeeded();
    }
  }

  _recordSecondaryId(orderId, sec) {
    if (orderId != null) this._secondaryOrderIds.set(String(orderId), { accountId: sec.id, accountSpec: sec.name });
  }

  /**
   * Register the background secondary-placement promise for a primary orderId so
   * a later modify/cancel of that order can await the mapping. Self-clears when
   * the placement settles (identity-checked so a re-used id isn't clobbered).
   */
  _trackPending(orderId, promise) {
    if (orderId == null || !promise) return;
    const key = String(orderId);
    this._pendingFanout.set(key, promise);
    promise.finally(() => {
      if (this._pendingFanout.get(key) === promise) this._pendingFanout.delete(key);
    }).catch(() => {});
  }

  /** Await any in-flight secondary placement for this order (no-op if none). */
  async _awaitPendingFanout(orderId) {
    if (orderId == null) return;
    const p = this._pendingFanout.get(String(orderId));
    if (p) { try { await p; } catch (_) { /* placement reported its own divergence */ } }
  }

  // Memory is tiny (a handful of orders per trade, reset daily on restart), but
  // bound it defensively so a long-running process can't grow unboundedly.
  _pruneIfNeeded() {
    const CAP = 2000;
    if (this._primaryOrderIds.size > CAP) {
      const drop = this._primaryOrderIds.size - CAP;
      let i = 0;
      for (const k of this._primaryOrderIds) { if (i++ >= drop) break; this._primaryOrderIds.delete(k); }
    }
    if (this._secondaryOrderIds.size > CAP) {
      const drop = this._secondaryOrderIds.size - CAP;
      let i = 0;
      for (const k of this._secondaryOrderIds.keys()) { if (i++ >= drop) break; this._secondaryOrderIds.delete(k); }
    }
    if (this._orderMap.size > CAP) {
      const drop = this._orderMap.size - CAP;
      let i = 0;
      for (const k of this._orderMap.keys()) { if (i++ >= drop) break; this._orderMap.delete(k); }
    }
    // _pendingFanout self-clears on settle, but bound it defensively too.
    if (this._pendingFanout.size > CAP) {
      const drop = this._pendingFanout.size - CAP;
      let i = 0;
      for (const k of this._pendingFanout.keys()) { if (i++ >= drop) break; this._pendingFanout.delete(k); }
    }
  }

  /**
   * Run `task(sec)` for every secondary in parallel; never throws. Returns
   * [{ sec, value, error }]. Used so one secondary's failure can't block another.
   */
  async _fanout(task) {
    const settled = await Promise.allSettled(this._secondaries.map(sec => task(sec)));
    return settled.map((r, i) => ({
      sec: this._secondaries[i],
      value: r.status === 'fulfilled' ? r.value : null,
      error: r.status === 'rejected' ? (r.reason && r.reason.message ? r.reason.message : String(r.reason)) : null,
    }));
  }

  // ════════════════════════════════════════════════════════════════════════
  //  Order-mutating methods (mirrored). Each: await primary -> return to caller
  //  immediately, fire secondaries in the BACKGROUND.
  // ════════════════════════════════════════════════════════════════════════

  async placeMarketOrder(accountId, contractId, qty, action) {
    const primary = await this._real.placeMarketOrder(accountId, contractId, qty, action);
    this._recordPrimaryId(primary && primary.orderId);
    this._fireEntry('placeMarketOrder',
      (sec) => this._real.placeMarketOrder(sec.id, contractId, qty, action),
      primary);
    return primary;
  }

  async placeLimitOrder(accountId, contractId, qty, action, price) {
    const primary = await this._real.placeLimitOrder(accountId, contractId, qty, action, price);
    this._recordPrimaryId(primary && primary.orderId);
    this._fireEntry('placeLimitOrder',
      (sec) => this._real.placeLimitOrder(sec.id, contractId, qty, action, price),
      primary);
    return primary;
  }

  /** Shared background fanout for single-order entries (market/limit). */
  _fireEntry(method, task, primary) {
    const done = this._fanout(task).then((results) => {
      for (const { sec, value, error } of results) {
        if (error || !value || value.orderId == null) {
          // Secondary missed the entry. Primary is in a trade, secondary is not —
          // accounts diverged. No naked position (the entry simply didn't happen),
          // so just halt-all + alert; do not touch the primary.
          this._reportDivergence({ method, accountId: sec.id, accountSpec: sec.name, error: error || 'no orderId returned' });
          continue;
        }
        this._recordSecondaryId(value.orderId, sec);
        if (primary && primary.orderId != null) this._mapAppend(primary.orderId, sec, value.orderId);
        logger.info(`${this._tag} ✓ ${method} mirrored to ${sec.name} (orderId=${value.orderId})`);
      }
    });
    // Let a cancel of this (still-placing) entry wait for the mapping to land.
    this._trackPending(primary && primary.orderId, done);
    done.catch(() => {});
  }

  async placeOCO(accountSpec, accountId, symbol, qty, exitAction, stopPrice, targetPrice) {
    const primary = await this._real.placeOCO(accountSpec, accountId, symbol, qty, exitAction, stopPrice, targetPrice);
    // primary.orderId === stop leg, primary.ocoId === target leg
    this._recordPrimaryId(primary && primary.orderId);
    this._recordPrimaryId(primary && primary.ocoId);

    const done = (async () => {
      const contractId = await this._resolveContractId(symbol);
      await this._fanout(async (sec) => {
        // ── H2 GATE: only bracket a secondary that ACTUALLY ENTERED ──
        // Mirror-replicated entries are market orders placed within ms of the
        // primary's, so by the time the primary fills (which triggers this OCO)
        // the secondary has normally filled too. But if a secondary's entry was
        // rejected/missed it is FLAT — and a Stop+Limit on a flat account are
        // OPENING orders (an unintended stop-entry + limit-entry). So confirm the
        // secondary holds a position first; if not, skip the bracket entirely.
        // Size the bracket to the secondary's OWN net (robust to partial fills).
        const net = await this._confirmSecondaryEntered(sec.id, contractId);
        if (net === 0) {
          this._reportDivergence({
            method: 'placeOCO(skipped)', accountId: sec.id, accountSpec: sec.name,
            error: 'secondary holds no position (entry missed/rejected) — bracket skipped; no naked orders created',
          });
          return;
        }
        try {
          const value = await this._real.placeOCO(sec.name || String(sec.id), sec.id, symbol, Math.abs(net), exitAction, stopPrice, targetPrice);
          if (value && value.orderId != null) {
            this._recordSecondaryId(value.orderId, sec);
            if (primary && primary.orderId != null) this._mapAppend(primary.orderId, sec, value.orderId);
          }
          if (value && value.ocoId != null) {
            this._recordSecondaryId(value.ocoId, sec);
            if (primary && primary.ocoId != null) this._mapAppend(primary.ocoId, sec, value.ocoId);
          }
          logger.info(`${this._tag} ✓ placeOCO mirrored to ${sec.name} (stop=${value && value.orderId}, target=${value && value.ocoId})`);
        } catch (e) {
          // Entered but its protective bracket failed → NAKED. Flatten it to
          // protect capital (no halt — the other accounts are independently safe).
          await this._flattenSecondary(sec, symbol);
          this._reportDivergence({ method: 'placeOCO', accountId: sec.id, accountSpec: sec.name, error: e && e.message ? e.message : String(e), naked: true });
        }
      });
    })();
    // A BE-stop modify or an exit cancel keys off the primary's stop (orderId) or
    // target (ocoId). Register the same fanout under BOTH so either can wait for
    // the secondary mapping to land before reading it.
    this._trackPending(primary && primary.orderId, done);
    this._trackPending(primary && primary.ocoId, done);
    done.catch(() => {});

    // Backstop: a few seconds after placement, reconcile every secondary against
    // exchange truth (re-bracket / flatten / cancel-stray / BE-sync as needed).
    this._scheduleReconcile(symbol);

    return primary;
  }

  async modifyOrder(orderId, changes) {
    // Await the primary modify exactly as before (callers verify the result).
    const primary = await this._real.modifyOrder(orderId, changes);
    // Only mirror once the primary modify succeeded — if the primary order is
    // dead/rejected the await above throws and we never reach here, so we never
    // raise a false-positive divergence on a stale order.
    // If the secondary placement for this order is still in flight, wait for it
    // so we don't read an empty map and silently skip the secondary modify.
    await this._awaitPendingFanout(orderId);
    const mapped = this._orderMap.get(String(orderId)) || [];
    if (mapped.length) {
      Promise.allSettled(mapped.map(m => this._real.modifyOrder(m.orderId, changes))).then((settled) => {
        settled.forEach((r, i) => {
          if (r.status === 'rejected') {
            const m = mapped[i];
            // Secondary stop did NOT move — it still has a (now mis-leveled) bracket,
            // so it isn't naked, but the accounts have drifted. Halt-all + alert.
            this._reportDivergence({ method: 'modifyOrder', accountId: m.accountId, accountSpec: m.accountSpec, error: r.reason && r.reason.message ? r.reason.message : String(r.reason) });
          } else {
            logger.info(`${this._tag} ✓ modifyOrder mirrored to ${mapped[i].accountSpec} (orderId=${mapped[i].orderId})`);
          }
        });
      }).catch(() => {});
    }
    return primary;
  }

  async cancelOrder(orderId) {
    const primary = await this._real.cancelOrder(orderId);
    // Wait for an in-flight secondary placement so a fast cancel still reaches it.
    await this._awaitPendingFanout(orderId);
    const key = String(orderId);
    const mapped = this._orderMap.get(key) || [];
    if (mapped.length) {
      Promise.allSettled(mapped.map(m => this._real.cancelOrder(m.orderId))).then((settled) => {
        settled.forEach((r, i) => {
          if (r.status === 'rejected') {
            const m = mapped[i];
            this._reportDivergence({ method: 'cancelOrder', accountId: m.accountId, accountSpec: m.accountSpec, error: r.reason && r.reason.message ? r.reason.message : String(r.reason) });
          }
        });
      }).catch(() => {});
    }
    this._orderMap.delete(key);
    return primary;
  }

  async liquidatePosition(accountId, contractId, netPos) {
    const primary = await this._real.liquidatePosition(accountId, contractId, netPos);
    // Flatten each secondary's OWN actual net position for this contract (robust
    // against any divergence in fill qty between accounts).
    this._secondaries.forEach((sec) => {
      this._flattenSecondary(sec, contractId).catch(() => {});
    });
    return primary;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  _mapAppend(primaryOrderId, sec, secOrderId) {
    const key = String(primaryOrderId);
    const arr = this._orderMap.get(key) || [];
    arr.push({ accountId: sec.id, accountSpec: sec.name, orderId: secOrderId });
    this._orderMap.set(key, arr);
  }

  /**
   * Read a secondary account's live position for the given contract and flatten
   * it. `contractRef` may be a numeric contractId (liquidate path) OR a contract
   * NAME/symbol (naked-OCO path) — resolved to a numeric id so the match is
   * reliable exactly when it matters (a naked secondary).
   */
  async _flattenSecondary(sec, contractRef) {
    try {
      const contractId = await this._resolveContractId(contractRef);
      const positions = await this._real.getOpenPositions(sec.id);
      const p = Array.isArray(positions) && contractId != null
        ? positions.find(x => Number(x.contractId) === Number(contractId))
        : null;
      if (p && p.netPos) {
        await this._real.liquidatePosition(sec.id, p.contractId, p.netPos);
        logger.warn(`${this._tag} flattened secondary ${sec.name} (netPos=${p.netPos}, contractId=${p.contractId})`);
      }
    } catch (e) {
      this._reportDivergence({ method: 'liquidatePosition', accountId: sec.id, accountSpec: sec.name, error: e.message });
    }
  }

  /** Resolve a numeric contractId from either a numeric id or a contract name. */
  async _resolveContractId(contractRef) {
    if (contractRef == null) return null;
    if (typeof contractRef === 'number') return contractRef;
    const asNum = Number(contractRef);
    if (Number.isFinite(asNum) && String(asNum) === String(contractRef)) return asNum; // numeric string
    // It's a symbol name (e.g. "MNQH6") — resolve via the API.
    try {
      const contract = await this._real.findContract(contractRef);
      return contract && contract.id != null ? contract.id : null;
    } catch (_) {
      return null;
    }
  }

  // ── per-secondary protection / reconciliation ─────────────────────────────

  /** Read a sub-account's signed net position for a contract (0 if flat/none). */
  async _netPos(accountId, contractId) {
    try {
      const positions = await this._real.getOpenPositions(accountId);
      const p = (Array.isArray(positions) && contractId != null)
        ? positions.find(x => Number(x.contractId) === Number(contractId)) : null;
      return p && p.netPos ? Number(p.netPos) : 0;
    } catch (_) { return 0; }
  }

  /**
   * Poll a secondary's net for this contract a few times (covers the brief race
   * where the OCO fires the instant the primary fills but the secondary's own
   * entry fill ack hasn't posted yet). Returns the signed net, or 0 if it never
   * shows a position (entry missed/rejected).
   */
  async _confirmSecondaryEntered(accountId, contractId, attempts = 3, delayMs = 150) {
    for (let i = 0; i < attempts; i++) {
      const net = await this._netPos(accountId, contractId);
      if (net !== 0) return net;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
    }
    return 0;
  }

  /**
   * Read an account's working exit legs for a contract and assess bracket HEALTH.
   *
   * Tradovate's /order/list returns the SPARSE Order entity — it carries id,
   * accountId, action, ordStatus and `ocoId`, but NOT orderType/stopPrice/price
   * (those live on the OrderVersion; confirmed against the live API). So we CANNOT
   * reliably classify "stop vs target" from a working-orders read alone, and a
   * healthy 2-leg OCO bracket can read back with stop=null,target=null.
   *
   * We therefore compute a PRICE-FREE "protected" signal from leg COUNT + ocoId
   * pairing, and ALSO expose the classified stop/target WHEN the rich fields happen
   * to be present (e.g. tests, or a future API that returns them) so the caller can
   * still re-bracket at exact levels / BE-sync opportunistically.
   *
   * @returns {{orders:Array, count:number, ocoPairedCount:number, stop:Object|null,
   *            target:Object|null, protected:boolean}}
   */
  async _getBracketHealth(accountId, contractId) {
    let orders = [];
    try { orders = await this._real.getWorkingOrders(accountId); } catch (_) { orders = []; }
    const mine = (Array.isArray(orders) ? orders : []).filter(o => Number(o.contractId) === Number(contractId));

    // Rich classification (only succeeds when the price/type fields are present).
    const isStop = (o) => o.ordType === 'Stop' || o.ordType === 'StopLimit' || o.orderType === 'Stop' || o.orderType === 'StopLimit' || o.stopPrice != null;
    const isLimit = (o) => (o.ordType === 'Limit' || o.orderType === 'Limit') || (o.price != null && o.stopPrice == null);
    const stop = mine.find(isStop) || null;
    const target = mine.find(o => isLimit(o) && !isStop(o)) || null;

    // Price-free protection signal: legs that reference ANOTHER of our working legs
    // via ocoId form a confirmed OCO bracket. A full bracket = 2 such paired legs.
    const ids = new Set(mine.map(o => String(o.id)));
    const ocoPairedCount = mine.filter(o => o.ocoId != null && ids.has(String(o.ocoId))).length;
    const hasOcoField = mine.some(o => o.ocoId != null);

    // "protected" if EITHER a classified stop AND target exist (rich), OR there are
    // >= 2 ocoId-paired legs (sparse live reality), OR — defensively, only when the
    // entity exposes no ocoId field at all — there are simply >= 2 working legs.
    const isProtected = !!(stop && target)
      || ocoPairedCount >= 2
      || (!hasOcoField && mine.length >= 2);

    return { orders: mine, count: mine.length, ocoPairedCount, stop, target, protected: isProtected };
  }

  /** Flatten a secondary's signed net for a contract (market). */
  async _flattenNet(sec, contractId, net) {
    try {
      await this._real.liquidatePosition(sec.id, contractId, net);
      logger.warn(`${this._tag} reconcile flattened ${sec.name} (netPos=${net}, contractId=${contractId})`);
    } catch (e) {
      this._reportDivergence({ method: 'liquidatePosition', accountId: sec.id, accountSpec: sec.name, error: e.message });
    }
  }

  /** Schedule a one-shot reconcile sweep (post-OCO backstop). */
  _scheduleReconcile(symbol, delayMs = 6000) {
    (async () => {
      const cid = await this._resolveContractId(symbol);
      if (cid == null) return;
      setTimeout(() => { this.reconcileSecondaries(cid, symbol).catch(() => {}); }, delayMs);
    })().catch(() => {});
  }

  /**
   * Reconcile every secondary against exchange truth so each is protected exactly
   * like the primary. Stateless (reads live positions + working orders), so it is
   * safe to call repeatedly and survives process restarts. Per secondary:
   *   • flat with stray resting legs        → cancel them (would be naked opening orders)
   *   • holding while primary is flat        → cancel legs + flatten (primary already exited)
   *   • holding but NOT fully bracketed      → re-place OCO at primary's levels IF the
   *                                            prices are readable, ELSE flatten-to-protect
   *   • holding & protected & stop lagging   → re-sync stop ONLY if prices readable
   * Never halts; alerts only on corrective action.
   *
   * SPARSE-FIELD SAFETY: Tradovate's live /order/list returns no orderType/stopPrice/
   * price, so "protected" is judged PRICE-FREE via leg count + ocoId pairing (see
   * _getBracketHealth). That is the difference that makes this run correctly DURING a
   * live trade — the previous price-based gate always saw null prices and bailed,
   * making reconcile a no-op while any position was open. The re-bracket / BE-sync
   * steps still fire opportunistically when prices ARE readable (rich data / tests);
   * otherwise a genuinely under-protected secondary is flattened to protect capital
   * and BE moves are left to the proven live modifyOrder fanout.
   *
   * @param {number} contractId
   * @param {string} [contractName] - symbol name, needed only to re-place a bracket
   */
  async reconcileSecondaries(contractId, contractName = null) {
    if (!this._secondaries.length) return;
    const cid = Number(contractId);
    if (!Number.isFinite(cid)) return;

    let primaryNet = 0, pb = null, pStop = null, pTarget = null, pStopId = null, pTargetId = null, exitAction = null;
    try {
      primaryNet = await this._netPos(this._primary.id, cid);
      pb = await this._getBracketHealth(this._primary.id, cid);
      if (pb.stop) { pStopId = pb.stop.id; pStop = pb.stop.stopPrice != null ? Number(pb.stop.stopPrice) : (pb.stop.price != null ? Number(pb.stop.price) : null); exitAction = pb.stop.action || exitAction; }
      if (pb.target) { pTargetId = pb.target.id; pTarget = pb.target.price != null ? Number(pb.target.price) : null; exitAction = exitAction || pb.target.action; }
      if (!exitAction && primaryNet !== 0) exitAction = primaryNet > 0 ? 'Sell' : 'Buy';
    } catch (e) {
      logger.error(`${this._tag} reconcile: failed reading primary state: ${e.message}`);
      return;
    }

    // If the primary holds a position but isn't fully bracketed yet, it is mid-entry
    // — its own watchdog handles it; don't act on secondaries this pass (avoids
    // racing the normal OCO placement). Judged PRICE-FREE (count/ocoId), so this no
    // longer false-bails on every in-trade sweep the way the old price gate did.
    if (primaryNet !== 0 && !pb.protected) return;

    for (const sec of this._secondaries) {
      try {
        const secNet = await this._netPos(sec.id, cid);
        const sb = await this._getBracketHealth(sec.id, cid);

        // (1) secondary FLAT → cancel any stray resting legs (naked opening orders)
        if (secNet === 0) {
          if (sb.orders.length) {
            for (const o of sb.orders) { try { await this._real.cancelOrder(o.id); } catch (_) {} }
            this._reportDivergence({ method: 'reconcile', accountId: sec.id, accountSpec: sec.name, error: `flat account had ${sb.orders.length} stray order(s) — cancelled` });
          }
          continue;
        }

        // (2) secondary HOLDS a position but the primary is FLAT → primary already
        //     exited; cancel legs + flatten the secondary to match.
        if (primaryNet === 0) {
          for (const o of sb.orders) { try { await this._real.cancelOrder(o.id); } catch (_) {} }
          await this._flattenNet(sec, cid, secNet);
          this._reportDivergence({ method: 'reconcile', accountId: sec.id, accountSpec: sec.name, error: `held ${secNet} while primary flat — flattened to match`, naked: true });
          continue;
        }

        // (3) secondary holds but is NOT fully bracketed (price-free count/ocoId test).
        //     Prefer re-bracketing at the primary's exact levels WHEN the prices are
        //     readable; otherwise (sparse live data) flatten to protect capital.
        if (!sb.protected) {
          if (pStop != null && pTarget != null && exitAction) {
            for (const o of sb.orders) { try { await this._real.cancelOrder(o.id); } catch (_) {} }
            try {
              const oco = await this._real.placeOCO(sec.name || String(sec.id), sec.id, contractName || cid, Math.abs(secNet), exitAction, pStop, pTarget);
              if (oco && oco.orderId != null) { this._recordSecondaryId(oco.orderId, sec); if (pStopId != null) this._mapAppend(pStopId, sec, oco.orderId); }
              if (oco && oco.ocoId != null) { this._recordSecondaryId(oco.ocoId, sec); if (pTargetId != null) this._mapAppend(pTargetId, sec, oco.ocoId); }
              this._reportDivergence({ method: 'reconcile', accountId: sec.id, accountSpec: sec.name, error: `unprotected position re-bracketed (stop ${pStop}, target ${pTarget})` });
            } catch (e) {
              await this._flattenNet(sec, cid, secNet);
              this._reportDivergence({ method: 'reconcile', accountId: sec.id, accountSpec: sec.name, error: `could not bracket (${e.message}) — flattened to protect capital`, naked: true });
            }
          } else {
            for (const o of sb.orders) { try { await this._real.cancelOrder(o.id); } catch (_) {} }
            await this._flattenNet(sec, cid, secNet);
            this._reportDivergence({ method: 'reconcile', accountId: sec.id, accountSpec: sec.name, error: `held ${secNet} but not fully bracketed (${sb.count} working leg(s); primary prices unreadable) — flattened to protect`, naked: true });
          }
          continue;
        }

        // (4) protected → keep the stop in lockstep with the primary, but ONLY when we
        //     can actually read both prices (rich data). On sparse live data we skip:
        //     BE/stop moves propagate through the live modifyOrder fanout instead.
        if (pStop != null && sb.stop) {
          const sStop = sb.stop.stopPrice != null ? Number(sb.stop.stopPrice) : (sb.stop.price != null ? Number(sb.stop.price) : null);
          if (sStop != null && Math.abs(sStop - pStop) > 0.24) {
            try {
              await this._real.modifyOrder(sb.stop.id, { orderType: 'Stop', stopPrice: pStop, orderQty: Math.abs(secNet) });
              logger.info(`${this._tag} reconcile: synced ${sec.name} stop ${sStop} → ${pStop} (BE catch-up)`);
            } catch (_) { /* still protected at the old level; try again next sweep */ }
          }
        }
      } catch (eSec) {
        logger.error(`${this._tag} reconcile error on ${sec.name}: ${eSec.message}`);
      }
    }
  }

  /**
   * Build a drop-in client: a Proxy that exposes this mirror's wrapped trading
   * methods and forwards everything else (reads, auth, helpers) to the real
   * client. Pass the result anywhere a TradovateClient is expected.
   */
  asClient() {
    const target = this;
    const real = this._real;
    return new Proxy(target, {
      get(t, prop) {
        if (prop in t) {
          const v = t[prop];
          return typeof v === 'function' ? v.bind(t) : v;
        }
        const rv = real[prop];
        return typeof rv === 'function' ? rv.bind(real) : rv;
      },
      set(t, prop, value) {
        // Writes target the real client so any client-state mutation behaves as
        // before (the mirror itself is stateless w.r.t. client config).
        real[prop] = value;
        return true;
      },
    });
  }
}

/**
 * Create the client the runners should use.
 *  - 1 sub-account  -> returns the REAL client unchanged (zero behavioral delta).
 *  - >1 sub-account -> returns { client, mirror } where `client` is the drop-in
 *    proxy and `mirror` is the OrderMirror instance (for ownerOfOrder / divergence
 *    wiring from AccountInstance).
 */
function createOrderClient(realClient, subAccounts) {
  if (!Array.isArray(subAccounts) || subAccounts.length <= 1) {
    return { client: realClient, mirror: null };
  }
  const mirror = new OrderMirror(realClient, subAccounts);
  return { client: mirror.asClient(), mirror };
}

module.exports = { OrderMirror, createOrderClient };
