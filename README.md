# AURA // NEPSE ATR Momentum Tracker

A sleek, premium dark-mode web application designed to automate the calculations and routine management for the **Efficient Trader Strategy (ATR Momentum Version)** on the Nepal Stock Exchange (NEPSE).

**Live App**: [scuba3198.github.io/nepse-momentum-trader](https://scuba3198.github.io/nepse-momentum-trader/)

---

## The Strategy

This tracker strictly automates the mathematical rules of the **Efficient Trader Strategy**:

0. **Macro Filter**: Confirm Stage 2 is the dominant market regime before opening new positions; a failed filter auto-cancels any outstanding GTC orders.
1. **Find the Stock**: Run Stage 2 filters on NepseAlpha (SMA rising, high RS, < 10% from 52-week high) and pick the stock closest to its high.
2. **Planned Entry**: Determine planned entry price.
3. **Calculate Position Sizing**: Compute position size so each position risks exactly **1% of account value** (5% total across 5 slots).
4. **Place GTC Limit Order**: Log the order as pending. It auto-cancels if unfilled after 5 trading days, or if a day's close drops below the planned stop.
5. **Set Stop**: Once filled, define the initial stop at the actual average purchase price minus $2.5 \times \text{ATR}(14)$.
6. **Trailing Stop**: Raise stop only if the new candidate stop is higher than the previous stop.
7. **Exit**: Trigger sell warning if the closing price drops below the trailing stop.

---

## Features

- **Account Capital Management**: Track account value and compute exact risk values automatically.
- **Position Sizing Calculator**: Computes stops, risk-per-share, and suggests exact rounded share amounts using a strict 1%-of-account risk per position.
- **Pending Orders (Daily Re-Priced Day Orders)**: Places a Day Order that's cancelled by NEPSE at session end and manually resubmitted each day at the *previous close*, since NEPSE's daily circuit band is computed off the prior close and a stale multi-day limit price can drift outside the tradeable range. Each day's close and fresh ATR(14) reprice both the order and its stop (`new stop = new price − 2.5×ATR`); since risk-per-share is always `2.5×ATR` by construction, the target share count is recomputed daily from ATR alone. There's no cap on how far the price can drift day to day — the only hard stops are (1) the close breaking the *current* day's stop, which cancels immediately, or (2) hitting 5 total day-order attempts. Shares already filled from earlier days are never discarded — only the unfilled remainder is dropped on cancellation. Selling is symmetric: log a partial sale any day liquidity can't absorb the full exit, and the tool tracks a running exit VWAP until the position is fully closed.
- **Actual Risk % Log**: Visualizes exact capital risk (e.g. `Risk: 0.94%`) on every active trade card to account for share rounding and execution pricing.
- **Daily Updates & Exits**: Enter daily prices/ATR values to automatically adjust trailing stops and generate instant exit flags.
- **Historical Log & P&L Adjustment**: Archive closed positions and auto-adjust account equity based on realized profit/loss.
- **Privacy First**: Fully client-side web application. All data is saved inside your browser's local storage (`localStorage`).

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
