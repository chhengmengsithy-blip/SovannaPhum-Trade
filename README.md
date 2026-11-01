# SOVANNAPHUMTRADE Market Analysis Platform

React + TypeScript frontend with a Node.js API, Neon PostgreSQL database and an optional
Python research sidecar for Pro analytics.

## Features

- Public landing page with Free / Plus / Pro pricing
- Account system: email signup + login (Gmail/Telegram sign-in gated behind `ALLOW_SOCIAL_SIMULATION=1` for local testing only)
- Server sessions with an HttpOnly cookie (survives reloads)
- Protected workspace and admin dashboard
- Owner account with Pro forever
- TradingView Lightweight Charts with REST history and WebSocket quotes for 11 markets
- Public homepage market strip backed by the real Yahoo Finance quote endpoint
- Animated Engine → Scan → Score → Result product pipeline with no fabricated market metrics
- On-demand **V1 FREE** BUY/SELL/NO SIGNAL engine on closed candles
- Deterministic scoring: EMA 30, RSI+MACD 25, Supertrend 20, structure 25 (must exceed 60)
- Dynamic swing + ATR stop loss, structural TP1/TP2 and optional TP3
- One active signal at a time; a new setup unlocks after TP1 is hit
- Daily FREE limits (20 analyses / 3 signals, UTC) enforced by the server
- On-demand **V2 PLUS** engine with 3L/3R structure, SMC/ICT zones,
  price-action confirmation and a 12-symbol market scanner
- On-demand **V3 PRO** engine with nine Auto/Manual playbooks, Low/Medium/High
  quality presets, a 100-point decision, SMC/ICT zones and unlimited use
- Pro Python Playbook Lab for independent rankings, volatility, Fibonacci,
  supply/demand and S/R research (never used to bypass the live engine)
- Cold glass UI, responsive 3D motion, full persisted signal timeline and
  candle-anchored historical BUY/SELL markers even while markets are closed
- Backend-connected Signals workspace and dashboard feed with V1/V2/V3 filters,
  status, scores and frozen Entry/SL/TP levels
- Unlimited Plus/Pro image Chart Scanner with BUY/SELL, real Entry Zone, SL and
  TP1/TP2/TP3 derived from the selected market's closed candles
- KHQR checkout (Plus $5 / Pro $15) with server-issued QR payloads
- Telegram alert linking
- Neon PostgreSQL persistence for users, sessions, payments and gateway settings

## Requirements

- Node.js 22.20+ (Node 24/26 recommended)
- npm
- A Neon project with pooled and direct PostgreSQL connection strings
- Python 3.11+ for the optional Pro Playbook Lab (standard library only)

## Project structure

- `src/features/terminal/` — chart, analysis inspector, levels, history and Pro Lab
- `src/features/scanner/` — screenshot scanner and unlimited scanner plans
- `src/features/signals/` — backend-connected signals workspace
- `src/services/` — authenticated API and WebSocket market transports
- `src/config/` — shared market/timeframe configuration
- `src/styles/` — ordered base, page and cold-glass theme layers
- `src/v1`, `src/v2`, `src/v3` — pure deterministic strategy domains
- `server/` — Node.js API and Neon PostgreSQL persistence
- `python/` — isolated research sidecar
- `design/tokens.json` — visual design tokens
- `docs/ARCHITECTURE.md` — architecture and data-authority rules

## Run locally

Install dependencies once:

```bash
npm install
```

Start the Python lab (`8790`), API (`8787`) and Vite together:

```bash
npm run dev:all
```

Or use two terminals:

```bash
npm run server
npm run dev
```

Vite proxies `/api` and `/ws` to the backend, so open the URL Vite prints
(default `http://localhost:5173`).

## Production build

Build the browser app and the typed Node.js backend together:

```bash
npm run build
```

This writes the frontend to `dist/` and an esbuild ESM backend bundle plus source
map to `dist-server/`. Run the production server from the project root so it can
serve `dist/` and load the configured Neon environment variables:

```bash
npm run start:prod
```

For the Pro Playbook Lab, run the Python sidecar in a second process:

```bash
npm run python:research
```

The frontend and backend can also be built independently with
`npm run build:frontend` and `npm run build:backend`. The backend build runs
strict TypeScript checking through `tsconfig.server.json` before bundling.

## Admin account

Created (or refreshed) every time the server starts:

