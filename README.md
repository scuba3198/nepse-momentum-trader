# ATR Desk // NEPSE Momentum Tracker

A dark-mode-first (with light mode toggle), fully client-side web dashboard that automates the calculations and daily routine for the **Efficient Trader Strategy (ATR Momentum Version)** on the Nepal Stock Exchange (NEPSE).

**Live App**: [scuba3198.github.io/nepse-momentum-trader](https://scuba3198.github.io/nepse-momentum-trader/)

---

## The Strategy

The tracker enforces the mathematical rules of the **Efficient Trader Strategy** step by step:

0. **Distribution Day Counter**: Upload the NEPSE index's adjusted price CSV (exported from NepseAlpha) or paste bars manually. The app counts distribution days (index closes lower on higher volume than the prior bar) over the trailing 25 trading days, and a Follow-Through Day (a ≥1.5% up day on higher volume) resets the count. Fewer than two valid index sessions is blocked until there is enough history to establish a market state. 0–2 days is Normal, 3–4 is Caution (advisory — new entries are still allowed, just be more selective), and **5+ is "Under Distribution," which hard-blocks placing new day-orders** until the count drops or a new Follow-Through Day resets it. This gate only stops new entries — it never touches pending orders already placed or open positions, which keep re-pricing, filling, trailing, and exiting normally. Weekends are excluded automatically; maintain the closed-session list from current NEPSE notices for holidays and ad-hoc closures.
1. **Screener Shortlist**: Paste rows directly from NepseAlpha's Minervini SEPA screener table (`Symbol, Final, Trend Template, VCP, EPS, Sales, Margin, RS`). A candidate must clear **both** the Trend Template score and RS score (≥ 75 each) to pass the gate. Passers are ranked by RS score (leadership strength) first, VCP Pattern Score as a tiebreaker. The default "Top 5" view applies a stricter bar on top of the gate — RS ≥ 90 and VCP ≥ 75 — matching the app's 5 portfolio slots; other filter views (All Passing / Failing / All) are available too. VCP alone never gates or ranks a stock on its own — it's an entry-timing read (No Base Yet / Forming / Tight Base).
2. **Planned Entry & Position Sizing**: Enter a planned entry price and current ATR(14) for a shortlisted ticker. Position size is computed so each position risks exactly **1% of account value** (up to 5% total across 5 portfolio slots), with a live capital-concentration check (flags positions eating >20%/>40% of account capital), a minimum-lot-size warning below 10 shares, and an optional liquidity check (position size vs. average daily turnover, pasted straight from NepseAlpha's rotation table).
3. **Place GTC Day Order**: Placing an order is blocked if all 5 portfolio slots (open positions + pending orders) are committed, if the ticker already has an order or position open, if there isn't enough cash for the sized position, if today is not a configured NEPSE session, or if the Distribution Day Counter is hard-gated (see Step 0). Otherwise it's logged as a pending day order. NEPSE cancels day orders at session end, so each trading day you log the close and fresh ATR(14); the tool re-prices the order and its stop and resubmits automatically (capping the re-priced size to available cash). A log is idempotent per trading date, so repeated clicks cannot duplicate fills or consume attempts. It auto-cancels if unfilled after 5 daily attempts, or the moment a day's close breaks that day's current stop. Partial fills accumulate toward a running fill VWAP across multiple days and retain their first-fill date.
4. **Set Stop**: Once filled (fully or via the 5-attempt/stop-breach cutoff, converting whatever did fill), the initial stop is set at the actual VWAP purchase price minus 2.5 × ATR(14).
5. **Trailing Stop**: Updated daily via the Daily Routine form; only ever raised, never lowered — `new stop = max(previous stop, highest close since entry − 2.5×ATR)`.
6. **Exit**: An exit warning is triggered the moment the logged closing price drops below the trailing stop. Selling supports partial/multi-day exits with a running exit VWAP — the trailing stop stays active on whatever remains until the position is fully closed — and once a position is fully exited and a slot frees up, the app prompts you to rescan the screener for a replacement.

---

## Features

- **Distribution Day Counter**: Upload a NepseAlpha index CSV export or paste bars manually (`Date Close Volume`, one per line); tolerant of header rows and extra whitespace. Tracks the trailing distribution-day count, detects Follow-Through Days, and hard-blocks new day-order placement once the count is severe.
- **Account Capital Management**: Track account value, actual settled cash, and realized P&L separately; partial fills/sales update the cash ledger immediately so losses cannot create phantom buying power. Manual account-value adjustments keep the cash ledger aligned.
- **Screener Shortlist**: Bulk-paste parser handles NepseAlpha's copy format (tab/space-separated rows, or one field per line), auto-skips header/malformed rows, and lets you filter the shortlist by Top 5 / All Passing / Failing / All.
- **Position Sizing Calculator**: Computes stop, risk-per-share, suggested share count (rounded down, with a minimum-lot-size warning below 10 shares), required capital vs. available cash, capital concentration %, and an optional liquidity/ADV check — all live as you type.
- **Pending Orders (Daily Re-Priced Day Orders)**: Log each trading session's close, ATR, and any shares actually filled in your TMS. The tool handles date-idempotent logging, re-pricing, cash-availability capping on re-priced size increases, stop-breach cancellation, the 5-day attempt cap, and converting completed/partial fills into an active trade — applying the fill-day close/ATR and preserving the first actual fill date so late conversions can trigger catch-up updates.
- **Active Trades**: Live P&L, actual risk % (accounting for share rounding and real fill price), trailing stop, highest close, and an exit signal banner when the trailing stop is breached.
- **Partial & Multi-Day Selling**: Log a sale of any size against a position; the app tracks a running exit VWAP and keeps the trailing stop active on whatever remains until the position is fully closed.
- **Daily Routine**: A single form to update an active trade's close/ATR, recompute the trailing stop, and surface exit signals.
- **Historical Log & P&L**: Closed trades are archived with entry/exit price, shares, risk taken, P&L, and return %; realized P&L is applied once per sale tranche to the account-value and cash ledgers.
- **Import / Export**: Full state export to a timestamped JSON file, with tolerant re-import (accepts wrapped or raw state objects, validates nested orders/trades/history and dates, sanitizes malformed fields, escapes display strings, and reports how many records were dropped rather than importing silently).
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
- The Distribution Day Counter reads whatever index CSV/bars you upload — it doesn't fetch NEPSE index data itself.
- State lives entirely in one browser's `localStorage`; use Export/Import to move data between devices or back it up.
- Portfolio is fixed at 5 slots and 1% risk per position (5% total); these are strategy constants, not user-configurable settings.
