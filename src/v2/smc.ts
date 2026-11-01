/**
 * SMC / ICT context for V2 PLUS.
 *
 * Everything is derived from closed candles only. Mitigation, sweeps and the
 * premium/discount read all stop at the analysis bar, so a setup can be
 * reproduced later from the same candle history.
 *
 * These concepts describe *where* a trade is valid; they never issue a signal on
 * their own. The engine still requires trend, structure, a fresh break and
 * momentum before an entry zone can become a signal.
 */

import type {
  Candle,
  FairValueGap,
  LiquidityLevel,
  LiquiditySweep,
  OrderBlock,
  PremiumDiscount,
  SMCMap,
  Structure,
} from './types.ts'
import { g5 } from './types.ts'

const MAX_ITEMS = 8
const FVG_LOOKBACK = 140
const SWEEP_LOOKBACK = 22
const EQ_TOLERANCE_ATR = 0.15

function finite(value: number | undefined | null): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function roundKey(value: number, tick: number): number {
  return Math.round(value / tick)
}

function detectFvgs(candles: Candle[], lastPos: number, atr: number): FairValueGap[] {
  const start = Math.max(2, lastPos - FVG_LOOKBACK)
  const gaps: FairValueGap[] = []

  for (let i = start; i <= lastPos; i += 1) {
    const first = candles[i - 2]
    const third = candles[i]
    if (!first || !third) continue

    let direction: 'BULLISH' | 'BEARISH' | null = null
    let low = 0
    let high = 0
    if (first.high < third.low && third.close > third.open) {
      direction = 'BULLISH'
      low = first.high
      high = third.low
    } else if (first.low > third.high && third.close < third.open) {
      direction = 'BEARISH'
      low = third.high
      high = first.low
    }
    if (!direction || !(high > low)) continue

    let mitigated = false
    for (let j = i + 1; j <= lastPos; j += 1) {
      if (direction === 'BULLISH' && candles[j].close < low) {
        mitigated = true
        break
      }
      if (direction === 'BEARISH' && candles[j].close > high) {
        mitigated = true
        break
      }
    }

    gaps.push({
      direction,
      low,
      high,
      index: i,
      confirmIndex: i,
      time: third.time,
      mitigated,
    })
  }

  // Keep the freshest unmitigated gaps; a fully filled gap is no longer an entry.
  const unmitigated = gaps.filter(gap => !gap.mitigated)
  const kept = (unmitigated.length ? unmitigated : gaps).slice(-MAX_ITEMS)
  return kept.sort((left, right) => left.index - right.index)
}

function detectOrderBlocks(candles: Candle[], lastPos: number, atr: number): OrderBlock[] {
  const start = Math.max(3, lastPos - FVG_LOOKBACK)
  const blocks: OrderBlock[] = []

  for (let i = start; i <= lastPos; i += 1) {
    const bar = candles[i]
    const body = Math.abs(bar.close - bar.open)
    if (!(body >= 0.6 * atr)) continue

    const bullish = bar.close > bar.open
    let source: number | null = null
    for (let j = i - 1; j >= Math.max(0, i - 3); j -= 1) {
      const candidate = candles[j]
      if (bullish ? candidate.close < candidate.open : candidate.close > candidate.open) {
        source = j
        break
      }
    }
    if (source === null) continue

    const origin = candles[source]
    let mitigated = false
    for (let k = i + 1; k <= lastPos; k += 1) {
      if (bullish ? candles[k].close < origin.low : candles[k].close > origin.high) {
        mitigated = true
        break
      }
    }

    blocks.push({
      direction: bullish ? 'BULLISH' : 'BEARISH',
      low: origin.low,
      high: origin.high,
      index: source,
      confirmIndex: i,
      time: origin.time,
      mitigated,
    })
  }

  const unmitigated = blocks.filter(block => !block.mitigated)
  const kept = (unmitigated.length ? unmitigated : blocks).slice(-MAX_ITEMS)
  return kept.sort((left, right) => left.confirmIndex - right.confirmIndex)
}

