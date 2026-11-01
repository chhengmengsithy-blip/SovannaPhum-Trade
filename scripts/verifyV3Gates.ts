/**
 * Isolated V3 PRO gate verification.
 *
 * Boots a real server against an isolated PostgreSQL test branch and exercises the HTTP
 * routes exactly as a browser would:
 *
 *   1. no session                → 401
 *   2. free plan on V3           → 403
 *   3. plus plan on V3           → 403
 *   4. pro plan on V3            → 200 and a persisted signal
 *   5. pro plan on V2            → 403 (Pro is routed to V3, never V2)
 *   6. duplicate bar             → blocked
 *   7. ACTIVE slot on a later bar→ blocked
 *   8. after TP1                 → slot unlocks
 *   9. scan on pro               → 200, scan on plus → 403
 *
 * Run with: node scripts/verifyV3Gates.ts
 */

import { spawn } from 'node:child_process'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL must point to an isolated PostgreSQL test branch.')
}

process.env.DATABASE_URL = testDatabaseUrl
process.env.DATABASE_URL_UNPOOLED = process.env.TEST_DATABASE_URL_UNPOOLED || testDatabaseUrl

const PORT = 8899 + (process.pid % 100)
const BASE = `http://127.0.0.1:${PORT}`
const runId = `${process.pid}_${Date.now()}`
const ids = {
  free: `u_free_${runId}`,
  plus: `u_plus_${runId}`,
  pro: `u_pro_${runId}`,
}
const tokens = {
  free: `tok_free_${runId}`,
  plus: `tok_plus_${runId}`,
  pro: `tok_pro_${runId}`,
}

const { closeDatabase, db, initializeDatabase } = await import('../server/db.ts')
await initializeDatabase()

const stamp = new Date().toISOString()
const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString()

async function seed(id: string, email: string, plan: 'free' | 'plus' | 'pro', token: string): Promise<void> {
  await db.prepare(
    `INSERT INTO users (id, name, email, password_hash, plan, role, provider, telegram, lifetime_pro, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, 'user', 'email', NULL, 0, ?, ?)`,
  ).run(id, id, email, plan, stamp, stamp)
  await db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(token, id, stamp, expires)
}

await seed(ids.free, `${ids.free}@gate.test`, 'free', tokens.free)
await seed(ids.plus, `${ids.plus}@gate.test`, 'plus', tokens.plus)
await seed(ids.pro, `${ids.pro}@gate.test`, 'pro', tokens.pro)

