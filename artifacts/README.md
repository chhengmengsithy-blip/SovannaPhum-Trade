# Project artifacts

This directory keeps generated and historical files out of the application root.

- `reports/` — generated backtest reports.
- `screenshots/legacy/` — historical UI review screenshots.
- `logs/legacy/` — archived local development logs and session files.
- `source-images/` — original source images retained for reference.

Application assets used at runtime remain in `public/`. Production data remains
in `server/data/` and must not be moved or deleted while the server is running.