function detectEqualLevels(
  candles: Candle[],
  structure: Structure,
  lastPos: number,
  atr: number,
): { equalHighs: LiquidityLevel[]; equalLows: LiquidityLevel[] } {
  const tolerance = EQ_TOLERANCE_ATR * Math.max(atr, 1e-9)
  const build = (
    points: Structure['swingHighs'],
    kind: 'EQH' | 'EQL',
  ): LiquidityLevel[] => {
    const levels: LiquidityLevel[] = []
    for (let i = 1; i < points.length; i += 1) {
      const previous = points[i - 1]
      const current = points[i]
      if (Math.abs(current.price - previous.price) > tolerance) continue
      const price = (current.price + previous.price) / 2
      let swept = false
      for (let j = current.confirmIndex + 1; j <= lastPos; j += 1) {
        if (kind === 'EQH' ? candles[j].high > price : candles[j].low < price) {
          swept = true
          break
        }
      }
      levels.push({
        kind,
        price,
        index: current.index,
        confirmIndex: current.confirmIndex,
        time: current.time,
        swept,
      })
    }
    return levels.slice(-4)
  }

  return {
    equalHighs: build(structure.swingHighs, 'EQH'),
    equalLows: build(structure.swingLows, 'EQL'),
  }
}

function detectSweeps(
  candles: Candle[],
  structure: Structure,
  equalHighs: LiquidityLevel[],
  equalLows: LiquidityLevel[],
  lastPos: number,
  atr: number,
): LiquiditySweep[] {
  const tolerance = 0.05 * Math.max(atr, 1e-9)
  const highLevels: Array<{ price: number; confirmIndex: number; source: 'EQH' | 'SWING' }> = [
    ...equalHighs.map(level => ({ price: level.price, confirmIndex: level.confirmIndex, source: 'EQH' as const })),
    ...structure.swingHighs.map(point => ({ price: point.price, confirmIndex: point.confirmIndex, source: 'SWING' as const })),
  ]
  const lowLevels: Array<{ price: number; confirmIndex: number; source: 'EQL' | 'SWING' }> = [
    ...equalLows.map(level => ({ price: level.price, confirmIndex: level.confirmIndex, source: 'EQL' as const })),
    ...structure.swingLows.map(point => ({ price: point.price, confirmIndex: point.confirmIndex, source: 'SWING' as const })),
  ]

  const sweeps: LiquiditySweep[] = []
  const seen = new Set<string>()
  const start = Math.max(1, lastPos - SWEEP_LOOKBACK)

  for (let i = start; i <= lastPos; i += 1) {
    const bar = candles[i]
    for (const level of highLevels) {
      if (level.confirmIndex >= i) continue
      if (!(bar.high > level.price + tolerance && bar.close < level.price)) continue
      const key = `H:${roundKey(level.price, Math.max(atr, 1e-9) / 10)}:${i}`
      if (seen.has(key)) continue
      seen.add(key)
      sweeps.push({ direction: 'BEARISH', level: level.price, index: i, time: bar.time, source: level.source })
    }
    for (const level of lowLevels) {
      if (level.confirmIndex >= i) continue
      if (!(bar.low < level.price - tolerance && bar.close > level.price)) continue
      const key = `L:${roundKey(level.price, Math.max(atr, 1e-9) / 10)}:${i}`
      if (seen.has(key)) continue
      seen.add(key)
      sweeps.push({ direction: 'BULLISH', level: level.price, index: i, time: bar.time, source: level.source })
    }
  }

  return sweeps.slice(-MAX_ITEMS)
}

