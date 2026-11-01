/**
 * Deterministic V1 regression tests.
 *
 * Run with: npm run test:v1
 *
 * The profiles are geometric, not forecasts: one uptrend with a shallow
 * pullback, its exact mirrored downtrend, and a flat range. They exercise every
 * symbol/timeframe pair the terminal exposes.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { evaluate } from '../src/v1/engine.ts'
import { advanceSignal, occupiesActiveSlot } from '../src/v1/lifecycle.ts'
import type { Candle, Signal } from '../src/v1/types.ts'
import { TIMEFRAME_SECONDS, TIMEFRAMES } from '../src/v1/types.ts'
import { SYMBOLS, buildSeries } from './v1Data.ts'

test('45-combination matrix returns the expected direction', () => {
  const failures: string[] = []
  for (const symbol of SYMBOLS) {
    for (const timeframe of TIMEFRAMES) {
      for (const kind of ['buy', 'sell', 'range'] as const) {
        const { candles, now } = buildSeries(symbol, timeframe, kind)
        const result = evaluate({ symbol, timeframe, candles, now })
        const expected = kind === 'buy' ? 'BUY' : kind === 'sell' ? 'SELL' : 'NO_SIGNAL'
        if (result.action !== expected) {
          failures.push(`${symbol} ${timeframe} ${kind}: expected ${expected}, got ${result.action} — ${result.reason}`)
        }
      }
    }
  }
  assert.deepEqual(failures, [])
})

test('no repainting: a forming bar cannot change the result', () => {
  const { candles, now } = buildSeries('XAUUSD', '1H', 'buy')
  const clean = evaluate({ symbol: 'XAUUSD', timeframe: '1H', candles, now })

  const forming: Candle = {
    time: now + TIMEFRAME_SECONDS['1H'] * 1000,
    open: clean.indicators!.close * 2,
    high: clean.indicators!.close * 3,
    low: 1,
    close: clean.indicators!.close * 2.5,
    volume: 999,
  }
  const withForming = evaluate({ symbol: 'XAUUSD', timeframe: '1H', candles: [...candles, forming], now })

  assert.equal(withForming.action, clean.action)
  assert.equal(withForming.barTime, clean.barTime)
  assert.deepEqual(withForming.levels, clean.levels)
  assert.deepEqual(withForming.score, clean.score)
})

test('signal levels freeze on the closed bar', () => {
  const { candles, now } = buildSeries('EURUSD', '15m', 'sell')
  const first = evaluate({ symbol: 'EURUSD', timeframe: '15m', candles, now })
  const second = evaluate({ symbol: 'EURUSD', timeframe: '15m', candles, now })
  assert.equal(first.action, second.action)
  assert.deepEqual(first.levels, second.levels)
  assert.deepEqual(first.structure, second.structure)
})

test('TP1 releases the active slot while TP2/TP3 stay tracked', () => {
  const { candles, now } = buildSeries('XAUUSD', '1H', 'buy')
  const result = evaluate({ symbol: 'XAUUSD', timeframe: '1H', candles, now })
  assert.equal(result.action, 'BUY')
  const signal = result.signal!
  assert.ok(occupiesActiveSlot(signal.status))

  const after = signal.barTime + 60_000
  const tp1Bar: Candle = {
    time: after,
    open: signal.levels.entry,
    high: signal.levels.tp1,
    low: signal.levels.entry,
    close: signal.levels.tp1,
    volume: 100,
  }
  const tp1 = advanceSignal(signal, [tp1Bar], after)
  assert.equal(tp1.status, 'TP1_HIT')
  assert.equal(tp1.currentStopLoss, signal.levels.breakevenStop)
  assert.equal(tp1.breakevenApplied, true)
  assert.equal(occupiesActiveSlot(tp1.status), false)

  if (signal.levels.tp2 !== null) {
    const tp2Bar: Candle = {
      time: after + 60_000,
      open: signal.levels.tp1,
      high: signal.levels.tp2,
      low: signal.levels.tp1,
      close: signal.levels.tp2,
      volume: 100,
    }
    const tp2 = advanceSignal(tp1, [tp2Bar], after + 60_000)
    assert.equal(tp2.status, 'TP2_HIT')
  }
})

test('a stop-loss touch closes the signal', () => {
  const { candles, now } = buildSeries('BTCUSD', '4H', 'sell')
  const result = evaluate({ symbol: 'BTCUSD', timeframe: '4H', candles, now })
  assert.equal(result.action, 'SELL')
  const signal = result.signal!
  const after = signal.barTime + 60_000
  const stopBar: Candle = {
    time: after,
    open: signal.levels.entry,
    high: signal.levels.stopLoss,
    low: signal.levels.entry,
    close: signal.levels.entry,
    volume: 100,
  }
  const stopped = advanceSignal(signal, [stopBar], after)
  assert.equal(stopped.status, 'STOP_LOSS_HIT')
  assert.equal(occupiesActiveSlot(stopped.status), false)
})

test('duplicate bar and cooldown protection', async () => {
  const store = await import('../server/v1Store.ts')
  const { candles, now } = buildSeries('XAUUSD', '1H', 'buy')
  const signal = evaluate({ symbol: 'XAUUSD', timeframe: '1H', candles, now }).signal as Signal
  assert.ok(signal)

  assert.equal(store.isDuplicateBar(signal, signal.barTime, '1H'), true)
  assert.equal(store.isDuplicateBar(signal, signal.barTime + TIMEFRAME_SECONDS['1H'] * 1000, '1H'), true)
  assert.equal(store.isDuplicateBar(signal, signal.barTime + TIMEFRAME_SECONDS['1H'] * 4000, '1H'), false)
})
