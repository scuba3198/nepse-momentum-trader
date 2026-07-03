// ==========================================================================
// NEPSE ATR Momentum Tracker - Core Logic
// ==========================================================================

// Application State
let state = {
  accountValue: 1000000.00,
  candidates: [],
  activeTrades: [],
  history: []
};

// DOM Elements
const elements = {
  // Header
  headerAccountValue: document.getElementById('header-account-value'),
  editAccountBtn: document.getElementById('edit-account-btn'),
  resetAppBtn: document.getElementById('reset-app-btn'),
  strategyState: document.getElementById('strategy-state'),
  
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

// Format currency
function formatNPR(value) {
  return new Intl.NumberFormat('en-NP', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

// Save/Load State from LocalStorage
function saveState() {
  localStorage.setItem('nepse_atr_momentum_state', JSON.stringify(state));
  renderAll();
}

function loadState() {
  const saved = localStorage.getItem('nepse_atr_momentum_state');
  if (saved) {
    try {
      state = JSON.parse(saved);
      // Ensure expected arrays/values exist
      if (!state.candidates) state.candidates = [];
      if (!state.activeTrades) state.activeTrades = [];
      if (!state.history) state.history = [];
      if (state.accountValue !== undefined) {
        state.accountValue = parseFloat(state.accountValue) || 1000000.00;
      } else {
        state.accountValue = 1000000.00;
      }
    } catch (e) {
      console.error("Failed to parse saved state", e);
    }
  }
}

// Initial Setup & Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  loadState();
  setupEventListeners();
  renderAll();
});

function setupEventListeners() {
  // Account Value Modals
  elements.editAccountBtn.addEventListener('click', () => {
    elements.modalAccountValue.value = state.accountValue;
    elements.accountModal.classList.add('active');
  });
  elements.closeAccountModal.addEventListener('click', () => elements.accountModal.classList.remove('active'));
  elements.saveAccountBtn.addEventListener('click', () => {
    const val = parseFloat(elements.modalAccountValue.value);
    if (!isNaN(val) && val > 0) {
      state.accountValue = val;
      elements.accountModal.classList.remove('active');
      saveState();
      calculatePosition(); // Recalculate based on new account value
    }
  });

  // Reset App Data
  elements.resetAppBtn.addEventListener('click', () => {
    if (confirm("Are you sure you want to reset all data? This will clear your portfolio, scan lists, and trading history.")) {
      if (confirm("Double checking: This action CANNOT be undone. Proceed with reset?")) {
        localStorage.removeItem('nepse_atr_momentum_state');
        state = {
          accountValue: 1000000.00,
          candidates: [],
          activeTrades: [],
          history: []
        };
        // Reset inputs
        elements.calcTicker.value = '';
        elements.calcEntry.value = '';
        elements.calcAtr.value = '';
        elements.scanTicker.value = '';
        elements.scanPctOff.value = '';
        elements.routineSelect.value = '';
        elements.routineClose.value = '';
        elements.routineAtr.value = '';
        
        saveState();
        alert("Dashboard has been fully reset to default settings.");
      }
    }
  });

  // Scanner Actions
  elements.addScanCandidate.addEventListener('click', () => {
    const ticker = elements.scanTicker.value.trim().toUpperCase();
    const pctOff = parseFloat(elements.scanPctOff.value);
    
    if (!ticker) return;
    if (isNaN(pctOff) || pctOff < 0 || pctOff > 100) {
      alert("Please enter a valid % off 52-week high between 0 and 100.");
      return;
    }
    
    // Avoid duplicate ticker in list
    if (state.candidates.some(c => c.ticker === ticker)) {
      alert("Ticker already exists in the scanner list.");
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
    // Find the candidate with the lowest % off 52w high
    let best = state.candidates.reduce((prev, curr) => prev.pctOff < curr.pctOff ? prev : curr);
    
    elements.calcTicker.value = best.ticker;
    calculatePosition();
  });

  // Calculator inputs
  elements.calcTicker.addEventListener('input', () => {
    elements.calcTicker.value = elements.calcTicker.value.toUpperCase();
    calculatePosition();
  });
  elements.calcEntry.addEventListener('input', calculatePosition);
  elements.calcAtr.addEventListener('input', calculatePosition);

  // Execute Trade Button
  elements.executeTradeBtn.addEventListener('click', () => {
    const ticker = elements.calcTicker.value.trim().toUpperCase();
    const entry = parseFloat(elements.calcEntry.value);
    const atr = parseFloat(elements.calcAtr.value);
    
    if (!ticker || isNaN(entry) || isNaN(atr)) return;

    // Calculate suggested shares
    const risk = state.accountValue * 0.01;
    const initialStop = entry - (2.5 * atr);
    const riskPerShare = entry - initialStop;
    const size = Math.floor(risk / riskPerShare);

    if (size <= 0) return;

    // Setup Modal Info
    elements.execTickerLbl.textContent = ticker;
    elements.execPlannedPriceLbl.textContent = `Rs. ${entry.toFixed(2)}`;
    elements.execPlannedSharesLbl.textContent = size;
    
    elements.execActualPrice.value = entry.toFixed(2);
    elements.execActualShares.value = size;
    elements.execPriceWarning.style.display = 'none';
    elements.confirmExecuteBtn.disabled = false; // Fix: reset disabled state
    
    elements.executeModal.classList.add('active');
  });

  // Execute Modal Handlers
  elements.execActualPrice.addEventListener('input', () => {
    const planned = parseFloat(elements.calcEntry.value);
    const actual = parseFloat(elements.execActualPrice.value);
    if (!isNaN(planned) && !isNaN(actual)) {
      const pctIncrease = ((actual - planned) / planned) * 100;
      if (pctIncrease > 2.0) {
        elements.execPriceWarning.style.display = 'block';
        elements.confirmExecuteBtn.disabled = true;
      } else {
        elements.execPriceWarning.style.display = 'none';
        elements.confirmExecuteBtn.disabled = false;
      }
    }
  });

  elements.closeExecuteModal.addEventListener('click', () => {
    elements.executeModal.classList.remove('active');
  });

  elements.confirmExecuteBtn.addEventListener('click', () => {
    const ticker = elements.calcTicker.value.trim().toUpperCase();
    const plannedEntry = parseFloat(elements.calcEntry.value);
    const actualPrice = parseFloat(elements.execActualPrice.value);
    const actualShares = parseInt(elements.execActualShares.value);
    const atr = parseFloat(elements.calcAtr.value);

    if (isNaN(actualPrice) || isNaN(actualShares) || actualShares <= 0) {
      alert("Please enter valid purchase details.");
      return;
    }

    // Safety rule check
    const pctIncrease = ((actualPrice - plannedEntry) / plannedEntry) * 100;
    if (pctIncrease > 2.0) {
      alert("Trade execution price is more than 2% higher than planned entry. Strategy rules state you must skip this trade.");
      return;
    }

    const initialStop = actualPrice - (2.5 * atr);
    const newTrade = {
      ticker,
      plannedEntry,
      actualPrice,
      shares: actualShares,
      initialAtr: atr,
      initialStop: initialStop,
      trailingStop: initialStop,
      highestClose: actualPrice, // Initialize highest close as actual purchase price
      lastClose: actualPrice,
      accountValueAtEntry: state.accountValue, // Save current account value at entry
      entryDate: new Date().toLocaleDateString()
    };

    state.activeTrades.push(newTrade);
    
    // Clear calculator form
    elements.calcTicker.value = '';
    elements.calcEntry.value = '';
    elements.calcAtr.value = '';
    calculatePosition();

    elements.executeModal.classList.remove('active');
    saveState();
  });

  // Daily Routine Update Select
  elements.routineSelect.addEventListener('change', () => {
    const index = elements.routineSelect.value;
    if (index !== "") {
      const trade = state.activeTrades[index];
      // Pre-fill fields with latest values or placeholders
      elements.routineClose.value = trade.highestClose.toFixed(2);
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

  // Daily Routine submit
  elements.routineForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const index = elements.routineSelect.value;
    const todayClose = parseFloat(elements.routineClose.value);
    const todayAtr = parseFloat(elements.routineAtr.value);

    if (index === "" || isNaN(todayClose) || isNaN(todayAtr) || todayClose <= 0 || todayAtr <= 0) {
      alert("Please provide valid daily inputs.");
      return;
    }

    const trade = state.activeTrades[index];
    
    // Step 6: Update highest closing price since entry
    trade.highestClose = Math.max(trade.highestClose, todayClose);
    trade.lastClose = todayClose;
    
    // Calculate Candidate Stop
    const candidateStop = trade.highestClose - (2.5 * todayAtr);
    
    // Update Trailing Stop = MAX(Previous Stop, Candidate Stop)
    trade.trailingStop = Math.max(trade.trailingStop, candidateStop);
    trade.lastUpdatedDate = new Date().toLocaleDateString();

    saveState();

    // Reset fields
    elements.routineSelect.value = '';
    elements.routineClose.value = '';
    elements.routineAtr.value = '';
    elements.routineClose.disabled = true;
    elements.routineAtr.disabled = true;
    elements.routineSubmitBtn.disabled = true;
  });
}

// Recalculate fields in the Calculator panel
function calculatePosition() {
  const ticker = elements.calcTicker.value.trim();
  const entry = parseFloat(elements.calcEntry.value);
  const atr = parseFloat(elements.calcAtr.value);

  if (!ticker || isNaN(entry) || isNaN(atr) || entry <= 0 || atr <= 0) {
    elements.resPlannedRisk.textContent = "Rs. 0.00";
    elements.resInitialStop.textContent = "Rs. 0.00";
    elements.resRiskPerShare.textContent = "Rs. 0.00";
    elements.resPositionSize.textContent = "0 Shares";
    elements.executeTradeBtn.disabled = true;
    return;
  }

  const plannedRisk = state.accountValue * 0.01;
  const initialStop = entry - (2.5 * atr);
  const riskPerShare = entry - initialStop;
  
  elements.resPlannedRisk.textContent = `Rs. ${formatNPR(plannedRisk)}`;

  if (initialStop <= 0) {
    elements.resInitialStop.textContent = "Rs. 0.00 (ATR too high)";
    elements.resRiskPerShare.textContent = "N/A";
    elements.resPositionSize.textContent = "0 Shares";
    elements.executeTradeBtn.disabled = true;
    return;
  }

  elements.resInitialStop.textContent = `Rs. ${formatNPR(initialStop)}`;
  elements.resRiskPerShare.textContent = `Rs. ${formatNPR(riskPerShare)}`;

  const positionSize = Math.floor(plannedRisk / riskPerShare);

  if (positionSize > 0) {
    elements.resPositionSize.textContent = `${positionSize} Shares`;
    elements.executeTradeBtn.disabled = false;
  } else {
    elements.resPositionSize.textContent = "0 Shares (Risk per share too high)";
    elements.executeTradeBtn.disabled = true;
  }
}

// Render functions
function renderAll() {
  renderHeader();
  renderScanner();
  renderActiveTrades();
  renderDailyRoutineDropdown();
  renderHistory();
}

function renderHeader() {
  elements.headerAccountValue.textContent = formatNPR(state.accountValue);
  
  if (state.activeTrades.length > 0) {
    elements.strategyState.textContent = `INVESTED (${state.activeTrades.length} ACTIVE)`;
    elements.strategyState.className = "state-badge invested";
  } else {
    elements.strategyState.textContent = "CASH (100% FREE)";
    elements.strategyState.className = "state-badge cash";
  }
}

function renderScanner() {
  elements.scannerList.innerHTML = '';
  
  if (state.candidates.length === 0) {
    elements.scannerList.innerHTML = `
      <tr class="empty-row">
        <td colspan="4">No candidates added. Verify Stage 2, SMA & RS criteria first.</td>
      </tr>
    `;
    elements.useBestCandidateBtn.disabled = true;
    return;
  }

  elements.useBestCandidateBtn.disabled = false;

  // Rank and find best candidate (lowest % off 52w high)
  const bestValue = Math.min(...state.candidates.map(c => c.pctOff));

  state.candidates.forEach((candidate, idx) => {
    const isBest = candidate.pctOff === bestValue;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${candidate.ticker}</strong></td>
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
      const i = parseInt(e.currentTarget.getAttribute('data-index'));
      state.candidates.splice(i, 1);
      saveState();
    });

    elements.scannerList.appendChild(tr);
  });
}

function renderActiveTrades() {
  elements.portfolioList.innerHTML = '';
  elements.activeTradesCount.textContent = `${state.activeTrades.length} Open`;

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
    // Current hypothetical P&L based on last update
    const currentPrice = trade.lastClose || trade.actualPrice;
    const totalCost = trade.actualPrice * trade.shares;
    const currentVal = currentPrice * trade.shares;
    const pnl = currentVal - totalCost;
    const pnlPct = (pnl / totalCost) * 100;
    
    // Check if trailing stop triggered exit
    const stopTriggered = trade.highestClose < trade.trailingStop; // Normally we compare latest closing price, but since we update trailingStop daily, let's flag if trailing stop is below/above close. Wait, if closing price is below trailing stop, we must exit. Let's make sure we flag exit correctly.
    // Let's check: was the last updated close price below trailing stop? 
    // We will save `lastClose` in the trade object if we want. Yes, let's store `lastClose` when updated.
    const lastClose = trade.lastClose || trade.actualPrice;
    const isExitRequired = lastClose < trade.trailingStop;

    // Calculate actual risk % relative to entry account value
    const entryAccountValue = trade.accountValueAtEntry || state.accountValue;
    const actualRiskPerShare = 2.5 * trade.initialAtr;
    const actualRiskNpr = actualRiskPerShare * trade.shares;
    const actualRiskPct = (actualRiskNpr / entryAccountValue) * 100;

    const card = document.createElement('div');
    card.className = `trade-card ${isExitRequired ? 'alert-exit' : ''}`;
    
    card.innerHTML = `
      <div class="trade-card-header">
        <div class="trade-card-title">
          <h3>${trade.ticker}</h3>
          <span class="shares-badge">${trade.shares} Shares</span>
          <span class="risk-badge-mini" style="font-size: 0.65rem; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(255, 255, 255, 0.08); color: #f87171; padding: 0.15rem 0.4rem; border-radius: 4px; font-weight: 700; display: inline-flex; align-items: center; gap: 0.2rem;" title="Actual Risk % of your account value"><i class="fa-solid fa-shield-halved"></i> Risk: ${actualRiskPct.toFixed(2)}%</span>
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
          ${isExitRequired ? 
            `<span class="status-exit"><i class="fa-solid fa-triangle-exclamation"></i> EXIT SIGNAL: Sell at Open</span>` : 
            `<span class="status-check"><i class="fa-solid fa-circle-check"></i> Holding Pattern</span>`
          }
        </span>
        <button class="btn btn-secondary ${isExitRequired ? 'btn-danger-action' : ''}" style="padding: 0.4rem 0.8rem; font-size: 0.75rem;" data-index="${idx}">
          <i class="fa-solid fa-arrow-right-from-bracket"></i> Sell Position
        </button>
      </div>
    `;

    card.querySelector('button').addEventListener('click', (e) => {
      const i = parseInt(e.currentTarget.getAttribute('data-index'));
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
    elements.routineForm.className = "disabled-form";
    return;
  }

  elements.routineSelect.disabled = false;
  elements.routineClose.disabled = true; // Disabled until selection changes
  elements.routineAtr.disabled = true;
  elements.routineSubmitBtn.disabled = true;
  elements.routineForm.className = "";

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
    const riskPctStr = h.actualRiskPct ? `(${h.actualRiskPct.toFixed(2)}% of account)` : '';
    tr.innerHTML = `
      <td><strong>${h.ticker}</strong></td>
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

// Exit / Sell Position Action
function sellPosition(index) {
  const trade = state.activeTrades[index];
  const exitPriceStr = prompt(`Sell execution for ${trade.ticker}.\nEnter average actual sell price (NPR):`, trade.trailingStop.toFixed(2));
  
  if (exitPriceStr === null) return; // cancelled
  const exitPrice = parseFloat(exitPriceStr);

  if (isNaN(exitPrice) || exitPrice <= 0) {
    alert("Please enter a valid sell price.");
    return;
  }

  const exitDate = new Date().toLocaleDateString();
  const totalCost = trade.actualPrice * trade.shares;
  const totalRevenue = exitPrice * trade.shares;
  const pnl = totalRevenue - totalCost;
  const returnPct = (pnl / totalCost) * 100;

  // Calculate risk taken based on actual purchase to initial stop
  const riskPerShare = 2.5 * trade.initialAtr;
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

  // Archive trade
  state.history.unshift(historyItem);
  
  // Remove from active
  state.activeTrades.splice(index, 1);

  // Ask to adjust Account Value automatically by the P&L amount
  if (confirm(`Trade logged. Would you like to adjust your Account Value by the P&L amount of Rs. ${formatNPR(pnl)}?`)) {
    state.accountValue += pnl;
  }

  saveState();
}
