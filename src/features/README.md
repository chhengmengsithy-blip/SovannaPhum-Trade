# Frontend features

Each feature folder owns its UI components and local domain helpers. Cross-feature
network access goes through `src/services/api.ts` or `src/services/marketData.ts`; strategy rules
remain in `src/v1`, `src/v2` and `src/v3`.

- `terminal/`: charting, signal decision UI, levels, history and Pro research.
- `scanner/`: screenshot analysis and non-persisted scanner plans.
- `signals/`: Neon PostgreSQL-backed signal browsing and dashboard summaries.
