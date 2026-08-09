# ATR Desk // NEPSE Momentum Tracker

ATR Desk is a local-first NEPSE momentum workflow built with ReScript React, Vite and a typed strategy core. It keeps the market gate, ATR sizing, pending fills, active-trade updates, exits and recovery envelope on the device.

## Architecture

- `src/Domain.res` contains pure parsing, distribution-day, sizing, liquidity and exit accounting functions.
- `src/Reducer.res` contains the typed state transitions for candidates, index bars, orders, fills, updates, sales and reset/import.
- `src/Storage.res` owns versioned envelopes, legacy migration, rolling backup/recovery plans and normalization.
- `src/App.res` is the ReScript React signal desk. It persists through `Storage.planWrite`, exposes account/cost settings, import/export recovery, and keeps keyboard-accessible native controls.
- `src/styles.css` and `src/tokens.css` provide the responsive signal-desk theme without external CDNs. `vite-plugin-pwa` precaches the app and uses a network-first holiday cache with offline fallback.

## Commands

```bash
npm install
npm run dev       # local Vite server
npm run check     # ReScript compile, Vite build, regression + component tests
npm run test      # domain/storage regression and ReScript component tests
npm run test:component # focused Dialog/order guard tests only
npm run test:e2e  # Playwright smoke flows (requires a browser)
```

The production build is emitted to `dist/`. The app is static and can be hosted on GitHub Pages or any HTTPS static host. All ledger data remains in browser storage under the versioned `atr-desk:state:v2` key; the legacy `nepse_efficient_trader_state` key is migrated on first load. Use Backup to prepare an exact export envelope before moving devices or resetting.

The document-level CSP restricts scripts, styles, fonts, workers, connections, and form targets to the app origin. GitHub Pages does not provide per-project response-header configuration, so anti-framing directives such as `frame-ancestors` cannot be enforced there; a host with configurable HTTP headers should add `Content-Security-Policy: frame-ancestors 'none'`.

The strategy constants are one percent account risk per position, a five-slot portfolio, a 2.5 ATR stop and a ten-share minimum lot. The tool is a disciplined calculator and ledger, not a broker integration.
