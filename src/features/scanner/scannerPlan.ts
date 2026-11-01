import type { Candle as CandleData } from '../../v1/types'
import type { ScanBias } from './chartScanner'

export type ScannerTradePlan = {
  action: 'BUY' | 'SELL'
  entryZoneLow: number
  entryZoneHigh: number
  entry: number
  stopLoss: number
  tp1: number
  tp2: number
  tp3: number
  risk: number
  atr: number
  barTime: number
  references: string[]
}

function finite(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

function atr(candles: CandleData[], length = 14): number {
  const ranges: number[] = []
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index]
    const previous = candles[index - 1].close
    ranges.push(Math.max(candle.high - candle.low, Math.abs(candle.high - previous), Math.abs(candle.low - previous)))
  }
  const sample = ranges.slice(-length)
  return sample.reduce((total, value) => total + value, 0) / Math.max(1, sample.length)
}

function pivots(candles: CandleData[], kind: 'LOW' | 'HIGH'): number[] {
  const output: number[] = []
  for (let index = 2; index < candles.length - 2; index += 1) {
    const value = kind === 'LOW' ? candles[index].low : candles[index].high
    const neighbors = candles.slice(index - 2, index + 3).filter((_, offset) => offset !== 2)
    const confirmed = kind === 'LOW'
      ? neighbors.every(candle => value < candle.low)
      : neighbors.every(candle => value > candle.high)
    if (confirmed) output.push(value)
  }
  return output
}

export function buildScannerPlan(bias: ScanBias, rawCandles: CandleData[]): ScannerTradePlan | null {
  if (bias === 'WAIT') return null
  const candles = [...rawCandles]
    .filter(candle => finite(candle.open) && finite(candle.high) && finite(candle.low) && finite(candle.close) && Number.isFinite(candle.time))
    .sort((left, right) => left.time - right.time)
  if (candles.length < 40) return null

  const recent = candles.slice(-160)
  const last = recent[recent.length - 1]
  const atrValue = atr(recent)
  if (!finite(atrValue)) return null
  const buy = bias === 'LONG'
  const entry = last.close
  const halfZone = Math.max(0.12 * atrValue, entry * 0.00005)
  const lows = pivots(recent, 'LOW').filter(value => value < entry - 0.2 * atrValue)
  const highs = pivots(recent, 'HIGH').filter(value => value > entry + 0.2 * atrValue)

  const structuralStop = buy
    ? (lows.length ? lows[lows.length - 1] - 0.2 * atrValue : entry - atrValue)
    : (highs.length ? highs[highs.length - 1] + 0.2 * atrValue : entry + atrValue)
  const rawRisk = buy ? entry - structuralStop : structuralStop - entry
  const risk = Math.max(0.6 * atrValue, Math.min(3 * atrValue, rawRisk))
  const stopLoss = buy ? entry - risk : entry + risk

  const targets = buy ? highs.sort((a, b) => a - b) : lows.sort((a, b) => b - a)
  const targetAt = (multiple: number, beyond: number | null = null) => {
    const projected = buy ? entry + multiple * risk : entry - multiple * risk
    const structural = targets.find(value => (
      (buy ? value >= projected : value <= projected)
      && (beyond === null || (buy ? value > beyond : value < beyond))
    ))
    if (structural !== undefined) return structural
    if (beyond === null) return projected
    return buy ? Math.max(projected, beyond + risk) : Math.min(projected, beyond - risk)
  }

  const tp1 = targetAt(1)
  const tp2 = targetAt(2, tp1)
  const tp3 = targetAt(3, tp2)

  return {
    action: buy ? 'BUY' : 'SELL',
    entryZoneLow: entry - halfZone,
    entryZoneHigh: entry + halfZone,
    entry,
    stopLoss,
    tp1,
    tp2,
    tp3,
    risk,
    atr: atrValue,
    barTime: last.time,
    references: [
      'Image structure and momentum bias',
      lows.length || highs.length ? 'Confirmed 2L/2R swing invalidation' : 'ATR fallback invalidation',
      'Real closed market candle from Yahoo Finance',
    ],
  }
}
