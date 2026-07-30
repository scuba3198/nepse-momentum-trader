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

// Top 5 view is stricter than the base pass/fail gate above: a candidate
// must pass the gate AND clear these higher bars to appear in Top 5.
const SCREENER_TOP5_RS_THRESHOLD = 90;
const SCREENER_TOP5_VCP_THRESHOLD = 75;

// Which subset of screener candidates is currently displayed. This is a
// transient view preference (not persisted to state/export) — it always
// resets to 'top5' on reload, matching the app's default actionable view.
let screenerFilterMode = 'top5'; // 'top5' | 'passing' | 'failing' | 'all'

// Application State
let state = {
  accountValue: 1000000.00,
  indexBars: [],            // Step 0: Distribution Day Counter — { date, close, volume }, ascending
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

  // Distribution Day Counter (Step 0)
  indexBarsUploadBtn: document.getElementById('index-bars-upload-btn'),
  indexBarsFileInput: document.getElementById('index-bars-file-input'),
  indexBarsClearBtn: document.getElementById('index-bars-clear-btn'),
  macroStatusText: document.getElementById('macro-status-text'),
  distributionDaysList: document.getElementById('distribution-days-list'),
  haltBanner: document.getElementById('halt-banner'),
  haltBannerText: document.getElementById('halt-banner-text'),
  haltBannerDesc: document.getElementById('halt-banner-desc'),

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
  calcReason: document.getElementById('calc-reason'),
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
  macroBlockedWarning: document.getElementById('macro-blocked-warning'),

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

  // Catch-Up Reminder (missed daily updates)
  catchupBanner: document.getElementById('catchup-banner'),
  catchupBannerText: document.getElementById('catchup-banner-text'),
  catchupBannerBtn: document.getElementById('catchup-banner-btn'),

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

// Short display copy for table cells — full text still lives in the title
// attribute wherever this is used, so nothing is actually lost, just collapsed.
function truncateText(str, max = 60) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
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
      state.indexBars = Array.isArray(importedState.indexBars)
        ? importedState.indexBars.filter(b => b && typeof b.date === 'string' && isFinite(parseFloat(b.close)) && isFinite(parseFloat(b.volume)))
            .map(b => ({ date: b.date, close: parseFloat(b.close), volume: parseFloat(b.volume) }))
        : [];

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
        if (typeof o.entryReason !== 'string') o.entryReason = '';
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
        if (typeof t.entryReason !== 'string') t.entryReason = '';
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
      elements.calcReason.value = '';
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
        state.indexBars = Array.isArray(parsed.indexBars)
          ? parsed.indexBars.filter(b => b && typeof b.date === 'string' && isFinite(parseFloat(b.close)) && isFinite(parseFloat(b.volume)))
              .map(b => ({ date: b.date, close: parseFloat(b.close), volume: parseFloat(b.volume) }))
          : [];

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
          if (typeof o.entryReason !== 'string') o.entryReason = '';
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
          if (typeof t.entryReason !== 'string') t.entryReason = '';
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
// Hero splash — ASCII-density "chart mountain", built the same way a photo
// gets turned into a halftone: draw a shape to an offscreen canvas, sample
// pixel brightness on a grid, and drop a character at each point whose
// density and opacity follow that brightness. The source shape here is a
// drawn ascending trend line instead of a photo.
// --------------------------------------------------------------------------

function initHeroSplash() {
  const field = document.getElementById('hero-ascii-field');
  const heroSection = document.getElementById('hero-splash');
  const cue = document.getElementById('hero-scroll-cue');
  if (!field || !heroSection) return;

  const CHARS = '01ATRVCP';

  function render() {
    field.innerHTML = '';
    const w = field.clientWidth || 1;
    const h = field.clientHeight || 1;

    // Offscreen canvas: draw an ascending "higher highs, higher lows"
    // mountain silhouette plus a few background price-node dots.
    const cw = 240, ch = 240;
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);

    // Sparse background field (like the faint outer dots in a halftone photo)
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * cw, y = Math.random() * ch;
      ctx.fillRect(x, y, 2, 2);
    }

    // The mountain: a jagged uptrend polyline, filled, with a glow core.
    const points = [
      [0, ch * 0.92], [cw * 0.10, ch * 0.80], [cw * 0.18, ch * 0.86],
      [cw * 0.27, ch * 0.62], [cw * 0.35, ch * 0.70], [cw * 0.44, ch * 0.46],
      [cw * 0.52, ch * 0.54], [cw * 0.60, ch * 0.30], [cw * 0.68, ch * 0.38],
      [cw * 0.77, ch * 0.16], [cw * 0.85, ch * 0.24], [cw * 0.93, ch * 0.06],
      [cw, ch * 0.10]
    ];
    ctx.beginPath();
    ctx.moveTo(0, ch);
    points.forEach(p => ctx.lineTo(p[0], p[1]));
    ctx.lineTo(cw, ch);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, ch);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(1, 'rgba(255,255,255,0.08)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Bright trace along the trend line itself
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    points.forEach(p => ctx.lineTo(p[0], p[1]));
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    const imgData = ctx.getImageData(0, 0, cw, ch).data;

    // Sample onto a character grid mapped across the field's box
    const cols = Math.floor(w / 9);
    const rows = Math.floor(h / 11);
    const frag = document.createDocumentFragment();

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const sx = Math.floor((c / cols) * cw);
        const sy = Math.floor((r / rows) * ch);
        const idx = (sy * cw + sx) * 4;
        const alpha = imgData[idx + 3] / 255;
        if (alpha < 0.06) continue;
        if (Math.random() > (0.35 + alpha * 0.5)) continue;

        const span = document.createElement('span');
        span.textContent = CHARS[Math.floor(Math.random() * CHARS.length)];
        span.style.left = (c * 9) + 'px';
        span.style.top = (r * 11) + 'px';
        span.style.opacity = Math.min(1, 0.18 + alpha * 0.85).toFixed(2);
        frag.appendChild(span);
      }
    }
    field.appendChild(frag);
  }

  render();
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 200);
  });
  window.addEventListener('orientationchange', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 250);
  });

  // Lock the page on the splash until the desk is entered — no scrolling
  // past it, only the button reveals what's underneath.
  document.body.classList.add('hero-locked');

  if (cue) {
    cue.addEventListener('click', () => {
      if (cue.disabled) return;
      cue.disabled = true;

      const target = document.getElementById('app-content');
      heroSection.classList.add('hero-dismissed');
      heroSection.setAttribute('aria-hidden', 'true');
      if (target) target.classList.add('app-content-visible');
      document.body.classList.remove('hero-locked');

      // Once the fade/scale-out finishes, take the splash fully out of the
      // way so it can't intercept clicks or show up in the tab order.
      window.setTimeout(() => {
        heroSection.style.display = 'none';
      }, 750);
    });
  }
}

