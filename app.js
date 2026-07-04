// ==========================================================================
// NEPSE Efficient Trader Strategy (ATR Momentum Version) - Core Logic
// ==========================================================================

// Strategy Constants
const PORTFOLIO_SLOTS = 3;
const TOTAL_PORTFOLIO_RISK_PCT = 0.01;       // 1% total
const RISK_PER_SLOT = TOTAL_PORTFOLIO_RISK_PCT / PORTFOLIO_SLOTS; // ~0.3333%
const ATR_MULTIPLIER = 2.5;
const MAX_SLIPPAGE_PCT = 2.0;                // Skip trade if >2% above planned

// Application State
let state = {
  accountValue: 1000000.00,
  stage2IsLeading: false,   // Step 0: Broad Market Macro Filter
  candidates: [],
  activeTrades: [],
  history: []
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

  // Scanner
  scanTicker: document.getElementById('scan-ticker'),
  scanPctOff: document.getElementById('scan-pct-off'),
  addScanCandidate: document.getElementById('add-scan-candidate'),
  scannerList: document.getElementById('scanner-list'),
  clearScannerBtn: document.getElementById('clear-scanner-btn'),
  useBestCandidateBtn: document.getElementById('use-best-candidate'),

  // Calculator
  calcTicker: document.getElementById('calc-ticker'),
  calcEntry: document.getElementById('calc-entry'),
  calcAtr: document.getElementById('calc-atr'),
  resPlannedRisk: document.getElementById('res-planned-risk'),
  resInitialStop: document.getElementById('res-initial-stop'),
  resRiskPerShare: document.getElementById('res-risk-per-share'),
  resPositionSize: document.getElementById('res-position-size'),
  executeTradeBtn: document.getElementById('execute-trade-btn'),
  slotsFullWarning: document.getElementById('slots-full-warning'),

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

  executeModal: document.getElementById('execute-modal'),
  execTickerLbl: document.getElementById('exec-ticker-lbl'),
  execPlannedPriceLbl: document.getElementById('exec-planned-price-lbl'),
  execPlannedSharesLbl: document.getElementById('exec-planned-shares-lbl'),
  execActualPrice: document.getElementById('exec-actual-price'),
  execActualShares: document.getElementById('exec-actual-shares'),
  execPriceWarning: document.getElementById('exec-price-warning'),
  closeExecuteModal: document.getElementById('close-execute-modal'),
  confirmExecuteBtn: document.getElementById('confirm-execute-btn')
};

// --------------------------------------------------------------------------
// Utilities
// --------------------------------------------------------------------------

