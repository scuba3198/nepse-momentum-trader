const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadApp(options = {}) {
  const noop = () => {};
  let reducedMotion = false;
  const storage = new Map();
  const handlers = new Map();
  const elements = new Map();
  const dialogMessages = [];
  const makeElement = id => {
    let textContent = '';
    const node = {
    addEventListener: (name, handler) => {
      const key = `${id}:${name}`;
      if (!handlers.has(key)) handlers.set(key, []);
      handlers.get(key).push(handler);
      if (options.autoResolveDialogs && id === 'app-dialog-ok-btn' && name === 'click') {
        Promise.resolve().then(handler);
      }
    },
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add: noop, remove: noop },
    dataset: {},
    style: {},
    setAttribute: noop,
    appendChild: noop,
    focus: noop,
    select: noop,
    dispatchEvent: noop,
    getBoundingClientRect: () => null,
    value: '',
    innerHTML: ''
    };
    Object.defineProperty(node, 'textContent', {
      get: () => textContent,
      set: value => {
        textContent = String(value);
        if (id === 'app-dialog-message') dialogMessages.push(textContent);
      }
    });
    return node;
  };
  const element = id => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const fixedDate = options.fixedDate ? new Date(options.fixedDate) : null;
  const AppDate = fixedDate ? class extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedDate.getTime()])); }
    static now() { return fixedDate.getTime(); }
  } : Date;
  const context = {
    console,
    document: { getElementById: element, addEventListener: noop, removeEventListener: noop, createElement: element },
    window: {
      addEventListener: noop,
      setTimeout: noop,
      matchMedia: () => ({ matches: reducedMotion }),
      setReducedMotion: value => { reducedMotion = value; }
    },
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    Blob, URL, Intl, Date: AppDate, Set, Map, Math, JSON, isFinite, parseFloat, parseInt,
    Promise, Array, Object, Number, String, RegExp, Error
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('app.js', 'utf8'), context);
  context.__testElements = elements;
  context.__testHandlers = handlers;
  context.__testDialogMessages = dialogMessages;
  if (options.setupEventListeners) {
    vm.runInContext('holidayCalendarReady = true; holidayCalendarAvailable = true; setupEventListeners();', context);
  }
  vm.runInContext(`this.api = {
    applyDailyUpdate, recomputeTradeFromUpdateLog, normalizePersistedState,
    validatePendingFillCash, convertOrderToActiveTrade, getAvailableCash, recordPendingFill,
    summarizeExitAccounting, getTop5ScreenerCandidates, recordScreenerTop5Streaks, setMotionText,
    computeDistributionDays, getMacroGateStatus,
    hasSeenHeroSplash, rememberHeroSplashSeen,
    setReducedMotion: value => window.setReducedMotion(value),
    setState: value => { state = value; }, getState: () => state,
    setElementValue: (id, value) => { __testElements.get(id).value = value; },
    clickExecute: () => __testHandlers.get('execute-trade-btn:click')[0](),
    clickPending: target => __testHandlers.get('pending-orders-list:click')[0]({ target }),
    getDialogMessages: () => __testDialogMessages.slice()
  };`, context);
  return context.api;
}

const api = loadApp();

function confirmedMarketBars(count = 120) {
  const bars = [
    { date: '0', close: 100, volume: 100 },
    { date: '1', close: 99, volume: 100 },
    { date: '2', close: 100, volume: 100 },
    { date: '3', close: 100.2, volume: 100 },
    { date: '4', close: 100.4, volume: 100 },
    { date: '5', close: 102.1, volume: 200 }
  ];
  while (bars.length < count) {
    bars.push({ date: String(bars.length), close: bars.at(-1).close + 0.1, volume: 200 });
  }
  return bars;
}

// Day-order placement remains available on a weekend when the published
// calendar loaded successfully; the later per-session logging guard is separate.
let weekendOrderCheck;
{
  const orderApi = loadApp({
    fixedDate: '2026-08-23T12:00:00+05:45', // Sunday
    setupEventListeners: true,
    autoResolveDialogs: true
  });
  orderApi.setState({
    ...orderApi.getState(),
    accountValue: 1000000,
    cashBalance: 1000000,
    indexBars: confirmedMarketBars(),
    activeTrades: [],
    pendingOrders: []
  });
  orderApi.setElementValue('calc-ticker', 'WEEKEND');
  orderApi.setElementValue('calc-entry', '100');
  orderApi.setElementValue('calc-atr', '2');
  weekendOrderCheck = orderApi.clickExecute().then(() => {
    assert.equal(orderApi.getState().pendingOrders.length, 1);
    assert.equal(orderApi.getState().pendingOrders[0].ticker, 'WEEKEND');
    assert.equal(orderApi.getDialogMessages().some(message => message.includes('only be placed on a NEPSE trading session')), false);
  });
}