// --------------------------------------------------------------------------
// Bootstrap
// --------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  setupEventListeners();
  renderAll();
  initHeroSplash();
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
    entryISO: todayISODateString(), // robust, locale-independent — used for catch-up date math
    entryReason: order.entryReason || '',  // why the trade was taken — carried through to history on exit
    soldShares: 0,   // cumulative shares exited so far (for multi-day/illiquid exits)
    soldValue: 0,    // cumulative Rs. received so far, for exit VWAP
    updateLog: []    // Daily Routine history: { date, close, atr, trailingStop } per submission
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

  // --- Distribution Day Counter (Step 0) ---
  function ingestIndexBarsText(text) {
    const { bars, skippedCount } = parsePastedIndexBars(text);
    if (bars.length === 0) {
      appAlert('No valid index bars found. Expected either "Date Close Volume" per line, or a pasted/uploaded NepseAlpha CSV export.');
      return;
    }
    const merged = new Map(state.indexBars.map(b => [b.date, b]));
    bars.forEach(b => merged.set(b.date, b));
    state.indexBars = Array.from(merged.values()).sort((a, b) => a.date.localeCompare(b.date));
    saveState();
    renderDistributionPanel();
    if (skippedCount > 0) appAlert(`Added ${bars.length} bar(s). Skipped ${skippedCount} unparseable line(s).`);
  }

  elements.indexBarsUploadBtn.addEventListener('click', () => {
    elements.indexBarsFileInput.click();
  });

  elements.indexBarsFileInput.addEventListener('change', async () => {
    const file = elements.indexBarsFileInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      ingestIndexBarsText(text);
    } catch (err) {
      await appAlert('Could not read that file. Make sure it is a .csv file.');
    } finally {
      elements.indexBarsFileInput.value = '';
    }
  });

  elements.indexBarsClearBtn.addEventListener('click', async () => {
    if (state.indexBars.length === 0) return;
    const ok = await appConfirm('Clear all stored index bar history? This cannot be undone.');
    if (!ok) return;
    state.indexBars = [];
    saveState();
    renderDistributionPanel();
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
          indexBars: [],
          pendingOrders: [],
          activeTrades: [],
          history: [],
          screenerCandidates: []
        };
        elements.calcTicker.value = '';
        elements.calcEntry.value = '';
        elements.calcAtr.value = '';
        elements.calcLiquidity.value = '';
        elements.calcReason.value = '';
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

    // Hard gate: block new entries outright while the trailing distribution-day
    // count is severe ("Under Distribution"). Existing positions/orders are
    // unaffected — this only stops committing new capital.
    const macroGate = getMacroGateStatus();
    if (macroGate.blocked) {
      await appAlert(
        `New entries are blocked: ${macroGate.count} distribution day(s) in the trailing window (Under Distribution).\n\n` +
        `Manage existing positions/orders as normal — this only blocks placing new day-orders. It will unblock once the count drops, or a Follow-Through Day resets it.`
      );
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
    const entryReason = elements.calcReason.value.trim();
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
      accountValueAtEntry: state.accountValue,  // account value used to size this order originally
      entryReason              // why the trade was taken — optional, carried through to the active trade and history
    });

    // Clear calculator
    elements.calcTicker.value = '';
    elements.calcEntry.value = '';
    elements.calcAtr.value = '';
    elements.calcLiquidity.value = '';
    elements.calcReason.value = '';
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

  // --- Daily Routine: Catch-Up ---
  elements.catchupBannerBtn.addEventListener('click', runCatchUpFlow);

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

    applyDailyUpdate(trade, todayISODateString(), todayClose, todayAtr);
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
  const macroGate = getMacroGateStatus();
  const macroOk = !macroGate.blocked;

  // Show/hide slots-full warning
  elements.slotsFullWarning.style.display = (!slotsAvailable) ? 'flex' : 'none';

  // Show/hide macro-blocked warning (hard gate — distribution count severe)
  elements.macroBlockedWarning.style.display = macroGate.blocked ? 'flex' : 'none';

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
  renderDistributionPanel();
  renderHeader();
  renderScreenerTable();
  renderPendingOrders();
  renderActiveTrades();
  renderDailyRoutineDropdown();
  renderHistory();
  renderCatchupBanner();
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
    const top5Eligible = allPassers.filter(c => c.rs >= SCREENER_TOP5_RS_THRESHOLD && c.vcp >= SCREENER_TOP5_VCP_THRESHOLD);
    shown = top5Eligible.slice(0, SCREENER_TOP_N);
    const hiddenEligibleCount = top5Eligible.length - shown.length;
    const belowTop5Count = allPassers.length - top5Eligible.length;
    const parts = [];
    if (hiddenEligibleCount > 0) parts.push(`${hiddenEligibleCount} more candidate(s) ranked below the top ${SCREENER_TOP_N}`);
    if (belowTop5Count > 0) parts.push(`${belowTop5Count} passing candidate(s) below RS ${SCREENER_TOP5_RS_THRESHOLD} / VCP ${SCREENER_TOP5_VCP_THRESHOLD}`);
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
        <td>
          <div style="display:flex; gap:0.4rem; align-items:center; justify-content:flex-end;">
            ${passes ? `<button class="screener-use-btn" data-ticker="${escapeHTML(c.ticker)}"><i class="fa-solid fa-arrow-right"></i> Use</button>` : ''}
            <button class="screener-row-remove" data-remove="${escapeHTML(c.ticker)}" title="Remove"><i class="fa-solid fa-xmark"></i></button>
          </div>
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

