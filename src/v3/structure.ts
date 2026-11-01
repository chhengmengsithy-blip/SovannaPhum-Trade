/**
 * Confirmed market structure for V3 PRO.
 *
 * V3 confirms pivots with 3 candles on each side (3L / 3R). A pivot at index `p`
 * is only knowable at `p + 3`, and every break is accepted on a closed candle
 * after that confirmation, so structure is free of look-ahead and cannot
 * repaint.
 *
 * Break taxonomy is identical to V2 because it is a structural fact, not a
 * strategy rule:
 *   BOS   — continuation in the same direction as the current bias
 *   CHoCH — first close through the opposing level, without displacement
 *   MSS   — the same reversal, but the break candle has real displacement
 */

import { confirmedSwingHighs, confirmedSwingLows } from '../v1/indicators.ts'
import type {
  BreakEvent,
  BreakKind,
  Candle,
  MarketView,
  Structure,
  SwingPoint,
} from './types.ts'
import { g5 } from './types.ts'
import { deriveKeyLevels } from '../shared/keyLevels.ts'

export const V3_PIVOT_LOOKBACK = 3
export const BREAK_VIEW_RECENCY = 30
const MIN_RANGE_PIVOTS = 6

type PivotKind = 'HIGH' | 'LOW'

function finite(value: number | undefined | null): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function pivots(candles: Candle[], kind: PivotKind, lookback: number, lastPos: number): SwingPoint[] {
  const raw = kind === 'HIGH'
    ? confirmedSwingHighs(candles.map(candle => candle.high), lookback)
    : confirmedSwingLows(candles.map(candle => candle.low), lookback)
  if (!raw.length) return []

  const points: SwingPoint[] = []
  let previousPrice: number | null = null
  for (const pivot of raw) {
    if (pivot.confirmPos > lastPos) continue
    const price = pivot.price
    let label = ''
    if (previousPrice !== null) {
      if (kind === 'HIGH') label = price > previousPrice ? 'HH' : price < previousPrice ? 'LH' : ''
      else label = price > previousPrice ? 'HL' : price < previousPrice ? 'LL' : ''
    }
    points.push({
      kind,
      index: pivot.pivotPos,
      confirmIndex: pivot.confirmPos,
      price,
      label,
      time: candles[pivot.pivotPos]?.time ?? null,
    })
    previousPrice = price
  }
  return points
}

function scanBreaks(
  candles: Candle[],
  highs: SwingPoint[],
  lows: SwingPoint[],
  lastPos: number,
  breakBuffer: number,
  atrValues?: number[],
): { events: BreakEvent[]; bias: MarketView } {
  if (!highs.length && !lows.length) return { events: [], bias: 'RANGING' }

  const firstConfirm = Math.min(...[...highs, ...lows].map(point => point.confirmIndex))
  const brokenHighs = new Set<number>()
  const brokenLows = new Set<number>()
  let bias: MarketView = 'RANGING'
  const events: BreakEvent[] = []

  for (let pos = firstConfirm + 1; pos <= lastPos; pos += 1) {
    let activeHigh: SwingPoint | null = null
    for (const point of highs) {
      if (point.confirmIndex <= pos - 1 && !brokenHighs.has(point.index)) activeHigh = point
    }
    let activeLow: SwingPoint | null = null
    for (const point of lows) {
      if (point.confirmIndex <= pos - 1 && !brokenLows.has(point.index)) activeLow = point
    }

    const previousClose = candles[pos - 1].close
    const close = candles[pos].close
    const body = Math.abs(candles[pos].close - candles[pos].open)
    const atrAtBar = atrValues && finite(atrValues[pos]) ? atrValues[pos] : NaN
    const displacement = finite(atrAtBar) && atrAtBar > 0 && body >= 0.5 * atrAtBar
    const checks: PivotKind[] = close >= previousClose ? ['HIGH', 'LOW'] : ['LOW', 'HIGH']

    for (const side of checks) {
      if (side === 'HIGH' && activeHigh) {
        const level = activeHigh.price
        if (close > level + breakBuffer && previousClose <= level + breakBuffer) {
          const kind: BreakKind = bias === 'BEARISH'
            ? (displacement ? 'MSS' : 'CHOCH')
            : 'BOS'
          events.push({
            kind,
            direction: 'BULLISH',
            level,
            pivotIndex: activeHigh.index,
            confirmIndex: pos,
            confirmPrice: close,
            displacement,
            time: candles[pos].time,
          })
          brokenHighs.add(activeHigh.index)
          bias = 'BULLISH'
          break
        }
      } else if (side === 'LOW' && activeLow) {
        const level = activeLow.price
        if (close < level - breakBuffer && previousClose >= level - breakBuffer) {
          const kind: BreakKind = bias === 'BULLISH'
            ? (displacement ? 'MSS' : 'CHOCH')
            : 'BOS'
          events.push({
            kind,
            direction: 'BEARISH',
            level,
            pivotIndex: activeLow.index,
            confirmIndex: pos,
            confirmPrice: close,
            displacement,
            time: candles[pos].time,
          })
          brokenLows.add(activeLow.index)
          bias = 'BEARISH'
          break
        }
      }
    }
  }

  return { events, bias }
}

function lastEvent(events: BreakEvent[], kind: BreakKind): BreakEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].kind === kind) return events[i]
  }
  return null
}

/** The most recent of BOS / CHoCH / MSS, whichever confirmed last. */
export function latestStructureBreak(structure: Structure): BreakEvent | null {
  const candidates = [structure.lastBos, structure.lastChoch, structure.lastMss]
    .filter((event): event is BreakEvent => event !== null)
  if (!candidates.length) return null
  return candidates.reduce((best, event) => (event.confirmIndex >= best.confirmIndex ? event : best))
}