// A migrated unfilled order uses its old reservation only until the next
// valid-session re-price, then available cash uses the new gross reservation.
let pendingOrderRepriceCheck;
{
  const repriceApi = loadApp({
    fixedDate: '2026-08-24T12:00:00+05:45', // Monday
    setupEventListeners: true,
    autoResolveDialogs: true
  });
  const migrated = repriceApi.normalizePersistedState({
    accountValue: 1000,
    cashBalance: 1000,
    transactionCosts: { brokeragePct: 1, regulatoryFeePct: 0.5 },
    pendingOrders: [{ ticker: 'REPRICE', plannedEntry: 100, atr: 1, plannedStop: 7.5,
      shares: 10, filledShares: 0, filledValue: 0, filledCost: 0 }],
    activeTrades: [],
    history: []
  });
  migrated.state.indexBars = confirmedMarketBars();
  assert.ok(Math.abs(migrated.state.pendingOrders[0].legacyReservedCash - 1015) < 1e-9);
  repriceApi.setState(migrated.state);

  const fields = {
    '.pending-close-input': { value: '11' },
    '.pending-atr-input': { value: '0.1' },
    '.pending-fill-shares-input': { value: '' },
    '.pending-fill-price-input': { value: '' }
  };
  const row = { querySelector: selector => fields[selector], querySelectorAll: () => [] };
  const logButton = {
    getAttribute: () => '0',
    closest: selector => selector === '.pending-order-card' ? row : null
  };
  const target = { closest: selector => selector === '.log-today-btn' ? logButton : null };
  pendingOrderRepriceCheck = repriceApi.clickPending(target).then(() => {
    const order = repriceApi.getState().pendingOrders[0];
    assert.equal(order.legacyReservedCash, null);
    assert.equal(order.plannedEntry, 11);
    assert.equal(order.shares, 40);
    assert.equal(repriceApi.getAvailableCash(), repriceApi.getState().cashBalance -
      (order.shares - order.filledShares) * order.plannedEntry);
  });
}

// The market gate requires the advertised six months of history, and tiny
// higher-volume declines do not count as institutional distribution.
{
  const bars = confirmedMarketBars();
  api.setState({ indexBars: bars.slice(0, 119) });
  assert.equal(api.getMacroGateStatus().insufficientHistory, true);
  api.setState({ indexBars: bars });
  assert.equal(api.getMacroGateStatus().blocked, false);

  const tinyDecline = { date: '120', close: bars.at(-1).close * 0.999, volume: 201 };
  const meaningfulDecline = { date: '121', close: tinyDecline.close * 0.997, volume: 202 };
  assert.equal(api.computeDistributionDays([...bars, tinyDecline]).count, 0);
  assert.equal(api.computeDistributionDays([...bars, tinyDecline, meaningfulDecline]).count, 1);
}

// The intro is remembered only after it has been successfully entered.
{
  assert.equal(api.hasSeenHeroSplash(), false);
  api.rememberHeroSplashSeen();
  assert.equal(api.hasSeenHeroSplash(), true);
}

// Motion feedback only replays when a displayed value actually changes.
{
  const additions = [];
  const value = {
    dataset: {},
    textContent: '',
    offsetWidth: 0,
    classList: { remove: () => {}, add: name => additions.push(name) }
  };
  api.setMotionText(value, '10');
  api.setMotionText(value, '10');
  assert.equal(additions.length, 0);
  api.setMotionText(value, '11');
  assert.equal(additions.length, 1);
  api.setReducedMotion(true);
  api.setMotionText(value, '12');
  assert.equal(additions.length, 1);
  api.setReducedMotion(false);
}

