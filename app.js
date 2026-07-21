// ==========================================================================
// NEPSE Efficient Trader Strategy (ATR Momentum Version) - Core Logic
// ==========================================================================

// Strategy Constants
const PORTFOLIO_SLOTS = 5;
const RISK_PER_POSITION_PCT = 0.01;                                        // 1% of account value, per position
const TOTAL_PORTFOLIO_RISK_PCT = RISK_PER_POSITION_PCT * PORTFOLIO_SLOTS;  // 5% with all slots filled
const ATR_MULTIPLIER = 2.5;
const MIN_LOT_SIZE = 10; // NEPSE: odd lots under 10 shares are a hassle to buy/sell — don't recommend them
const MAX_DAY_ORDER_ATTEMPTS = 5;            // Give up after 5 daily re-priced attempts if never filled

// Screener Shortlist gate thresholds (Step 01): a candidate must clear BOTH
// the Trend Template and Relative Strength scores to "pass". VCP Pattern
// Score is NOT a gate — it's used only to rank passers (tighter base first).
const SCREENER_TT_THRESHOLD = 75;
const SCREENER_RS_THRESHOLD = 75;
const SCREENER_TOP_N = 5; // Portfolio has 5 slots — only show the top-ranked passers

// Which subset of screener candidates is currently displayed. This is a
// transient view preference (not persisted to state/export) — it always
// resets to 'top5' on reload, matching the app's default actionable view.
let screenerFilterMode = 'top5'; // 'top5' | 'passing' | 'failing' | 'all'

// Application State
let state = {
  accountValue: 1000000.00,
  stage2IsLeading: false,   // Step 0: Broad Market Macro Filter
  pendingOrders: [],        // Step 4: GTC Limit Orders awaiting fill
  activeTrades: [],
  history: [],
  screenerCandidates: []    // Step 01: { ticker, tt, rs, vcp }
};

// DOM Elements
const elements = {
  // Header
  headerAccountValue: document.getElementById('header-account-value'),
  headerSlotsCount: document.getElementById('header-slots-count'),
  editAccountBtn: document.getElementById('edit-account-btn'),
  resetAppBtn: document.getElementById('reset-app-btn'),
  strategyState: document.getElementById('strategy-state'),
  exportBtn: document.getElementById('export-btn'),
  importBtn: document.getElementById('import-btn'),
  importFileInput: document.getElementById('import-file-input'),

  // Macro Filter (Step 0)
  macroYesBtn: document.getElementById('macro-yes-btn'),
  macroNoBtn: document.getElementById('macro-no-btn'),
  macroStatusText: document.getElementById('macro-status-text'),
  haltBanner: document.getElementById('halt-banner'),

  // Screener Shortlist (Step 01)
  screenerBulkPaste: document.getElementById('screener-bulk-paste'),
  screenerBulkParseBtn: document.getElementById('screener-bulk-parse-btn'),
  screenerList: document.getElementById('screener-list'),
  screenerFilterGroup: document.getElementById('screener-filter-group'),
  screenerSummary: document.getElementById('screener-summary'),
  screenerThresholdLabel: document.getElementById('screener-threshold-label'),

  // Calculator
  calcTicker: document.getElementById('calc-ticker'),
  calcEntry: document.getElementById('calc-entry'),
  calcAtr: document.getElementById('calc-atr'),
  calcLiquidity: document.getElementById('calc-liquidity'),
  resPlannedRisk: document.getElementById('res-planned-risk'),
  resInitialStop: document.getElementById('res-initial-stop'),
  resRiskPerShare: document.getElementById('res-risk-per-share'),
  resPositionSize: document.getElementById('res-position-size'),
  resCapitalCheck: document.getElementById('res-capital-check'),
  capitalPctTile: document.getElementById('capital-pct-tile'),
  resCapitalPct: document.getElementById('res-capital-pct'),
  liquidityCheckTile: document.getElementById('liquidity-check-tile'),
  resLiquidityCheck: document.getElementById('res-liquidity-check'),
  executeTradeBtn: document.getElementById('execute-trade-btn'),
  slotsFullWarning: document.getElementById('slots-full-warning'),

  // Pending GTC Orders
  pendingOrdersList: document.getElementById('pending-orders-list'),
  pendingOrdersCount: document.getElementById('pending-orders-count'),

  // Active Trades
  portfolioList: document.getElementById('portfolio-list'),
  activeTradesCount: document.getElementById('active-trades-count'),

  // Daily Routine
  routineForm: document.getElementById('routine-form'),
  routineSelect: document.getElementById('routine-select'),
  routineClose: document.getElementById('routine-close'),
  routineAtr: document.getElementById('routine-atr'),
  routineSubmitBtn: document.getElementById('routine-submit-btn'),

  // History
  historyList: document.getElementById('history-list'),

  // Modals
  accountModal: document.getElementById('account-modal'),
  modalAccountValue: document.getElementById('modal-account-value'),
  closeAccountModal: document.getElementById('close-account-modal'),
  saveAccountBtn: document.getElementById('save-account-btn'),

};

// Generic App Dialog elements (replaces native alert/confirm/prompt)
const dialogEls = {
  overlay: document.getElementById('app-dialog'),
  title: document.getElementById('app-dialog-title'),
  message: document.getElementById('app-dialog-message'),
  inputRow: document.getElementById('app-dialog-input-row'),
  input: document.getElementById('app-dialog-input'),
  okBtn: document.getElementById('app-dialog-ok-btn'),
  cancelBtn: document.getElementById('app-dialog-cancel-btn')
};

// Internal engine: shows the dialog configured for alert/confirm/prompt and
// resolves a promise when the user responds. Only one dialog is shown at a
// time. Concurrent calls are serialized through dialogQueue below — the
// actual DOM manipulation always happens one call at a time, so two dialogs
// triggered close together can no longer overwrite each other's listeners.
let dialogQueue = Promise.resolve();

function showDialog(opts) {
  const run = () => showDialogNow(opts);
  const result = dialogQueue.then(run, run);
  dialogQueue = result.catch(() => {}); // never let one dialog's issue block the next
  return result;
}

function showDialogNow({ title, message, mode, defaultValue = '' }) {
  return new Promise((resolve) => {
    dialogEls.title.textContent = title;
    dialogEls.message.textContent = message;

    if (mode === 'prompt') {
      dialogEls.inputRow.style.display = 'block';
      dialogEls.input.value = defaultValue;
      dialogEls.cancelBtn.style.display = 'inline-block';
    } else if (mode === 'confirm') {
      dialogEls.inputRow.style.display = 'none';
      dialogEls.cancelBtn.style.display = 'inline-block';
    } else {
      // alert
      dialogEls.inputRow.style.display = 'none';
      dialogEls.cancelBtn.style.display = 'none';
    }

    dialogEls.okBtn.textContent = mode === 'prompt' ? 'Confirm' : mode === 'confirm' ? 'Yes' : 'OK';

    const cleanup = () => {
      dialogEls.overlay.classList.remove('active');
      dialogEls.okBtn.removeEventListener('click', onOk);
      dialogEls.cancelBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKeydown);
    };

    const onOk = () => {
      cleanup();
      if (mode === 'prompt') resolve(dialogEls.input.value);
      else if (mode === 'confirm') resolve(true);
      else resolve(undefined);
    };

    const onCancel = () => {
      cleanup();
      if (mode === 'prompt') resolve(null);
      else if (mode === 'confirm') resolve(false);
      else resolve(undefined);
    };

    const onKeydown = (e) => {
      // Ignore Enter while typing in the prompt input if the browser would
      // otherwise submit some ancestor form — we handle it explicitly instead.
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };

    dialogEls.okBtn.addEventListener('click', onOk);
    dialogEls.cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKeydown);

    dialogEls.overlay.classList.add('active');
    if (mode === 'prompt') {
      dialogEls.input.focus();
      dialogEls.input.select();
    } else {
      dialogEls.okBtn.focus();
    }
  });
}

function appAlert(message, title = 'Notice') {
  return showDialog({ title, message, mode: 'alert' });
}

function appConfirm(message, title = 'Please Confirm') {
  return showDialog({ title, message, mode: 'confirm' });
}

function appPrompt(message, defaultValue = '', title = 'Input Needed') {
  return showDialog({ title, message, mode: 'prompt', defaultValue });
}

// --------------------------------------------------------------------------
// Utilities
// --------------------------------------------------------------------------

// Total capital currently committed: open positions (at cost) + pending orders
// (already-filled portion at fill VWAP, plus the still-unfilled portion at planned entry price).
function getCapitalDeployed() {
  const activeCapital = state.activeTrades.reduce(
    (sum, t) => sum + (t.actualPrice * t.shares), 0
  );
  const pendingCapital = state.pendingOrders.reduce((sum, o) => {
    const filled = o.filledShares || 0;
    const unfilled = o.shares - filled;
    const filledCost = o.filledValue || 0;                 // already-spent capital
    const unfilledCost = unfilled * o.plannedEntry;         // capital that WOULD be spent if it fills
    return sum + filledCost + unfilledCost;
  }, 0);
  return activeCapital + pendingCapital;
}

// Returns a finite number, falling back to `fallback` for anything that
// isn't (missing field, corrupted localStorage/import data, NaN, etc.) so a
// bad value can't silently render as "Rs. NaN" throughout the UI.
function sanitizeNumber(value, fallback) {
  const n = parseFloat(value);
  return isFinite(n) ? n : fallback;
}

