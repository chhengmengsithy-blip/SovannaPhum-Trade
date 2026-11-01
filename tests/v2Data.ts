/**
 * Deterministic OHLCV builders for the V2 PLUS tests.
 *
 * The profiles are geometric, never forecasts. `trend` ends with a fresh
 * bullish CHoCH into a pullback zone with an untaken swing high above it;
 * `range` is a flat market that must never produce a signal.
 */

import type { Candle, Timeframe } from '../src/v2/types.ts'
import { TIMEFRAME_SECONDS } from '../src/v1/types.ts'

export const V2_BASES: Record<string, number> = { XAUUSD: 2000, EURUSD: 1.1, BTCUSD: 60000 }

export type V2Kind = 'trend' | 'sell' | 'range'

function path(kind: V2Kind, n: number): number[] {
  if (kind === 'range') {
    return Array.from({ length: n }, (_, i) => 2000 + 6 * Math.sin((2 * Math.PI * i) / 26))
  }

  // Uptrend 1980 -> 2038, a three-leg pullback (2026 / 2030 / 2027) and a final
  // rally that confirms a bullish reversal and leaves an untaken high above.
  const points: number[] = []
  for (let i = 0; i <= 279; i += 1) {
    points.push(1980 + (i / 279) * 58 + 6 * Math.sin((2 * Math.PI * i) / 24))
  }
  const leg = (from: number, to: number, count: number) => {
    for (let step = 1; step <= count; step += 1) {
      points.push(from + ((to - from) * step) / count)
    }
  }
  leg(2038, 2026, 15)
  leg(2026, 2030, 8)
  leg(2030, 2027, 7)
  leg(2027, 2035, 10)

  while (points.length < n) points.push(points[points.length - 1])
  // `sell` is the exact vertical mirror, so SELL is tested with the same shape.
  const shaped = kind === 'sell' ? points.map(value => 4000 - value) : points
  return shaped.slice(0, n)
}

export function buildV2Series(
  symbol: string,
  timeframe: Timeframe,
  kind: V2Kind,
  n = 320,
  now?: number,
): { candles: Candle[]; now: number } {
  const base = V2_BASES[symbol] ?? 100
  const scale = base / 2000
  const closes = path(kind, n)
  const interval = TIMEFRAME_SECONDS[timeframe] * 1000
  const start = Date.UTC(2026, 0, 1)

  const candles = closes.map((value, index) => {
    const close = value * scale
    const previous = (index === 0 ? value - 0.4 : closes[index - 1]) * scale
    const open = previous
    const wick = (2.2 + 0.7 * (((index * 7) % 5) / 4)) * scale
    const lowerWick = (2.2 + 0.7 * (((index * 3 + 1) % 5) / 4)) * scale
    return {
      time: start + interval * (index + 1),
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - lowerWick,
      close,
      volume: 120 + 30 * Math.sin(index / 6),
    }
  })

  const finalNow = now ?? candles[candles.length - 1].time + 1000
  return { candles, now: finalNow }
}