// --------------------------------------------------------------------------
// Distribution Day Counter (Step 0)
// A distribution day = index closes lower than the prior bar's close, on
// volume higher than the prior bar's volume. Counted over the trailing
// DISTRIBUTION_WINDOW_DAYS trading days. A Follow-Through Day (a strong up
// day — DISTRIBUTION_FTD_MIN_PCT or more — on volume higher than the prior
// bar) resets the window: only bars from the FTD onward are considered.
// This is a hard gate on NEW entries once severe ("Under Distribution"):
// Place Day Order is blocked until the count drops back down. It does not
// touch existing pending orders or open positions — those keep re-pricing,
// filling, trailing, and exiting normally regardless of this count.
// --------------------------------------------------------------------------
const DISTRIBUTION_WINDOW_DAYS = 25;          // sessions after which a distribution day expires
const DISTRIBUTION_CAUTION_THRESHOLD = 3;
const DISTRIBUTION_SEVERE_THRESHOLD = 5;       // hitting this also kicks the state machine back to 'correction'
const DISTRIBUTION_FTD_MIN_PCT = 1.5;          // min % gain, on higher volume, to qualify as a Follow-Through Day
const DISTRIBUTION_FTD_MIN_RALLY_DAY = 4;      // earliest day (of the rally attempt) an FTD can fire
const DISTRIBUTION_RECOVERY_PCT = 6;           // a distribution day is removed early once price closes this much above it

// Hard gate: once the trailing distribution-day count hits the severe
// threshold ("Under Distribution"), new capital commitments are blocked
// outright — placing a new GTC day-order is disabled until the count drops
// back down. "Caution" (3-4) stays advisory only, same as before. Existing
// pending orders keep re-pricing/filling and existing positions keep
// trailing/exiting normally — the gate only stops *new* entries.
function getMacroGateStatus() {
  const { count, level } = computeDistributionDays(state.indexBars);
  return { blocked: level === 'distribution', count, level };
}

// Splits one CSV line respecting double-quoted fields (which may contain
// commas, e.g. thousand-separated numbers like "6,267,226,722.57").
function splitCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { fields.push(cur); cur = ''; continue; }
    cur += ch;
  }
  fields.push(cur);
  return fields.map(f => f.trim());
}

