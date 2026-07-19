# ATR Desk // NEPSE Momentum Tracker

A dark-mode-first (with light mode toggle), fully client-side web dashboard that automates the calculations and daily routine for the **Efficient Trader Strategy (ATR Momentum Version)** on the Nepal Stock Exchange (NEPSE).

**Live App**: [scuba3198.github.io/nepse-momentum-trader](https://scuba3198.github.io/nepse-momentum-trader/)

---

## The Strategy

The tracker enforces the mathematical rules of the **Efficient Trader Strategy** step by step:

0. **Macro Filter**: Confirm Stage 2 (Uptrend) is the market regime with the highest stock count on NepseAlpha's Stage Analysis chart before opening new positions. Answering "No" halts trading and auto-cancels any outstanding GTC orders (unfilled shares are dropped; already-filled shares are kept as active trades).
1. **Screener Shortlist**: Paste rows directly from NepseAlpha's Minervini SEPA screener table (`Symbol, Final, Trend Template, VCP, EPS, Sales, Margin, RS`). A candidate must clear **both** the Trend Template score and RS score (≥ 75 each) to pass the gate. Passers are ranked by RS score (leadership strength) first, VCP Pattern Score as a tiebreaker — VCP alone never gates or ranks a stock, it's an entry-timing read (No Base Yet / Forming / Tight Base).
2. **Planned Entry**: Enter the planned entry price for a shortlisted ticker.
3. **Calculate Position Sizing**: Position size is computed so each position risks exactly **1% of account value** (up to 5% total across 5 portfolio slots), with a live capital-concentration check (flags positions eating >20%/>40% of account capital) and an optional liquidity check (position size vs. average daily turnover, pasted straight from NepseAlpha's rotation table).
4. **Place GTC Limit Order**: Logged as a pending day order. NEPSE cancels day orders at session end, so each day you log the close and fresh ATR(14); the tool re-prices the order and its stop and resubmits automatically. It auto-cancels if unfilled after 5 trading day attempts, or the moment a day's close breaks that day's stop. Partial fills accumulate toward a running fill VWAP across multiple days.
5. **Set Stop**: Once filled, the initial stop is set at the actual (VWAP) purchase price minus 2.5 × ATR(14).
6. **Trailing Stop**: Updated daily; only ever raised, never lowered — `new stop = max(previous stop, highest close since entry − 2.5×ATR)`.
7. **Exit**: An exit warning is triggered the moment the logged closing price drops below the trailing stop. Selling supports partial/multi-day exits with a running exit VWAP, and can prompt you to rescan for a replacement once a slot frees up (if the macro filter is still passing).

---

## Features

- **Account Capital Management**: Track account value and auto-derive every risk figure from it; account value can be adjusted at any time, including retroactively by realized P&L on trade close.
- **Screener Shortlist**: Bulk-paste parser handles NepseAlpha's copy format (tab/space-separated rows, or one field per line), auto-skips header/malformed rows, and lets you filter the shortlist by Top 5 / All Passing / Failing / All.
- **Position Sizing Calculator**: Computes stop, risk-per-share, suggested share count (rounded down, with a minimum-lot-size warning below 10 shares), required capital vs. available cash, capital concentration %, and an optional liquidity/ADV check — all live as you type.
- **Pending Orders (Daily Re-Priced Day Orders)**: Log each trading day's close, ATR, and any shares actually filled in your TMS. The tool handles re-pricing, cash-availability capping on re-priced size increases, stop-breach cancellation, the 5-day attempt cap, and converting completed/partial fills into an active trade — all with the account-value-at-entry preserved so risk % stays accurate no matter how many days a fill takes.
- **Active Trades**: Live P&L, actual risk % (accounting for share rounding and real fill price), trailing stop, highest close, and an exit signal banner when the trailing stop is breached.
- **Partial & Multi-Day Selling**: Log a sale of any size against a position; the app tracks a running exit VWAP and keeps the trailing stop active on whatever remains until the position is fully closed.
- **Daily Routine**: A single form to update an active trade's close/ATR, recompute the trailing stop, and surface exit signals.
- **Historical Log & P&L**: Closed trades are archived with entry/exit price, shares, risk taken, P&L, and return %; you're prompted to fold realized P&L back into account value.
- **Import / Export**: Full state export to a timestamped JSON file, with tolerant re-import (accepts wrapped or raw state objects, sanitizes malformed numeric fields, and reports how many records were dropped rather than importing silently).
- **Light / Dark Mode**: Toggle in the header, persisted in `localStorage` and defaulting to your OS preference on first load.
- **Privacy First**: Fully client-side. All data lives in your browser's `localStorage` (`nepse_efficient_trader_state`); nothing is sent anywhere.

---

## Installation & Running Locally

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/scuba3198/nepse-momentum-trader.git
   cd nepse-momentum-trader
   ```

2. **Run a Local Web Server** (needed for the app's assets to load correctly — opening `index.html` directly via `file://` is not recommended):
   ```bash
   python -m http.server 5000
   # or
   npx serve -l 5000
   ```

3. **Access the App**: Open `http://localhost:5000` in your browser.

No build step, no dependencies to install — it's plain HTML/CSS/JS plus FontAwesome and Google Fonts loaded from CDN.

---

## Key Calculations Implemented

- **Max Risk per Position**:
  $$\text{Max Risk} = \text{Account Value} \times 1\%$$

- **Planned/Initial Stop**:
  $$\text{Stop} = \text{Entry Price} - (2.5 \times \text{ATR}(14))$$

- **Risk Per Share**:
  $$\text{Risk Per Share} = \text{Entry Price} - \text{Stop}$$

- **Position Size**:
  $$\text{Position Size} = \left\lfloor \frac{\text{Max Risk}}{\text{Risk Per Share}} \right\rfloor$$

- **Initial Stop (after fill)**:
  $$\text{Initial Stop} = \text{Actual VWAP Purchase Price} - (2.5 \times \text{ATR}(14))$$

- **Candidate Stop**:
  $$\text{Candidate Stop} = \text{Highest Close Since Entry} - (2.5 \times \text{ATR}(14))$$

- **Trailing Stop**:
  $$\text{Trailing Stop} = \max(\text{Previous Stop}, \text{Candidate Stop})$$

---

## Notes & Limitations

- All prices, ATR values, and screener scores are entered manually — there is no live market data feed or broker integration. The app is a calculator and routine-tracker, not an execution engine.
- State lives entirely in one browser's `localStorage`; use Export/Import to move data between devices or back it up.
- Portfolio is fixed at 5 slots and 1% risk per position (5% total); these are strategy constants, not user-configurable settings.


---

## Installation & Running Locally

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/scuba3198/nepse-momentum-trader.git
   cd nepse-momentum-trader
   ```

2. **Run a Local Web Server**:
   You can run the dashboard using any local HTTP server. For example, using Python:
   ```bash
   python -m http.server 5000
   ```
   Or using Node.js:
   ```bash
   npx serve -l 5000
   ```

3. **Access the App**:
   Open your browser and navigate to `http://localhost:5000`.

---

## Key Calculations Implemented

- **Max Risk per Position**:
  $$\text{Max Risk} = \text{Account Value} \times 1\%$$

- **Planned/Initial Stop**:
  $$\text{Stop} = \text{Entry Price} - (2.5 \times \text{ATR}(14))$$

- **Risk Per Share**:
  $$\text{Risk Per Share} = \text{Entry Price} - \text{Stop}$$

- **Position Size**:
  $$\text{Position Size} = \left\lfloor \frac{\text{Max Risk}}{\text{Risk Per Share}} \right\rfloor$$

- **Initial Stop (after fill)**:
  $$\text{Initial Stop} = \text{Actual Average Purchase Price} - (2.5 \times \text{ATR}(14))$$

- **Candidate Stop**:
  $$\text{Candidate Stop} = \text{Highest Close Since Entry} - (2.5 \times \text{ATR}(14))$$

- **Trailing Stop**:
  $$\text{Trailing Stop} = \max(\text{Previous Stop}, \text{Candidate Stop})$$
