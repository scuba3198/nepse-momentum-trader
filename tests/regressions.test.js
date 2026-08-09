import assert from 'node:assert/strict';

(async () => {
  const d = await import('../src/Domain.res.mjs');
  const reducer = await import('../src/Reducer.res.mjs');
  const storage = await import('../src/Storage.res.mjs');
  const reduceOk = (state, action) => {
    const result = reducer.reducer(state, action);
    assert.equal(result.TAG, 'Ok');
    return result._0;
  };

  const order = (overrides = {}) => ({
    ticker: 'FLOOR', plannedEntry: 100, plannedStop: 97.5, atr: 1, shares: 10,
    filledShares: 10, filledValue: 1000, filledCost: 1000, daysWaiting: 0,
    placedDate: '', firstFillDate: '1/3/2026', firstFillISO: '2026-01-03',
    fillLog: [], lastLoggedDate: '', accountValueAtEntry: 1000, entryReason: '',
    transactionCostsApplied: true, ...overrides
  });

  // A pending order's prior stop remains the replay floor on fill-day conversion.
  {
    const trade = d.convertOrderToActiveTrade(order(), 101, 10, '2026-01-03');
    assert.equal(trade.initialStop, 75);
    assert.equal(trade.trailingStop, 97.5);
  }

  // Backfills are replayed by date and same-day corrections can lower a stop.
  {
    const base = {
      ticker: 'ABC', plannedEntry: 100, actualPrice: 100, shares: 10,
      initialAtr: 4, initialStop: 90, replayStopFloor: 90, trailingStop: 90,
      highestClose: 100, lastClose: 100, lastAtr: null, entryDate: '',
      entryISO: null, lastUpdatedDate: '', lastUpdatedISO: null,
      accountValueAtEntry: 1000, entryReason: '', exitReasonDraft: '',
      soldShares: 0, soldValue: 0, soldNetValue: 0, entryShares: 10,
      entryGrossValue: 1000, entryCost: 1000, transactionCostsApplied: true,
      updateLog: []
    };
    let trade = d.applyDailyUpdate(base, '2026-01-03', 120, 5);
    trade = d.applyDailyUpdate(trade, '2026-01-04', 110, 5);
    assert.equal(trade.trailingStop, 107.5);
    trade = d.applyDailyUpdate(trade, '2026-01-03', 102, 5);
    assert.equal(trade.highestClose, 110);
    assert.equal(trade.trailingStop, 97.5);
    assert.deepEqual(trade.updateLog.map(e => e.dateISO), ['2026-01-03', '2026-01-04']);
    assert.deepEqual(trade.updateLog.map(e => e.trailingStop), [90, 97.5]);
  }

  // Import replay ignores an inflated persisted stop and applies a correction.
  {
    const result = d.normalizePersistedState({
      accountValue: 1000, pendingOrders: [], history: [], activeTrades: [{
        ticker: 'REPLAY', actualPrice: 100, shares: 10, initialAtr: 4,
        initialStop: 90, trailingStop: 200, highestClose: 300, lastClose: 120,
        updateLog: [
          {dateISO: '2026-01-03', close: 120, atr: 5, trailingStop: 200},
          {dateISO: '2026-01-04', close: 110, atr: 5, trailingStop: 200}
        ]
      }]
    });
    let trade = result.state.activeTrades[0];
    assert.equal(trade.trailingStop, 107.5);
    trade = d.applyDailyUpdate(trade, '2026-01-03', 102, 5);
    assert.equal(trade.trailingStop, 97.5);
  }

  // Configured costs apply to buy/sell net cash.
  {
    const costs = {brokeragePct: 1, regulatoryFeePct: 0.5, dpChargePerSell: 10, capitalGainsTaxPct: 10};
    assert.equal(d.buyNetCost(100, costs), 101.5);
    assert.equal(d.sellNetProceeds(120, 100, costs), 106.2);
  }

  // Active wins ticker clashes during migration and malformed records are counted.
  {
    const result = d.normalizePersistedState({
      accountValue: 1000,
      pendingOrders: [{ticker: 'ABC', plannedEntry: 10, atr: 1, shares: 10}],
      activeTrades: [{ticker: 'abc', actualPrice: 10, shares: 10, initialAtr: 1}],
      history: []
    });
    assert.equal(result.state.activeTrades.length, 1);
    assert.equal(result.state.pendingOrders.length, 0);
    assert.equal(result.dropped.duplicateTickers, 1);
  }

  // Affordability is checked before a fill mutates the order.
  {
    const check = d.validatePendingFillCash(50, {brokeragePct: 1, regulatoryFeePct: 0, dpChargePerSell: 0, capitalGainsTaxPct: 0}, order({ticker: 'XYZ', shares: 10, filledShares: 0, filledValue: 0, filledCost: 0}), 10, 6);
    assert.equal(check.ok, false);
    assert.equal(check.required, 60.6);
  }

  // Zero net proceeds remain zero in close accounting.
  {
    const summary = d.summarizeExitAccounting(10, 1, 10, 0, 10);
    assert.equal(JSON.parse(JSON.stringify(summary)).netRevenue, 0);
    assert.equal(JSON.parse(JSON.stringify(summary)).pnl, -10);
  }

  // Raw, old wrapped, and new envelopes all normalize through the same decoder.
  {
    const raw = {accountValue: 1234, pendingOrders: [], activeTrades: [], history: []};
    assert.equal(d.normalizePersistedState(raw).state.accountValue, 1234);
    assert.equal(d.normalizePersistedState({state: raw}).state.accountValue, 1234);
    assert.equal(d.normalizePersistedState({format: 'atr-desk', schemaVersion: 1, exportedAt: '2026-01-01T00:00:00Z', state: raw}).state.accountValue, 1234);
  }

  // Exports remain schema 1 while storage writes use version 2 and preserve
  // the first legacy payload in the untouched recovery slot.
  {
    const state = d.defaultState();
    assert.equal(JSON.parse(storage.serializeState(state)).schemaVersion, 1);
    assert.equal(JSON.parse(storage.serializeStorageState(state)).schemaVersion, 2);
    const legacy = JSON.stringify({accountValue: 123, pendingOrders: [], activeTrades: [], history: []});
    const plan = storage.planWrite({primary: undefined, legacy, recovery: undefined, backup: undefined}, state);
    assert.equal(plan.recoveryValue, legacy);
    assert.equal(JSON.parse(plan.primaryValue).schemaVersion, 2);
    const previousPrimary = storage.serializeStorageState({...state, accountValue: 99});
    const repeated = storage.planWrite({primary: previousPrimary, legacy, recovery: 'untouched-recovery', backup: undefined}, state);
    assert.equal(repeated.recoveryValue, 'untouched-recovery');
    assert.equal(repeated.backupValue, previousPrimary);
  }

  // Canonical storage precedence never resurrects legacy data once a primary
  // namespace exists, and corrupt primaries fall through backup then recovery.
  {
    const rawState = d.defaultState();
    const primary = storage.serializeStorageState({...rawState, accountValue: 10});
    const backup = storage.serializeStorageState({...rawState, accountValue: 20});
    const recovery = storage.serializeStorageState({...rawState, accountValue: 30});
    const legacy = storage.serializeState({...rawState, accountValue: 40});
    assert.equal(storage.loadFromRecords({primary, backup, recovery, legacy}).state.accountValue, 10);
    assert.equal(storage.loadFromRecords({primary: '{bad', backup, recovery, legacy}).state.accountValue, 20);
    assert.equal(storage.loadFromRecords({primary: undefined, backup, recovery, legacy}).state.accountValue, 20);
    assert.equal(storage.loadFromRecords({primary: undefined, backup: undefined, recovery: undefined, legacy}).state.accountValue, 40);
    assert.equal(storage.loadFromRecords({primary: '{bad', backup, recovery, legacy}).source, 'backup');
  }

  // Missing legacy cash is reconstructed from committed positions, pending
  // reservations, and partial-sale net proceeds.
  {
    const legacy = {
      accountValue: 10000,
      activeTrades: [{ticker: 'ACTIVE', actualPrice: 100, shares: 60, entryShares: 100, entryCost: 4000, soldShares: 40, soldNetValue: 500, initialAtr: 2}],
      pendingOrders: [{ticker: 'PENDING', plannedEntry: 100, plannedStop: 97.5, atr: 1, shares: 10, filledShares: 5, filledValue: 500, filledCost: 1000}],
      history: []
    };
    assert.equal(d.normalizePersistedState(legacy).state.cashBalance, 5500);
  }

  // Envelope metadata is strict while explicit raw/old wrapped states remain accepted.
  {
    const raw = {accountValue: 7, pendingOrders: [], activeTrades: [], history: []};
    assert.equal(storage.deserializeState(JSON.stringify({format: 'other', schemaVersion: 1, state: raw})), undefined);
    assert.equal(storage.deserializeState(JSON.stringify({format: 'atr-desk', schemaVersion: 99, state: raw})), undefined);
    assert.equal(storage.deserializeState(JSON.stringify({state: raw})).accountValue, 7);
  }

  // Typed reducer actions replace persisted state and normalize imported bars/candidates.
  {
    const state = d.defaultState();
    const sorted = reduceOk(state, {
      TAG: 'SetIndexBars',
      _0: [
        {date: '2026-01-04', close: 104, volume: 1000},
        {date: '2026-01-02', close: 102, volume: 900}
      ]
    });
    assert.deepEqual(sorted.indexBars.map(bar => bar.date), ['2026-01-02', '2026-01-04']);

    const candidates = reduceOk(sorted, {
      TAG: 'SetCandidates',
      _0: [
        {ticker: ' zzz ', tt: 90, rs: 80, vcp: 70},
        {ticker: ' aaa ', tt: 80, rs: 95, vcp: 80}
      ]
    });
    assert.deepEqual(candidates.screenerCandidates.map(candidate => candidate.ticker), ['AAA', 'ZZZ']);

    const replaced = reduceOk(candidates, {
      TAG: 'ReplaceState',
      _0: {...candidates, accountValue: 4321, cashBalance: 4321}
    });
    assert.equal(replaced.accountValue, 4321);
    assert.equal(replaced.cashBalance, 4321);
    assert.notStrictEqual(replaced, candidates);
  }

  // Partial exits accrue one tranche at a time, preserve the trailing stop,
  // and emit one complete typed history row only on the final close.
  {
    const trade = {
      ticker: 'MULTI', plannedEntry: 100, actualPrice: 100, shares: 100,
      initialAtr: 4, initialStop: 90, replayStopFloor: 90, trailingStop: 90,
      highestClose: 100, lastClose: 100, lastAtr: null,
      entryDate: '03/01/2026', entryISO: '2026-01-03',
      lastUpdatedDate: '', lastUpdatedISO: null,
      accountValueAtEntry: 10000, entryReason: 'breakout', exitReasonDraft: '',
      soldShares: 0, soldValue: 0, soldNetValue: 0, entryShares: 100,
      entryGrossValue: 10000, entryCost: 10000,
      transactionCostsApplied: false, updateLog: []
    };
    let state = {...d.defaultState(), accountValue: 10000, cashBalance: 0, activeTrades: [trade]};
    state = reduceOk(state, {TAG: 'SellOn', _0: 'MULTI', _1: '2026-01-04', _2: 40, _3: 120, _4: 'risk'});
    assert.equal(state.activeTrades[0].shares, 60);
    assert.equal(state.activeTrades[0].trailingStop, 90);
    assert.equal(state.history.length, 0);
    assert.equal(state.cashBalance, 4800);
    assert.equal(state.realizedPnl, 800);

    state = reduceOk(state, {TAG: 'SellOn', _0: 'MULTI', _1: '2026-01-05', _2: 60, _3: 110, _4: ''});
    assert.equal(state.activeTrades.length, 0);
    assert.equal(state.cashBalance, 11400);
    assert.equal(state.realizedPnl, 1400);
    assert.equal(state.history.length, 1);
    const history = state.history[0];
    assert.equal(history.shares, 100);
    assert.equal(history.entryDate, '03/01/2026');
    assert.equal(history.exitDate, '05/01/2026');
    assert.equal(history.exitPrice, 114);
    assert.equal(history.grossPnl, 1400);
    assert.equal(history.netPnl, 1400);
    assert.equal(history.netEntryCost, 10000);
    assert.equal(history.netExitValue, 11400);
    assert.equal(history.totalRisk, 1000);
    assert.equal(history.actualRiskPct, 10);
    assert.equal(history.entryReason, 'breakout');
    assert.equal(history.exitReason, 'risk');
    assert.equal(history.transactionCostsApplied, false);
  }

  // Pending lifecycle: partial fills use VWAP, repricing preserves the fill
  // ledger, same-day no-fill is idempotent, and attempt five cancels.
  {
    const pending = {
      ticker: 'WAIT', plannedEntry: 100, plannedStop: 95, atr: 2, shares: 20,
      filledShares: 0, filledValue: 0, filledCost: 0, daysWaiting: 0,
      placedDate: '01/01/2026', placedISO: '2026-01-01', firstFillDate: '',
      firstFillISO: undefined, fillLog: [], lastLoggedDate: '', lastLoggedISO: undefined,
      accountValueAtEntry: 10000, entryReason: 'test', transactionCostsApplied: false
    };
    let state = reduceOk({...d.defaultState(), accountValue: 10000, cashBalance: 10000}, {TAG: 'AddPending', _0: pending});
    let dayState = reduceOk({...d.defaultState(), accountValue: 10000, cashBalance: 10000}, {TAG: 'AddPending', _0: {...pending, ticker: 'DAY'}});
    dayState = reduceOk(dayState, {TAG: 'LogPendingDay', _0: 'DAY', _1: '2026-01-02', _2: 100, _3: 2, _4: undefined});
    assert.equal(dayState.pendingOrders[0].daysWaiting, 1);
    assert.equal(dayState.pendingOrders[0].plannedStop, 95);
    const backdatedDay = reducer.reducer(dayState, {TAG: 'LogPendingDay', _0: 'DAY', _1: '2026-01-01', _2: 100, _3: 2, _4: undefined});
    assert.equal(backdatedDay.TAG, 'Error');
    assert.equal(backdatedDay._0.TAG, 'InvalidDate');
    const repeatedDay = reducer.reducer(dayState, {TAG: 'LogPendingDay', _0: 'DAY', _1: '2026-01-02', _2: 100, _3: 2, _4: [1, 100]});
    assert.equal(repeatedDay.TAG, 'Ok');
    assert.strictEqual(repeatedDay._0, dayState);
    state = reduceOk(state, {TAG: 'ApplyPendingFill', _0: 'WAIT', _1: '2026-01-02', _2: 5, _3: 100, _4: 101, _5: 2});
    state = reduceOk(state, {TAG: 'ApplyPendingFill', _0: 'WAIT', _1: '2026-01-03', _2: 5, _3: 110, _4: 111, _5: 2});
    assert.equal(state.pendingOrders[0].filledShares, 10);
    assert.equal(state.pendingOrders[0].filledValue, 1050);
    const cashBeforeRejectedFill = state.cashBalance;
    const sameSession = reducer.reducer(state, {TAG: 'ApplyPendingFill', _0: 'WAIT', _1: '2026-01-03', _2: 1, _3: 110, _4: 111, _5: 2});
    assert.equal(sameSession.TAG, 'Error');
    assert.equal(sameSession._0.TAG, 'InvalidDate');
    assert.equal(sameSession._1, undefined);
    assert.equal(state.cashBalance, cashBeforeRejectedFill);
    const outOfOrder = reducer.reducer(state, {TAG: 'ApplyPendingFill', _0: 'WAIT', _1: '2026-01-02', _2: 1, _3: 110, _4: 111, _5: 2});
    assert.equal(outOfOrder.TAG, 'Error');
    assert.equal(outOfOrder._0.TAG, 'InvalidDate');
    const repriced = reduceOk(state, {TAG: 'RepricePending', _0: 'WAIT', _1: 120, _2: 4});
    assert.equal(repriced.pendingOrders[0].plannedEntry, 120);
    assert.equal(repriced.pendingOrders[0].plannedStop, 110);
    assert.equal(repriced.pendingOrders[0].filledShares, 10);
    assert.equal(repriced.pendingOrders[0].filledValue, 1050);

    const waitOnly = {...pending, ticker: 'WAIT2'};
    let noFill = reduceOk({...d.defaultState(), accountValue: 10000, cashBalance: 10000}, {TAG: 'AddPending', _0: waitOnly});
    noFill = reduceOk(noFill, {TAG: 'LogNoFill', _0: 'WAIT2', _1: '2026-01-04'});
    assert.equal(noFill.pendingOrders[0].daysWaiting, 1);
    const sameDay = reducer.reducer(noFill, {TAG: 'LogNoFill', _0: 'WAIT2', _1: '2026-01-04'});
    assert.equal(sameDay.TAG, 'Ok');
    assert.equal(sameDay._0.pendingOrders[0].daysWaiting, 1);
    noFill = reduceOk(sameDay._0, {TAG: 'LogNoFill', _0: 'WAIT2', _1: '2026-01-05'});
    noFill = reduceOk(noFill, {TAG: 'LogNoFill', _0: 'WAIT2', _1: '2026-01-06'});
    noFill = reduceOk(noFill, {TAG: 'LogNoFill', _0: 'WAIT2', _1: '2026-01-07'});
    noFill = reduceOk(noFill, {TAG: 'LogNoFill', _0: 'WAIT2', _1: '2026-01-08'});
    assert.equal(noFill.pendingOrders.length, 0);

    const reserved = {...pending, ticker: 'RESERVED', shares: 80};
    const committed = reduceOk({...d.defaultState(), accountValue: 10000, cashBalance: 10000}, {TAG: 'AddPending', _0: reserved});
    const over = reducer.reducer({...committed, cashBalance: 100}, {TAG: 'AddPending', _0: {...pending, ticker: 'OVER', shares: 30}});
    assert.equal(over.TAG, 'Error');
    assert.equal(over._0.TAG, 'CashCap');

    let multi = {...d.defaultState(), accountValue: 10000, cashBalance: 3000};
    multi = reduceOk(multi, {TAG: 'AddPending', _0: {...pending, ticker: 'CASH1', shares: 10}});
    multi = reduceOk(multi, {TAG: 'AddPending', _0: {...pending, ticker: 'CASH2', shares: 10}});
    const reservationBlockedFill = reducer.reducer(multi, {TAG: 'ApplyPendingFill', _0: 'CASH1', _1: '2026-01-02', _2: 10, _3: 250, _4: 250, _5: 2});
    assert.equal(reservationBlockedFill.TAG, 'Error');
    assert.equal(reservationBlockedFill._0.TAG, 'CashCap');
    assert.equal(multi.cashBalance, 3000);

    const cashCappedReprice = reduceOk({...multi, accountValue: 12000}, {TAG: 'RepricePending', _0: 'CASH1', _1: 150, _2: 2});
    const repricedCashOrder = cashCappedReprice.pendingOrders.find(({ticker}) => ticker === 'CASH1');
    assert.equal(repricedCashOrder.shares, 13);
    assert.equal(repricedCashOrder.accountValueAtEntry, 12000);
    assert.ok(repricedCashOrder.shares * repricedCashOrder.plannedEntry <= 2000);

    const dailyCapped = reduceOk({...multi, accountValue: 12000}, {TAG: 'LogPendingDay', _0: 'CASH1', _1: '2026-01-02', _2: 150, _3: 2, _4: undefined});
    const dailyCappedOrder = dailyCapped.pendingOrders.find(({ticker}) => ticker === 'CASH1');
    assert.equal(dailyCappedOrder.shares, 13);
    assert.equal(dailyCappedOrder.accountValueAtEntry, 12000);
    assert.ok(dailyCappedOrder.shares * dailyCappedOrder.plannedEntry <= 2000);
  }

  // Invalid reducer inputs and duplicate committed tickers return typed errors.
  {
    const invalid = reducer.reducer(d.defaultState(), {TAG: 'SetCashBalance', _0: NaN});
    assert.equal(invalid.TAG, 'Error');
    assert.equal(invalid._0.TAG, 'InvalidNumber');
  }

  console.log('ReScript domain regression checks passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
