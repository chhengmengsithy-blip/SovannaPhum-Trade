/** Durable V2 PLUS store tests against TEST_DATABASE_URL. */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { evaluateV2 } from '../src/v2/engine.ts'
import type { Signal } from '../src/v2/types.ts'
import { buildV2Series } from './v2Data.ts'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

test('V2 counters, concurrent setups, duplicates, best setups and 30-day history', { skip: !testDatabaseUrl }, async () => {
  process.env.DATABASE_URL = testDatabaseUrl
  process.env.DATABASE_URL_UNPOOLED = process.env.TEST_DATABASE_URL_UNPOOLED || testDatabaseUrl

  const { closeDatabase, db, initializeDatabase } = await import('../server/db.ts')
  const store = await import('../server/v2Store.ts')
  const userId = `u_v2_test_${process.pid}_${Date.now()}`

  try {
    await initializeDatabase()
    const stamp = new Date().toISOString()
    await db.prepare(
      `INSERT INTO users (id, name, email, password_hash, plan, role, provider, telegram, lifetime_pro, created_at, updated_at)
       VALUES (?, 'V2 Test', ?, '', 'plus', 'user', 'email', NULL, 0, ?, ?)`,
    ).run(userId, `${userId}@local.test`, stamp, stamp)

    const { candles, now } = buildV2Series('XAUUSD', '1H', 'trend')
    const analysis = evaluateV2({ symbol: 'XAUUSD', timeframe: '1H', candles, now })
    const signal = analysis.signal
    assert.ok(signal, analysis.reason)
    const day = store.utcDay(now)

    assert.equal((await store.recordAnalysis(userId, day, now)).analyses, 1)
    assert.equal((await store.recordAnalysis(userId, day, now)).analyses, 2)

    const usage = await store.saveSignal(userId, signal, day, now)
    assert.equal(usage.signals, 1)
    assert.equal((await store.findOpen(userId, now)).length, 1)

    const second: Signal = {
      ...signal,
      signalId: 'v2-second',
      symbol: 'EURUSD',
      timeframe: '15m',
      direction: 'SELL',
      barTime: signal.barTime + 900_000,
      createdAt: now + 60_000,
      updatedAt: now + 60_000,
      score: { ...signal.score, total: 91 },
    }
    assert.equal((await store.saveSignal(userId, second, day, now)).signals, 2)
    assert.equal((await store.findOpen(userId, now)).length, 2)
    assert.equal((await store.findOpenFor(userId, 'XAUUSD', '1H')).length, 1)

    const duplicate: Signal = { ...signal, signalId: 'v2-duplicate' }
    await assert.rejects(() => store.saveSignal(userId, duplicate, day, now))
    assert.equal((await store.getUsage(userId, day, now)).signals, 2)

    assert.equal(store.isDuplicateBar(signal, signal.barTime, '1H'), true)
    assert.equal(store.isDuplicateBar(signal, signal.barTime + 3_600_000, '1H'), true)
    assert.equal(store.isDuplicateBar(signal, signal.barTime + 3 * 3_600_000, '1H'), false)

    const best = await store.bestSetups(userId, day)
    assert.equal(best.length, 2)
    assert.equal(best[0].signalId, 'v2-second')
    assert.equal(best[0].score.total, 91)
    assert.equal((await store.bestSetups(userId, day, 1)).length, 1)

    assert.equal((await store.recordScans(userId, day, 4, now)).scans, 4)
    assert.equal((await store.getUsage(userId, day, now)).scans, 4)
    assert.equal((await store.getUsage(userId, day, now)).analyses, 2)

    const resolved = { ...signal, status: 'TP1_HIT' as const, closedFraction: 0.5, updatedAt: now + 120_000, lastEvaluatedBar: signal.barTime + 3_600_000 }
    await store.updateSignal(resolved)
    const reopened = await store.findOpen(userId, now + 120_000)
    assert.equal(reopened.length, 2)
    assert.equal((await store.latestSignal(userId, 'XAUUSD', '1H'))?.status, 'TP1_HIT')

    assert.equal((await store.history(userId, now + 60_000)).length, 2)
    await store.purgeHistory(userId, now + 31 * 24 * 3_600_000)
    assert.equal((await store.history(userId, now + 31 * 24 * 3_600_000)).length, 0)
  } finally {
    await db.prepare('DELETE FROM users WHERE id = ?').run(userId).catch(() => undefined)
    await closeDatabase()
  }
})
