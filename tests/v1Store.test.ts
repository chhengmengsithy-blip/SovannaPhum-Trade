/** Durable-limit and active-slot tests against TEST_DATABASE_URL. */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { evaluate } from '../src/v1/engine.ts'
import { advanceSignal } from '../src/v1/lifecycle.ts'
import type { Candle } from '../src/v1/types.ts'
import { buildSeries } from './v1Data.ts'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

test('daily counters, one active slot, and TP1 unlock', { skip: !testDatabaseUrl }, async () => {
  process.env.DATABASE_URL = testDatabaseUrl
  process.env.DATABASE_URL_UNPOOLED = process.env.TEST_DATABASE_URL_UNPOOLED || testDatabaseUrl

  const { closeDatabase, db, initializeDatabase } = await import('../server/db.ts')
  const store = await import('../server/v1Store.ts')
  const userId = `u_v1_test_${process.pid}_${Date.now()}`

  try {
    await initializeDatabase()
    const stamp = new Date().toISOString()
    await db.prepare(
      `INSERT INTO users (id, name, email, password_hash, plan, role, provider, telegram, lifetime_pro, created_at, updated_at)
       VALUES (?, 'V1 Test', ?, '', 'free', 'user', 'email', NULL, 0, ?, ?)`,
    ).run(userId, `${userId}@local.test`, stamp, stamp)

    const { candles, now } = buildSeries('XAUUSD', '1H', 'buy')
    const signal = evaluate({ symbol: 'XAUUSD', timeframe: '1H', candles, now }).signal
    assert.ok(signal)
    const day = store.utcDay(now)

    const firstUsage = await store.saveSignal(userId, signal, day, now)
    assert.equal(firstUsage.signals, 1)
    assert.equal((await store.findActive(userId))?.signalId, signal.signalId)

    const competing = { ...signal, signalId: 'competing-signal' }
    await assert.rejects(() => store.saveSignal(userId, competing, day, now))

    const tp1Bar: Candle = {
      time: signal.barTime + 60_000,
      open: signal.levels.entry,
      high: signal.levels.tp1,
      low: signal.levels.entry,
      close: signal.levels.tp1,
      volume: 100,
    }
    const tp1 = advanceSignal(signal, [tp1Bar], signal.barTime + 60_000)
    assert.equal(tp1.status, 'TP1_HIT')
    await store.updateSignal(tp1)
    assert.equal(await store.findActive(userId), null)

    const secondUsage = await store.saveSignal(userId, competing, day, now)
    assert.equal(secondUsage.signals, 2)
    assert.equal((await store.findActive(userId))?.signalId, 'competing-signal')

    for (let index = 0; index < 3; index += 1) await store.recordAnalysis(userId, day, now)
    const usage = await store.getUsage(userId, day, now)
    assert.equal(usage.analyses, 3)
    assert.equal(usage.signals, 2)

    const tracked = (await store.findTracked(userId, 'XAUUSD', '1H')).map(item => item.signalId)
    assert.ok(tracked.includes(signal.signalId))
    assert.ok(tracked.includes('competing-signal'))
  } finally {
    await db.prepare('DELETE FROM users WHERE id = ?').run(userId).catch(() => undefined)
    await closeDatabase()
  }
})
