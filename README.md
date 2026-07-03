# AURA // NEPSE ATR Momentum Tracker

A sleek, premium dark-mode web application designed to automate the calculations and routine management for the **Efficient Trader Strategy (ATR Momentum Version)** on the Nepal Stock Exchange (NEPSE).

---

## The Strategy

This tracker strictly automates the mathematical rules of the **Efficient Trader Strategy**:

1. **Find the Stock**: Run Stage 2 filters on NepseAlpha (SMA rising, high RS, < 10% from 52-week high) and pick the stock closest to its high.
2. **Planned Entry**: Determine planned entry price.
3. **Calculate Position Sizing**: Compute position size based on a strict 1% account risk threshold.
4. **Execution Check**: Verify that actual average entry price is not > 2% higher than planned (safety check).
5. **Set Stop**: Define initial stop at $2.5 \times \text{ATR}(14)$ distance.
6. **Trailing Stop**: Raise stop only if the new candidate stop is higher than the previous stop.
7. **Exit**: Trigger sell warning if the closing price drops below the trailing stop.

---

## Features

- **Account Capital Management**: Track account value and compute exact risk values automatically.
- **Super Performance Scanner**: Input prospective stocks and immediately find the best-performing candidate.
- **Position Sizing Calculator**: Computes stops, risk-per-share, and suggests exact rounded share amounts.
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

- **Max Risk Amount**:
  $$\text{Max Risk} = \text{Account Value} \times 0.01$$

- **Risk Per Share**:
  $$\text{Risk Per Share} = 2.5 \times \text{ATR}(14)$$

- **Initial Stop**:
  $$\text{Initial Stop} = \text{Average Execution Price} - (2.5 \times \text{ATR}(14))$$

- **Candidate Stop**:
  $$\text{Candidate Stop} = \text{Highest Close Since Entry} - (2.5 \times \text{ATR}(14))$$

- **Trailing Stop**:
  $$\text{Trailing Stop} = \max(\text{Previous Stop}, \text{Candidate Stop})$$
