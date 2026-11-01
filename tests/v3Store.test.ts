/** Durable V3 PRO store tests against TEST_DATABASE_URL. */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { evaluateV3 } from '../src/v3/engine.ts'
import type { Signal } from '../src/v3/types.ts'
import { buildV3Series } from './v3Data.ts'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

test('V3 unlimited counters, active slot, TP1 unlock, duplicates and 365-day history', { skip: !testDatabaseUrl }, async () => {
  process.env.DATABASE_URL = testDatabaseUrl
  process.env.DATABASE_URL_UNPOOLED = process.env.TEST_DATABASE_URL_UNPOOLED || testDatabaseUrl

  const { closeDatabase, db, initializeDatabase } = await import('../server/db.ts')
  const store = await import('../server/v3Store.ts')
  const userId = `u_v3_test_${process.pid}_${Date.now()}`

  try {
    await initializeDatabase()
    const stamp = new Date().toISOString()
    await db.prepare(
      `INSERT INTO users (id, name, email, password_hash, plan, role, provider, telegram, lifetime_pro, created_at, updated_at)
       VALUES (?, 'V3 Test', ?, '', 'pro', 'user', 'email', NULL, 0, ?, ?)`,
    ).run(userId, `${userId}@local.test`, stamp, stamp)

    const { candles, now } = buildV3Series('XAUUSD', '1H', 'trend')
    const analysis = evaluateV3({ symbol: 'XAUUSD', timeframe: '1H', candles, now })
    const signal = analysis.signal
    assert.ok(signal, analysis.reason)
    const day = store.utcDay(now)

    assert.equal((await store.recordAnalysis(userId, day, now)).analyses, 1)
    assert.equal((await store.recordAnalysis(userId, day, now)).analyses, 2)
    assert.equal((await store.recordScans(userId, day, 5, now)).scans, 5)
    assert.equal((await store.getUsage(userId, day, now)).analyses, 2)

    const usage = await store.saveSignal(userId, signal, day, now)
    assert.equal(usage.signals, 1)
    assert.equal((await store.findOpen(userId, now)).length, 1)
    assert.equal((await store.findActiveFor(userId, 'XAUUSD', '1H'))?.signalId, signal.signalId)

    const second: Signal = {
      ...signal,
      signalId: 'v3-active-second',
      barTime: signal.barTime + 3_600_000,
      createdAt: now + 60_000,
      updatedAt: now + 60_000,
    }
    await assert.rejects(() => store.saveSignal(userId, second, day, now + 60_000))
    assert.equal((await store.getUsage(userId, day, now)).signals, 1)

    const tp1: Signal = {
      ...signal,
      status: 'TP1_HIT',
      closedFraction: 0.5,
      currentStopLoss: signal.levels.breakevenStop,
      breakevenApplied: true,
      updatedAt: now + 120_000,
      lastEvaluatedBar: signal.barTime + 3_600_000,
    }
    await store.updateSignal(tp1)
    assert.equal(await store.findActiveFor(userId, 'XAUUSD', '1H'), null)
    assert.equal((await store.findOpen(userId, now + 120_000)).length, 1)
    assert.equal((await store.findOpenFor(userId, 'XAUUSD', '1H')).length, 1)

    assert.equal((await store.saveSignal(userId, second, day, now + 120_000)).signals, 2)
    assert.equal((await store.findActiveFor(userId, 'XAUUSD', '1H'))?.signalId, 'v3-active-second')

    const duplicate: Signal = { ...signal, signalId: 'v3-duplicate', status: 'ACTIVE' }
    await assert.rejects(() => store.saveSignal(userId, duplicate, day, now + 180_000))

    assert.equal(store.isDuplicateBar(signal, signal.barTime, '1H'), true)
    assert.equal(store.isDuplicateBar(signal, signal.barTime + 3_600_000, '1H'), true)
    assert.equal(store.isDuplicateBar(signal, signal.barTime + 3 * 3_600_000, '1H'), false)

    const scored: Signal = {
      ...signal,
      signalId: 'v3-scored',
      symbol: 'EURUSD',
      timeframe: '15m',
      direction: 'SELL',
      barTime: signal.barTime + 900_000,
      createdAt: now + 200_000,
      updatedAt: now + 200_000,
      status: 'ACTIVE',
      score: { ...signal.score, total: 96 },
    }
    await store.saveSignal(userId, scored, day, now + 200_000)
    const best = await store.bestSetups(userId, day)
    assert.equal(best[0].signalId, 'v3-scored')
    assert.equal(best[0].score.total, 96)
    assert.equal((await store.bestSetups(userId, day, 1)).length, 1)

    const items = store.historyItems(await store.history(userId, now + 300_000))
    assert.ok(items.length >= 3)
    assert.ok(items.every(item => item.signalId && item.symbol && Number.isFinite(item.entry)))

    assert.equal((await store.history(userId, now + 364 * 24 * 3_600_000)).length, 3)
    await store.purgeHistory(userId, now + 366 * 24 * 3_600_000)
    assert.equal((await store.history(userId, now + 366 * 24 * 3_600_000)).length, 0)

    const reportMarker = { userId, runs: 3, winRate: 0.5 }
    await store.saveBacktestReport(reportMarker, now)
    assert.deepEqual(await store.latestBacktestReport(), reportMarker)
  } finally {
    await db.prepare("DELETE FROM v3_backtests WHERE payload LIKE ?").run(`%${userId}%`).catch(() => undefined)
    await db.prepare('DELETE FROM users WHERE id = ?').run(userId).catch(() => undefined)
    await closeDatabase()
  }
})