function formatNPR(value) {
  if (!isFinite(value)) return '0.00';
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

// Sanitize user input to prevent XSS when injecting into innerHTML
function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --------------------------------------------------------------------------
// State Persistence
// --------------------------------------------------------------------------

function exportState() {
  const exportData = {
    exportedAt: new Date().toISOString(),
    appVersion: '2.0.0',
    state
  };
  const json = JSON.stringify(exportData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const today = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nepse-efficient-trader-${today}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importState(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const parsed = JSON.parse(e.target.result);

      // Support both wrapped exports ({ state: {...} }) and raw state objects
      const importedState = parsed.state || parsed;

      if (typeof importedState !== 'object' || importedState === null) {
        throw new Error('Invalid structure');
      }

      // Validate required keys exist (pendingOrders included — it used to be
      // silently defaulted to empty, dropping real orders with no warning)
      const requiredKeys = ['accountValue', 'activeTrades', 'pendingOrders', 'history'];
      const missing = requiredKeys.filter(key => !(key in importedState));
      if (missing.length > 0) {
        throw new Error(`Missing required field(s): ${missing.join(', ')}`);
      }

      // Merge into state with type guards
      state.accountValue = sanitizeNumber(importedState.accountValue, 1000000.00);
      state.stage2IsLeading = importedState.stage2IsLeading === true;

      state.pendingOrders = Array.isArray(importedState.pendingOrders) ? importedState.pendingOrders : [];
      const droppedOrders = state.pendingOrders.filter(o => !isFinite(parseFloat(o?.plannedEntry)) || !isFinite(parseFloat(o?.atr)));
      state.pendingOrders = state.pendingOrders.filter(o => isFinite(parseFloat(o?.plannedEntry)) && isFinite(parseFloat(o?.atr)));
      state.pendingOrders.forEach(o => {
        o.plannedEntry = sanitizeNumber(o.plannedEntry, 0);
        o.atr = sanitizeNumber(o.atr, 0);
        o.plannedStop = sanitizeNumber(o.plannedStop, o.plannedEntry - ATR_MULTIPLIER * o.atr);
        o.shares = sanitizeNumber(o.shares, 0);
        o.filledShares = sanitizeNumber(o.filledShares, 0);
        o.filledValue = sanitizeNumber(o.filledValue, 0);
        o.daysWaiting = sanitizeNumber(o.daysWaiting, 0);
        o.accountValueAtEntry = sanitizeNumber(o.accountValueAtEntry, state.accountValue);
      });

      state.activeTrades = Array.isArray(importedState.activeTrades) ? importedState.activeTrades : [];
      const droppedTrades = state.activeTrades.filter(t => !isFinite(parseFloat(t?.actualPrice)) || !isFinite(parseFloat(t?.shares)));
      state.activeTrades = state.activeTrades.filter(t => isFinite(parseFloat(t?.actualPrice)) && isFinite(parseFloat(t?.shares)));
      state.activeTrades.forEach(t => {
        t.actualPrice = sanitizeNumber(t.actualPrice, 0);
        t.shares = sanitizeNumber(t.shares, 0);
        t.initialAtr = sanitizeNumber(t.initialAtr, 0);
        t.initialStop = sanitizeNumber(t.initialStop, t.actualPrice - ATR_MULTIPLIER * t.initialAtr);
        t.trailingStop = sanitizeNumber(t.trailingStop, t.initialStop);
        t.highestClose = sanitizeNumber(t.highestClose, t.actualPrice);
        t.lastClose = sanitizeNumber(t.lastClose, t.actualPrice);
        t.accountValueAtEntry = sanitizeNumber(t.accountValueAtEntry, state.accountValue);
        if (typeof t.soldShares !== 'number' || !isFinite(t.soldShares)) t.soldShares = 0;
        if (typeof t.soldValue !== 'number' || !isFinite(t.soldValue)) t.soldValue = 0;
      });

      state.history = Array.isArray(importedState.history) ? importedState.history : [];

      state.screenerCandidates = Array.isArray(importedState.screenerCandidates) ? importedState.screenerCandidates : [];
      state.screenerCandidates = state.screenerCandidates
        .filter(c => c && typeof c.ticker === 'string' && c.ticker.trim() !== '')
        .map(c => ({
          ticker: c.ticker.toUpperCase().trim(),
          tt: sanitizeNumber(c.tt, 0),
          rs: sanitizeNumber(c.rs, 0),
          vcp: sanitizeNumber(c.vcp, 0)
        }));

      saveState();

      // Clear stale form inputs so they don't linger with pre-import values
      elements.calcTicker.value = '';
      elements.calcEntry.value = '';
      elements.calcAtr.value = '';
      elements.calcLiquidity.value = '';
      elements.screenerBulkPaste.value = '';
      screenerFilterMode = 'top5';
      elements.routineSelect.value = '';
      elements.routineClose.value = '';
      elements.routineAtr.value = '';

      const droppedCount = droppedOrders.length + droppedTrades.length;
      const droppedNote = droppedCount > 0
        ? `\n\nWarning: ${droppedCount} record(s) had invalid/missing price data and were skipped rather than imported.`
        : '';
      await appAlert(`Import successful! Loaded ${state.pendingOrders.length} pending order(s), ${state.activeTrades.length} active trade(s) and ${state.history.length} history record(s).${droppedNote}`);
    } catch (err) {
      await appAlert(`Import failed: ${err.message}\n\nMake sure you are importing a valid NEPSE Efficient Trader export file.`);
      console.error('Import error:', err);
    } finally {
      // Reset the input so the same file can be re-imported if needed
      event.target.value = '';
    }
  };
  reader.readAsText(file);
}

function saveState() {
  localStorage.setItem('nepse_efficient_trader_state', JSON.stringify(state));
  renderAll();
}

function loadState() {
  const saved = localStorage.getItem('nepse_efficient_trader_state');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed === 'object') {
        state.accountValue = sanitizeNumber(parsed.accountValue, 1000000.00);
        state.stage2IsLeading = parsed.stage2IsLeading === true;

        state.pendingOrders = Array.isArray(parsed.pendingOrders) ? parsed.pendingOrders : [];
        state.pendingOrders.forEach(o => {
          o.plannedEntry = sanitizeNumber(o.plannedEntry, 0);
          o.atr = sanitizeNumber(o.atr, 0);
          o.plannedStop = sanitizeNumber(o.plannedStop, o.plannedEntry - ATR_MULTIPLIER * o.atr);
          o.shares = sanitizeNumber(o.shares, 0);
          o.filledShares = sanitizeNumber(o.filledShares, 0);
          o.filledValue = sanitizeNumber(o.filledValue, 0);
          o.daysWaiting = sanitizeNumber(o.daysWaiting, 0);
          o.accountValueAtEntry = sanitizeNumber(o.accountValueAtEntry, state.accountValue);
        });

        state.activeTrades = Array.isArray(parsed.activeTrades) ? parsed.activeTrades : [];
        state.activeTrades.forEach(t => {
          t.actualPrice = sanitizeNumber(t.actualPrice, 0);
          t.shares = sanitizeNumber(t.shares, 0);
          t.initialAtr = sanitizeNumber(t.initialAtr, 0);
          t.initialStop = sanitizeNumber(t.initialStop, t.actualPrice - ATR_MULTIPLIER * t.initialAtr);
          t.trailingStop = sanitizeNumber(t.trailingStop, t.initialStop);
          t.highestClose = sanitizeNumber(t.highestClose, t.actualPrice);
          t.lastClose = sanitizeNumber(t.lastClose, t.actualPrice);
          t.accountValueAtEntry = sanitizeNumber(t.accountValueAtEntry, state.accountValue);
          if (typeof t.soldShares !== 'number' || !isFinite(t.soldShares)) t.soldShares = 0;
          if (typeof t.soldValue !== 'number' || !isFinite(t.soldValue)) t.soldValue = 0;
        });

        state.history = Array.isArray(parsed.history) ? parsed.history : [];

        state.screenerCandidates = Array.isArray(parsed.screenerCandidates) ? parsed.screenerCandidates : [];
        state.screenerCandidates = state.screenerCandidates
          .filter(c => c && typeof c.ticker === 'string' && c.ticker.trim() !== '')
          .map(c => ({
            ticker: c.ticker.toUpperCase().trim(),
            tt: sanitizeNumber(c.tt, 0),
            rs: sanitizeNumber(c.rs, 0),
            vcp: sanitizeNumber(c.vcp, 0)
          }));
      }
    } catch (e) {
      console.error('Failed to parse saved state:', e);
    }
  }
}

// --------------------------------------------------------------------------
// Bootstrap
// --------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  setupEventListeners();
  renderAll();
});

// --------------------------------------------------------------------------
// Event Listeners
// --------------------------------------------------------------------------

// Converts a pending GTC order's accumulated fills into an active trade,
// using the volume-weighted average price across every partial fill logged.
function convertOrderToActiveTrade(order) {
  const vwap = order.filledValue / order.filledShares;
  const initialStop = vwap - (ATR_MULTIPLIER * order.atr);

  const newTrade = {
    ticker: order.ticker,
    plannedEntry: order.plannedEntry,
    actualPrice: vwap,
    shares: order.filledShares,
    initialAtr: order.atr,
    initialStop,
    trailingStop: initialStop,
    highestClose: vwap,
    lastClose: vwap,
    // Use the account value that was actually used to size this order (captured
    // when it was first placed), not today's value — the share count was fixed
    // against that original sizing, even if this order took several days to fill.
    accountValueAtEntry: order.accountValueAtEntry != null ? order.accountValueAtEntry : state.accountValue,
    entryDate: new Date().toLocaleDateString(),
    soldShares: 0,   // cumulative shares exited so far (for multi-day/illiquid exits)
    soldValue: 0     // cumulative Rs. received so far, for exit VWAP
  };

  state.activeTrades.push(newTrade);
}