// Top 5 streaks advance only across consecutive confirmed market sessions.
{
  api.setState({ screenerTop5Streaks: {}, screenerTop5StreakDate: '' });
  const streaks = api.getState().screenerTop5Streaks;
  const recorded = api.recordScreenerTop5Streaks([
    { ticker: 'A', tt: 100, rs: 99, vcp: 80 },
    { ticker: 'B', tt: 100, rs: 98, vcp: 80 },
    { ticker: 'C', tt: 100, rs: 97, vcp: 80 },
    { ticker: 'D', tt: 100, rs: 96, vcp: 80 },
    { ticker: 'E', tt: 100, rs: 95, vcp: 80 },
    { ticker: 'OUTSIDE', tt: 100, rs: 94, vcp: 80 }
  ], '2026-01-02', true);
  assert.equal(recorded, 5);
  assert.equal(streaks.A, 1);
  assert.equal(streaks.OUTSIDE, undefined);
  api.recordScreenerTop5Streaks([
    { ticker: 'A', tt: 100, rs: 99, vcp: 80 },
    { ticker: 'C', tt: 100, rs: 97, vcp: 80 },
    { ticker: 'E', tt: 100, rs: 95, vcp: 80 },
    { ticker: 'F', tt: 100, rs: 94, vcp: 80 },
    { ticker: 'G', tt: 100, rs: 93, vcp: 80 }
  ], '2026-01-05', true); // Monday follows Friday
  assert.equal(streaks.A, 2);
  assert.equal(streaks.C, 2);
  assert.equal(streaks.B, undefined);
  assert.equal(streaks.F, 1);
  assert.equal(api.recordScreenerTop5Streaks([{ ticker: 'A', tt: 100, rs: 99, vcp: 80 }], '2026-01-05', true), 0);
  api.recordScreenerTop5Streaks([{ ticker: 'A', tt: 100, rs: 99, vcp: 80 }], '2026-01-07', true); // Tuesday was missed
  assert.equal(api.getState().screenerTop5Streaks.A, 1);
  assert.equal(api.recordScreenerTop5Streaks([{ ticker: 'A', tt: 100, rs: 99, vcp: 80 }], '2026-01-08', false), 0);
  assert.equal(api.getState().screenerTop5StreakDate, '2026-01-07');
  const restored = api.normalizePersistedState({
    screenerTop5Hits: { LEGACY: 9 },
    screenerTop5Streaks: { A: 2 },
    screenerSessionAnswers: { '2026-01-02': true, '2026-01-03': false, invalid: true }
  });
  assert.equal(restored.state.screenerTop5Streaks.A, 2);
  assert.equal(restored.state.screenerTop5Streaks.LEGACY, undefined);
  assert.equal(restored.state.screenerSessionAnswers['2026-01-02'], true);
  assert.equal(restored.state.screenerSessionAnswers['2026-01-03'], false);
  assert.equal(restored.state.screenerSessionAnswers.invalid, undefined);
}

// Top 5 candidates rank by current streak, then RS; VCP does not break ties.
{
  api.setState({ screenerTop5Streaks: { STREAK: 3, HIGH_RS: 1 }, screenerTop5StreakDate: '2026-01-02' });
  const ranked = api.getTop5ScreenerCandidates([
    { ticker: 'HIGH_RS', tt: 100, rs: 99, vcp: 90 },
    { ticker: 'STREAK', tt: 100, rs: 90, vcp: 75 },
    { ticker: 'TIE_LOW_VCP', tt: 100, rs: 95, vcp: 75 },
    { ticker: 'TIE_HIGH_VCP', tt: 100, rs: 95, vcp: 99 }
  ]);
  assert.deepEqual(ranked.map(candidate => candidate.ticker), ['STREAK', 'HIGH_RS', 'TIE_LOW_VCP', 'TIE_HIGH_VCP']);
}

// A gap clears stale streaks before selecting a fresh Top 5, so they cannot
// influence the new sequence's ranking.
{
  api.setState({ screenerTop5Streaks: { STALE: 9 }, screenerTop5StreakDate: '2026-01-02' });
  const candidates = [
    { ticker: 'STALE', tt: 100, rs: 90, vcp: 80 },
    { ticker: 'A', tt: 100, rs: 99, vcp: 80 },
    { ticker: 'B', tt: 100, rs: 98, vcp: 80 },
    { ticker: 'C', tt: 100, rs: 97, vcp: 80 },
    { ticker: 'D', tt: 100, rs: 96, vcp: 80 },
    { ticker: 'E', tt: 100, rs: 95, vcp: 80 }
  ];
  api.recordScreenerTop5Streaks(candidates, '2026-01-07', true); // Tuesday was missed
  assert.equal(api.getState().screenerTop5Streaks.STALE, undefined);
  assert.equal(api.getState().screenerTop5Streaks.A, 1);
}

