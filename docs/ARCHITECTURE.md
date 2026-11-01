# AUREX architecture

## Runtime layers

- `src/` — React + TypeScript browser application.
- `server/` — authenticated Node.js API, Neon PostgreSQL persistence and market services.
- `python/` — optional Pro research sidecar; never persists live signals.
- `dist/` — production frontend output.
- `dist-server/` — bundled production Node.js API.
- `design/` — source-of-truth visual tokens shared by product and code.

## Frontend feature boundaries

- `src/features/terminal/` — Lightweight Chart, analysis panel, levels, signal timeline and Pro lab.
- `src/features/scanner/` — image scanner, pixel analysis and unlimited scanner trade plans.
- `src/features/signals/` — backend-connected Signals workspace and recent dashboard feed.
- `src/v1`, `src/v2`, `src/v3` — deterministic strategy domains shared by browser types and server execution.
- `src/services/api.ts`, `src/services/marketData.ts` — shared transport services; feature code never calls raw backend URLs directly.
- `src/styles/` — ordered base, theme, page and cold-glass visual layers.

## Data authority

1. `server/marketData.ts` is the only closed-candle source.
2. Server services invoke V1/V2/V3 pure engines.
3. Stores own limits, cooldowns, active slots and signal lifecycle persistence.
4. The chart consumes the same candles and only visualizes persisted decisions.
5. Python reports are research context and cannot create live signals.

## UI architecture rules

- Reuse tokens from `design/tokens.json` and CSS custom properties in `theme-cold.css`.
- Keep the chart as the dominant terminal surface.
- Secondary workflows belong in the tabbed Workspace Intelligence inspector.
- Green is reserved for BUY/open success, red for SELL/closed loss, amber for closed/warning, cyan for live data and violet for Pro-only features.
- Motion must preserve `prefers-reduced-motion` behavior.

## Build and verification

```bash
npm run build
npm run test:v1
npm run test:v2
npm run test:v3
npm run test:scanner
npm run test:market
npm run test:python
```