function setupEventListeners() {

  // --- Custom number-input spinner buttons (replaces native browser arrows) ---
  // Delegated at document level so it also covers inputs rendered dynamically
  // later (e.g. pending-order rows rebuilt on every renderAll()).
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.spin-btn');
    if (!btn) return;
    const wrap = btn.closest('.number-spin-wrap');
    const input = wrap && wrap.querySelector('input[type="number"]');
    if (!input || input.disabled || input.readOnly) return;

    const step = parseFloat(input.step) || 1;
    const current = parseFloat(input.value);
    let next = (isFinite(current) ? current : 0) + (btn.classList.contains('spin-up') ? step : -step);

    if (input.min !== '' && isFinite(parseFloat(input.min))) next = Math.max(next, parseFloat(input.min));
    if (input.max !== '' && isFinite(parseFloat(input.max))) next = Math.min(next, parseFloat(input.max));

    const decimals = (String(step).split('.')[1] || '').length;
    input.value = next.toFixed(decimals);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // --- Export / Import ---
  elements.exportBtn.addEventListener('click', exportState);
  elements.importBtn.addEventListener('click', () => elements.importFileInput.click());
  elements.importFileInput.addEventListener('change', importState);

  // --- Macro Filter (Step 0) ---
  elements.macroYesBtn.addEventListener('click', () => {
    state.stage2IsLeading = true;
    saveState();
  });

  elements.macroNoBtn.addEventListener('click', async () => {
    state.stage2IsLeading = false;

    // Step 4 cancellation rule #3: the Broad Market Macro Filter failing
    // cancels any outstanding GTC orders. Shares already filled on an order
    // (from partial fills over prior days) are kept as active trades since
    // they're real, owned shares — only the unfilled remainder is dropped.
    if (state.pendingOrders.length > 0) {
      const tickers = state.pendingOrders.map(o => o.ticker);
      state.pendingOrders.forEach(order => {
        if (order.filledShares > 0) convertOrderToActiveTrade(order);
      });
      state.pendingOrders = [];
      saveState();
      await appAlert(`Macro filter failed. Pending GTC order(s) cancelled per strategy rules: ${tickers.join(', ')}`);
      return;
    }

    saveState();
  });

  // --- Screener Shortlist (Step 01) ---
  elements.screenerFilterGroup.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      screenerFilterMode = btn.getAttribute('data-filter');
      renderScreenerTable();
    });
  });
  elements.screenerBulkParseBtn.addEventListener('click', bulkAddScreenerCandidates);

  // --- Account Value Modal ---
  elements.editAccountBtn.addEventListener('click', () => {
    elements.modalAccountValue.value = state.accountValue;
    elements.accountModal.classList.add('active');
  });

  elements.closeAccountModal.addEventListener('click', () => {
    elements.accountModal.classList.remove('active');
  });

  elements.saveAccountBtn.addEventListener('click', () => {
    const val = parseFloat(elements.modalAccountValue.value);
    if (!isNaN(val) && val > 0) {
      state.accountValue = val;
      elements.accountModal.classList.remove('active');
      saveState();
      calculatePosition();
    }
  });

  // --- Reset App Data ---
  elements.resetAppBtn.addEventListener('click', async () => {
    if (await appConfirm('Are you sure you want to reset all data? This will clear your portfolio, scan list, and trading history.')) {
      if (await appConfirm('Double checking: This action CANNOT be undone. Proceed with full reset?')) {
        localStorage.removeItem('nepse_efficient_trader_state');
        state = {
          accountValue: 1000000.00,
          stage2IsLeading: false,
          pendingOrders: [],
          activeTrades: [],
          history: [],
          screenerCandidates: []
        };
        elements.calcTicker.value = '';
        elements.calcEntry.value = '';
        elements.calcAtr.value = '';
        elements.calcLiquidity.value = '';
        elements.screenerBulkPaste.value = '';
        screenerFilterMode = 'top5';
        elements.routineSelect.value = '';
        elements.routineClose.value = '';
        elements.routineAtr.value = '';
        saveState();
        await appAlert('Dashboard has been fully reset to default settings.');
      }
    }
  });

  // --- Calculator ---
  elements.calcTicker.addEventListener('input', () => {
    elements.calcTicker.value = elements.calcTicker.value.toUpperCase();
    calculatePosition();
  });
  elements.calcEntry.addEventListener('input', calculatePosition);
  elements.calcAtr.addEventListener('input', calculatePosition);
  elements.calcLiquidity.addEventListener('input', calculatePosition);

  // --- Step 4: Place GTC Limit Order ---
  elements.executeTradeBtn.addEventListener('click', async () => {
    const ticker = elements.calcTicker.value.trim().toUpperCase();
    const entry = parseFloat(elements.calcEntry.value);
    const atr = parseFloat(elements.calcAtr.value);

    if (!ticker || isNaN(entry) || isNaN(atr)) return;

    // Guard: macro filter
    if (!state.stage2IsLeading) {
      await appAlert('Trading is HALTED. Stage 2 is not the dominant market regime. Enable the Macro Filter first.');
      return;
    }

    // Guard: portfolio slots (count both open positions AND outstanding GTC orders reserved against them)
    const slotsCommitted = state.activeTrades.length + state.pendingOrders.length;
    if (slotsCommitted >= PORTFOLIO_SLOTS) {
      await appAlert(`All ${PORTFOLIO_SLOTS} portfolio slots are filled or reserved by pending GTC orders. Close a position or cancel an order first.`);
      return;
    }

    // Guard: duplicate ticker. Checked before the cash guard below so that if
    // both conditions are true, the person sees the more specific/actionable
    // "already have this ticker" message rather than a misleading cash error.
    if (state.pendingOrders.some(o => o.ticker === ticker) || state.activeTrades.some(t => t.ticker === ticker)) {
      await appAlert(`${ticker} already has a pending order or open position.`);
      return;
    }

    const maxRiskPerPosition = state.accountValue * RISK_PER_POSITION_PCT;
    const plannedStop = entry - (ATR_MULTIPLIER * atr);
    const riskPerShare = entry - plannedStop;
    const size = Math.floor(maxRiskPerPosition / riskPerShare);

    if (size <= 0) return;

    // Guard: available cash (risk-based sizing has no built-in cap on capital deployed,
    // only on total risk — so check we actually have the cash for this position).
    const capitalDeployed = getCapitalDeployed();
    const cashAvailable = state.accountValue - capitalDeployed;
    const requiredCapital = size * entry;
    if (requiredCapital > cashAvailable) {
      const affordableSize = Math.floor(cashAvailable / entry);
      await appAlert(
        `Not enough cash for the full risk-sized position.\n\n` +
        `Required: Rs. ${formatNPR(requiredCapital)} (${size} shares)\n` +
        `Available cash: Rs. ${formatNPR(cashAvailable)}\n\n` +
        (affordableSize > 0
          ? `You could afford ${affordableSize} share(s) with available cash, but that would under-risk this position relative to your 1% target. Consider skipping this trade or freeing up cash first.`
          : `You have no cash available to open this position — a slot is committed but capital is already fully deployed.`)
      );
      return;
    }

    // Step 4: place the GTC limit order (does not fill immediately)
    state.pendingOrders.push({
      ticker,
      plannedEntry: entry,
      atr,
      plannedStop,
      shares: size,          // planned/target quantity
      filledShares: 0,       // cumulative shares actually filled so far (may span multiple days)
      filledValue: 0,        // cumulative price*shares filled so far, for VWAP
      daysWaiting: 0,
      placedDate: new Date().toLocaleDateString(),
      accountValueAtEntry: state.accountValue  // account value used to size this order originally
    });

    // Clear calculator
    elements.calcTicker.value = '';
    elements.calcEntry.value = '';
    elements.calcAtr.value = '';
    elements.calcLiquidity.value = '';
    calculatePosition();
    saveState();

    await appAlert(`Day Order placed: BUY ${size} ${ticker} @ Rs. ${entry.toFixed(2)}, stop Rs. ${plannedStop.toFixed(2)}. It cancels at session end each day — log the close & ATR daily to re-price and resubmit (up to ${MAX_DAY_ORDER_ATTEMPTS} attempts, or until the close breaks the current stop).`);
  });

  // --- Pending Orders: log a trading day, cancel, or mark filled ---
  elements.pendingOrdersList.addEventListener('click', async (e) => {
    const cancelBtn = e.target.closest('.cancel-order-btn');
    const logTodayBtn = e.target.closest('.log-today-btn');

    if (cancelBtn) {
      const idx = parseInt(cancelBtn.getAttribute('data-index'), 10);
      const order = state.pendingOrders[idx];
      if (!order) return;
      const ticker = order.ticker;
      const hasFill = order.filledShares > 0;

      const confirmMsg = hasFill
        ? `${order.filledShares} of ${order.shares} share(s) have already been filled on this order.\n\n` +
          `Cancelling will KEEP the ${order.filledShares} filled share(s) as an active trade (at their VWAP of ` +
          `Rs. ${(order.filledValue / order.filledShares).toFixed(2)}) and drop only the unfilled remainder ` +
          `(${order.shares - order.filledShares}). Continue?`
        : `Cancel the pending order for ${order.ticker}?`;

      if (await appConfirm(confirmMsg)) {
        // Re-resolve by ticker rather than trusting the idx captured before the
        // await — defense-in-depth in case anything ever changes pendingOrders
        // while this confirm is open.
        const currentIdx = state.pendingOrders.findIndex(o => o.ticker === ticker);
        if (currentIdx === -1) return; // already gone (e.g. filled/cancelled elsewhere)
        const currentOrder = state.pendingOrders[currentIdx];
        if (hasFill) convertOrderToActiveTrade(currentOrder);
        state.pendingOrders.splice(currentIdx, 1);
        saveState();
        renderAll();
        if (hasFill) {
          await appAlert(`${currentOrder.ticker}: ${currentOrder.filledShares} filled share(s) moved to Active Trades. Unfilled remainder cancelled.`);
        }
      }
      return;
    }

    if (logTodayBtn) {
      const idx = parseInt(logTodayBtn.getAttribute('data-index'), 10);
      const initialOrder = state.pendingOrders[idx];
      if (!initialOrder) return;
      const ticker = initialOrder.ticker;
      const row = logTodayBtn.closest('.pending-order-card');
      const todayClose = parseFloat(row.querySelector('.pending-close-input').value);
      const todayAtr = parseFloat(row.querySelector('.pending-atr-input').value);
      const fillSharesRaw = row.querySelector('.pending-fill-shares-input').value;
      const fillPriceRaw = row.querySelector('.pending-fill-price-input').value;

      if (isNaN(todayClose) || todayClose <= 0) {
        await appAlert("Enter today's closing price (required every day, whether or not anything filled in your TMS).");
        return;
      }
      if (isNaN(todayAtr) || todayAtr <= 0) {
        await appAlert("Enter today's ATR(14) — needed to re-price tomorrow's order and stop.");
        return;
      }
      if (todayAtr >= todayClose) {
        await appAlert(`ATR (Rs. ${todayAtr.toFixed(2)}) can't be greater than or equal to today's close (Rs. ${todayClose.toFixed(2)}). Double-check which value went in which field.`);
        return;
      }

      // Re-resolve by ticker (not the idx captured before the awaits above) —
      // defense-in-depth in case pendingOrders ever changes underneath this form.
      const currentIdxAtStart = state.pendingOrders.findIndex(o => o.ticker === ticker);
      if (currentIdxAtStart === -1) {
        await appAlert('That order is no longer pending. The list has been refreshed.');
        renderAll();
        return;
      }
      const order = state.pendingOrders[currentIdxAtStart];
      const remaining = order.shares - order.filledShares;
      const loggingAFill = fillSharesRaw.trim() !== '' || fillPriceRaw.trim() !== '';

      // Step 1: if anything filled in your TMS today (against TODAY's order price), record it against the running VWAP
      if (loggingAFill) {
        const fillShares = parseInt(fillSharesRaw, 10);
        const fillPrice = parseFloat(fillPriceRaw);

        if (isNaN(fillShares) || fillShares <= 0 || isNaN(fillPrice) || fillPrice <= 0) {
          await appAlert('Enter both a valid fill quantity and fill price for today (or leave both blank if nothing filled).');
          return;
        }
        if (fillShares > remaining) {
          await appAlert(`Only ${remaining} share(s) remain unfilled on this order — enter ${remaining} or fewer.`);
          return;
        }

        order.filledShares += fillShares;
        order.filledValue += fillPrice * fillShares;

        if (order.filledShares >= order.shares) {
          // Fully filled today (possibly the last of several partial fills) — move to active trade
          convertOrderToActiveTrade(order);
          const idxNow = state.pendingOrders.findIndex(o => o.ticker === ticker);
          if (idxNow !== -1) state.pendingOrders.splice(idxNow, 1);
          saveState();
          await appAlert(`${order.ticker}: fully filled at a VWAP of Rs. ${(order.filledValue / order.filledShares).toFixed(2)}. Moved to Active Trades.`);
          return;
        }
      }

      // Step 2: cancellation rule 1 — today's close dropped below TODAY's stop (the one set yesterday)
      if (todayClose < order.plannedStop) {
        const hadFill = order.filledShares > 0;
        if (hadFill) convertOrderToActiveTrade(order);
        const idxNow = state.pendingOrders.findIndex(o => o.ticker === ticker);
        if (idxNow !== -1) state.pendingOrders.splice(idxNow, 1);
        saveState();
        await appAlert(
          `${order.ticker}: close (Rs. ${todayClose.toFixed(2)}) fell below today's stop (Rs. ${order.plannedStop.toFixed(2)}).\n\n` +
          (hadFill
            ? `${order.filledShares} share(s) already filled were converted into an active trade at their VWAP. The unfilled remainder (${order.shares - order.filledShares}) is cancelled.`
            : `No shares had been filled — order cancelled per strategy rules.`)
        );
        return;
      }

      // Step 3: this counts as one trading day, whether or not a fill happened
      order.daysWaiting += 1;

      // Cancellation rule 2 — day-order attempts capped at 5 trading days total
      if (order.daysWaiting >= MAX_DAY_ORDER_ATTEMPTS) {
        const hadFill = order.filledShares > 0;
        if (hadFill) convertOrderToActiveTrade(order);
        const idxNow = state.pendingOrders.findIndex(o => o.ticker === ticker);
        if (idxNow !== -1) state.pendingOrders.splice(idxNow, 1);
        saveState();
        await appAlert(
          `${order.ticker}: order window closed after ${MAX_DAY_ORDER_ATTEMPTS} trading days.\n\n` +
          (hadFill
            ? `${order.filledShares} of ${order.shares} planned shares were filled and converted into an active trade at their VWAP. The unfilled remainder is cancelled.`
            : `Nothing was filled — order cancelled per strategy rules.`)
        );
        return;
      }

      // Step 4: no breach, still within the window — roll forward to tomorrow's day-order.
      // New price = today's close. New stop = new price − 2.5×today's ATR. Risk-per-share is
      // always 2.5×ATR by construction, so the target share count only depends on ATR, not price —
      // it's recomputed fresh each day so the 1%-of-account risk promise stays accurate no matter
      // how many days this takes to fill.
      const maxRiskPerPosition = state.accountValue * RISK_PER_POSITION_PCT;
      const newStop = todayClose - (ATR_MULTIPLIER * todayAtr);
      const newRiskPerShare = todayClose - newStop; // == ATR_MULTIPLIER * todayAtr
      let newTargetShares = Math.floor(maxRiskPerPosition / newRiskPerShare);

      // Cash guard: a re-price can raise the target size (e.g. ATR shrank), but nothing
      // re-checks that cash is actually available for the larger size — so successive
      // re-prices across multiple pending orders could quietly commit more capital than
      // exists. Cap the target to what's actually affordable, same as initial placement.
      const otherCapitalDeployed = getCapitalDeployed() - (
        order.filledValue + (order.shares - order.filledShares) * order.plannedEntry
      );
      const cashAvailableForThisOrder = state.accountValue - otherCapitalDeployed - order.filledValue;
      const affordableNewShares = order.filledShares + Math.floor(cashAvailableForThisOrder / todayClose);
      let cappedByCash = false;
      if (newTargetShares > affordableNewShares) {
        newTargetShares = Math.max(affordableNewShares, order.filledShares);
        cappedByCash = true;
      }

      order.plannedEntry = todayClose;
      order.atr = todayAtr;
      order.plannedStop = newStop;

      if (newTargetShares <= 0 && order.filledShares === 0) {
        // Today's ATR is too large relative to the 1% risk budget to size any shares at all —
        // nothing to convert (nothing filled), so cancel outright rather than leave a frozen
        // 0-share order sitting in the list forever.
        const idxNow = state.pendingOrders.findIndex(o => o.ticker === ticker);
        if (idxNow !== -1) state.pendingOrders.splice(idxNow, 1);
        saveState();
        await appAlert(
          cappedByCash
            ? `${order.ticker}: no cash available to size any shares for this order. Order cancelled.`
            : `${order.ticker}: today's ATR is too large to size any shares within the 1% risk budget. Order cancelled.`
        );
        return;
      }

      // Below the practical minimum lot size but not zero — same rule the initial
      // placement calculator enforces (odd lots under MIN_LOT_SIZE aren't recommended).
      // Nothing has filled yet, so there's nothing to preserve; cancel outright rather
      // than silently letting a re-price roll the order into an unbuyable lot size.
      if (newTargetShares > 0 && newTargetShares < MIN_LOT_SIZE && order.filledShares === 0) {
        const idxNow = state.pendingOrders.findIndex(o => o.ticker === ticker);
        if (idxNow !== -1) state.pendingOrders.splice(idxNow, 1);
        saveState();
        await appAlert(
          `${order.ticker}: today's re-priced risk math only supports ${newTargetShares} share(s), below the ${MIN_LOT_SIZE}-share practical minimum. Order cancelled.`
        );
        return;
      }

      if (newTargetShares <= order.filledShares && order.filledShares > 0) {
        // Updated risk math says you already hold at (or above) today's target size —
        // stop trying to buy more; take what you have.
        convertOrderToActiveTrade(order);
        const idxNow = state.pendingOrders.findIndex(o => o.ticker === ticker);
        if (idxNow !== -1) state.pendingOrders.splice(idxNow, 1);
        saveState();
        await appAlert(`${order.ticker}: today's re-priced risk math caps the target at ${newTargetShares} share(s), which you've already filled. Order completed and moved to Active Trades.`);
        return;
      }

      order.shares = Math.max(newTargetShares, order.filledShares);
      // Keep the risk-tracking basis in sync with what actually sized the order today —
      // otherwise "Actual Risk %" shown later on the active trade / history would be
      // computed against a stale account value from the original placement day, even
      // though the share count above was just resized against TODAY's account value.
      order.accountValueAtEntry = state.accountValue;
      saveState();
      await appAlert(
        `${order.ticker}: rolled forward for tomorrow — new order: BUY ${order.shares - order.filledShares} @ Rs. ${todayClose.toFixed(2)}, ` +
        `stop Rs. ${newStop.toFixed(2)} (${MAX_DAY_ORDER_ATTEMPTS - order.daysWaiting} day(s) left in the window).` +
        (cappedByCash
          ? `\n\nNote: today's risk math targeted a larger size, but available cash capped it at ${order.shares} share(s) to avoid over-committing capital.`
          : '')
      );
    }
  });

  // --- Daily Routine ---
  elements.routineSelect.addEventListener('change', () => {
    const ticker = elements.routineSelect.value;
    const trade = ticker !== '' ? findActiveTradeByTicker(ticker) : null;
    if (trade) {
      elements.routineClose.value = trade.lastClose.toFixed(2);
      elements.routineAtr.value = (trade.lastAtr != null ? trade.lastAtr : trade.initialAtr).toFixed(2);
      elements.routineClose.disabled = false;
      elements.routineAtr.disabled = false;
      elements.routineSubmitBtn.disabled = false;
    } else {
      elements.routineClose.value = '';
      elements.routineAtr.value = '';
      elements.routineClose.disabled = true;
      elements.routineAtr.disabled = true;
      elements.routineSubmitBtn.disabled = true;
    }
  });

  elements.routineForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ticker = elements.routineSelect.value;
    const todayClose = parseFloat(elements.routineClose.value);
    const todayAtr = parseFloat(elements.routineAtr.value);

    if (ticker === '' || isNaN(todayClose) || isNaN(todayAtr) || todayClose <= 0 || todayAtr <= 0) {
      await appAlert('Please provide valid daily inputs.');
      return;
    }

    const trade = findActiveTradeByTicker(ticker);
    if (!trade) {
      // The trade was sold/removed while this form was open — refresh and stop.
      await appAlert('That trade is no longer open. The form has been refreshed.');
      renderAll();
      return;
    }

    // Sanity guard: ATR should never realistically exceed the closing price
    // itself. A fat-fingered entry here (e.g. price typed into the ATR field)
    // would otherwise collapse the trailing stop toward zero and silently
    // disable the exit signal.
    if (todayAtr >= todayClose) {
      await appAlert(`ATR (Rs. ${todayAtr.toFixed(2)}) can't be greater than or equal to today's close (Rs. ${todayClose.toFixed(2)}). Double-check which value went in which field.`);
      return;
    }

    // Step 6: Update highest close since entry
    trade.highestClose = Math.max(trade.highestClose, todayClose);
    trade.lastClose = todayClose;

    // Candidate Stop = Highest Close Since Entry − (2.5 × ATR)
    const candidateStop = trade.highestClose - (ATR_MULTIPLIER * todayAtr);

    // Trailing Stop = MAX(Previous Stop, Candidate Stop) — never moves lower
    trade.trailingStop = Math.max(trade.trailingStop, candidateStop);
    trade.lastAtr = todayAtr;
    trade.lastUpdatedDate = new Date().toLocaleDateString();

    saveState();

    // Reset form
    elements.routineSelect.value = '';
    elements.routineClose.value = '';
    elements.routineAtr.value = '';
    elements.routineClose.disabled = true;
    elements.routineAtr.disabled = true;
    elements.routineSubmitBtn.disabled = true;
  });
}