const child = spawn(process.execPath, ['server/index.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', chunk => process.stdout.write(`  [server] ${chunk}`))
child.stderr.on('data', chunk => process.stderr.write(`  [server:err] ${chunk}`))

let failures = 0
function check(name: string, condition: boolean, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`)
      if (response.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('server did not start')
}

type Json = Record<string, unknown>

async function post(path: string, token: string | null, body: Json): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { cookie: `svn_session=${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const json = (await response.json().catch(() => ({}))) as Json
  return { status: response.status, json }
}

try {
  await waitForHealth()
  console.log('\nV3 PRO route gates\n')

  const anon = await post('/api/analyze/v3', null, { symbol: 'XAUUSD', timeframe: '1H' })
  check('anonymous V3 analysis is 401', anon.status === 401, `status ${anon.status}`)

  const free = await post('/api/analyze/v3', tokens.free, { symbol: 'XAUUSD', timeframe: '1H' })
  check('free plan V3 analysis is 403', free.status === 403, `status ${free.status} ${JSON.stringify(free.json)}`)

  const plus = await post('/api/analyze/v3', tokens.plus, { symbol: 'XAUUSD', timeframe: '1H' })
  check('plus plan V3 analysis is 403', plus.status === 403, `status ${plus.status} ${JSON.stringify(plus.json)}`)

  const plusV2 = await post('/api/analyze/v2', tokens.plus, { symbol: 'XAUUSD', timeframe: '1H' })
  check('plus plan V2 analysis is allowed', plusV2.status === 200, `status ${plusV2.status}`)

  const proV2 = await post('/api/analyze/v2', tokens.pro, { symbol: 'XAUUSD', timeframe: '1H' })
  check('pro plan V2 analysis is 403', proV2.status === 403, `status ${proV2.status} ${JSON.stringify(proV2.json)}`)

  const pro = await post('/api/analyze/v3', tokens.pro, { symbol: 'XAUUSD', timeframe: '1H' })
  check('pro plan V3 analysis is 200', pro.status === 200, `status ${pro.status}`)
  const action = String(pro.json.action ?? '')
  check('pro V3 response has a score', typeof (pro.json.score as Json | undefined)?.total === 'number', `${String((pro.json.score as Json | undefined)?.total)}`)
  let signal = pro.json.signal as Json | null
  let symbol = 'XAUUSD'
  let timeframe = '1H'
  console.log(`      engine action: ${action}; signal: ${signal ? `${String(signal.direction)} ${String(signal.strategyName)}` : 'none'}`)

  // The live market may legitimately return NO_SIGNAL. Walk a few liquid
  // setups until one closed bar produces a saved signal so the slot rules can
  // still be exercised end-to-end.
  const candidates: Array<[string, string]> = [
    ['EURUSD', '1H'], ['GBPUSD', '1H'], ['BTCUSD', '4H'], ['ETHUSD', '15m'], ['SOLUSD', '30m'],
  ]
  for (const [nextSymbol, nextTimeframe] of candidates) {
    if (signal) break
    const attempt = await post('/api/analyze/v3', tokens.pro, { symbol: nextSymbol, timeframe: nextTimeframe })
    if (attempt.status === 200 && attempt.json.signal) {
      signal = attempt.json.signal as Json
      symbol = nextSymbol
      timeframe = nextTimeframe
      console.log(`      saved a signal on ${symbol} ${timeframe}: ${String(signal.direction)} ${String(signal.strategyName)}`)
    }
  }

  const again = await post('/api/analyze/v3', tokens.pro, { symbol, timeframe })
  const againReason = String(again.json.reason ?? '')
  if (signal) {
    check('same closed bar is blocked as a duplicate', againReason.toLowerCase().includes('duplicate'), againReason.slice(0, 90))
  } else {
    check('no-signal analysis is reported without a forced trade', again.status === 200 && again.json.signal === null, againReason.slice(0, 90))
  }

  // Move the saved signal back in time so the duplicate check passes and the
  // ACTIVE slot rule is the thing under test.
  if (signal) {
    const signalId = String(signal.signalId)
    const row = await db.prepare('SELECT bar_time, payload FROM v3_signals WHERE signal_id = ?')
      .get<{ bar_time: number; payload: string }>(signalId)
    if (row) {
      const shifted = row.bar_time - 6 * 3_600_000
      const shiftedPayload = JSON.parse(row.payload) as Json
      shiftedPayload.barTime = shifted
      await db.prepare(
        `UPDATE v3_signals
            SET bar_time = ?,
                payload = ?
          WHERE signal_id = ?`,
      ).run(shifted, JSON.stringify(shiftedPayload), signalId)
      const slot = await post('/api/analyze/v3', tokens.pro, { symbol, timeframe })
      const slotReason = String(slot.json.reason ?? '')
      check('ACTIVE slot blocks a second setup', slotReason.toLowerCase().includes('one active signal'), slotReason.slice(0, 90))
      check('blocked response exposes the existing active signal', slot.json.existingActive !== null, JSON.stringify((slot.json.existingActive as Json | null)?.direction))

      // TP1 unlocks the slot while the runner stays open. Update both the index
      // column the query filters on and the payload the decoder reads.
      shiftedPayload.status = 'TP1_HIT'
      await db.prepare(
        `UPDATE v3_signals
            SET status = 'TP1_HIT',
                payload = ?
          WHERE signal_id = ?`,
      ).run(JSON.stringify(shiftedPayload), signalId)
      const unlocked = await post('/api/analyze/v3', tokens.pro, { symbol, timeframe })
      const unlockedReason = String(unlocked.json.reason ?? '').toLowerCase()
      check(
        'after TP1 the slot is no longer blocked',
        unlocked.status === 200 && !unlockedReason.includes('one active signal') && !unlockedReason.includes('duplicate'),
        unlockedReason.slice(0, 90),
      )
    }
  }

  const scanPro = await post('/api/scan/v3', tokens.pro, { timeframe: '1H', symbols: ['XAUUSD', 'EURUSD'] })
  check('pro scan is 200', scanPro.status === 200, `status ${scanPro.status}`)

  const scanPlus = await post('/api/scan/v3', tokens.plus, { timeframe: '1H', symbols: ['XAUUSD'] })
  check('plus scan is 403', scanPlus.status === 403, `status ${scanPlus.status}`)

  console.log(`\n${failures === 0 ? 'All gate checks passed.' : `${failures} gate check(s) failed.`}`)
} finally {
  child.kill()
  await new Promise(resolve => setTimeout(resolve, 400))
  await db.prepare('DELETE FROM users WHERE id IN (?, ?, ?)').run(ids.free, ids.plus, ids.pro).catch(() => undefined)
  await closeDatabase()
}

if (failures > 0) process.exitCode = 1
