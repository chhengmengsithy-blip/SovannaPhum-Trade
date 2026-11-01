/**
 * Closed-candle validation for V3 PRO.
 *
 * V3 needs the longest warm-up of the three engines because EMA 200, ADX,
 * Bollinger, Keltner, Donchian, Stochastic, ROC and MFI are all part of the
 * decision. A signal is never evaluated on an unclosed, stale, duplicated or
 * inconsistent series.
 */

import { TIMEFRAME_SECONDS } from '../v1/types.ts'
import type { Candle, Timeframe } from './types.ts'

export const MIN_V3_HISTORY_BARS = 260

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

export function validateV3Candles(
  candles: Candle[],
  timeframe: Timeframe,
  now: number,
): { ok: boolean; notes: string[] } {
  const notes: string[] = []
  if (!candles.length) {
    return { ok: false, notes: ['No closed candles were returned by the market-data feed'] }
  }

  if (candles.length < MIN_V3_HISTORY_BARS) {
    notes.push(
      `Insufficient history: ${candles.length} closed candles, ${MIN_V3_HISTORY_BARS} required for EMA 200, ADX, Keltner, Donchian and the stochastic warm-up`,
    )
  }

  const seen = new Set<number>()
  let duplicate = false
  for (const candle of candles) {
    if (seen.has(candle.time)) duplicate = true
    seen.add(candle.time)
  }
  if (duplicate) notes.push('Duplicate candle timestamps')

  let ascending = true
  for (let i = 1; i < candles.length; i += 1) {
    if (!(candles[i].time > candles[i - 1].time)) ascending = false
  }
  if (!ascending) notes.push('Candle timestamps are not in ascending order')

  let nonFinite = false
  let nonPositive = false
  let inconsistent = 0
  for (const candle of candles) {
    const values = [candle.open, candle.high, candle.low, candle.close]
    if (!values.every(Number.isFinite)) nonFinite = true
    if (values.some(value => value <= 0)) nonPositive = true
    if (
      candle.high < Math.max(candle.open, candle.close) - 1e-12
      || candle.low > Math.min(candle.open, candle.close) + 1e-12
      || candle.high < candle.low
    ) {
      inconsistent += 1
    }
  }
  if (nonFinite) notes.push('Non-finite OHLC value')
  if (nonPositive) notes.push('Non-positive price')
  if (inconsistent) notes.push(`${inconsistent} candle(s) have inconsistent OHLC ranges`)

  const interval = TIMEFRAME_SECONDS[timeframe] * 1000
  let allowed = Math.max(interval * 12, 2 * HOUR)
  if (timeframe === '1H' || timeframe === '4H') allowed = Math.max(allowed, 2 * DAY)
  const moment = new Date(now)
  const weekday = moment.getUTCDay()
  if (weekday === 0 || weekday === 6 || (weekday === 1 && moment.getUTCHours() < 12)) {
    allowed = Math.max(allowed, 4 * DAY)
  }
  const age = now - candles[candles.length - 1].time
  if (age > allowed) {
    notes.push(`Market data is stale: last closed candle is ${Math.round(age / HOUR)}h old (limit ${Math.round(allowed / HOUR)}h)`)
  }

  return { ok: notes.length === 0, notes }
}
