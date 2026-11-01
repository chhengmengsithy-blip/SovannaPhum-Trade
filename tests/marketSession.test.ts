import { strict as assert } from 'node:assert'
import test from 'node:test'

import { formatCambodiaTime, marketSession } from '../src/marketSession.ts'

test('weekend markets close while crypto remains live', () => {
  const cambodiaSaturday = new Date(Date.UTC(2026, 9, 31, 6, 0, 0))
  assert.equal(marketSession('XAUUSD', cambodiaSaturday).open, false)
  assert.equal(marketSession('EURUSD', cambodiaSaturday).open, false)
  assert.equal(marketSession('US100', cambodiaSaturday).open, false)
  assert.equal(marketSession('BTCUSD', cambodiaSaturday).open, true)
  assert.equal(marketSession('ETHUSD', cambodiaSaturday).open, true)
})

test('forex reopens at the New York Sunday boundary', () => {
  const afterSundayOpen = new Date(Date.UTC(2026, 10, 1, 23, 0, 0))
  assert.equal(marketSession('EURUSD', afterSundayOpen).open, true)
  assert.equal(marketSession('XAUUSD', afterSundayOpen).open, true)
})

test('US100 follows regular Nasdaq hours', () => {
  assert.equal(marketSession('US100', new Date(Date.UTC(2026, 10, 2, 15, 0, 0))).open, true)
  assert.equal(marketSession('US100', new Date(Date.UTC(2026, 10, 2, 22, 0, 0))).open, false)
})

test('USOIL follows the WTI futures week and daily maintenance break', () => {
  assert.equal(marketSession('USOIL', new Date(Date.UTC(2026, 10, 2, 20, 0, 0))).open, true)
  assert.equal(marketSession('USOIL', new Date(Date.UTC(2026, 10, 2, 22, 30, 0))).open, false)
  assert.equal(marketSession('USOIL', new Date(Date.UTC(2026, 10, 2, 23, 30, 0))).open, true)
})

test('Cambodia clock uses UTC+7', () => {
  const value = formatCambodiaTime(new Date(Date.UTC(2026, 9, 31, 6, 15, 30)))
  assert.equal(value, '13:15:30')
})