// --------------------------------------------------------------------------
// Position Size Calculator
// --------------------------------------------------------------------------

// Parses turnover figures out of either:
//  (a) a raw paste straight off NepseAlpha's rotation table, e.g.
//      "197 21.90 Lac.	154 43.96 Lac.	104 77.45 Lac.	68 1.31 Cr."
//      — each cell is "<rank> <amount> <unit>"; rank numbers are ignored,
//      and Cr. values are converted to their Lac. equivalent (1 Cr. = 100 Lac.)
//  (b) plain comma-separated numbers assumed to already be in Lac., e.g.
//      "77.45, 84.17, 67.09" — kept for backward compatibility / manual entry
// Returns { avg, min, max, count } in raw NPR, or null if nothing usable found.
function parseLiquidityStats(rawText) {
  if (!rawText || !rawText.trim()) return null;

  // Try the "<amount> <unit>" pattern first — this is what a direct paste
  // from the site looks like, and correctly skips over the leading rank
  // numbers since they aren't followed by Lac./Cr.
  const unitPattern = /(\d+(?:\.\d+)?)\s*(Lac\.?|Cr\.?|Crore)/gi;
  const unitMatches = [...rawText.matchAll(unitPattern)];

  let values;
  if (unitMatches.length > 0) {
    values = unitMatches.map(m => {
      const amount = parseFloat(m[1]);
      const isCrore = /^Cr/i.test(m[2]);
      return isCrore ? amount * 100 : amount; // normalize everything to Lac.
    });
  } else {
    // Fallback: plain comma-separated numbers, assumed to already be in Lac.
    values = rawText.split(',').map(s => parseFloat(s.trim()));
  }

  values = values.filter(n => isFinite(n) && n > 0).map(lac => lac * 100000); // Lac. -> raw NPR
  if (values.length === 0) return null;

  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { avg, min, max, count: values.length };
}

