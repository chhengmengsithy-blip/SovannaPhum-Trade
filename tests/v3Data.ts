/**
 * Deterministic OHLCV builders for the V3 PRO tests.
 *
 * The profiles are geometric, never forecasts. `trend` ends with a bullish
 * reversal into a pullback zone with untaken swing highs above it; `sell` is
 * its exact vertical mirror; `range` oscillates without a directional stack and
 * ends near the middle of its own range, so it must not force a trade.
 */

import type { Candle, Timeframe } from '../src/v3/types.ts'
import { TIMEFRAME_SECONDS } from '../src/v1/types.ts'

export const V3_BASES: Record<string, number> = { XAUUSD: 2000, EURUSD: 1.1, BTCUSD: 60000 }

export type V3Kind = 'trend' | 'sell' | 'range'

function trendPath(n: number): number[] {
  // Phase lengths scale with `n` so the same shape works for the 259-bar
  // validation test and the 360-bar engine matrix.
  const phase1 = Math.max(40, Math.round(n * 0.62))
  const phase2 = Math.max(10, Math.round(n * 0.1))
  const phase3 = Math.max(6, Math.round(n * 0.06))
  const phase4 = Math.max(5, Math.round(n * 0.04))
  const phase5 = n - phase1 - phase2 - phase3 - phase4
  const points: number[] = []
  const leg = (from: number, to: number, count: number) => {
    for (let step = 1; step <= count; step += 1) {
      points.push(from + ((to - from) * step) / count)
    }
  }

  // Base uptrend 1980 -> 2060 with a regular swing rhythm (HH/HL). The final
  // rally stops below these highs, so resistance remains above the entry.
  for (let i = 0; i < phase1; i += 1) {
    points.push(1980 + (i / (phase1 - 1)) * 80 + 5 * Math.sin((2 * Math.PI * i) / 30))
  }
  // Three-leg pullback: 2060 -> 2018 -> 2024 -> 2019.
  leg(2060, 2018, phase2)
  leg(2018, 2024, phase3)
  leg(2024, 2019, phase4)
  // Zig-zag impulse 2019 -> 2045. The repeating up-up-down rhythm creates the
  // HH/HL labels, strong closes and a confirmed swing low under the entry.
  const steps = [1.3, 1.6, -0.8, 1.4, 1.7, -0.9]
  const raw: number[] = []
  let running = 0
  for (let i = 0; i < phase5; i += 1) {
    running += steps[i % steps.length]
    raw.push(running)
  }
  const total = raw[raw.length - 1] || 1
  for (let i = 0; i < phase5; i += 1) {
    points.push(2019 + (raw[i] / total) * 26)
  }

  return points.slice(0, n)
}

function path(kind: V3Kind, n: number): number[] {
  if (kind === 'range') {
    // Period 24 chosen so a 360-bar series ends near the middle of the range.
    return Array.from({ length: n }, (_, i) => 2000 + 8 * Math.sin((2 * Math.PI * i) / 24))
  }
  const base = trendPath(n)
  return kind === 'sell' ? base.map(value => 4000 - value) : base
}

export function buildV3Series(
  symbol: string,
  timeframe: Timeframe,
  kind: V3Kind,
  n = 360,
  now?: number,
): { candles: Candle[]; now: number } {
  const base = V3_BASES[symbol] ?? 100
  const scale = base / 2000
  const closes = path(kind, n)
  const interval = TIMEFRAME_SECONDS[timeframe] * 1000
  const start = Date.UTC(2026, 0, 1)

  const candles = closes.map((value, index) => {
    const close = value * scale
    const previous = (index === 0 ? value - 0.4 : closes[index - 1]) * scale
    const open = previous
    const wick = (2.0 + 0.6 * (((index * 7) % 5) / 4)) * scale
    const lowerWick = (2.0 + 0.6 * (((index * 3 + 1) % 5) / 4)) * scale
    return {
      time: start + interval * (index + 1),
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - lowerWick,
      close,
      volume: 100 + 90 * (index / Math.max(1, n - 1)) + 20 * Math.sin(index / 6) + (index >= n - 5 ? 80 : 0),
    }
  })

  const finalNow = now ?? candles[candles.length - 1].time + 1000
  return { candles, now: finalNow }
}
