import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { closeDatabase, db, initializeDatabase, transaction } from '../server/db.ts'

const TABLES = [
  'users',
  'sessions',
  'payments',
  'khqr_config',
  'api_tokens',
  'backtest_jobs',
  'alert_rules',
  'trade_journal',
  'v1_usage',
  'v1_signals',
  'v2_usage',
  'v2_signals',
  'v3_usage',
  'v3_signals',
  'v3_backtests',
] as const

type LegacyValue = string | number | bigint | Uint8Array | null
type LegacyRow = Record<string, LegacyValue>

function argument(name: string): string | undefined {
  const exact = `--${name}`
  const inline = `${exact}=`
  const index = process.argv.findIndex(value => value === exact || value.startsWith(inline))
  if (index < 0) return undefined
  const value = process.argv[index]
  return value.startsWith(inline) ? value.slice(inline.length) : process.argv[index + 1]
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

const sourcePath = resolve(
  argument('source')
    || process.env.SQLITE_SOURCE_PATH
    || process.env.DB_PATH
    || 'server/data/sovan.db',
)

if (!existsSync(sourcePath)) {
  throw new Error(`SQLite source database was not found: ${sourcePath}`)
}

const sqlite = new DatabaseSync(sourcePath, { readOnly: true })

try {
  await initializeDatabase()

  const available = new Set(
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map(row => row.name),
  )
  const imported: Array<{ table: string; sourceRows: number }> = []

  await transaction(async () => {
    for (const table of TABLES) {
      if (!available.has(table)) continue

      const columns = (sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>)
        .map(column => column.name)
      if (!columns.length) continue

      const rows = sqlite.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all() as LegacyRow[]
      if (!rows.length) {
        imported.push({ table, sourceRows: 0 })
        continue
      }

      const names = columns.map(quoteIdentifier).join(', ')
      const placeholders = columns.map(() => '?').join(', ')
      const conflict = table === 'khqr_config'
        ? `ON CONFLICT (id) DO UPDATE SET ${columns
          .filter(column => column !== 'id')
          .map(column => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`)
          .join(', ')}`
        : 'ON CONFLICT DO NOTHING'
      const statement = db.prepare(
        `INSERT INTO ${quoteIdentifier(table)} (${names}) VALUES (${placeholders}) ${conflict}`,
      )

      for (const row of rows) {
        await statement.run(...columns.map(column => row[column]))
      }
      imported.push({ table, sourceRows: rows.length })
    }

    if (available.has('v3_backtests')) {
      await db.exec(`
        SELECT setval(
          pg_get_serial_sequence('v3_backtests', 'id'),
          COALESCE((SELECT MAX(id) FROM v3_backtests), 1),
          EXISTS (SELECT 1 FROM v3_backtests)
        )
      `)
    }
  })

  console.log(`Imported SQLite data from ${sourcePath}`)
  for (const result of imported) {
    const target = await db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(result.table)}`)
      .get<{ count: number }>()
    console.log(`  ${result.table}: source ${result.sourceRows}, PostgreSQL ${target?.count ?? 0}`)
  }
} finally {
  sqlite.close()
  await closeDatabase()
}