function dealingRange(structure: Structure, candles: Candle[], lastPos: number) {
  if (finite(structure.rangeHigh) && finite(structure.rangeLow) && structure.rangeHigh > structure.rangeLow) {
    return { high: structure.rangeHigh, low: structure.rangeLow }
  }
  const start = Math.max(0, lastPos - 30)
  let high = -Infinity
  let low = Infinity
  for (let i = start; i <= lastPos; i += 1) {
    high = Math.max(high, candles[i].high)
    low = Math.min(low, candles[i].low)
  }
  return high > low ? { high, low } : { high: null, low: null }
}

function classifyPremiumDiscount(
  close: number,
  high: number | null,
  low: number | null,
): PremiumDiscount {
  if (high === null || low === null || !(high > low)) return 'EQUILIBRIUM'
  const position = (close - low) / (high - low)
  if (position > 0.55) return 'PREMIUM'
  if (position < 0.45) return 'DISCOUNT'
  return 'EQUILIBRIUM'
}

function narrative(
  fvgs: FairValueGap[],
  blocks: OrderBlock[],
  equalHighs: LiquidityLevel[],
  equalLows: LiquidityLevel[],
  sweeps: LiquiditySweep[],
  zone: PremiumDiscount,
  high: number | null,
  low: number | null,
): string {
  const parts: string[] = []
  const activeGaps = fvgs.filter(gap => !gap.mitigated)
  if (activeGaps.length) {
    const last = activeGaps[activeGaps.length - 1]
    parts.push(`Open ${last.direction.toLowerCase()} FVG ${g5(last.low)}–${g5(last.high)}`)
  } else {
    parts.push('No open fair value gap in the recent window')
  }

  const activeBlocks = blocks.filter(block => !block.mitigated)
  if (activeBlocks.length) {
    const last = activeBlocks[activeBlocks.length - 1]
    parts.push(`Active ${last.direction.toLowerCase()} order block ${g5(last.low)}–${g5(last.high)}`)
  }

  if (equalHighs.length) parts.push(`EQH at ${g5(equalHighs[equalHighs.length - 1].price)}`)
  if (equalLows.length) parts.push(`EQL at ${g5(equalLows[equalLows.length - 1].price)}`)

  if (sweeps.length) {
    const last = sweeps[sweeps.length - 1]
    parts.push(`${last.direction === 'BULLISH' ? 'Sell-side' : 'Buy-side'} sweep at ${g5(last.level)}`)
  }

  parts.push(`${zone.charAt(0)}${zone.slice(1).toLowerCase()} of the dealing range ${g5(low)}–${g5(high)}`)
  return parts.join('; ')
}

export function analyzeSMC(
  candles: Candle[],
  structure: Structure,
  atr: number,
  lastPos: number,
): SMCMap {
  if (!candles.length || !(atr > 0)) {
    return {
      fvgs: [],
      orderBlocks: [],
      equalHighs: [],
      equalLows: [],
      sweeps: [],
      premiumDiscount: 'EQUILIBRIUM',
      equilibrium: null,
      dealingRangeHigh: null,
      dealingRangeLow: null,
      narrative: 'No SMC context is available yet.',
    }
  }

  const fvgs = detectFvgs(candles, lastPos, atr)
  const orderBlocks = detectOrderBlocks(candles, lastPos, atr)
  const { equalHighs, equalLows } = detectEqualLevels(candles, structure, lastPos, atr)
  const sweeps = detectSweeps(candles, structure, equalHighs, equalLows, lastPos, atr)
  const range = dealingRange(structure, candles, lastPos)
  const zone = classifyPremiumDiscount(candles[lastPos].close, range.high, range.low)

  return {
    fvgs,
    orderBlocks,
    equalHighs,
    equalLows,
    sweeps,
    premiumDiscount: zone,
    equilibrium: range.high !== null && range.low !== null ? (range.high + range.low) / 2 : null,
    dealingRangeHigh: range.high,
    dealingRangeLow: range.low,
    narrative: narrative(fvgs, orderBlocks, equalHighs, equalLows, sweeps, zone, range.high, range.low),
  }
}