// Accepts either:
// 1) Manually typed lines: "2026-06-20  2145.30  18500000" (date, close,
//    volume — tab or space separated).
// 2) NepseAlpha's exported CSV, pasted as-is: header row
//    Symbol,Date,Open,High,Low,Close,Percent Change,Volume,Turn Over —
//    Date and Close are used directly; Volume (NepseAlpha exports total
//    turnover in this column for the index) is used as the volume proxy.
// Tolerant of extra whitespace and header rows; skips lines that don't
// parse rather than throwing.
function parsePastedIndexBars(text) {
  const bars = [];
  let skippedCount = 0;
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed.includes(',')) {
      // NepseAlpha CSV row
      const fields = splitCsvLine(trimmed);
      if (fields.length < 8 || fields[1] === 'Date') { skippedCount++; return; } // header row
      const date = fields[1];
      const close = parseFloat(fields[5].replace(/[^0-9.\-]/g, ''));
      const volume = parseFloat(fields[7].replace(/[^0-9.\-]/g, ''));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isFinite(close) || !isFinite(volume)) { skippedCount++; return; }
      bars.push({ date, close, volume });
      return;
    }

    const parts = trimmed.split(/\t+|\s+/).filter(p => p !== '');
    if (parts.length < 3) { skippedCount++; return; }
    const [date, closeRaw, volumeRaw] = parts;
    const close = parseFloat(closeRaw.replace(/[^0-9.\-]/g, ''));
    const volume = parseFloat(volumeRaw.replace(/[^0-9.\-]/g, ''));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isFinite(close) || !isFinite(volume)) { skippedCount++; return; }
    bars.push({ date, close, volume });
  });
  return { bars, skippedCount };
}

// --------------------------------------------------------------------------
// Market state machine (Correction -> Rally Attempt -> Confirmed Uptrend)
//
//   correction  — no active rally attempt. Distribution days aren't counted
//                 here (there's no confirmed trend to protect); the gate
//                 itself is treated as blocked, since IBD discipline is to
//                 not commit new capital until an FTD confirms a new uptrend.
//   attempt     — day 1 was an up-close right after a down-close. The
//                 attempt's low (the close of that prior down day) must
//                 hold: closing below it invalidates the attempt and sends
//                 the state back to 'correction' to wait for a new low.
//                 Down days *within* the attempt are fine as long as the
//                 low isn't undercut — an attempt does not require
//                 consecutive up-closes.
//   uptrend     — entered once an FTD fires: on day >= DISTRIBUTION_FTD_MIN_RALLY_DAY
//                 of the attempt, a >= DISTRIBUTION_FTD_MIN_PCT gain on
//                 higher volume than the prior bar. Only one FTD is
//                 recognized per correction/attempt cycle. While in this
//                 state, distribution days are tallied in a trailing
//                 DISTRIBUTION_WINDOW_DAYS-session window; a flagged day
//                 expires after that window OR early once price closes
//                 DISTRIBUTION_RECOVERY_PCT% above it. Hitting the severe
//                 threshold reverts the state to 'correction', so a new
//                 FTD has to be earned again rather than firing on top of
//                 an already-unhealthy tape.
//
// Returns { count, level, flagged: [{date, close, volume}], ftdDate, state }
// --------------------------------------------------------------------------
function computeDistributionDays(bars) {
  if (!Array.isArray(bars) || bars.length < 2) {
    return { count: 0, level: 'normal', flagged: [], ftdDate: null, state: 'uptrend' };
  }

  let marketState = 'correction';
  let attemptLow = null;      // close of the day the current attempt must defend
  let attemptStartIndex = -1; // index of day 1 of the current attempt
  let lastFtdIndex = -1;
  let activeDist = [];        // { date, close, volume, index } — distribution days since the last FTD, not yet expired/recovered

  for (let i = 1; i < bars.length; i++) {
    const prior = bars[i - 1];
    const cur = bars[i];

    if (marketState === 'uptrend') {
      // Expire distribution days older than the trailing window, or ones
      // price has since recovered DISTRIBUTION_RECOVERY_PCT% above.
      activeDist = activeDist.filter(d =>
        (i - d.index) <= DISTRIBUTION_WINDOW_DAYS &&
        cur.close < d.close * (1 + DISTRIBUTION_RECOVERY_PCT / 100)
      );

      if (cur.close < prior.close && cur.volume > prior.volume) {
        activeDist.push({ date: cur.date, close: cur.close, volume: cur.volume, index: i });
      }

      if (activeDist.length >= DISTRIBUTION_SEVERE_THRESHOLD) {
        // Market re-enters a correction — a fresh attempt + FTD has to be earned.
        marketState = 'correction';
        attemptLow = null;
        attemptStartIndex = -1;
      }
      continue;
    }

    if (marketState === 'correction') {
      if (cur.close > prior.close && prior.close < bars[i - 2 >= 0 ? i - 2 : 0].close) {
        marketState = 'attempt';
        attemptStartIndex = i;
        attemptLow = prior.close;
      }
      continue;
    }

    // marketState === 'attempt'
    if (cur.close < attemptLow) {
      marketState = 'correction';
      attemptStartIndex = -1;
      attemptLow = null;
      continue;
    }
    const rallyDay = i - attemptStartIndex + 1;
    const pctChange = ((cur.close - prior.close) / prior.close) * 100;
    if (rallyDay >= DISTRIBUTION_FTD_MIN_RALLY_DAY && pctChange >= DISTRIBUTION_FTD_MIN_PCT && cur.volume > prior.volume) {
      marketState = 'uptrend';
      lastFtdIndex = i;
      activeDist = [];
    }
  }

  const count = activeDist.length;
  let level;
  if (marketState !== 'uptrend') {
    level = 'distribution'; // no confirmed uptrend yet — treated as blocked, same as severe
  } else if (count >= DISTRIBUTION_SEVERE_THRESHOLD) {
    level = 'distribution';
  } else if (count >= DISTRIBUTION_CAUTION_THRESHOLD) {
    level = 'caution';
  } else {
    level = 'normal';
  }

  return {
    count,
    level,
    flagged: activeDist.map(d => ({ date: d.date, close: d.close, volume: d.volume })),
    ftdDate: lastFtdIndex >= 0 ? bars[lastFtdIndex].date : null,
    state: marketState
  };
}

