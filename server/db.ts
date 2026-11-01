import './env.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Pool, types as pgTypes, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { hashPassword } from './security.ts'
import { migrations } from './schema.ts'

export type Plan = 'free' | 'plus' | 'pro'
export type Role = 'user' | 'admin'
export type Provider = 'email' | 'gmail' | 'telegram'
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired'

export type UserRow = {
  id: string
  name: string
  email: string
  password_hash: string
  plan: Plan
  role: Role
  provider: Provider
  telegram: string | null
  lifetime_pro: number
  created_at: string
  updated_at: string
}

export type PaymentRow = {
  id: string
  user_id: string
  plan: Exclude<Plan, 'free'>
  amount: number
  currency: string
  bill_number: string
  status: PaymentStatus
  qr_payload: string
  provider_ref: string | null
  created_at: string
  paid_at: string | null
}

export type KhqrRow = {
  id: number
  bakong_id: string
  merchant_name: string
  city: string
  demo: number
  updated_at: string
}

type Executor = Pick<Pool | PoolClient, 'query'>

// BIGINT is used only for safe JavaScript values here (millisecond timestamps,
// row ids and counts). Parse it as a number instead of node-postgres' default
// string representation.
pgTypes.setTypeParser(20, value => Number(value))

let applicationPool: Pool | null = null
const transactionClient = new AsyncLocalStorage<PoolClient>()

function requireConnectionString(name: 'DATABASE_URL' | 'DATABASE_URL_UNPOOLED' = 'DATABASE_URL'): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is required. Link a Neon project and pull its environment variables before starting the server.`,
    )
  }
  return value
}

function pool(): Pool {
  if (!applicationPool) {
    const configuredMax = Number(process.env.DB_POOL_MAX || 10)
    applicationPool = new Pool({
      connectionString: requireConnectionString(),
      max: Number.isFinite(configuredMax) ? Math.max(1, Math.floor(configuredMax)) : 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    })
    applicationPool.on('error', error => {
      console.error('[postgres] idle client error', error)
    })
  }
  return applicationPool
}

function executor(): Executor {
  return transactionClient.getStore() ?? pool()
}

/** Convert the existing SQLite-style placeholders to PostgreSQL parameters. */
function postgresSql(sql: string): string {
  let parameter = 0
  let singleQuoted = false
  let doubleQuoted = false
  let output = ''

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    const next = sql[index + 1]

    if (char === "'" && !doubleQuoted) {
      output += char
      if (singleQuoted && next === "'") {
        output += next
        index += 1
      } else {
        singleQuoted = !singleQuoted
      }
      continue
    }
    if (char === '"' && !singleQuoted) {
      output += char
      if (doubleQuoted && next === '"') {
        output += next
        index += 1
      } else {
        doubleQuoted = !doubleQuoted
      }
      continue
    }
    if (char === '?' && !singleQuoted && !doubleQuoted) {
      parameter += 1
      output += `$${parameter}`
      continue
    }
    output += char
  }

  return output
}

class PreparedStatement {
  private readonly sql: string

  constructor(sql: string) {
    this.sql = sql
  }

  run(...values: unknown[]): Promise<QueryResult<QueryResultRow>> {
    return executor().query(postgresSql(this.sql), values)
  }

  async get<T extends QueryResultRow = QueryResultRow>(...values: unknown[]): Promise<T | undefined> {
    const result = await executor().query<T>(postgresSql(this.sql), values)
    return result.rows[0]
  }

  async all<T extends QueryResultRow = QueryResultRow>(...values: unknown[]): Promise<T[]> {
    const result = await executor().query<T>(postgresSql(this.sql), values)
    return result.rows
  }
}

export const db = {
  prepare(sql: string) {
    return new PreparedStatement(sql)
  },
  async exec(sql: string): Promise<void> {
    await executor().query(sql)
  },
  async close(): Promise<void> {
    await closeDatabase()
  },
}

export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  // Reuse an outer transaction when helpers call other transactional helpers.
  if (transactionClient.getStore()) return fn()

  const client = await pool().connect()
  try {
    await client.query('BEGIN')
    const result = await transactionClient.run(client, fn)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackError) {
      console.error('[postgres] transaction rollback failed', rollbackError)
    }
    throw error
  } finally {
    client.release()
  }
}

export async function migrateDatabase(): Promise<void> {
  const migrationPool = new Pool({
    connectionString: requireConnectionString('DATABASE_URL_UNPOOLED'),
    max: 1,
    connectionTimeoutMillis: 15_000,
    allowExitOnIdle: true,
  })
  let client: PoolClient | undefined
  try {
    client = await migrationPool.connect()
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sovannaphumtrade-schema'))")
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    const applied = new Set((await client.query<{ id: string }>('SELECT id FROM schema_migrations')).rows.map(row => row.id))
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue
      await client.query(migration.sql)
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id])
      console.log(`[postgres] applied migration ${migration.id}`)
    }
    await client.query('COMMIT')
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        console.error('[postgres] migration rollback failed', rollbackError)
      }
    }
    throw error
  } finally {
    client?.release()
    await migrationPool.end()
  }
}

const now = () => new Date().toISOString()

async function seedKhqrConfig(): Promise<void> {
  await db.prepare(
    `INSERT INTO khqr_config (id, bakong_id, merchant_name, city, demo, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(
    process.env.KHQR_BAKONG_ID || '',
    process.env.KHQR_MERCHANT_NAME || 'SOVANNAPHUMTRADE',
    process.env.KHQR_CITY || 'Phnom Penh',
    process.env.KHQR_DEMO === '1' || process.env.ALLOW_DEMO_PAYMENTS === '1' ? 1 : 0,
    now(),
  )

  // Demo payments are a local-testing escape hatch only. Real deployments
  // always start with demo off, including databases created by older builds.
  if (process.env.ALLOW_DEMO_PAYMENTS !== '1') {
    await db.prepare('UPDATE khqr_config SET demo = 0 WHERE demo <> 0').run()
  }
}

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'Sithy@dev.pro'
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Sithy123$$'

