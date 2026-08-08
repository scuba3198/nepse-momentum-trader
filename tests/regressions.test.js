const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadApp() {
  const noop = () => {};
  const element = () => ({
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add: noop, remove: noop },
    style: {},
    setAttribute: noop,
    appendChild: noop,
    focus: noop,
    select: noop,
    value: '',
    textContent: '',
    innerHTML: ''
  });
  const context = {
    console,
    document: { getElementById: element, addEventListener: noop, removeEventListener: noop, createElement: element },
    window: { addEventListener: noop, setTimeout: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    Blob, URL, Intl, Date, Set, Map, Math, JSON, isFinite, parseFloat, parseInt,
    Promise, Array, Object, Number, String, RegExp, Error
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('app.js', 'utf8'), context);
  vm.runInContext(`this.api = {
    applyDailyUpdate, recomputeTradeFromUpdateLog, normalizePersistedState,
    buyNetCost, sellNetProceeds, validatePendingFillCash, convertOrderToActiveTrade,
    summarizeExitAccounting,
    setState: value => { state = value; }, getState: () => state
  };`, context);
  return context.api;
}

const api = loadApp();

// A pending order's prior stop remains the replay floor on fill-day conversion.
{
  api.setState({ accountValue: 1000, cashBalance: 1000, transactionCosts: {}, activeTrades: [], pendingOrders: [] });
  const trade = api.convertOrderToActiveTrade({ ticker: 'FLOOR', plannedEntry: 100, atr: 1,
    plannedStop: 97.5, filledShares: 10, filledValue: 1000, filledCost: 1000,
    firstFillISO: '2026-01-03', firstFillDate: '1/3/2026', accountValueAtEntry: 1000 },
    { todayClose: 101, todayAtr: 10, fillDateISO: '2026-01-03' });
  assert.equal(trade.initialStop, 75);
  assert.equal(trade.trailingStop, 97.5);
}

// Backfills are replayed by date and same-day corrections can lower a stop.
{
  const trade = { ticker: 'ABC', actualPrice: 100, initialAtr: 4, initialStop: 90, replayStopFloor: 90, updateLog: [] };
  api.applyDailyUpdate(trade, '2026-01-03', 120, 5);
  api.applyDailyUpdate(trade, '2026-01-04', 110, 5);
  assert.equal(trade.trailingStop, 107.5);
  api.applyDailyUpdate(trade, '2026-01-03', 102, 5);
  assert.equal(trade.highestClose, 110);
  assert.equal(trade.trailingStop, 97.5);
  assert.deepEqual(Array.from(trade.updateLog, e => e.dateISO), ['2026-01-03', '2026-01-04']);
  assert.deepEqual(Array.from(trade.updateLog, e => e.trailingStop), [90, 97.5]);
}

// Import normalization must ignore an inflated persisted trailing stop when a
// dated log can be replayed, then lower the corrected same-day result.
{
  const result = api.normalizePersistedState({ accountValue: 1000, pendingOrders: [], history: [], activeTrades: [{
    ticker: 'REPLAY', actualPrice: 100, shares: 10, initialAtr: 4, initialStop: 90,
    trailingStop: 200, highestClose: 300, lastClose: 120, updateLog: [
      { dateISO: '2026-01-03', close: 120, atr: 5, trailingStop: 200 },
      { dateISO: '2026-01-04', close: 110, atr: 5, trailingStop: 200 }
    ]
  }] });
  const trade = result.state.activeTrades[0];
  assert.equal(trade.trailingStop, 107.5);
  api.applyDailyUpdate(trade, '2026-01-03', 102, 5);
  assert.equal(trade.trailingStop, 97.5);
}

// Configured buy/sell costs are reflected in net cash/P&L helpers.
{
  api.setState({ accountValue: 1000, cashBalance: 1000, transactionCosts: {
    brokeragePct: 1, regulatoryFeePct: 0.5, dpChargePerSell: 10, capitalGainsTaxPct: 10
  }, pendingOrders: [], activeTrades: [] });
  assert.equal(api.buyNetCost(100), 101.5);
  assert.equal(api.sellNetProceeds(120, 100), 106.2);
}

// Import keeps an active ticker and deterministically drops its pending clash.
{
  const result = api.normalizePersistedState({ accountValue: 1000,
    pendingOrders: [{ ticker: 'ABC', plannedEntry: 10, atr: 1, shares: 10 }],
    activeTrades: [{ ticker: 'abc', actualPrice: 10, shares: 10, initialAtr: 1 }], history: [] });
  assert.equal(result.state.activeTrades.length, 1);
  assert.equal(result.state.pendingOrders.length, 0);
  assert.equal(result.dropped.duplicateTickers, 1);
}

// The affordability decision is made before a fill can mutate an order.
{
  api.setState({ accountValue: 100, cashBalance: 50, transactionCosts: { brokeragePct: 1, regulatoryFeePct: 0, dpChargePerSell: 0, capitalGainsTaxPct: 0 }, pendingOrders: [] });
  const order = { ticker: 'XYZ', shares: 10, filledShares: 0, plannedEntry: 10 };
  const check = api.validatePendingFillCash(order, 6, 10);
  assert.equal(check.ok, false);
  assert.equal(order.filledShares, 0);
}

// A zero net sale (fees can consume the entire gross proceeds) must remain
// zero in the closed-trade accounting rather than falling back to gross.
{
  const summary = api.summarizeExitAccounting({ actualPrice: 10, soldShares: 1,
    soldValue: 10, soldNetValue: 0, entryCost: 10 });
  assert.equal(summary.netRevenue, 0);
  assert.equal(summary.pnl, -10);
}

console.log('Regression checks passed.');