function renderDistributionPanel() {
  const { count, level, flagged, ftdDate, state: marketState } = computeDistributionDays(state.indexBars);

  if (state.indexBars.length === 0) {
    elements.macroStatusText.innerHTML = '<i class="fa-solid fa-circle-info"></i> Upload at least 6 months of index CSV data (starting before the last major low) to compute the distribution day count.';
    elements.macroStatusText.className = 'macro-status-text clear';
    elements.distributionDaysList.innerHTML = '';
    elements.haltBanner.style.display = 'none';
    return;
  }

  let copy;
  if (marketState === 'correction') {
    copy = { icon: 'fa-triangle-exclamation', cls: 'halted', text: 'No confirmed uptrend — market is in a correction with no valid rally attempt yet. New entries are blocked.' };
  } else if (marketState === 'attempt') {
    copy = { icon: 'fa-triangle-exclamation', cls: 'halted', text: 'No confirmed uptrend — a rally attempt is underway but hasn\u2019t follow-throughed yet. New entries are blocked.' };
  } else {
    const levelCopy = {
      normal: { icon: 'fa-circle-check', cls: 'clear', text: `${count} distribution day(s) in the trailing window — Normal. Full size, standard selectivity.` },
      caution: { icon: 'fa-triangle-exclamation', cls: 'halted', text: `${count} distribution day(s) in the trailing window — Caution. Be more selective on new entries.` },
      distribution: { icon: 'fa-triangle-exclamation', cls: 'halted', text: `${count} distribution day(s) in the trailing window — Under Distribution. New entries are blocked.` }
    };
    copy = levelCopy[level];
  }
  elements.macroStatusText.innerHTML = `<i class="fa-solid ${copy.icon}"></i> ${copy.text}`;
  elements.macroStatusText.className = `macro-status-text ${copy.cls}`;

  if (ftdDate) {
    elements.distributionDaysList.innerHTML = `Follow-through day on ${escapeHTML(ftdDate)} confirmed the current uptrend.` +
      (flagged.length > 0 ? ` Flagged since: ${flagged.map(f => escapeHTML(f.date)).join(', ')}` : '');
  } else if (flagged.length > 0) {
    elements.distributionDaysList.innerHTML = `Flagged: ${flagged.map(f => escapeHTML(f.date)).join(', ')}`;
  } else {
    elements.distributionDaysList.innerHTML = '';
  }

  if (level === 'distribution') {
    elements.haltBannerText.textContent = 'UNDER DISTRIBUTION';
    elements.haltBannerDesc.textContent = 'Elevated distribution day count. New entries are blocked until this clears — manage existing positions/orders as normal.';
    elements.haltBanner.style.display = 'flex';
  } else if (level === 'caution') {
    elements.haltBannerText.textContent = 'CAUTION';
    elements.haltBannerDesc.textContent = 'Elevated distribution day count. Be selective with new entries; this does not block trading.';
    elements.haltBanner.style.display = 'flex';
  } else {
    elements.haltBanner.style.display = 'none';
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

      ${order.entryReason ? `
      <p class="trade-reason-note" title="${escapeHTML(order.entryReason)}">
        <i class="fa-solid fa-quote-left"></i> ${escapeHTML(order.entryReason)}
      </p>` : ''}

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

      ${trade.entryReason ? `
      <p class="trade-reason-note" title="${escapeHTML(trade.entryReason)}">
        <i class="fa-solid fa-quote-left"></i> ${escapeHTML(trade.entryReason)}
      </p>` : ''}

      <div class="trade-card-footer">
        <span class="trade-card-status">
          ${isExitRequired
            ? `<span class="status-exit"><i class="fa-solid fa-triangle-exclamation"></i> EXIT SIGNAL: Sell at Open</span>`
            : `<span class="status-check"><i class="fa-solid fa-circle-check"></i> Holding Pattern</span>`
          }
        </span>
        <div style="display: flex; gap: 0.5rem;">
          <button class="btn btn-secondary view-log-btn" style="padding: 0.4rem 0.8rem; font-size: 0.75rem;" data-ticker="${escapeHTML(trade.ticker)}">
            <i class="fa-solid fa-calendar-days"></i> Update Log${trade.updateLog && trade.updateLog.length ? ` (${trade.updateLog.length})` : ''}
          </button>
          <button class="btn btn-secondary ${isExitRequired ? 'btn-danger-action' : ''}" style="padding: 0.4rem 0.8rem; font-size: 0.75rem;" data-index="${idx}">
            <i class="fa-solid fa-arrow-right-from-bracket"></i> Sell Position
          </button>
        </div>
      </div>
    `;

    card.querySelector('.view-log-btn').addEventListener('click', (e) => {
      const t = e.currentTarget.getAttribute('data-ticker');
      showUpdateLog(t);
    });

    card.querySelector('[data-index]').addEventListener('click', (e) => {
      const i = parseInt(e.currentTarget.getAttribute('data-index'), 10);
      sellPosition(i);
    });

    elements.portfolioList.appendChild(card);
  });
}

// Shows every day the Daily Routine was submitted for a given ticker,
// most recent first, using the existing app dialog (its message element
// preserves line breaks via white-space: pre-line).
async function showUpdateLog(ticker) {
  const trade = findActiveTradeByTicker(ticker);
  if (!trade) return;

  const log = Array.isArray(trade.updateLog) ? trade.updateLog : [];

  if (log.length === 0) {
    await appAlert(
      trade.lastUpdatedDate
        ? `No detailed log yet for ${ticker} — only a last-updated date is on record: ${trade.lastUpdatedDate}.`
        : `No Daily Routine updates logged yet for ${ticker}.`
    );
    return;
  }

  const lines = log
    .slice()
    .reverse()
    .map(e => `${e.date}  —  Close: Rs. ${formatNPR(e.close)}   ATR: ${e.atr.toFixed(2)}   Stop: Rs. ${formatNPR(e.trailingStop)}`)
    .join('\n');

  await appAlert(`${lines}`, `${ticker} — Update Log (${log.length})`);
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
    const missedCount = getMissedTradingDays(resolveSinceDate(trade)).length;
    const behindTag = missedCount > 0 ? ` — ⚠ ${missedCount} day${missedCount > 1 ? 's' : ''} behind` : '';
    opt.textContent = `${trade.ticker} (Stop: Rs. ${trade.trailingStop.toFixed(1)})${behindTag}`;
    elements.routineSelect.appendChild(opt);
  });
}

// --------------------------------------------------------------------------
// Catch-Up Reminder: flags active trades whose close/ATR log has fallen
// behind, and lets you backfill the missed NEPSE trading days.
// NEPSE trades Monday-Friday, so Saturday/Sunday are never "missed" days.
// --------------------------------------------------------------------------

const NEPSE_TRADING_WEEKDAYS = [1, 2, 3, 4, 5]; // Mon=1 ... Fri=5 (Sat/Sun are non-trading)

function isNepseTradingDay(date) {
  return NEPSE_TRADING_WEEKDAYS.includes(date.getDay());
}

// Locale-independent "YYYY-MM-DD" for a Date, built from local Y/M/D fields
// (not toISOString(), which converts to UTC and can land on the wrong day
// near midnight). This is what gets stored for date math going forward.
function toISODateString(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayISODateString() {
  return toISODateString(new Date());
}

// Strict "YYYY-MM-DD" parser — built from the numeric fields directly rather
// than handed to `new Date(str)`, so it can't be misread as day-first vs
// month-first depending on the browser's locale. Returns null on anything
// that isn't exactly that shape.
function parseISODateOnly(str) {
  if (typeof str !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

function displayDateFromISO(iso) {
  const d = parseISODateOnly(iso);
  return d ? d.toLocaleDateString() : iso;
}

function toDateOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Trades saved before this feature existed only have the locale-formatted
// display date (e.g. "7/31/2026" or "31/7/2026" depending on the browser
// that wrote it) and no ISO field. `new Date(str)` on that is a best-effort,
// last-resort fallback only — it's not trusted for anything but old data,
// and a misread here just means an old trade's catch-up count is off by a
// bit, never a crash.
function legacyParseDisplayDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

// Resolves the date to measure "missed trading days" from: the robust ISO
// field if this trade has one, otherwise a best-effort parse of whichever
// legacy display-date field is available.
function resolveSinceDate(trade) {
  const isoDate = parseISODateOnly(trade.lastUpdatedISO || trade.entryISO);
  if (isoDate) return isoDate;
  return legacyParseDisplayDate(trade.lastUpdatedDate || trade.entryDate);
}

// NEPSE closes at 3:00 PM local time. Give a 30-minute buffer for the close
// to settle before nagging about the day's data — otherwise this would flag
// "today" as missed the moment it becomes today, hours before there's even
// a closing price to log.
const CATCHUP_READY_HOUR = 15;
const CATCHUP_READY_MINUTE = 30;

function isTodayReadyForCatchUp(now) {
  return now.getHours() > CATCHUP_READY_HOUR ||
    (now.getHours() === CATCHUP_READY_HOUR && now.getMinutes() >= CATCHUP_READY_MINUTE);
}

// Returns an array of date-only Date objects for every NEPSE trading day
// strictly after `sinceDate`, up through the most recent trading day whose
// close is already in and ready to log — today, if today is a trading day
// and it's past market-close-plus-buffer, otherwise the closest earlier
// trading day. Empty array means nothing is missed.
function getMissedTradingDays(sinceDate) {
  if (!sinceDate) return [];
  const sinceDay = toDateOnly(sinceDate);

  const now = new Date();
  let mostRecentTradingDay = toDateOnly(now);
  if (!isTodayReadyForCatchUp(now)) {
    mostRecentTradingDay.setDate(mostRecentTradingDay.getDate() - 1);
  }
  while (!isNepseTradingDay(mostRecentTradingDay)) {
    mostRecentTradingDay.setDate(mostRecentTradingDay.getDate() - 1);
  }

  if (mostRecentTradingDay <= sinceDay) return [];

  const missed = [];
  const cursor = new Date(sinceDay);
  cursor.setDate(cursor.getDate() + 1);
  while (cursor <= mostRecentTradingDay) {
    if (isNepseTradingDay(cursor)) missed.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return missed;
}

// { trade, missedDays } for every active trade with at least one un-logged
// NEPSE trading day since its last close/ATR entry (or since entry, for
// trades that have never had a routine update logged).
function getTradesNeedingCatchUp() {
  return state.activeTrades
    .map((trade) => ({
      trade,
      missedDays: getMissedTradingDays(resolveSinceDate(trade))
    }))
    .filter((item) => item.missedDays.length > 0);
}

// Applies one day's close/ATR to a trade — same trailing-stop math whether
// it's run for today via the routine form, or backfilled for a missed day
// via the catch-up flow. dateISO must be a "YYYY-MM-DD" string.
function applyDailyUpdate(trade, dateISO, close, atr) {
  // Step 6: Update highest close since entry
  trade.highestClose = Math.max(trade.highestClose, close);
  trade.lastClose = close;

  // Candidate Stop = Highest Close Since Entry − (2.5 × ATR)
  const candidateStop = trade.highestClose - (ATR_MULTIPLIER * atr);

  // Trailing Stop = MAX(Previous Stop, Candidate Stop) — never moves lower
  trade.trailingStop = Math.max(trade.trailingStop, candidateStop);
  trade.lastAtr = atr;
  trade.lastUpdatedISO = dateISO;
  trade.lastUpdatedDate = displayDateFromISO(dateISO); // kept for display/back-compat

  // Log this submission so the full update history is visible later, not
  // just the most recent date. Older trades saved before this field existed
  // won't have the array yet — create it on first use.
  if (!Array.isArray(trade.updateLog)) trade.updateLog = [];
  // Replace same-day entries instead of duplicating — keyed on the ISO date
  // so this can't be fooled by locale display-string differences. Falls
  // back to matching on the display string for older log entries that
  // predate the ISO field.
  const existingIdx = trade.updateLog.findIndex(e => (e.dateISO ? e.dateISO === dateISO : e.date === trade.lastUpdatedDate));
  const logEntry = { date: trade.lastUpdatedDate, dateISO, close, atr, trailingStop: trade.trailingStop };
  if (existingIdx !== -1) {
    trade.updateLog[existingIdx] = logEntry;
  } else {
    trade.updateLog.push(logEntry);
  }
}

function renderCatchupBanner() {
  const items = getTradesNeedingCatchUp();
  if (items.length === 0) {
    elements.catchupBanner.style.display = 'none';
    return;
  }

  const totalMissedDays = items.reduce((sum, i) => sum + i.missedDays.length, 0);
  const maxMissedDays = Math.max(...items.map(i => i.missedDays.length));
  const tickers = items.map(i => i.trade.ticker).join(', ');

  elements.catchupBannerText.textContent =
    `Daily update missed: ${items.length} trade${items.length > 1 ? 's' : ''} (${tickers}) ` +
    `${maxMissedDays > 1 ? `up to ${maxMissedDays} trading days` : '1 trading day'} behind ` +
    `(${totalMissedDays} closing price${totalMissedDays > 1 ? 's' : ''}/ATR${totalMissedDays > 1 ? 's' : ''} to fill).`;
  elements.catchupBanner.style.display = 'flex';
}

// Walks through every trade with missed trading days, oldest missed day
// first, prompting for that day's close and ATR and applying it with the
// same math the normal Daily Routine submit uses. Cancelling any prompt
// stops the whole catch-up (whatever was already logged stays saved).
async function runCatchUpFlow() {
  const items = getTradesNeedingCatchUp();
  if (items.length === 0) {
    await appAlert("No missed trading days — you're all caught up.");
    return;
  }

  for (const { trade } of items) {
    // Re-derive per trade (not per day) in case an earlier iteration in this
    // same run already logged some of its days.
    const ticker = trade.ticker;
    let missedDays = getMissedTradingDays(resolveSinceDate(trade));

    for (const day of missedDays) {
      const t = findActiveTradeByTicker(ticker);
      if (!t) break; // sold mid-catchup — nothing left to backfill for it

      const dayISO = toISODateString(day);
      const dayDisplay = day.toLocaleDateString();

      const closeStr = await appPrompt(
        `Catch-up for ${ticker} — ${dayDisplay}.\nClosing price (Rs.):`,
        '',
        'Catch Up: Missed Day'
      );
      if (closeStr === null) return; // cancelled — stop the whole catch-up
      const close = parseFloat(closeStr);
      if (isNaN(close) || close <= 0) {
        await appAlert('Please enter a valid closing price. Catch-up stopped — run it again to resume.');
        return;
      }

      const atrStr = await appPrompt(
        `Catch-up for ${ticker} — ${dayDisplay}.\nATR (14) (Rs.):`,
        '',
        'Catch Up: Missed Day'
      );
      if (atrStr === null) return; // cancelled
      const atr = parseFloat(atrStr);
      if (isNaN(atr) || atr <= 0 || atr >= close) {
        await appAlert(`ATR must be a valid number less than the close (Rs. ${close.toFixed(2)}). Catch-up stopped — run it again to resume.`);
        return;
      }

      applyDailyUpdate(t, dayISO, close, atr);
      saveState();
      renderAll();
    }
  }

  await appAlert("All missed trading days have been logged. You're caught up.");
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
        <td colspan="9">No historical trades logged yet.</td>
      </tr>
    `;
    return;
  }

  state.history.forEach((h) => {
    const tr = document.createElement('tr');
    const isGain = h.pnl >= 0;
    const riskPctStr = h.actualRiskPct != null ? `(${h.actualRiskPct.toFixed(2)}% of account)` : '';
    const notesParts = [];
    if (h.entryReason) {
      notesParts.push(`<div class="history-note" title="${escapeHTML(h.entryReason)}"><i class="fa-solid fa-arrow-right-to-bracket"></i> ${escapeHTML(truncateText(h.entryReason))}</div>`);
    }
    if (h.exitReason) {
      notesParts.push(`<div class="history-note" title="${escapeHTML(h.exitReason)}"><i class="fa-solid fa-arrow-right-from-bracket"></i> ${escapeHTML(truncateText(h.exitReason))}</div>`);
    }
    const notesHtml = notesParts.length > 0 ? notesParts.join('') : '<span class="text-muted">—</span>';
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
      <td class="history-notes-cell">${notesHtml}</td>
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

  // Optional — cancelling this prompt does NOT abort the sale, it just skips
  // the note. Keeps the running note if the position exits across multiple
  // partial sells and only some of them get a reason typed in.
  const exitReasonRaw = await appPrompt(
    'Reason for exiting (optional):',
    trade.exitReasonDraft || '',
    'Log Sell Execution'
  );
  if (exitReasonRaw !== null && exitReasonRaw.trim() !== '') {
    trade.exitReasonDraft = exitReasonRaw.trim();
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
    returnPct,
    entryReason: trade.entryReason || '',
    exitReason: trade.exitReasonDraft || ''
  };

  state.history.unshift(historyItem);
  const currentIndex = state.activeTrades.findIndex(t => t.ticker === ticker);
  if (currentIndex !== -1) state.activeTrades.splice(currentIndex, 1);

  // Offer to update account value by P&L
  if (await appConfirm(`Trade logged. Adjust Account Value by the P&L of Rs. ${formatNPR(pnl)}?`)) {
    state.accountValue += pnl;
  }

  saveState();

  // Step 7: After exit, prompt to rescan for replacement if a slot is free
  const slotsCommitted = state.activeTrades.length + state.pendingOrders.length;
  const slotsRemaining = PORTFOLIO_SLOTS - slotsCommitted;
  if (slotsRemaining > 0) {
    await appAlert(
      `Slot freed. You now have ${slotsRemaining} vacant slot${slotsRemaining > 1 ? 's' : ''}.\n\n` +
      `Per strategy rules: Rescan NepseAlpha Super Performance filter and fill the vacant slot(s) with the next highest-ranked qualifying stock.`
    );
  }
}
