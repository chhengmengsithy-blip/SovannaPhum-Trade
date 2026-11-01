/** Deterministic OHLCV builders shared by the V1 tests. */

import type { Candle, Timeframe } from '../src/v1/types.ts'
import { TIMEFRAME_SECONDS } from '../src/v1/types.ts'

export const BASES: Record<string, number> = { XAUUSD: 2000, EURUSD: 1.1, BTCUSD: 60000 }
export const SYMBOLS = Object.keys(BASES)

export type Kind = 'buy' | 'sell' | 'range'

export function mulberry32(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(rng: () => number) {
  const u = Math.max(rng(), 1e-12)
  const v = Math.max(rng(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export function buildSeries(
  symbol: string,
  timeframe: Timeframe,
  kind: Kind,
  n = 260,
): { candles: Candle[]; now: number } {
  const scale = BASES[symbol] / 100
  const [center, slope, amplitude, period, noise, seed] = kind === 'buy'
    ? [100, 0.12, 1, 24, 0.25, 3]
    : kind === 'sell'
      ? [100, 0.12, 1, 24, 0.25, 3]
      : [100, 0, 1, 12, 0.05, 5]
  const rng = mulberry32(seed)
  let raw = Array.from({ length: n }, (_, i) => (
    center + slope * i + amplitude * Math.sin((2 * Math.PI * i) / period) + gaussian(rng) * noise
  ) * scale)
  if (kind === 'sell') {
    const mirror = 230 * scale
    raw = raw.map(value => mirror - value)
  }

  const interval = TIMEFRAME_SECONDS[timeframe] * 1000
  const start = Date.UTC(2026, 0, 1)
  const candles = raw.map((value, i) => ({
    time: start + interval * (i + 1),
    open: value + (kind === 'sell' ? 0.05 : -0.05) * scale,
    high: value + 0.45 * scale,
    low: value - 0.45 * scale,
    close: value,
    volume: 100 + 20 * Math.sin(i / 5) + 10 * Math.abs(gaussian(rng)),
  }))
  return { candles, now: candles[candles.length - 1].time + 1000 }
}