function calculatePosition() {
  const ticker = elements.calcTicker.value.trim();
  const entry = parseFloat(elements.calcEntry.value);
  const atr = parseFloat(elements.calcAtr.value);

  const slotsCommitted = state.activeTrades.length + state.pendingOrders.length;
  const slotsAvailable = slotsCommitted < PORTFOLIO_SLOTS;
  const macroOk = state.stage2IsLeading;

  // Show/hide slots-full warning
  elements.slotsFullWarning.style.display = (!slotsAvailable) ? 'flex' : 'none';

  if (!ticker || isNaN(entry) || isNaN(atr) || entry <= 0 || atr <= 0) {
    elements.resPlannedRisk.textContent = 'Rs. 0.00';
    elements.resInitialStop.textContent = 'Rs. 0.00';
    elements.resRiskPerShare.textContent = 'Rs. 0.00';
    elements.resPositionSize.textContent = '0 Shares';
    elements.resPositionSize.style.color = '';
    elements.resCapitalCheck.textContent = 'Rs. 0.00 / Rs. 0.00';
    elements.resCapitalCheck.style.color = '';
    elements.capitalPctTile.style.display = 'none';
    elements.liquidityCheckTile.style.display = 'none';
    elements.executeTradeBtn.disabled = true;
    return;
  }

  const maxRiskPerPosition = state.accountValue * RISK_PER_POSITION_PCT;
  const plannedStop = entry - (ATR_MULTIPLIER * atr);
  const riskPerShare = entry - plannedStop;

  elements.resPlannedRisk.textContent = `Rs. ${formatNPR(maxRiskPerPosition)}`;

  if (plannedStop <= 0) {
    elements.resInitialStop.textContent = 'Rs. 0.00 (ATR too high)';
    elements.resRiskPerShare.textContent = 'N/A';
    elements.resPositionSize.textContent = '0 Shares';
    elements.resPositionSize.style.color = '';
    elements.resCapitalCheck.textContent = 'Rs. 0.00 / Rs. 0.00';
    elements.resCapitalCheck.style.color = '';
    elements.capitalPctTile.style.display = 'none';
    elements.liquidityCheckTile.style.display = 'none';
    elements.executeTradeBtn.disabled = true;
    return;
  }

  elements.resInitialStop.textContent = `Rs. ${formatNPR(plannedStop)}`;
  elements.resRiskPerShare.textContent = `Rs. ${formatNPR(riskPerShare)}`;

  const positionSize = Math.floor(maxRiskPerPosition / riskPerShare);

  if (positionSize > 0) {
    const belowMinLot = positionSize < MIN_LOT_SIZE;
    elements.resPositionSize.textContent = belowMinLot
      ? `${positionSize} Shares — below ${MIN_LOT_SIZE}-share minimum, don't buy`
      : `${positionSize} Shares`;
    elements.resPositionSize.style.color = belowMinLot ? 'var(--color-danger)' : '';

    // Capital availability check (risk-based sizing has no built-in cap on capital deployed)
    const capitalDeployed = getCapitalDeployed();
    const cashAvailable = state.accountValue - capitalDeployed;
    const requiredCapital = positionSize * entry;
    const cashOk = requiredCapital <= cashAvailable;

    elements.resCapitalCheck.textContent = `Rs. ${formatNPR(requiredCapital)} / Rs. ${formatNPR(cashAvailable)}`;
    elements.resCapitalCheck.style.color = cashOk ? '' : 'var(--color-danger)';

    // Capital concentration check — advisory only. A fixed 1% risk allocation does NOT
    // imply a fixed capital allocation: low-ATR, high-price stocks can consume a large
    // share of account capital for the same 1% risk. Flag it so it's a conscious choice
    // rather than something only discovered when the cash guard blocks a later trade.
    const capitalPct = (requiredCapital / state.accountValue) * 100;
    let capitalPctColor = 'var(--color-primary)'; // green
    let capitalPctLabel = '';
    if (capitalPct > 40) {
      capitalPctColor = 'var(--color-danger)'; // red
      capitalPctLabel = ' — very capital-heavy for one position';
    } else if (capitalPct > 20) {
      capitalPctColor = 'var(--color-accent)'; // amber
      capitalPctLabel = ' — capital-heavy relative to a typical 1/5 slot';
    }
    elements.resCapitalPct.textContent = `${capitalPct.toFixed(1)}%${capitalPctLabel}`;
    elements.resCapitalPct.style.color = capitalPctColor;
    elements.capitalPctTile.style.display = '';

    // Liquidity check — advisory only, never affects whether the order can be placed
    const liquidity = parseLiquidityStats(elements.calcLiquidity.value);
    if (liquidity) {
      const pctOfAdv = (requiredCapital / liquidity.avg) * 100;
      let color = 'var(--color-primary)'; // green
      let label = 'Comfortable';
      if (pctOfAdv > 15) {
        color = 'var(--color-danger)'; // red
        label = 'Thin — likely to move price';
      } else if (pctOfAdv > 10) {
        color = 'var(--color-accent)'; // amber (theme's brass gold)
        label = 'Borderline';
      }

      // Flag inconsistent turnover separately from the average itself —
      // a wide day-to-day swing is its own risk even if the average looks fine.
      const swingRatio = liquidity.min > 0 ? liquidity.max / liquidity.min : Infinity;
      const stabilityNote = swingRatio > 3 ? ' — unstable volume' : '';

      elements.resLiquidityCheck.textContent = `${pctOfAdv.toFixed(1)}% of ADV (${label}${stabilityNote}, n=${liquidity.count})`;
      elements.resLiquidityCheck.style.color = color;
      elements.liquidityCheckTile.style.display = '';
    } else {
      elements.liquidityCheckTile.style.display = 'none';
    }

    // Only enable placing the GTC order if macro filter passes AND slots are available AND
    // cash is sufficient AND the position clears the practical minimum lot size
    elements.executeTradeBtn.disabled = !macroOk || !slotsAvailable || !cashOk || belowMinLot;
  } else {
    elements.resPositionSize.textContent = '0 Shares (Risk per share too high)';
    elements.resPositionSize.style.color = '';
    elements.resCapitalCheck.textContent = 'Rs. 0.00 / Rs. 0.00';
    elements.capitalPctTile.style.display = 'none';
    elements.liquidityCheckTile.style.display = 'none';
    elements.executeTradeBtn.disabled = true;
  }
}

