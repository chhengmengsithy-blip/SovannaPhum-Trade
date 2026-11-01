/**
 * Ordered PostgreSQL migrations.
 *
 * Keep every schema change append-only. Production migrations run against the
 * direct Neon connection while application traffic uses the pooled connection.
 */
export const migrations = [
  {
    id: '001_initial_postgres_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL DEFAULT '',
        plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'plus', 'pro')),
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
        provider TEXT NOT NULL DEFAULT 'email' CHECK (provider IN ('email', 'gmail', 'telegram')),
        telegram TEXT,
        lifetime_pro SMALLINT NOT NULL DEFAULT 0 CHECK (lifetime_pro IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
        ON users (LOWER(email));
      CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_unique
        ON users (LOWER(telegram)) WHERE telegram IS NOT NULL;

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        plan TEXT NOT NULL CHECK (plan IN ('plus', 'pro')),
        amount DOUBLE PRECISION NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        bill_number TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
        qr_payload TEXT NOT NULL,
        provider_ref TEXT,
        created_at TEXT NOT NULL,
        paid_at TEXT
      );
      CREATE INDEX IF NOT EXISTS payments_user_idx ON payments (user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS khqr_config (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        bakong_id TEXT NOT NULL DEFAULT '',
        merchant_name TEXT NOT NULL DEFAULT 'SOVANNAPHUMTRADE',
        city TEXT NOT NULL DEFAULT 'Phnom Penh',
        demo SMALLINT NOT NULL DEFAULT 0 CHECK (demo IN (0, 1)),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        prefix TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '[]',
        last_used_at TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens (user_id);
      CREATE INDEX IF NOT EXISTS api_tokens_hash_idx ON api_tokens (token_hash);

      CREATE TABLE IF NOT EXISTS backtest_jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        strategy TEXT NOT NULL,
        params TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
        result TEXT,
        progress INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS backtest_jobs_user_idx ON backtest_jobs (user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS alert_rules (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        condition TEXT NOT NULL,
        channels TEXT NOT NULL DEFAULT '[]',
        is_active SMALLINT NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at TEXT NOT NULL,
        last_triggered TEXT
      );
      CREATE INDEX IF NOT EXISTS alert_rules_user_idx ON alert_rules (user_id);

      CREATE TABLE IF NOT EXISTS trade_journal (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        signal_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('BUY', 'SELL')),
        entry_price DOUBLE PRECISION NOT NULL,
        exit_price DOUBLE PRECISION,
        stop_loss DOUBLE PRECISION NOT NULL,
        tp1 DOUBLE PRECISION NOT NULL,
        tp2 DOUBLE PRECISION,
        tp3 DOUBLE PRECISION,
        position_size DOUBLE PRECISION NOT NULL,
        risk_amount DOUBLE PRECISION NOT NULL,
        pnl_r DOUBLE PRECISION,
        pnl_usd DOUBLE PRECISION,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'partial')),
        notes TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        entry_time TEXT NOT NULL,
        exit_time TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trade_journal_user_idx ON trade_journal (user_id, entry_time DESC);

      CREATE TABLE IF NOT EXISTS v1_usage (
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        analyses INTEGER NOT NULL DEFAULT 0,
        signals INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, day)
      );

      CREATE TABLE IF NOT EXISTS v1_signals (
        signal_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('BUY', 'SELL')),
        status TEXT NOT NULL,
        bar_time BIGINT NOT NULL,
        active SMALLINT NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS v1_signals_one_active
        ON v1_signals (user_id) WHERE active = 1;
      CREATE INDEX IF NOT EXISTS v1_signals_lookup
        ON v1_signals (user_id, symbol, timeframe, bar_time DESC);

      CREATE TABLE IF NOT EXISTS v2_usage (
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        analyses INTEGER NOT NULL DEFAULT 0,
        signals INTEGER NOT NULL DEFAULT 0,
        scans INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, day)
      );

      CREATE TABLE IF NOT EXISTS v2_signals (
        signal_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('BUY', 'SELL')),
        status TEXT NOT NULL,
        bar_time BIGINT NOT NULL,
        score DOUBLE PRECISION NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS v2_signals_unique_setup
        ON v2_signals (user_id, symbol, timeframe, bar_time);
      CREATE INDEX IF NOT EXISTS v2_signals_history
        ON v2_signals (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS v2_signals_open
        ON v2_signals (user_id, status);

      CREATE TABLE IF NOT EXISTS v3_usage (
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        analyses INTEGER NOT NULL DEFAULT 0,
        signals INTEGER NOT NULL DEFAULT 0,
        scans INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, day)
      );

      CREATE TABLE IF NOT EXISTS v3_signals (
        signal_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('BUY', 'SELL')),
        status TEXT NOT NULL,
        strategy TEXT NOT NULL,
        bar_time BIGINT NOT NULL,
        score DOUBLE PRECISION NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS v3_signals_unique_setup
        ON v3_signals (user_id, symbol, timeframe, bar_time);
      CREATE UNIQUE INDEX IF NOT EXISTS v3_signals_active_slot
        ON v3_signals (user_id, symbol, timeframe) WHERE status = 'ACTIVE';
      CREATE INDEX IF NOT EXISTS v3_signals_history
        ON v3_signals (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS v3_signals_open
        ON v3_signals (user_id, status);

      CREATE TABLE IF NOT EXISTS v3_backtests (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        run_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `,
  },
] as const
