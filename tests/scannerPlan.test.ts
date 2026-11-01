import { strict as assert } from 'node:assert'
import test from 'node:test'
import { buildScannerPlan } from '../src/features/scanner/scannerPlan.ts'
import type { Candle as CandleData } from '../src/v1/types.ts'

function candles(direction: 'UP' | 'DOWN', count = 180): CandleData[] {
  const start = Date.UTC(2026, 0, 1)
  return Array.from({ length: count }, (_, index) => {
    const trend = (direction === 'UP' ? 1 : -1) * index * 0.2
    const close = 100 + trend + Math.sin(index / 5) * 1.2
    const open = close - (direction === 'UP' ? 0.1 : -0.1)
    return { time: start + (index + 1) * 300_000, open, high: Math.max(open, close) + 0.45, low: Math.min(open, close) - 0.45, close, volume: 100 + index }
  })
}

test('unlimited scanner BUY plan has ordered structural levels', () => {
  const plan = buildScannerPlan('LONG', candles('UP'))
  assert.ok(plan)
  assert.equal(plan.action, 'BUY')
  assert.ok(plan.stopLoss < plan.entry)
  assert.ok(plan.entry < plan.tp1 && plan.tp1 < plan.tp2 && plan.tp2 < plan.tp3)
  assert.ok((plan.tp1 - plan.entry) / plan.risk >= 1 - 1e-9)
})

test('unlimited scanner SELL plan has ordered structural levels', () => {
  const plan = buildScannerPlan('SHORT', candles('DOWN'))
  assert.ok(plan)
  assert.equal(plan.action, 'SELL')
  assert.ok(plan.stopLoss > plan.entry)
  assert.ok(plan.entry > plan.tp1 && plan.tp1 > plan.tp2 && plan.tp2 > plan.tp3)
  assert.ok((plan.entry - plan.tp1) / plan.risk >= 1 - 1e-9)
})

test('WAIT never invents a trade plan', () => {
  assert.equal(buildScannerPlan('WAIT', candles('UP')), null)
})