// --------------------------------------------------------------------------
// Render Functions
// --------------------------------------------------------------------------

function renderAll() {
  renderMacroFilter();
  renderHeader();
  renderScreenerTable();
  renderPendingOrders();
  renderActiveTrades();
  renderDailyRoutineDropdown();
  renderHistory();
  calculatePosition(); // Refresh calculator state/buttons
}

// --------------------------------------------------------------------------
// Screener Shortlist (Step 01)
// Gate: Trend Template Score AND RS Score must both clear their thresholds.
// Passers are ranked RS descending (leadership strength, Minervini's primary
// quality signal), with VCP Pattern Score descending as a tiebreaker (base
// tightness = timing quality, not overall priority). VCP is never the gate
// and never the primary sort key.
// --------------------------------------------------------------------------

// Parses rows copy-pasted from NepseAlpha's screener table. Expected column
// order per row: Symbol, Final Score, Trend Template Score, VCP Pattern
// Score, EPS Growth Score, Sales Growth Score, Margin Score, RS Score —
// matching the table exactly as it appears on-screen (8 fields total).
// Only Trend Template, VCP, and RS are kept; Final/EPS/Sales/Margin are
// parsed just to correctly locate RS at the end of the row, then discarded.
// Tolerant of tab-separated or multi-space-separated paste, and silently
// skips header rows / malformed lines rather than throwing.
// Flattens pasted text into a single stream of tokens, regardless of whether
// each row is on one line (tab or space separated) or each individual field
// is on its own line (NepseAlpha's actual copy behavior — Symbol, then each
// of the 7 scores, one per line, repeating per stock).
function tokenizePastedScreenerText(text) {
  const tokens = [];
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    trimmed.split(/\t+|\s+/).forEach((part) => {
      const p = part.trim();
      if (p !== '') tokens.push(p);
    });
  });
  return tokens;
}

function isNumericScoreToken(t) {
  const cleaned = t.replace(/[^0-9.\-]/g, '');
  return cleaned !== '' && cleaned !== '-' && cleaned !== '.' && /^-?\d+(\.\d+)?$/.test(cleaned) && isFinite(parseFloat(cleaned));
}

// Scans the token stream for the pattern: Symbol, Final, TrendTemplate, VCP,
// EPS, Sales, Margin, RS (8 tokens per stock). Works whether that pattern
// arrived as one row per line or one field per line, since both collapse to
// the same flat token stream. Anything that doesn't fit the pattern (header
// words, stray text) is skipped rather than aborting the whole paste.
function parsePastedScreenerText(text) {
  const tokens = tokenizePastedScreenerText(text);
  const results = [];
  let skippedCount = 0;
  let i = 0;

  while (i < tokens.length) {
    const symbolCandidate = tokens[i];
    const looksLikeSymbol = !isNumericScoreToken(symbolCandidate) && /^[A-Za-z][A-Za-z0-9]{1,9}$/.test(symbolCandidate);

    if (looksLikeSymbol && i + 7 < tokens.length) {
      const window = tokens.slice(i + 1, i + 8);
      if (window.every(isNumericScoreToken)) {
        const nums = window.map(t => parseFloat(t.replace(/[^0-9.\-]/g, '')));
        const [, tt, vcp, , , , rs] = nums; // final, tt, vcp, eps, sales, margin, rs
        results.push({ ticker: symbolCandidate.toUpperCase(), tt, vcp, rs });
        i += 8;
        continue;
      }
    }

    skippedCount++;
    i += 1;
  }

  const skipped = skippedCount > 0 ? [`${skippedCount} unmatched token(s) ignored (likely headers/labels)`] : [];
  return { results, skipped };
}

function bulkAddScreenerCandidates() {
  const raw = elements.screenerBulkPaste.value;
  if (!raw || !raw.trim()) {
    appAlert('Paste some screener rows first.');
    return;
  }

  const { results, skipped } = parsePastedScreenerText(raw);

  if (results.length === 0) {
    appAlert('No valid rows found. Expected: Symbol, Final, Trend Template, VCP, EPS, Sales, Margin, RS — tab or space separated, one row per line.');
    return;
  }

  // A fresh paste replaces the entire shortlist rather than merging with
  // whatever was there before — each paste is treated as this session's
  // full, current screener snapshot.
  state.screenerCandidates = results;

  elements.screenerBulkPaste.value = '';
  saveState();

  const skippedNote = skipped.length > 0
    ? `\n\n${skipped.length} row(s) skipped (headers or malformed): ${skipped.slice(0, 3).join(' | ')}${skipped.length > 3 ? '…' : ''}`
    : '';
  appAlert(`Shortlist replaced with ${results.length} candidate(s).${skippedNote}`);
}

function removeScreenerCandidate(ticker) {
  state.screenerCandidates = state.screenerCandidates.filter(c => c.ticker !== ticker);
  saveState();
}

function useScreenerCandidate(ticker) {
  elements.calcTicker.value = ticker;
  calculatePosition();
  elements.calcTicker.scrollIntoView({ behavior: 'smooth', block: 'center' });
  elements.calcEntry.focus();
}

// VCP Pattern Score isn't a gate or a primary rank — it's an entry-timing
// read: has this already-qualified, already-ranked stock actually formed a
// tight base yet, or is it still extended/choppy with no clean setup?
function getVcpFlag(vcp) {
  if (vcp < 50) return { label: 'No Base Yet', cls: 'low' };
  if (vcp < 75) return { label: 'Forming', cls: 'mid' };
  return { label: 'Tight Base', cls: 'high' };
}

