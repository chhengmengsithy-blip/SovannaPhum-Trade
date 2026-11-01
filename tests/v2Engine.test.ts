/**
 * Deterministic V2 PLUS engine tests.
 *
 * Run with: npm run test:v2
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { evaluateV2 } from '../src/v2/engine.ts'
import { advanceSignalV2, isTerminalV2 } from '../src/v2/lifecycle.ts'
import type { Candle, Signal, Timeframe } from '../src/v2/types.ts'
import {
  V2_ANALYSES_PER_DAY,
  V2_BEST_SETUPS_PER_DAY,
  V2_SCANS_PER_DAY,
  V2_SCAN_SYMBOL_LIMIT,
  V2_SIGNALS_PER_DAY,
  v2PlanAllowed,
} from '../src/v2/types.ts'
import { V2_BASES } from './v2Data.ts'
import { buildV2Series } from './v2Data.ts'

const SYMBOLS = Object.keys(V2_BASES)
const TIMEFRAMES: Timeframe[] = ['5m', '15m', '30m', '1H', '4H']

test('trend, mirrored sell and range profiles across every symbol and timeframe', () => {
  const failures: string[] = []
  for (const symbol of SYMBOLS) {
    for (const timeframe of TIMEFRAMES) {
      for (const kind of ['trend', 'sell', 'range'] as const) {
        const { candles, now } = buildV2Series(symbol, timeframe, kind)
        const result = evaluateV2({ symbol, timeframe, candles, now })
        const expected = kind === 'trend' ? 'BUY' : kind === 'sell' ? 'SELL' : 'NO_SIGNAL'
        if (result.action !== expected) {
          failures.push(`${symbol} ${timeframe} ${kind}: expected ${expected}, got ${result.action} — ${result.reason}`)
        }
      }
    }
  }
  assert.deepEqual(failures, [])
})

test('V2 derives confirmed support and resistance key levels without future bars', () => {
  const { candles, now } = buildV2Series('XAUUSD', '1H', 'range')
  const result = evaluateV2({ symbol: 'XAUUSD', timeframe: '1H', candles, now })
  const levels = result.structure.keyLevels
  assert.ok(levels.some(level => level.kind === 'SUPPORT'))
  assert.ok(levels.some(level => level.kind === 'RESISTANCE'))
  assert.ok(levels.every(level => Number.isFinite(level.price) && level.touches >= 1))
  assert.ok(levels.every(level => level.lastConfirmedIndex < candles.length))
  assert.ok(levels.some(level => level.strength === 'STRONG' && level.touches >= 3))
})

test('every generated plan respects the V2 risk rules', () => {
  for (const symbol of SYMBOLS) {
    for (const kind of ['trend', 'sell'] as const) {
      const { candles, now } = buildV2Series(symbol, '1H', kind)
      const result = evaluateV2({ symbol, timeframe: '1H', candles, now })
      assert.equal(result.action, kind === 'trend' ? 'BUY' : 'SELL')
      const levels = result.levels
      const snapshot = result.indicators
      assert.ok(levels && snapshot)

      const buy = result.action === 'BUY'
      if (buy) {
        assert.ok(levels.stopLoss < levels.entry)
        assert.ok(levels.entry < levels.tp1)
      } else {
        assert.ok(levels.stopLoss > levels.entry)
        assert.ok(levels.entry > levels.tp1)
      }
      assert.ok(levels.rrTp1 >= 1 - 1e-9, `TP1 ${levels.rrTp1} below 1R`)
      if (levels.tp2 !== null) assert.ok(levels.rrTp2 !== null && levels.rrTp2 >= 2 - 1e-9)
      if (levels.tp3 !== null) assert.ok(levels.rrTp3 !== null && levels.rrTp3 >= 3 - 1e-9)
      assert.equal(levels.tp1CloseFraction, 0.5)
      assert.equal(levels.allocations[0], 0.5)
      assert.ok(Math.abs(levels.allocations.reduce((total, part) => total + part, 0) - 1) < 1e-9)

      // Swing + ATR stop: Gold allows 4 ATR; other markets remain capped at 3.5.
      const riskAtr = levels.risk / snapshot.atr
      const maxRiskAtr = symbol === 'XAUUSD' ? 4 : 3.5
      assert.ok(riskAtr >= 0.25 && riskAtr <= maxRiskAtr, `risk ${riskAtr} ATR out of bounds`)
      const cap = symbol === 'XAUUSD' ? 0.04 : symbol === 'BTCUSD' ? 0.07 : 0.025
      assert.ok(levels.risk / levels.entry <= cap)

      // TP1 takes half, and the runner is protected at breakeven plus costs.
      if (buy) {
        assert.ok(levels.breakevenStop > levels.entry)
      } else {
        assert.ok(levels.breakevenStop < levels.entry)
      }
      assert.ok(levels.references.length >= 3)
      assert.equal(result.signal?.lastEvaluatedBar, result.barTime)
    }
  }
})

test('no repainting: a forming bar cannot change the result', () => {
  const { candles, now } = buildV2Series('XAUUSD', '1H', 'trend')
  const clean = evaluateV2({ symbol: 'XAUUSD', timeframe: '1H', candles, now })
  assert.equal(clean.action, 'BUY')

  const forming: Candle = {
    time: now + 3_600_000,
    open: clean.indicators!.close * 2,
    high: clean.indicators!.close * 3,
    low: 1,
    close: clean.indicators!.close * 2.5,
    volume: 999,
  }
  const withForming = evaluateV2({ symbol: 'XAUUSD', timeframe: '1H', candles: [...candles, forming], now })

  assert.equal(withForming.action, clean.action)
  assert.equal(withForming.barTime, clean.barTime)
  assert.deepEqual(withForming.levels, clean.levels)
  assert.deepEqual(withForming.score, clean.score)
})

test('insufficient history is reported as NO SIGNAL with data notes', () => {
  const { candles, now } = buildV2Series('EURUSD', '15m', 'trend', 120)
  const result = evaluateV2({ symbol: 'EURUSD', timeframe: '15m', candles, now })
  assert.equal(result.action, 'NO_SIGNAL')
  assert.equal(result.dataOk, false)
  assert.ok(result.dataNotes.some(note => /Insufficient history/.test(note)))
})

test('structure uses confirmed 3L/3R pivots and never sees the future', () => {
  const { candles, now } = buildV2Series('XAUUSD', '4H', 'trend')
  const result = evaluateV2({ symbol: 'XAUUSD', timeframe: '4H', candles, now })
  const lastPos = result.barTime === candles[candles.length - 1].time ? candles.length - 1 : -1
  assert.equal(lastPos, candles.length - 1)

  for (const point of [...result.structure.swingHighs, ...result.structure.swingLows]) {
    assert.equal(point.confirmIndex, point.index + 3)
    assert.ok(point.confirmIndex <= lastPos)
  }
  for (const event of [result.structure.lastBos, result.structure.lastChoch, result.structure.lastMss]) {
    if (event) assert.ok(event.confirmIndex > event.pivotIndex)
  }
})

test('TP1 closes 50%, the stop moves to breakeven and bars are never replayed', () => {
  const { candles, now } = buildV2Series('XAUUSD', '1H', 'trend')
  const base = evaluateV2({ symbol: 'XAUUSD', timeframe: '1H', candles, now }).signal
  assert.ok(base)

  const signal: Signal = { ...base, levels: { ...base.levels, tp2: base.levels.tp1 + base.levels.risk, tp3: null } }
  const buy = signal.direction === 'BUY'
  const step = 3_600_000

  const tp1Bar: Candle = {
    time: signal.barTime + step,
    open: signal.levels.entry,
    high: buy ? signal.levels.tp1 : signal.levels.entry,
    low: buy ? signal.levels.entry : signal.levels.tp1,
    close: signal.levels.tp1,
    volume: 100,
  }

  const afterTp1 = advanceSignalV2(signal, [tp1Bar], tp1Bar.time + 1)
  assert.equal(afterTp1.status, 'TP1_HIT')
  assert.equal(afterTp1.closedFraction, 0.5)
  assert.equal(afterTp1.currentStopLoss, signal.levels.breakevenStop)
  assert.equal(afterTp1.breakevenApplied, true)
  assert.equal(afterTp1.lastEvaluatedBar, tp1Bar.time)

  // Replaying the same closed candle must not change anything again.
  const replay = advanceSignalV2(afterTp1, [tp1Bar], tp1Bar.time + 2)
  assert.equal(replay, afterTp1)

  const tp2Bar: Candle = {
    time: tp1Bar.time + step,
    open: signal.levels.tp1,
    high: buy ? signal.levels.tp2 : signal.levels.tp1,
    low: buy ? signal.levels.tp1 : signal.levels.tp2,
    close: signal.levels.tp2,
    volume: 100,
  }
  const afterTp2 = advanceSignalV2(afterTp1, [tp2Bar], tp2Bar.time + 1)
  assert.equal(afterTp2.status, 'TP2_HIT')
  assert.equal(afterTp2.closedFraction, 1)
  assert.equal(isTerminalV2(afterTp2), true)
})

test('a bar that touches stop and target resolves conservatively as a stop', () => {
  const { candles, now } = buildV2Series('XAUUSD', '1H', 'trend')
  const signal = evaluateV2({ symbol: 'XAUUSD', timeframe: '1H', candles, now }).signal
  assert.ok(signal)
  const buy = signal.direction === 'BUY'
  const hitBoth: Candle = {
    time: signal.barTime + 3_600_000,
    open: signal.levels.entry,
    high: buy ? signal.levels.tp1 : signal.levels.stopLoss,
    low: buy ? signal.levels.stopLoss : signal.levels.tp1,
    close: signal.levels.entry,
    volume: 100,
  }
  const advanced = advanceSignalV2(signal, [hitBoth], hitBoth.time + 1)
  assert.equal(advanced.status, 'STOP_LOSS_HIT')
  assert.equal(advanced.closedFraction, 1)
  assert.equal(isTerminalV2(advanced), true)
})

test('PLUS plan limits and the plan gate are fixed', () => {
  assert.equal(v2PlanAllowed('free'), false)
  assert.equal(v2PlanAllowed('plus'), true)
  // Pro is routed to V3 PRO, never V2 PLUS.
  assert.equal(v2PlanAllowed('pro'), false)
  assert.deepEqual(
    [V2_ANALYSES_PER_DAY, V2_SIGNALS_PER_DAY, V2_BEST_SETUPS_PER_DAY, V2_SCANS_PER_DAY, V2_SCAN_SYMBOL_LIMIT],
    [50, 15, 10, 20, 12],
  )
})