function formatNPR(value) {
  return new Intl.NumberFormat('en-NP', {
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
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);

      // Support both wrapped exports ({ state: {...} }) and raw state objects
      const importedState = parsed.state || parsed;

      if (typeof importedState !== 'object' || importedState === null) {
        throw new Error('Invalid structure');
      }

      // Validate required keys exist
      const requiredKeys = ['accountValue', 'activeTrades', 'history'];
      for (const key of requiredKeys) {
        if (!(key in importedState)) {
          throw new Error(`Missing required field: ${key}`);
        }
      }

      // Merge into state with type guards
      state.accountValue = parseFloat(importedState.accountValue) || 1000000.00;
      state.stage2IsLeading = importedState.stage2IsLeading === true;
      state.candidates = Array.isArray(importedState.candidates) ? importedState.candidates : [];
      state.activeTrades = Array.isArray(importedState.activeTrades) ? importedState.activeTrades : [];
      state.history = Array.isArray(importedState.history) ? importedState.history : [];

      saveState();
      alert(`Import successful! Loaded ${state.activeTrades.length} active trade(s) and ${state.history.length} history record(s).`);
    } catch (err) {
      alert(`Import failed: ${err.message}\n\nMake sure you are importing a valid NEPSE Efficient Trader export file.`);
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
        state.accountValue = parseFloat(parsed.accountValue) || 1000000.00;
        state.stage2IsLeading = parsed.stage2IsLeading === true;
        state.candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
        state.activeTrades = Array.isArray(parsed.activeTrades) ? parsed.activeTrades : [];
        state.history = Array.isArray(parsed.history) ? parsed.history : [];
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

function setupEventListeners() {

  // --- Export / Import ---
  elements.exportBtn.addEventListener('click', exportState);
  elements.importBtn.addEventListener('click', () => elements.importFileInput.click());
  elements.importFileInput.addEventListener('change', importState);

  // --- Macro Filter (Step 0) ---
  elements.macroYesBtn.addEventListener('click', () => {
    state.stage2IsLeading = true;
    saveState();
  });

  elements.macroNoBtn.addEventListener('click', () => {
    state.stage2IsLeading = false;
    saveState();
  });

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
  elements.resetAppBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to reset all data? This will clear your portfolio, scan list, and trading history.')) {
      if (confirm('Double checking: This action CANNOT be undone. Proceed with full reset?')) {
        localStorage.removeItem('nepse_efficient_trader_state');
        state = {
          accountValue: 1000000.00,
          stage2IsLeading: false,
          candidates: [],
          activeTrades: [],
          history: []
        };
        elements.calcTicker.value = '';
        elements.calcEntry.value = '';
        elements.calcAtr.value = '';
        elements.scanTicker.value = '';
        elements.scanPctOff.value = '';
        elements.routineSelect.value = '';
        elements.routineClose.value = '';
        elements.routineAtr.value = '';
        saveState();
        alert('Dashboard has been fully reset to default settings.');
      }
    }
  });

  // --- Scanner ---
  elements.addScanCandidate.addEventListener('click', () => {
    const ticker = elements.scanTicker.value.trim().toUpperCase();
    const pctOff = parseFloat(elements.scanPctOff.value);

    if (!ticker) return;
    if (isNaN(pctOff) || pctOff < 0 || pctOff > 100) {
      alert('Please enter a valid % off 52-week high between 0 and 100.');
      return;
    }
    if (state.candidates.some(c => c.ticker === ticker)) {
      alert('Ticker already exists in the scanner list.');
      return;
    }

    state.candidates.push({ ticker, pctOff });
    elements.scanTicker.value = '';
    elements.scanPctOff.value = '';
    saveState();
  });

  elements.clearScannerBtn.addEventListener('click', () => {
    state.candidates = [];
    saveState();
  });

  elements.useBestCandidateBtn.addEventListener('click', () => {
    if (state.candidates.length === 0) return;
    const best = state.candidates.reduce((prev, curr) => prev.pctOff < curr.pctOff ? prev : curr);
    elements.calcTicker.value = best.ticker;
    calculatePosition();
  });

  // --- Calculator ---
  elements.calcTicker.addEventListener('input', () => {
    elements.calcTicker.value = elements.calcTicker.value.toUpperCase();
    calculatePosition();
  });
  elements.calcEntry.addEventListener('input', calculatePosition);
  elements.calcAtr.addEventListener('input', calculatePosition);

  // --- Execute Trade Button (opens modal) ---
  elements.executeTradeBtn.addEventListener('click', () => {
    const ticker = elements.calcTicker.value.trim().toUpperCase();
    const entry = parseFloat(elements.calcEntry.value);
    const atr = parseFloat(elements.calcAtr.value);

    if (!ticker || isNaN(entry) || isNaN(atr)) return;

    // Guard: macro filter
    if (!state.stage2IsLeading) {
      alert('Trading is HALTED. Stage 2 is not the dominant market regime. Enable the Macro Filter first.');
      return;
    }

    // Guard: portfolio slots
    if (state.activeTrades.length >= PORTFOLIO_SLOTS) {
      alert(`All ${PORTFOLIO_SLOTS} portfolio slots are filled. Close an existing position before opening a new one.`);
      return;
    }

    const maxRiskPerSlot = state.accountValue * RISK_PER_SLOT;
    const initialStop = entry - (ATR_MULTIPLIER * atr);
    const riskPerShare = entry - initialStop;
    const size = Math.floor(maxRiskPerSlot / riskPerShare);

    if (size <= 0) return;

    elements.execTickerLbl.textContent = ticker;
    elements.execPlannedPriceLbl.textContent = `Rs. ${entry.toFixed(2)}`;
    elements.execPlannedSharesLbl.textContent = size;
    elements.execActualPrice.value = entry.toFixed(2);
    elements.execActualShares.value = size;
    elements.execPriceWarning.style.display = 'none';
    // Reset button to default state
    elements.confirmExecuteBtn.textContent = 'Confirm Purchase';
    elements.confirmExecuteBtn.dataset.override = 'false';
    elements.confirmExecuteBtn.classList.remove('btn-override');
    elements.confirmExecuteBtn.classList.add('btn-success');
    elements.confirmExecuteBtn.disabled = false;

    elements.executeModal.classList.add('active');
  });

  // --- Execute Modal: slippage check ---
  elements.execActualPrice.addEventListener('input', () => {
    const planned = parseFloat(elements.calcEntry.value);
    const actual = parseFloat(elements.execActualPrice.value);
    if (!isNaN(planned) && !isNaN(actual)) {
      const pctIncrease = ((actual - planned) / planned) * 100;
      if (pctIncrease > MAX_SLIPPAGE_PCT) {
        elements.execPriceWarning.style.display = 'block';
        // Switch to override mode — don't hard-block (trade may already be executed in TMS)
        elements.confirmExecuteBtn.textContent = 'Override & Log';
        elements.confirmExecuteBtn.dataset.override = 'true';
        elements.confirmExecuteBtn.classList.add('btn-override');
        elements.confirmExecuteBtn.classList.remove('btn-success');
        elements.confirmExecuteBtn.disabled = false;
      } else {
        elements.execPriceWarning.style.display = 'none';
        elements.confirmExecuteBtn.innerHTML = 'Confirm Purchase';
        elements.confirmExecuteBtn.dataset.override = 'false';
        elements.confirmExecuteBtn.classList.remove('btn-override');
        elements.confirmExecuteBtn.classList.add('btn-success');
        elements.confirmExecuteBtn.disabled = false;
      }
    }
  });

  elements.closeExecuteModal.addEventListener('click', () => {
    elements.executeModal.classList.remove('active');
    // Reset button state on cancel
    elements.confirmExecuteBtn.textContent = 'Confirm Purchase';
    elements.confirmExecuteBtn.dataset.override = 'false';
    elements.confirmExecuteBtn.classList.remove('btn-override');
    elements.confirmExecuteBtn.classList.add('btn-success');
    elements.execPriceWarning.style.display = 'none';
  });

  elements.confirmExecuteBtn.addEventListener('click', () => {
    const ticker = elements.calcTicker.value.trim().toUpperCase();
    const plannedEntry = parseFloat(elements.calcEntry.value);
    const actualPrice = parseFloat(elements.execActualPrice.value);
    const actualShares = parseInt(elements.execActualShares.value, 10);
    const atr = parseFloat(elements.calcAtr.value);

    if (isNaN(actualPrice) || isNaN(actualShares) || actualShares <= 0) {
      alert('Please enter valid purchase details.');
      return;
    }

    const pctIncrease = ((actualPrice - plannedEntry) / plannedEntry) * 100;
    const isOverride = elements.confirmExecuteBtn.dataset.override === 'true';

    if (pctIncrease > MAX_SLIPPAGE_PCT && isOverride) {
      // Already executed in TMS — ask for a quick acknowledgment
      const ok = confirm(
        `⚠️ Execution price is ${pctIncrease.toFixed(1)}% above planned entry — exceeds the ${MAX_SLIPPAGE_PCT}% strategy limit.\n\n` +
        `If this trade is already executed in your TMS, click OK to log it anyway.\n` +
        `Otherwise click Cancel and review your entries.`
      );
      if (!ok) return;
    }

    // Step 5: Calculate actual initial stop from actual purchase price
    const initialStop = actualPrice - (ATR_MULTIPLIER * atr);

    const newTrade = {
      ticker,
      plannedEntry,
      actualPrice,
      shares: actualShares,
      initialAtr: atr,
      initialStop,
      trailingStop: initialStop,
      highestClose: actualPrice,  // Initialise as actual price; first daily update will set the real value
      lastClose: actualPrice,
      accountValueAtEntry: state.accountValue,
      entryDate: new Date().toLocaleDateString()
    };

    state.activeTrades.push(newTrade);

    // Clear calculator
    elements.calcTicker.value = '';
    elements.calcEntry.value = '';
    elements.calcAtr.value = '';
    calculatePosition();

    elements.executeModal.classList.remove('active');
    saveState();
  });

  // --- Daily Routine ---
  elements.routineSelect.addEventListener('change', () => {
    const index = elements.routineSelect.value;
    if (index !== '') {
      const trade = state.activeTrades[index];
      elements.routineClose.value = trade.lastClose.toFixed(2);
      elements.routineAtr.value = trade.initialAtr.toFixed(2);
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

  elements.routineForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const index = elements.routineSelect.value;
    const todayClose = parseFloat(elements.routineClose.value);
    const todayAtr = parseFloat(elements.routineAtr.value);

    if (index === '' || isNaN(todayClose) || isNaN(todayAtr) || todayClose <= 0 || todayAtr <= 0) {
      alert('Please provide valid daily inputs.');
      return;
    }

    const trade = state.activeTrades[index];

    // Step 6: Update highest close since entry
    trade.highestClose = Math.max(trade.highestClose, todayClose);
    trade.lastClose = todayClose;

    // Candidate Stop = Highest Close Since Entry − (2.5 × ATR)
    const candidateStop = trade.highestClose - (ATR_MULTIPLIER * todayAtr);

    // Trailing Stop = MAX(Previous Stop, Candidate Stop) — never moves lower
    trade.trailingStop = Math.max(trade.trailingStop, candidateStop);
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

function calculatePosition() {
  const ticker = elements.calcTicker.value.trim();
  const entry = parseFloat(elements.calcEntry.value);
  const atr = parseFloat(elements.calcAtr.value);

  const slotsAvailable = state.activeTrades.length < PORTFOLIO_SLOTS;
  const macroOk = state.stage2IsLeading;

  // Show/hide slots-full warning
  elements.slotsFullWarning.style.display = (!slotsAvailable) ? 'flex' : 'none';

  if (!ticker || isNaN(entry) || isNaN(atr) || entry <= 0 || atr <= 0) {
    elements.resPlannedRisk.textContent = 'Rs. 0.00';
    elements.resInitialStop.textContent = 'Rs. 0.00';
    elements.resRiskPerShare.textContent = 'Rs. 0.00';
    elements.resPositionSize.textContent = '0 Shares';
    elements.executeTradeBtn.disabled = true;
    return;
  }

  const maxRiskPerSlot = state.accountValue * RISK_PER_SLOT;
  const initialStop = entry - (ATR_MULTIPLIER * atr);
  const riskPerShare = entry - initialStop;

  elements.resPlannedRisk.textContent = `Rs. ${formatNPR(maxRiskPerSlot)}`;

  if (initialStop <= 0) {
    elements.resInitialStop.textContent = 'Rs. 0.00 (ATR too high)';
    elements.resRiskPerShare.textContent = 'N/A';
    elements.resPositionSize.textContent = '0 Shares';
    elements.executeTradeBtn.disabled = true;
    return;
  }

  elements.resInitialStop.textContent = `Rs. ${formatNPR(initialStop)}`;
  elements.resRiskPerShare.textContent = `Rs. ${formatNPR(riskPerShare)}`;

  const positionSize = Math.floor(maxRiskPerSlot / riskPerShare);

  if (positionSize > 0) {
    elements.resPositionSize.textContent = `${positionSize} Shares`;
    // Only enable execute if macro filter passes AND slots are available
    elements.executeTradeBtn.disabled = !macroOk || !slotsAvailable;
  } else {
    elements.resPositionSize.textContent = '0 Shares (Risk per share too high)';
    elements.executeTradeBtn.disabled = true;
  }
}

// --------------------------------------------------------------------------
// Render Functions
// --------------------------------------------------------------------------

function renderAll() {
  renderMacroFilter();
  renderHeader();
  renderScanner();
  renderActiveTrades();
  renderDailyRoutineDropdown();
  renderHistory();
  calculatePosition(); // Refresh calculator state/buttons
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

  // Slots badge
  const used = state.activeTrades.length;
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

function renderScanner() {
  elements.scannerList.innerHTML = '';

  if (state.candidates.length === 0) {
    elements.scannerList.innerHTML = `
      <tr class="empty-row">
        <td colspan="4">No candidates added. Verify Stage 2, SMA &amp; RS criteria first.</td>
      </tr>
    `;
    elements.useBestCandidateBtn.disabled = true;
    return;
  }

  elements.useBestCandidateBtn.disabled = false;

  const bestValue = Math.min(...state.candidates.map(c => c.pctOff));

  state.candidates.forEach((candidate, idx) => {
    const isBest = candidate.pctOff === bestValue;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHTML(candidate.ticker)}</strong></td>
      <td>${candidate.pctOff.toFixed(2)}%</td>
      <td>
        <span class="rank-badge ${isBest ? 'best' : 'candidate'}">
          ${isBest ? 'Best Choice' : 'Candidate'}
        </span>
      </td>
      <td>
        <button class="delete-row-btn" data-index="${idx}" title="Delete Candidate">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </td>
    `;

    tr.querySelector('.delete-row-btn').addEventListener('click', (e) => {
      const i = parseInt(e.currentTarget.getAttribute('data-index'), 10);
      state.candidates.splice(i, 1);
      saveState();
    });

    elements.scannerList.appendChild(tr);
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

  state.activeTrades.forEach((trade, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = `${trade.ticker} (Stop: Rs. ${trade.trailingStop.toFixed(1)})`;
    elements.routineSelect.appendChild(opt);
  });
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

function sellPosition(index) {
  const trade = state.activeTrades[index];
  const exitPriceStr = prompt(
    `Sell execution for ${trade.ticker}.\nEnter average actual sell price (NPR):`,
    trade.trailingStop.toFixed(2)
  );

  if (exitPriceStr === null) return; // cancelled
  const exitPrice = parseFloat(exitPriceStr);

  if (isNaN(exitPrice) || exitPrice <= 0) {
    alert('Please enter a valid sell price.');
    return;
  }

  const exitDate = new Date().toLocaleDateString();
  const totalCost = trade.actualPrice * trade.shares;
  const totalRevenue = exitPrice * trade.shares;
  const pnl = totalRevenue - totalCost;
  const returnPct = (pnl / totalCost) * 100;

  const riskPerShare = ATR_MULTIPLIER * trade.initialAtr;
  const totalRisk = riskPerShare * trade.shares;
  const entryAccountValue = trade.accountValueAtEntry || state.accountValue;
  const actualRiskPct = (totalRisk / entryAccountValue) * 100;

  const historyItem = {
    ticker: trade.ticker,
    entryPrice: trade.actualPrice,
    entryDate: trade.entryDate,
    exitPrice,
    exitDate,
    shares: trade.shares,
    totalRisk,
    actualRiskPct,
    pnl,
    returnPct
  };

  state.history.unshift(historyItem);
  state.activeTrades.splice(index, 1);

  // Offer to update account value by P&L
  if (confirm(`Trade logged. Adjust Account Value by the P&L of Rs. ${formatNPR(pnl)}?`)) {
    state.accountValue += pnl;
  }

  saveState();

  // Step 7: After exit, prompt to rescan for replacement if macro filter passes
  const slotsNow = state.activeTrades.length;
  const slotsRemaining = PORTFOLIO_SLOTS - slotsNow;
  if (slotsRemaining > 0 && state.stage2IsLeading) {
    alert(
      `Slot freed. You now have ${slotsRemaining} vacant slot${slotsRemaining > 1 ? 's' : ''}.\n\n` +
      `Per strategy rules: Rescan NepseAlpha Super Performance filter and fill the vacant slot(s) with the next highest-ranked qualifying stock.`
    );
  }
}