function renderScreenerTable() {
  elements.screenerThresholdLabel.textContent = `${SCREENER_TT_THRESHOLD}`;
  elements.screenerList.innerHTML = '';

  // Reflect the active filter mode on the toggle buttons
  elements.screenerFilterGroup.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-filter') === screenerFilterMode);
  });

  if (state.screenerCandidates.length === 0) {
    elements.screenerList.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">No candidates entered yet.</td>
      </tr>
    `;
    elements.screenerSummary.textContent = '';
    return;
  }

  // Passers (TT & RS both clear threshold) are ranked RS descending first —
  // RS Rating is Minervini's leadership/strength ranking among qualified
  // stocks. VCP Pattern Score is used only as a tiebreaker: among stocks of
  // equal leadership strength, the one with the tighter/cleaner base is the
  // more actionable entry right now. VCP is never the primary sort — it's a
  // timing/base-quality check, not a strength ranking.
  const allPassers = state.screenerCandidates
    .filter(c => c.tt >= SCREENER_TT_THRESHOLD && c.rs >= SCREENER_RS_THRESHOLD)
    .sort((a, b) => (b.rs - a.rs) || (b.vcp - a.vcp));
  const allFailers = state.screenerCandidates
    .filter(c => !(c.tt >= SCREENER_TT_THRESHOLD && c.rs >= SCREENER_RS_THRESHOLD))
    .sort((a, b) => (b.rs - a.rs) || (b.vcp - a.vcp));

  let shown = [];
  let summaryText = '';

  if (screenerFilterMode === 'top5') {
    shown = allPassers.slice(0, SCREENER_TOP_N);
    const hiddenPasserCount = allPassers.length - shown.length;
    const parts = [];
    if (hiddenPasserCount > 0) parts.push(`${hiddenPasserCount} more passing candidate(s) ranked below the top ${SCREENER_TOP_N}`);
    if (allFailers.length > 0) parts.push(`${allFailers.length} candidate(s) failed the gate`);
    summaryText = parts.join(' · ');
  } else if (screenerFilterMode === 'passing') {
    shown = allPassers;
    summaryText = allFailers.length > 0 ? `${allFailers.length} candidate(s) failed the gate (hidden)` : '';
  } else if (screenerFilterMode === 'failing') {
    shown = allFailers;
    summaryText = allPassers.length > 0 ? `${allPassers.length} candidate(s) passed the gate (hidden)` : '';
  } else {
    // 'all'
    shown = [...allPassers, ...allFailers];
    summaryText = '';
  }

  if (shown.length === 0) {
    const emptyMsg = screenerFilterMode === 'failing'
      ? 'No candidates are currently failing the gate.'
      : 'No candidates currently pass the Trend Template &amp; RS gate.';
    elements.screenerList.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">${emptyMsg}</td>
      </tr>
    `;
  } else {
    shown.forEach((c) => {
      const passes = c.tt >= SCREENER_TT_THRESHOLD && c.rs >= SCREENER_RS_THRESHOLD;
      const vcpFlag = getVcpFlag(c.vcp);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHTML(c.ticker)}</strong></td>
        <td>${c.tt}</td>
        <td>${c.rs}</td>
        <td>${c.vcp}<span class="vcp-flag ${vcpFlag.cls}">${vcpFlag.label}</span></td>
        <td><span class="gate-badge ${passes ? 'pass' : 'fail'}">${passes ? 'PASS' : 'FAIL'}</span></td>
        <td style="display:flex; gap:0.4rem; align-items:center; justify-content:flex-end;">
          ${passes ? `<button class="screener-use-btn" data-ticker="${escapeHTML(c.ticker)}"><i class="fa-solid fa-arrow-right"></i> Use</button>` : ''}
          <button class="screener-row-remove" data-remove="${escapeHTML(c.ticker)}" title="Remove"><i class="fa-solid fa-xmark"></i></button>
        </td>
      `;
      elements.screenerList.appendChild(tr);
    });
  }

  elements.screenerSummary.textContent = summaryText;

  elements.screenerList.querySelectorAll('.screener-use-btn').forEach(btn => {
    btn.addEventListener('click', (e) => useScreenerCandidate(e.currentTarget.getAttribute('data-ticker')));
  });
  elements.screenerList.querySelectorAll('.screener-row-remove').forEach(btn => {
    btn.addEventListener('click', (e) => removeScreenerCandidate(e.currentTarget.getAttribute('data-remove')));
  });
}

function renderMacroFilter() {
  const leading = state.stage2IsLeading;

  if (leading) {
    elements.macroYesBtn.classList.add('active-yes');
    elements.macroYesBtn.classList.remove('active-no');
    elements.macroNoBtn.classList.remove('active-no');
    elements.macroNoBtn.classList.add('inactive-btn');
    elements.macroStatusText.innerHTML = '<i class="fa-solid fa-circle-check"></i> Stage 2 is dominant. Market conditions favour trend-following trades.';
    elements.macroStatusText.className = 'macro-status-text clear';
    elements.haltBanner.style.display = 'none';
  } else {
    elements.macroNoBtn.classList.add('active-no');
    elements.macroNoBtn.classList.remove('inactive-btn');
    elements.macroYesBtn.classList.remove('active-yes');
    elements.macroYesBtn.classList.add('inactive-btn');
    elements.macroStatusText.innerHTML = '<i class="fa-solid fa-ban"></i> Market regime does not favour trading. Stay in cash.';
    elements.macroStatusText.className = 'macro-status-text halted';
    elements.haltBanner.style.display = 'flex';
  }
}

function renderHeader() {
  elements.headerAccountValue.textContent = formatNPR(state.accountValue);

  // Slots badge (open positions + reserved GTC orders)
  const used = state.activeTrades.length + state.pendingOrders.length;
  elements.headerSlotsCount.textContent = `${used} / ${PORTFOLIO_SLOTS}`;
  elements.headerSlotsCount.className = used >= PORTFOLIO_SLOTS
    ? 'slots-badge slots-full'
    : used > 0
      ? 'slots-badge slots-partial'
      : 'slots-badge';

  // Strategy state
  if (state.activeTrades.length > 0) {
    elements.strategyState.textContent = `INVESTED (${state.activeTrades.length} ACTIVE)`;
    elements.strategyState.className = 'state-badge invested';
  } else {
    elements.strategyState.textContent = 'CASH (100% FREE)';
    elements.strategyState.className = 'state-badge cash';
  }
}

function renderPendingOrders() {
  // A saveState() elsewhere (e.g. logging a different order) rebuilds this whole
  // list. Capture whatever the user was mid-typing in each card first, keyed by
  // ticker, so it isn't silently wiped out from underneath them.
  const preserved = {};
  elements.pendingOrdersList.querySelectorAll('.pending-order-card').forEach(card => {
    const ticker = card.querySelector('h3')?.textContent;
    if (!ticker) return;
    preserved[ticker] = {
      close: card.querySelector('.pending-close-input')?.value || '',
      atr: card.querySelector('.pending-atr-input')?.value || '',
      fillShares: card.querySelector('.pending-fill-shares-input')?.value || '',
      fillPrice: card.querySelector('.pending-fill-price-input')?.value || ''
    };
  });

  elements.pendingOrdersList.innerHTML = '';
  elements.pendingOrdersCount.textContent = `${state.pendingOrders.length} / ${PORTFOLIO_SLOTS} Reserved`;

  if (state.pendingOrders.length === 0) {
    elements.pendingOrdersList.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-clock"></i>
        <p>No outstanding orders. Use the calculator to place one.</p>
      </div>
    `;
    return;
  }

  state.pendingOrders.forEach((order, idx) => {
    const daysLeft = MAX_DAY_ORDER_ATTEMPTS - order.daysWaiting;
    const hasPartialFill = order.filledShares > 0;
    const card = document.createElement('div');
    card.className = 'trade-card pending-order-card';

    card.innerHTML = `
      <div class="trade-card-header">
        <div class="trade-card-title">
          <h3>${escapeHTML(order.ticker)}</h3>
          <span class="shares-badge">${order.shares} Shares Target</span>
          ${hasPartialFill ? `<span class="risk-badge-mini" title="Filled so far via partial fills"><i class="fa-solid fa-layer-group"></i> ${order.filledShares}/${order.shares} filled</span>` : ''}
          <span class="risk-badge-mini" title="Day-order attempts remaining before the window closes">
            <i class="fa-solid fa-hourglass-half"></i> ${daysLeft} day${daysLeft === 1 ? '' : 's'} left
          </span>
        </div>
      </div>

      <div class="trade-card-grid">
        <div>
          <span class="card-grid-lbl">Today's Order Price</span>
          <span class="card-grid-val">Rs. ${formatNPR(order.plannedEntry)}</span>
        </div>
        <div>
          <span class="card-grid-lbl">Today's Stop</span>
          <span class="card-grid-val" style="color: var(--color-accent);">Rs. ${formatNPR(order.plannedStop)}</span>
        </div>
        <div>
          <span class="card-grid-lbl">First Placed On</span>
          <span class="card-grid-val">${order.placedDate}</span>
        </div>
      </div>

      <p style="font-size: 0.7rem; color: var(--text-secondary); margin: 0.5rem 0 0;">
        Day order — cancels at session end. Log today's close &amp; ATR below to re-price and resubmit for tomorrow.
      </p>

      <div class="form-grid" style="margin-top: 0.5rem;">
        <div class="input-group">
          <label>Today's Close (required)</label>
          <div class="input-wrapper number-spin-wrap">
            <span class="input-prefix">Rs.</span>
            <input type="number" class="pending-close-input" placeholder="0.00" step="0.01">
            <div class="spin-buttons">
              <button type="button" class="spin-btn spin-up" tabindex="-1" aria-label="Increase"></button>
              <button type="button" class="spin-btn spin-down" tabindex="-1" aria-label="Decrease"></button>
            </div>
          </div>
        </div>
        <div class="input-group">
          <label>Today's ATR(14) (required)</label>
          <div class="input-wrapper number-spin-wrap">
            <input type="number" class="pending-atr-input" placeholder="0.00" step="0.01">
            <div class="spin-buttons">
              <button type="button" class="spin-btn spin-up" tabindex="-1" aria-label="Increase"></button>
              <button type="button" class="spin-btn spin-down" tabindex="-1" aria-label="Decrease"></button>
            </div>
          </div>
        </div>
        <div class="input-group">
          <label>Shares Filled Today (leave blank if none)</label>
          <div class="input-wrapper number-spin-wrap">
            <input type="number" class="pending-fill-shares-input" placeholder="0" step="1" max="${order.shares - order.filledShares}">
            <div class="spin-buttons">
              <button type="button" class="spin-btn spin-up" tabindex="-1" aria-label="Increase"></button>
              <button type="button" class="spin-btn spin-down" tabindex="-1" aria-label="Decrease"></button>
            </div>
          </div>
        </div>
        <div class="input-group">
          <label>Fill Price (if any filled today)</label>
          <div class="input-wrapper number-spin-wrap">
            <span class="input-prefix">Rs.</span>
            <input type="number" class="pending-fill-price-input" placeholder="0.00" step="0.01">
            <div class="spin-buttons">
              <button type="button" class="spin-btn spin-up" tabindex="-1" aria-label="Increase"></button>
              <button type="button" class="spin-btn spin-down" tabindex="-1" aria-label="Decrease"></button>
            </div>
          </div>
        </div>
      </div>

      <div class="trade-card-footer">
        <button class="btn btn-success log-today-btn" style="padding: 0.4rem 0.8rem; font-size: 0.75rem;" data-index="${idx}">
          <i class="fa-solid fa-calendar-check"></i> Log Today &amp; Re-Price
        </button>
        <button class="btn btn-secondary btn-danger-action cancel-order-btn" style="padding: 0.4rem 0.8rem; font-size: 0.75rem;" data-index="${idx}">
          <i class="fa-solid fa-xmark"></i> Cancel
        </button>
      </div>
    `;

    elements.pendingOrdersList.appendChild(card);

    // Restore anything the user had mid-typed for this ticker before the rebuild
    const saved = preserved[order.ticker];
    if (saved) {
      card.querySelector('.pending-close-input').value = saved.close;
      card.querySelector('.pending-atr-input').value = saved.atr;
      card.querySelector('.pending-fill-shares-input').value = saved.fillShares;
      card.querySelector('.pending-fill-price-input').value = saved.fillPrice;
    }
  });
}