/** Keep the owner account and its Pro-forever guarantee in sync on every boot. */
export async function seedAdmin(): Promise<void> {
  const timestamp = now()
  const existing = await db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get<{ id: string }>(ADMIN_EMAIL)
  const hash = hashPassword(ADMIN_PASSWORD)
  const id = existing?.id || 'admin-sithy'

  await db.prepare(
    `INSERT INTO users (id, name, email, password_hash, plan, role, provider, telegram, lifetime_pro, created_at, updated_at)
     VALUES (?, 'Sithy', ?, ?, 'pro', 'admin', 'email', NULL, 1, ?, ?)
     ON CONFLICT ((LOWER(email))) DO UPDATE SET
       password_hash = excluded.password_hash,
       plan = 'pro',
       role = 'admin',
       lifetime_pro = 1,
       updated_at = excluded.updated_at`,
  ).run(id, ADMIN_EMAIL, hash, timestamp, timestamp)
}

export async function initializeDatabase(): Promise<void> {
  await migrateDatabase()
  await seedKhqrConfig()
  await seedAdmin()
}

export async function findUserById(id: string): Promise<UserRow | undefined> {
  return db.prepare('SELECT * FROM users WHERE id = ?').get<UserRow>(id)
}

export async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  return db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get<UserRow>(email)
}

export async function findUserByTelegram(handle: string): Promise<UserRow | undefined> {
  return db.prepare('SELECT * FROM users WHERE LOWER(telegram) = LOWER(?)').get<UserRow>(handle)
}

export async function getKhqrConfig(): Promise<KhqrRow> {
  const row = await db.prepare('SELECT * FROM khqr_config WHERE id = 1').get<KhqrRow>()
  if (!row) throw new Error('KHQR configuration is missing.')
  return row
}

export async function updateKhqrConfig(patch: Partial<Omit<KhqrRow, 'id' | 'updated_at'>>): Promise<KhqrRow> {
  const current = await getKhqrConfig()
  await db.prepare(
    `UPDATE khqr_config SET bakong_id = ?, merchant_name = ?, city = ?, demo = ?, updated_at = ? WHERE id = 1`,
  ).run(
    patch.bakong_id ?? current.bakong_id,
    patch.merchant_name ?? current.merchant_name,
    patch.city ?? current.city,
    patch.demo ?? current.demo,
    now(),
  )
  return getKhqrConfig()
}

export async function purgeExpiredSessions(): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now())
}

export async function closeDatabase(): Promise<void> {
  if (!applicationPool) return
  const active = applicationPool
  applicationPool = null
  await active.end()
}