- Email: `Sithy@dev.pro`
- Password: `Sithy123$$`
- Role: `admin`
- Plan: **Pro forever** (cannot be downgraded)

Open `/admin` for accounts, plan switching, deletions and the KHQR gateway.

## Database

The backend uses Neon PostgreSQL through `pg`. Normal application requests use
the pooled `DATABASE_URL`; migrations and imports use the direct
`DATABASE_URL_UNPOOLED`.

Link a Neon project and pull its environment variables (the Neon CLI writes to
`.env` when it exists, otherwise `.env.local`):

```bash
neon link
neon env pull
npm run db:migrate
```

Schema changes are append-only migrations in `server/schema.ts`. The server also
checks and applies pending migrations at startup with the direct connection.

To import the existing ignored SQLite database into Neon without deleting rows
already present in PostgreSQL:

```bash
npm run db:import:sqlite -- --source server/data/sovan.db
```

Tables:

| Table | Purpose |
| --- | --- |
| `users` | accounts, roles, plans, provider, Telegram handle |
| `sessions` | server-side sessions referenced by an HttpOnly cookie |
| `payments` | KHQR checkout attempts, bill numbers, status |
| `khqr_config` | Bakong merchant ID, name, city, demo mode |
| `v1_usage` | per-user daily V1 analysis/signal counters (UTC day) |
| `v1_signals` | frozen V1 signal payloads, lifecycle status and active slot |
| `v2_usage` | per-user daily V2 analysis/signal/scanner counters (UTC day) |
| `v2_signals` | frozen V2 signal payloads, lifecycle status and 30-day history |
| `v3_usage` | per-user daily V3 telemetry (no caps are enforced) |
| `v3_signals` | frozen V3 signal payloads, lifecycle status, one-active-slot index and 365-day history |
| `v3_backtests` | saved V3 backtest reports (JSON payload per run) |

Keep the old SQLite file until the imported row counts and application flows
have been verified. `SQLITE_SOURCE_PATH` can set its default import location.

## Payments

Checkout creates a pending payment on the server and returns an EMVCo KHQR
payload which the browser renders as a QR code.

**Real mode only (production default):**
- Set a real Bakong account ID in Admin → Payments (format: `yourname@bankcode`, e.g. `sithy@aclb`).
- Free email domains (gmail, yahoo, outlook, etc.) are rejected.
- Provide `BAKONG_TOKEN` from the Bakong Open API.
- The server verifies the bill with `https://api-bakong.nbc.gov.kh/v1/check_transaction_by_md5` before activating the plan.
- Payment amount and currency (USD) are validated against the plan price.

**Demo mode (local testing only):**
- Enable by setting `ALLOW_DEMO_PAYMENTS=1` in the environment.
- Pressing “I have paid” confirms the payment without Bakong verification.
- Not available when `BAKONG_TOKEN` is configured.

The merchant Bakong ID and token never reach the browser.