function structureView(
  highs: SwingPoint[],
  lows: SwingPoint[],
  events: BreakEvent[],
  bias: MarketView,
  lastPos: number,
): MarketView {
  const labelsBull = highs.length > 0 && highs[highs.length - 1].label === 'HH'
    && lows.length > 0 && lows[lows.length - 1].label === 'HL'
  const labelsBear = highs.length > 0 && highs[highs.length - 1].label === 'LH'
    && lows.length > 0 && lows[lows.length - 1].label === 'LL'

  const latest = events.length ? events[events.length - 1] : null
  if (latest && lastPos - latest.confirmIndex <= BREAK_VIEW_RECENCY) return latest.direction
  if (labelsBull && !labelsBear) return 'BULLISH'
  if (labelsBear && !labelsBull) return 'BEARISH'
  if (bias !== 'RANGING') return bias
  return 'RANGING'
}

function eventSummary(event: BreakEvent): string {
  return `${event.kind} ${event.direction.toLowerCase()} at ${g5(event.level)}`
}

function narrative(
  view: MarketView,
  highs: SwingPoint[],
  lows: SwingPoint[],
  lastBos: BreakEvent | null,
  lastChoch: BreakEvent | null,
  lastMss: BreakEvent | null,
): string {
  const parts: string[] = []
  const lastHigh = highs.length ? highs[highs.length - 1].label : '—'
  const lastLow = lows.length ? lows[lows.length - 1].label : '—'
  parts.push(`3L/3R swing labels: high ${lastHigh || '—'}, low ${lastLow || '—'}`)
  if (lastBos) parts.push(`Last BOS: ${eventSummary(lastBos)}`)
  if (lastChoch) parts.push(`Last CHoCH: ${eventSummary(lastChoch)}`)
  if (lastMss) parts.push(`Last MSS: ${eventSummary(lastMss)}`)
  if (view === 'RANGING') {
    parts.push('No confirmed HH/HL or LH/LL sequence and no recent break')
  } else {
    parts.push(`${view.charAt(0)}${view.slice(1).toLowerCase()} structure`)
  }
  return parts.join('; ')
}

export type StructureOptions = {
  lookback?: number
  lastPos?: number
  breakBuffer?: number
  /** ATR series used to classify a reversal as MSS (displacement). */
  atrValues?: number[]
}

export function emptyStructureV3(): Structure {
  return {
    view: 'RANGING',
    bias: 'RANGING',
    support: null,
    resistance: null,
    rangeHigh: null,
    rangeLow: null,
    equilibrium: null,
    keyLevels: [],
    lastBos: null,
    lastChoch: null,
    lastMss: null,
    swingHighs: [],
    swingLows: [],
    recentLabels: [],
    narrative: '',
  }
}

export function analyzeStructureV3(candles: Candle[], options: StructureOptions = {}): Structure {
  if (!candles.length) return emptyStructureV3()

  const lookback = options.lookback ?? V3_PIVOT_LOOKBACK
  const pos = options.lastPos ?? candles.length - 1
  const breakBuffer = options.breakBuffer ?? 0
  const lastClose = candles[pos].close

  const highs = pivots(candles, 'HIGH', lookback, pos)
  const lows = pivots(candles, 'LOW', lookback, pos)
  const { events, bias } = scanBreaks(candles, highs, lows, pos, breakBuffer, options.atrValues)
  const view = structureView(highs, lows, events, bias, pos)

  const resistanceLevels = highs.filter(point => point.price > lastClose).map(point => point.price)
  const supportLevels = lows.filter(point => point.price < lastClose).map(point => point.price)
  const resistance = resistanceLevels.length ? Math.min(...resistanceLevels) : null
  const support = supportLevels.length ? Math.max(...supportLevels) : null

  const recentHighs = highs.slice(-MIN_RANGE_PIVOTS)
  const recentLows = lows.slice(-MIN_RANGE_PIVOTS)
  let rangeHigh: number | null = recentHighs.length ? Math.max(...recentHighs.map(point => point.price)) : null
  let rangeLow: number | null = recentLows.length ? Math.min(...recentLows.map(point => point.price)) : null
  if (rangeHigh !== null && rangeLow !== null && rangeHigh <= rangeLow) {
    rangeHigh = null
    rangeLow = null
  }
  const equilibrium = rangeHigh !== null && rangeLow !== null ? (rangeHigh + rangeLow) / 2 : null
  const fallbackAtr = candles.slice(Math.max(0, pos - 19), pos + 1)
    .reduce((total, candle) => total + (candle.high - candle.low), 0) / Math.min(20, pos + 1)
  const keyLevels = deriveKeyLevels(
    [...highs, ...lows],
    lastClose,
    options.atrValues?.[pos] ?? fallbackAtr,
    pos,
  )

  const recentLabels = highs.slice(-3).map(point => `H:${point.label || '—'}`)
  recentLabels.push(...lows.slice(-3).map(point => `L:${point.label || '—'}`))

  const lastBos = lastEvent(events, 'BOS')
  const lastChoch = lastEvent(events, 'CHOCH')
  const lastMss = lastEvent(events, 'MSS')

  return {
    view,
    bias: view !== 'RANGING' ? view : bias,
    support,
    resistance,
    rangeHigh,
    rangeLow,
    equilibrium,
    keyLevels,
    lastBos,
    lastChoch,
    lastMss,
    swingHighs: highs.slice(-24),
    swingLows: lows.slice(-24),
    recentLabels,
    narrative: narrative(view, highs, lows, lastBos, lastChoch, lastMss),
  }
}