// A pending order's prior stop remains the replay floor on fill-day conversion.
{
  api.setState({ accountValue: 1000, cashBalance: 1000, activeTrades: [], pendingOrders: [] });
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

// Import keeps an active ticker and deterministically drops its pending clash.
{
  const result = api.normalizePersistedState({ accountValue: 1000,
    pendingOrders: [{ ticker: 'ABC', plannedEntry: 10, atr: 1, shares: 10 }],
    activeTrades: [{ ticker: 'abc', actualPrice: 10, shares: 10, initialAtr: 1 }], history: [] });
  assert.equal(result.state.activeTrades.length, 1);
  assert.equal(result.state.pendingOrders.length, 0);
  assert.equal(result.dropped.duplicateTickers, 1);
}

// Imported fee settings are ignored after preserving old record values and the
// pending order's one-time legacy reservation until its next fill.
{
  const result = api.normalizePersistedState({
    accountValue: 1000,
    cashBalance: 1000,
    transactionCosts: { brokeragePct: 1, regulatoryFeePct: 0.5, dpChargePerSell: 10, capitalGainsTaxPct: 10 },
    pendingOrders: [{ ticker: 'LEGACY', plannedEntry: 10, atr: 1, plannedStop: 7.5, shares: 10,
      filledShares: 0, filledValue: 0, filledCost: 0 }],
    activeTrades: [{ ticker: 'HELD', actualPrice: 20, shares: 2, initialAtr: 1,
      initialStop: 17.5, trailingStop: 20, highestClose: 20, lastClose: 20,
      soldShares: 1, soldValue: 30, soldNetValue: 29, entryShares: 3,
      entryGrossValue: 60, entryCost: 42 }],
    history: [{ ticker: 'OLD', entryPrice: 10, exitPrice: 12, shares: 1,
      totalRisk: 2, pnl: 1.25, returnPct: 12.5, netPnl: 1.25,
      grossPnl: 2, netEntryCost: 10, netExitValue: 12 }]
  });
  assert.equal(result.state.transactionCosts, undefined);
  assert.equal(result.state.transactionCostsConfigured, undefined);
  assert.equal(result.state.cashBalance, 1000);
  assert.equal(result.state.activeTrades[0].entryCost, 42);
  assert.equal(result.state.activeTrades[0].soldNetValue, 29);
  assert.equal(result.state.history[0].pnl, 1.25);
  assert.equal(result.state.history[0].netEntryCost, 10);

  const order = result.state.pendingOrders[0];
  assert.ok(Math.abs(order.legacyReservedCash - 101.5) < 1e-9);
  api.setState(result.state);
  assert.ok(Math.abs(api.getAvailableCash() - 898.5) < 1e-9);
  api.recordPendingFill(order, 1, 10, '2026-01-05');
  assert.equal(order.legacyReservedCash, null);
  assert.equal(order.filledCost, 10);
  assert.equal(api.getAvailableCash(), 900);
}

// The affordability decision is made before a fill can mutate an order.
{
  api.setState({ accountValue: 100, cashBalance: 50, pendingOrders: [] });
  const order = { ticker: 'XYZ', shares: 10, filledShares: 0, plannedEntry: 10 };
  const check = api.validatePendingFillCash(order, 6, 10);
  assert.equal(check.ok, false);
  assert.equal(order.filledShares, 0);
}

// Sale accounting uses gross proceeds for new records while preserving an
// imported legacy explicit zero-net compatibility value.
{
  const summary = api.summarizeExitAccounting({ actualPrice: 10, soldShares: 1,
    soldValue: 10, soldNetValue: 10, entryCost: 10 });
  assert.equal(summary.netRevenue, 10);
  assert.equal(summary.pnl, 0);
  const importedLegacy = api.summarizeExitAccounting({ actualPrice: 10, soldShares: 1,
    soldValue: 10, soldNetValue: 0, entryCost: 10 });
  assert.equal(importedLegacy.netRevenue, 0);
  assert.equal(importedLegacy.pnl, -10);
}

Promise.all([weekendOrderCheck, pendingOrderRepriceCheck])
  .then(() => console.log('Regression checks passed.'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