## API

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/health` | status, account count, demo mode, KHQR readiness, social simulation |
| `GET` | `/api/market/public` | rate-limited real Yahoo quotes for the public homepage |
| `POST` | `/api/auth/signup` | create an account |
| `POST` | `/api/auth/login` | email + password login |
| `POST` | `/api/auth/gmail` | Gmail sign-in (requires `ALLOW_SOCIAL_SIMULATION=1`) |
| `POST` | `/api/auth/telegram` | Telegram sign-in (requires `ALLOW_SOCIAL_SIMULATION=1`) |
| `POST` | `/api/auth/logout` | destroy session |
| `GET` | `/api/auth/me` | current account |
| `PATCH` | `/api/auth/telegram` | link/unlink a Telegram handle |
| `POST` | `/api/payments/checkout` | create a KHQR payment |
| `GET` | `/api/payments` | payment history |
| `GET` | `/api/payments/:id` | payment status |
| `POST` | `/api/payments/:id/confirm` | verify and activate a plan |
| `GET` | `/api/admin/users` | list accounts (admin) |
| `PATCH` | `/api/admin/users/:id` | change a plan (admin) |
| `DELETE` | `/api/admin/users/:id` | delete an account (admin) |
| `GET`/`PUT` | `/api/admin/khqr` | read/update gateway settings |
| `GET` | `/api/admin/payments` | recent payments (admin) |
| `POST` | `/api/analyze` | run V1 on a closed candle (`{ symbol, timeframe }`) |
| `POST` | `/api/analyze/v2` | run V2 PLUS on a closed candle (Plus only) |
| `POST` | `/api/scan/v2` | scan up to 12 symbols with V2 (Plus only) |
| `POST` | `/api/analyze/v3` | run V3 PRO on a closed candle (Pro only) |
| `POST` | `/api/scan/v3` | scan any number of symbols with V3 (Pro only) |
| `GET` | `/api/signals?symbol=&timeframe=` | persisted V1/V2/V3 chart events and history |
| `POST` | `/api/pro/research` | Python Playbook Lab report (Pro only) |

`POST /api/analyze` requires a signed-in session. It returns the full
`V1Analysis`: action (`BUY` / `SELL` / `NO_SIGNAL`), weighted score, structure,
indicator snapshot, frozen levels, remaining daily limits and any existing active
signal. It never trusts a client-side decision.

`POST /api/analyze/v2` and `POST /api/scan/v2` return `V2Analysis` / `ScanResult`.
They refuse every plan except Plus with HTTP 403 and are fully separate from V1:
different tables, counters, scoring, risk rules and signals.

`POST /api/analyze/v3` and `POST /api/scan/v3` return `V3Analysis` / `ScanResult`.
They refuse every plan except Pro with HTTP 403. Pro accounts cannot call the V2
routes, so the three engines never share a decision, a counter or a table.

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

```bash
cp .env.example .env
```

Important values: `PORT`, `APP_ORIGIN`, `DATABASE_URL`,
`DATABASE_URL_UNPOOLED`, `DB_POOL_MAX`, `SESSION_DAYS`,
`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `KHQR_*`, `ALLOW_DEMO_PAYMENTS`,
`BAKONG_TOKEN`, `COOKIE_SECURE`. Optional Neon Object Storage credentials use
the standard server-side `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and `AWS_REGION` variables.

## Production

```bash
npm run build
npm run start
```

The server serves `dist/` and the API from the same origin on port `8787`.
For a real deployment use HTTPS, set `COOKIE_SECURE=1`, a strong
`ADMIN_PASSWORD`, and `APP_ORIGIN` to your public domain.

## Security notes

- Passwords are hashed with scrypt and a per-user salt.
- Sessions are opaque random tokens stored server-side; the cookie is HttpOnly
  and SameSite=Lax.
- All SQL uses prepared statements.
- Admin routes require an authenticated admin role.
- Gmail/Telegram sign-in is still a local simulation until OAuth bot
  credentials are configured.

## Market data

The terminal renders the official `lightweight-charts` candlestick and volume
series in `src/LightweightChart.tsx`; there is no cross-origin iframe. Historical
OHLCV loads from authenticated `GET /api/market/candles`, while current quotes
arrive through `/ws/market`. The server obtains both from real Yahoo Finance
instruments and never substitutes generated candles.

`server/marketData.ts` is the single closed-candle source for the chart and all
three strategy services. It drops the still-forming upstream bar, stores each
candle at its close time, builds 4H candles from complete 1H buckets, and caches
results for 15 seconds. An Analyze response also returns the exact candle array
used by its engine, which replaces the chart's closed series to guarantee a
visual/data match.

| Workspace | Yahoo Finance |
| --- | --- |
| XAUUSD | `GC=F` |
| XAGUSD | `SI=F` |
| EURUSD / GBPUSD / USDJPY / AUDUSD | `EURUSD=X` / `GBPUSD=X` / `USDJPY=X` / `AUDUSD=X` |
| BTCUSD / ETHUSD / SOLUSD / XRPUSD | `BTC-USD` / `ETH-USD` / `SOL-USD` / `XRP-USD` |
| US100 | `^NDX` |

The WebSocket quote may update a separate forming display candle and the LAST
line. That candle is never sent to V1/V2/V3. Native series markers bind historical
BUY/SELL records to exact candle timestamps, so markers follow zoom, pan and
resize. Entry-zone bounds, Entry, SL and TP lines are created only from a manual
Analyze response. To add a market, update `markets` in `src/App.tsx` and
`MARKET_SYMBOLS` in `server/marketData.ts`.

All clocks, chart labels, analysis timestamps and trade-history times are shown
in Cambodia time (`Asia/Phnom_Penh`, ICT / UTC+7). Display session state is
calculated in `src/marketSession.ts`: crypto remains Live 24/7, forex and metals
follow the New York Sunday 17:00 through Friday 17:00 trading week, and US100
follows regular Nasdaq hours. Closed weekend markets switch from Live to Closed
without pretending that an unchanged quote is streaming.

## Analyze button

`/terminal` runs an official signal decision only when the user clicks Analyze.
The request is routed to V1, V2 or V3 according to the account plan. Valid
BUY/SELL results are persisted and placed on the chart; daily caps, active slots,
duplicate cooldowns and plan gates remain enforced.

The V1 engine (`src/v1/`) runs on the server and only evaluates the newest
**closed** candle. A BUY requires a bullish EMA trend, bullish confirmed
structure, a fresh bullish BOS/CHoCH, RSI/MACD momentum support and a bullish
Supertrend. SELL is the mirror. The weighted score must be higher than 60,
but the hard gates above are not optional.

- Score: EMA 30, RSI + MACD 25, Supertrend 20, structure 25.
- Stop loss: confirmed swing ± ATR buffer (gold/silver 0.20, forex 0.15,
  crypto 0.25), with 0.20–3.0 ATR and market risk caps.
- TP1 must reach at least 1R from a real structural level. TP2 is the next
  structure target; TP3 is optional. Targets are never invented to force R
  multiples.
- Timeframes `5m/15m/30m/1H/4H` are independent; there is no mandatory
  higher-timeframe confirmation.
- Duplicate setups on the same bar and inside the 3-bar cooldown are rejected.
- One active signal per account. It is tracked to TP2/TP3, but the slot unlocks
  as soon as TP1 is hit so a new setup can be generated.
- Plan routing: Free runs V1 with 20 analyses and 3 valid signals per UTC day.
  Plus accounts run V2 PLUS and Pro accounts run V3 PRO (see below).

Gold uses a balanced transition rule: a STRONG V1 setup may confirm before the
EMA 20/50 crossover completes when price, structure, momentum and Supertrend are
already aligned. It still requires a fresh break, a structural stop and TP1 at
1R or better.

The panel shows the score breakdown, the exact entry zone, stop, TP1/TP2/TP3,
R multiples, the structure narrative and the remaining daily limits. The same
levels are native price lines on the Lightweight Chart and appear in a compact
strip below it.

## V2 PLUS engine (Plus)

The same Analyze control sends Plus accounts to V2 PLUS (`src/v2/`). Free
accounts keep V1 FREE and Pro accounts run V3 PRO; the engines never share
decisions, tables or counters.

V2 indicators: EMA 20/50/200, RSI 14, MACD 12/26/9, Supertrend 10/3, ATR 14,
Volume, ADX 14, session VWAP, Bollinger 20/2 and Stochastic 14/3/3. Every series
is built once per analysis and read at one closed-candle index, so there is no
look-ahead and no duplicated calculation.

Decision flow:

1. Confirmed 3L/3R pivots, HH/HL/LH/LL labels, support/resistance, BOS, CHoCH
   and MSS (a CHoCH whose break candle body is at least 0.5 ATR).
2. SMC/ICT map: fair value gaps, order blocks, EQH/EQL, liquidity sweeps and
   premium/discount within the dealing range.
3. Price action (engulfing, pin bar, rejection, inside/outside bar,
   breakout/retest) is confirmation only and never a mandatory gate.
4. Direction needs a trend or a valid reversal plus matching structure, a fresh
   bullish/bearish BOS/CHoCH/MSS, momentum support and a validated SMC/EMA entry
   zone.
5. Score /100: trend 20, momentum 20, Supertrend 10, structure 25, SMC 20, price
   action 5. The score must exceed 60; strong starts at 80. Supertrend agreement is required unless a
   fresh CHoCH/MSS scores 80+.

Risk: stop loss uses confirmed swing structure plus the V2 ATR buffer (GOLD
0.25, FOREX 0.20, BTC 0.30), normally bounded to 0.25–3.5 ATR and a per-market
risk cap. Gold's balanced volatility profile permits up to 4.0 ATR and a 4%
price-distance cap; Forex and crypto limits are unchanged.
For Gold only, V2 can also recognize a 70+ transition when structure scores at
least 20, momentum at least 15, price clears both fast EMAs, Supertrend agrees
and a fresh structural break confirms direction. V3 gives the same aligned Gold
transition a small regime-quality allowance; all normal risk gates still apply.
TP1 is at least 1R and closes 50%; the remaining stop moves to breakeven plus
costs once TP1 confirms. TP2 is used at 2R+ when structure allows and TP3 stays
optional at 3R+.

PLUS limits (UTC day, server enforced): 50 analyses, 15 persisted signals,
10 best setups, and 20 scanner analyses across up to 12 symbols. History is kept
for 30 days. Multiple setups may stay open at once, but the same
symbol + timeframe + candle is rejected, with a 3-bar cooldown.

`Scan markets` on `/terminal` runs the V2 scanner for the current timeframe
against the watchlist symbols. It ranks valid setups before NO SIGNAL results by
score, shows the R:R for TP1, and spends the dedicated scanner counter without
persisting signals.

The separate `/scanner` image tool is unlimited for Plus and Pro. Users select
the matching market/timeframe and upload a screenshot; on-device pixels provide
the directional BUY/SELL bias while authenticated Yahoo closed candles provide
the exact Entry Zone, structural/ATR SL and TP1/TP2/TP3. These are non-persisted
scanner setups and do not spend or bypass official V1/V2/V3 signal quotas. Mixed
images return NO TRADE rather than inventing a plan.

## V3 PRO engine (Pro)

Pro accounts are routed to `src/v3/` and the `/api/*/v3` routes. Free and Plus
receive HTTP 403, and Pro accounts cannot call V2. V3 has its own tables,
lifecycle and decision model.

Indicators: EMA 20/50/200, RSI 14, MACD 12/26/9, Supertrend 10/3, ADX 14 with
DI+/DI−, ATR 14, Stochastic 14/3/3, ROC, Bollinger 20/2, Keltner, Donchian 20,
VWAP, MFI 14 and volume. Every series is built once and read at one closed-candle
index, so there is no look-ahead, no repaint and no duplicated calculation.

Decision flow:

1. Market regime: strong/weak bull or bear, sideways/range, volatility
   expansion/contraction and transition/unclear.
2. Structure: confirmed swings, HH/HL/LH/LL, support/resistance, BOS, CHoCH,
   MSS and the dealing range.
3. SMC/ICT: fair value gaps, order blocks, breaker and mitigation blocks,
   liquidity sweeps, EQH/EQL and premium/discount.
4. Price action: engulfing, pin bar, rejection, inside/outside bar, strong
   close, breakout/retest and failed breakout.
5. Strategy fit: **Trend Continuation**, **Breakout & Retest**,
   **Pullback Continuation**, **Fibonacci Retracement**, **Supply & Demand**,
   **S/R Bounce**, **Liquidity Sweep Reversal**, **Range Mean Reversion** and
   **Volatility Expansion**. Auto picks the best fit; Pro users can also lock a
   manual playbook before Analyze or a market scan.
6. A BUY/SELL needs a valid trend, breakout or reversal plus matching structure
   or a confirmed reversal, momentum support, an SMC/ICT entry zone, price-action
   confirmation when available and acceptable risk. V3 never forces agreement
   and returns **NO SIGNAL** with the blocking reason when the bar is not valid.

Score /100: regime 15, structure 20, entry/SMC 20, momentum 15, price action 10,
volume 5, volatility/quality 10, strategy 5. Medium requires above 70. Low is
strict (above 80, 1.5R TP1, 0.5% suggested account risk); High allows more
quality setups (above 62, 2% suggested risk) but retains structural stops, 1R,
cooldowns and active-slot protection.

Risk uses the same V2 rules: a swing + ATR stop with buffers, TP1 at 1R or
better, TP2 at 2R+ and optional TP3 at 3R+. TP1 closes 50% and moves the runner
to breakeven plus costs.

V3 signal rules:

- Analyses run when Analyze is pressed; V3 has no quota and never forces a signal.
- Only closed candles are evaluated.
- One `ACTIVE` signal per `user + symbol + timeframe`, enforced by a partial
  unique index. TP1 unlocks the slot while the runner stays open.
- The same candle and the 3-bar cooldown are rejected as duplicates.
- Pro is unlimited: analyses, signals and scans have no daily cap. `v3_usage`
  is telemetry only and limits are always reported as `-1` (unlimited).
- History is retained for 365 days.
- The Python Playbook Lab is research-only. It ranks playbook context and reports
  volatility/Fibonacci/S/R analytics through `POST /api/pro/research`; live
  signals and persistence remain controlled by the TypeScript engine.

The main terminal chart draws persisted V1/V2/V3 BUY/SELL markers directly on
their original closed candles. Active Entry, SL and TP1/TP2/TP3 restore on reload
and remain visible while the market is closed. Legacy intra-candle timestamps are
anchored to their actual interval-close candle.

Run the isolated gate check against a dedicated Neon test branch (never point
these values at production):

```bash
# Set TEST_DATABASE_URL and TEST_DATABASE_URL_UNPOOLED first
npm run verify:v3
```

It boots a real server and asserts: anonymous 401, Free/Plus 403 on V3, Plus 200
on V2, Pro 403 on V2, Pro 200 on V3, duplicate block, ACTIVE-slot block, TP1
unlock and scanner permissions.

## V3 backtest

`npm run backtest:v3` replays real Yahoo Finance closed candles on a 320-bar
rolling window with 150 replay bars, a 12-bar limit-fill window and a 3-bar
cooldown. It charges per-symbol spread, commission and slippage, closes 50% at
TP1, moves the stop to breakeven plus costs, and resolves an ambiguous bar as a
stop. Each strategy is measured separately with a backtest-only engine override;
the same override powers Pro manual-playbook mode while Auto remains the default.

Latest full run (`--mode=both --replay=150 --window=320`), 54 of 55 datasets
available (US100 4H has only 247 closed bars and is reported as insufficient):

| Strategy | Trades | Win rate | Profit factor | Expectancy | Total R | Max DD | Avg RR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Trend Continuation | 366 | 47.0% | 0.99 | −0.01R | −2.17R | 57.88R | 1.52 |
| Breakout & Retest | 350 | 46.9% | 1.02 | +0.01R | +4.80R | 51.28R | 1.54 |
| Liquidity Sweep Reversal | 91 | 46.2% | 1.13 | +0.07R | +6.65R | 22.68R | 1.33 |
| Range Mean Reversion | 17 | 70.6% | 3.31 | +0.71R | +12.13R | 3.06R | 1.34 |
| Volatility Expansion | 156 | 44.2% | 0.85 | −0.09R | −13.58R | 52.08R | 1.41 |
| Auto-selected (live mode) | 381 | 46.5% | 0.97 | −0.02R | −7.18R | 64.23R | 1.51 |

The forced-strategy rows are the five-model baseline replay over the same history, so
they are not a portfolio and their drawdowns must not be added together. Results
are reported honestly, including negative expectancy; they are not a promise of
future performance. The full report is written to `artifacts/reports/backtest-v3-report.json` and
the `v3_backtests` table.

## Engine tests

```bash
npm run test:v1
npm run test:v2
npm run test:v3
npm run test:market
npm run test:python
```

The V1 suite runs a 45-combination matrix (3 markets × 5 timeframes × buy/sell/range),
checks that a forming bar cannot change a result, verifies frozen levels, TP1
unlock, stop-loss resolution, duplicate cooldown and the PostgreSQL daily/active-slot
rules. Store integration tests run when `TEST_DATABASE_URL` (and optionally
`TEST_DATABASE_URL_UNPOOLED`) points to an isolated test branch.

The V2 suite runs the same 3 markets × 5 timeframes matrix (plus its mirrored
SELL profile and a range that must stay NO SIGNAL), asserts every risk rule
(1R/2R/3R targets, 50% at TP1, breakeven, ATR and market caps), verifies 3L/3R
pivot confirmation, no-repaint behaviour, TP1→breakeven→TP2 lifecycle without bar
replay, and the PostgreSQL counters, duplicate index, best-setups ranking and 30-day
history.

The V3 suite runs the full 3 markets × 5 timeframes matrix for trending BUY,
mirrored SELL and a flat range, checks the 100-point score components, every
risk and R-multiple rule, insufficient-history and stale-data rejection, the
no-look-ahead guarantee, TP1→breakeven→stop lifecycle without bar replay, the
 nine playbook selectors, quality presets, plan isolation and PostgreSQL unlimited counters,
active-slot index, TP1 unlock, duplicates, best setups and 365-day history.

## Current data status

Charts use TradingView Lightweight Charts, Yahoo Finance REST candles and an
authenticated WebSocket quote stream. V1, V2 and V3 consume the same closed
candles and persist signals in separate PostgreSQL tables on Neon. The Pro Python lab is an
isolated research service; accounts,
sessions, plans, payments, all engine limits and signals, and gateway settings
are persisted by the backend.
#   S o v a n n a P h u m - T r a d e  
 