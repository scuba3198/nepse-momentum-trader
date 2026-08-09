# ATR Desk // NEPSE Momentum Tracker

ATR Desk is a private, local-first NEPSE momentum workflow built with ReScript 12, React 19 and Vite. It keeps the market gate, ATR sizing, pending-order lifecycle, trailing stops, exits, transaction costs and cash ledger on the device.

The production app is hosted at [scuba3198.github.io/nepse-momentum-trader](https://scuba3198.github.io/nepse-momentum-trader/).

## What it does

- Classifies the market from pasted index sessions, including distribution days, rally attempts and follow-through days.
- Ranks pasted screener candidates with the existing TT, RS and VCP thresholds.
- Sizes five portfolio slots at 1% account risk with 2.5× ATR stops and cash/liquidity guards.
- Tracks partial fills, VWAP, daily repricing, five-attempt cancellation, backfilled updates, trailing stops, partial sales, fees and realized P&L.
- Stores everything locally. There are no accounts, analytics, broker connections or live market feeds.
- Installs as a PWA and keeps the app shell available offline. New builds require an explicit Reload action.

## Run locally

Node.js 22 or newer and npm are required. Dependency versions are pinned in `package-lock.json`.

```bash
npm ci
npm run dev
```

Vite serves the app with the same `/nepse-momentum-trader/` base path used by GitHub Pages.

## Checks

```bash
npm run format:check   # ReScript formatting
npm run check          # compile, production build, unit and component tests
npm run test:unit      # domain, reducer, migration and storage regressions
npm run test:component # dialog, calendar, order guard and PWA prompt tests
npx playwright install # first browser-test run only
npm run test:e2e       # Chromium, Firefox, WebKit, mobile, offline and axe checks
```

## Architecture

- `src/Domain.res` contains the pure trading rules, parsers, accounting, migration normalization and Kathmandu date handling.
- `src/Reducer.res` handles every typed action and returns `result<state, domainError>`.
- `src/Storage.res` owns versioned envelopes, validation, rolling backups and recovery plans.
- `src/App.res` renders the ReScript React signal desk and keeps browser effects at the edge.
- `src/Browser.res`, `src/Pwa.res` and `src/RecoveryBoundary.res` isolate browser, service-worker and failure-recovery integrations.
- `src/styles.css` and `src/tokens.css` provide the responsive signal-desk design with locally bundled Fraunces, Inter and IBM Plex Mono fonts.

## Data and recovery

Portfolio data is saved under the versioned `atr-desk:state:v2` localStorage key. On first launch, the legacy `nepse_efficient_trader_state` value is decoded field-by-field, preserved untouched in recovery storage and migrated automatically.

If the primary value is damaged, loading falls back to the newest valid rolling backup and then the untouched recovery copy. Backup & recovery can export the current ledger before an import or reset. Exports use this envelope:

```json
{
  "format": "atr-desk",
  "schemaVersion": 1,
  "exportedAt": "ISO-8601 timestamp",
  "state": {}
}
```

Imports accept this envelope, the previous wrapped export and raw legacy state. Reset requires confirmation and clears primary, backup, recovery and legacy keys.

## Holidays, CI and deployment

`holidays.json` is a validated versioned contract. The app loads it network-first and retains the last valid local copy; only new entries are blocked when no valid calendar is available. Existing orders and positions remain manageable.

Pull requests and pushes run formatting, compilation, unit/component tests, a production PWA build and Chromium/Firefox/WebKit smoke tests. Merges to `master` deploy `dist/` through GitHub Pages Actions. The separate holiday synchronization workflow validates a complete replacement before committing it.

The document-level CSP restricts scripts, styles, fonts, workers, connections and forms to the app origin. GitHub Pages cannot set project-specific anti-framing response headers; a configurable host should additionally send `Content-Security-Policy: frame-ancestors 'none'`.

ATR Desk is a disciplined calculator and journal, not financial advice or an order-entry system.