function renderActiveTrades() {
  elements.portfolioList.innerHTML = '';
  elements.activeTradesCount.textContent = `${state.activeTrades.length} / ${PORTFOLIO_SLOTS} Open`;

  if (state.activeTrades.length === 0) {
    elements.portfolioList.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-wallet"></i>
        <p>No active trades. Scan and compute position sizes to start trading.</p>
      </div>
    `;
    return;
  }

  state.activeTrades.forEach((trade, idx) => {
    const currentPrice = trade.lastClose || trade.actualPrice;
    const totalCost = trade.actualPrice * trade.shares;
    const currentVal = currentPrice * trade.shares;
    const pnl = currentVal - totalCost;
    const pnlPct = (pnl / totalCost) * 100;

    // Step 7: exit if last close is below trailing stop
    const isExitRequired = (trade.lastClose || trade.actualPrice) < trade.trailingStop;

    // Actual risk % relative to account value at entry
    const entryAccountValue = trade.accountValueAtEntry || state.accountValue;
    const actualRiskNpr = (ATR_MULTIPLIER * trade.initialAtr) * trade.shares;
    const actualRiskPct = (actualRiskNpr / entryAccountValue) * 100;

    const card = document.createElement('div');
    card.className = `trade-card ${isExitRequired ? 'alert-exit' : ''}`;

    card.innerHTML = `
      <div class="trade-card-header">
        <div class="trade-card-title">
          <h3>${escapeHTML(trade.ticker)}</h3>
          <span class="shares-badge">${trade.shares} Shares</span>
          ${trade.soldShares > 0 ? `<span class="risk-badge-mini" title="Already exited via partial sells"><i class="fa-solid fa-layer-group"></i> ${trade.soldShares} sold so far</span>` : ''}
          <span class="risk-badge-mini" title="Actual Risk % of account value at entry">
            <i class="fa-solid fa-shield-halved"></i> Risk: ${actualRiskPct.toFixed(2)}%
          </span>
        </div>
        <div class="trade-card-pnl">
          <span class="pnl-val ${pnl >= 0 ? 'text-profit' : 'text-loss'}">
            Rs. ${pnl >= 0 ? '+' : ''}${formatNPR(pnl)}
          </span>
          <span class="pnl-pct ${pnl >= 0 ? 'text-profit' : 'text-loss'}">
            ${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%
          </span>
        </div>
      </div>

      <div class="trade-card-grid">
        <div>
          <span class="card-grid-lbl">Entry Avg</span>
          <span class="card-grid-val">Rs. ${formatNPR(trade.actualPrice)}</span>
        </div>
        <div>
          <span class="card-grid-lbl">Trailing Stop</span>
          <span class="card-grid-val" style="color: var(--color-accent);">Rs. ${formatNPR(trade.trailingStop)}</span>
        </div>
        <div>
          <span class="card-grid-lbl">Highest Close</span>
          <span class="card-grid-val">Rs. ${formatNPR(trade.highestClose)}</span>
        </div>
      </div>

      <div class="trade-card-footer">
        <span class="trade-card-status">
          ${isExitRequired
            ? `<span class="status-exit"><i class="fa-solid fa-triangle-exclamation"></i> EXIT SIGNAL: Sell at Open</span>`
            : `<span class="status-check"><i class="fa-solid fa-circle-check"></i> Holding Pattern</span>`
          }
        </span>
        <button class="btn btn-secondary ${isExitRequired ? 'btn-danger-action' : ''}" style="padding: 0.4rem 0.8rem; font-size: 0.75rem;" data-index="${idx}">
          <i class="fa-solid fa-arrow-right-from-bracket"></i> Sell Position
        </button>
      </div>
    `;

    card.querySelector('button').addEventListener('click', (e) => {
      const i = parseInt(e.currentTarget.getAttribute('data-index'), 10);
      sellPosition(i);
    });

    elements.portfolioList.appendChild(card);
  });
}

function renderDailyRoutineDropdown() {
  elements.routineSelect.innerHTML = '<option value="">-- Select Active Trade --</option>';

  if (state.activeTrades.length === 0) {
    elements.routineSelect.disabled = true;
    elements.routineClose.disabled = true;
    elements.routineAtr.disabled = true;
    elements.routineSubmitBtn.disabled = true;
    elements.routineForm.className = 'disabled-form';
    return;
  }

  elements.routineSelect.disabled = false;
  elements.routineClose.disabled = true;
  elements.routineAtr.disabled = true;
  elements.routineSubmitBtn.disabled = true;
  elements.routineForm.className = '';

  state.activeTrades.forEach((trade) => {
    const opt = document.createElement('option');
    opt.value = trade.ticker;
    opt.textContent = `${trade.ticker} (Stop: Rs. ${trade.trailingStop.toFixed(1)})`;
    elements.routineSelect.appendChild(opt);
  });
}

// Look up an active trade by ticker rather than positional index, since the
// index can shift if the trade list changes while a form/dialog is open.
function findActiveTradeByTicker(ticker) {
  return state.activeTrades.find(t => t.ticker === ticker);
}

function renderHistory() {
  elements.historyList.innerHTML = '';

  if (state.history.length === 0) {
    elements.historyList.innerHTML = `
      <tr class="empty-row">
        <td colspan="8">No historical trades logged yet.</td>
      </tr>
    `;
    return;
  }

  state.history.forEach((h) => {
    const tr = document.createElement('tr');
    const isGain = h.pnl >= 0;
    const riskPctStr = h.actualRiskPct != null ? `(${h.actualRiskPct.toFixed(2)}% of account)` : '';
    tr.innerHTML = `
      <td><strong>${escapeHTML(h.ticker)}</strong></td>
      <td>${h.entryDate}<br><small class="text-muted">Rs. ${formatNPR(h.entryPrice)}</small></td>
      <td>${h.exitDate}<br><small class="text-muted">Rs. ${formatNPR(h.exitPrice)}</small></td>
      <td>${h.shares}</td>
      <td>Rs. ${formatNPR(h.totalRisk)}<br><small class="text-muted">${riskPctStr}</small></td>
      <td class="${isGain ? 'text-profit' : 'text-loss'}"><strong>Rs. ${isGain ? '+' : ''}${formatNPR(h.pnl)}</strong></td>
      <td class="${isGain ? 'text-profit' : 'text-loss'}"><strong>${isGain ? '+' : ''}${h.returnPct.toFixed(2)}%</strong></td>
      <td>
        <span class="state-badge ${isGain ? 'cash' : 'invested'}" style="font-size: 0.65rem;">
          ${isGain ? 'PROFIT' : 'LOSS'}
        </span>
      </td>
    `;
    elements.historyList.appendChild(tr);
  });
}

// --------------------------------------------------------------------------
// Exit / Sell Position
// --------------------------------------------------------------------------

// Tracks tickers currently mid-sell so a double-click (or a second click before
// the first sell's dialogs resolve) can't run two overlapping sell flows for
// the same position.
const sellsInProgress = new Set();

async function sellPosition(index) {
  const initialTrade = state.activeTrades[index];
  if (!initialTrade) return;
  const ticker = initialTrade.ticker;

  if (sellsInProgress.has(ticker)) return; // already selling this one — ignore
  sellsInProgress.add(ticker);
  try {
    await sellPositionByTicker(ticker);
  } finally {
    sellsInProgress.delete(ticker);
  }
}

async function sellPositionByTicker(ticker) {
  let trade = findActiveTradeByTicker(ticker);
  if (!trade) return;
  const remainingShares = trade.shares;

  const sharesStr = await appPrompt(
    `Sell execution for ${trade.ticker}.\nHow many shares actually sold today? (${remainingShares} remaining)`,
    remainingShares,
    'Log Sell Execution'
  );
  if (sharesStr === null) return; // cancelled
  const sharesSold = parseInt(sharesStr, 10);

  if (isNaN(sharesSold) || sharesSold <= 0) {
    await appAlert('Please enter a valid number of shares.');
    return;
  }
  if (sharesSold > remainingShares) {
    await appAlert(`You only hold ${remainingShares} share(s) of ${trade.ticker}.`);
    return;
  }

  const exitPriceStr = await appPrompt(
    `Enter the actual sell price for these ${sharesSold} share(s) (NPR):`,
    '',
    'Log Sell Execution'
  );
  if (exitPriceStr === null) return; // cancelled
  const exitPrice = parseFloat(exitPriceStr);

  if (isNaN(exitPrice) || exitPrice <= 0) {
    await appAlert('Please enter a valid sell price.');
    return;
  }

  // Accumulate this partial sale into the trade's running exit VWAP
  trade.soldShares = (trade.soldShares || 0) + sharesSold;
  trade.soldValue = (trade.soldValue || 0) + (exitPrice * sharesSold);
  trade.shares -= sharesSold;

  if (trade.shares > 0) {
    // Liquidity couldn't absorb the full sale — position stays open with fewer
    // shares. Trailing stop keeps updating on the remainder via the Daily Routine.
    saveState();
    await appAlert(
      `${trade.ticker}: sold ${sharesSold} @ Rs. ${exitPrice.toFixed(2)}. ${trade.shares} share(s) still held — ` +
      `log the rest as fills allow. The trailing stop keeps applying to the remaining shares in the meantime.`
    );
    return;
  }

  // Fully exited (possibly across multiple partial sales) — close out to history
  const exitDate = new Date().toLocaleDateString();
  const totalSharesSold = trade.soldShares;
  const avgExitPrice = trade.soldValue / totalSharesSold;
  const totalCost = trade.actualPrice * totalSharesSold;
  const totalRevenue = trade.soldValue;
  const pnl = totalRevenue - totalCost;
  const returnPct = (pnl / totalCost) * 100;

  const riskPerShare = ATR_MULTIPLIER * trade.initialAtr;
  const totalRisk = riskPerShare * totalSharesSold;
  const entryAccountValue = trade.accountValueAtEntry || state.accountValue;
  const actualRiskPct = (totalRisk / entryAccountValue) * 100;

  const historyItem = {
    ticker: trade.ticker,
    entryPrice: trade.actualPrice,
    entryDate: trade.entryDate,
    exitPrice: avgExitPrice,
    exitDate,
    shares: totalSharesSold,
    totalRisk,
    actualRiskPct,
    pnl,
    returnPct
  };

  state.history.unshift(historyItem);
  const currentIndex = state.activeTrades.findIndex(t => t.ticker === ticker);
  if (currentIndex !== -1) state.activeTrades.splice(currentIndex, 1);

  // Offer to update account value by P&L
  if (await appConfirm(`Trade logged. Adjust Account Value by the P&L of Rs. ${formatNPR(pnl)}?`)) {
    state.accountValue += pnl;
  }

  saveState();

  // Step 7: After exit, prompt to rescan for replacement if macro filter passes
  const slotsCommitted = state.activeTrades.length + state.pendingOrders.length;
  const slotsRemaining = PORTFOLIO_SLOTS - slotsCommitted;
  if (slotsRemaining > 0 && state.stage2IsLeading) {
    await appAlert(
      `Slot freed. You now have ${slotsRemaining} vacant slot${slotsRemaining > 1 ? 's' : ''}.\n\n` +
      `Per strategy rules: Rescan NepseAlpha Super Performance filter and fill the vacant slot(s) with the next highest-ranked qualifying stock.`
    );
  }
}
