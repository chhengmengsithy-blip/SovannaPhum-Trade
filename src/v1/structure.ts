/**
 * Confirmed market structure for the V1 FREE strategy.
 *
 * Only pivots that were knowable at the analysis bar are used. A pivot at index
 * `p` is confirmed at `p + lookback`; a break is accepted only on a candle that
 * closes beyond the level after that confirmation, and only once per pivot. That
 * is what keeps BOS/CHoCH free of look-ahead and repeated detection.
 */

import { confirmedSwingHighs, confirmedSwingLows } from './indicators.ts'
import type {
  BreakEvent,
  BreakKind,
  Candle,
  MarketView,
  Structure,
  SwingPoint,
} from './types.ts'
import { g5 } from './types.ts'

const MIN_RANGE_PIVOTS = 6
// Must match the engine's break-recency gate. A 21-bar-old CHoCH is still the
// current structure on a 1H chart; using a shorter view window here would let
// stale swing labels overrule the latest confirmed break.
const BREAK_VIEW_RECENCY = 30

type PivotKind = 'HIGH' | 'LOW'

function pivots(
  candles: Candle[],
  kind: PivotKind,
  lookback: number,
  lastPos: number,
): SwingPoint[] {
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

/**
 * Detect candle-close BOS/CHoCH events without look-ahead.
 *
 * At each candle the most recent *unbroken* pivot confirmed on an earlier candle
 * is the active level. A close beyond it by `breakBuffer` is a break; the pivot
 * is retired so the same level cannot fire again.
 */
function scanBreaks(
  candles: Candle[],
  highs: SwingPoint[],
  lows: SwingPoint[],
  lastPos: number,
  breakBuffer: number,
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
    const checks: PivotKind[] = close >= previousClose ? ['HIGH', 'LOW'] : ['LOW', 'HIGH']

    for (const side of checks) {
      if (side === 'HIGH' && activeHigh) {
        const level = activeHigh.price
        if (close > level + breakBuffer && previousClose <= level) {
          events.push({
            kind: bias === 'BEARISH' ? 'CHOCH' : 'BOS',
            direction: 'BULLISH',
            level,
            pivotIndex: activeHigh.index,
            confirmIndex: pos,
            confirmPrice: close,
            time: candles[pos].time,
          })
          brokenHighs.add(activeHigh.index)
          bias = 'BULLISH'
          break
        }
      } else if (side === 'LOW' && activeLow) {
        const level = activeLow.price
        if (close < level - breakBuffer && previousClose >= level) {
          events.push({
            kind: bias === 'BULLISH' ? 'CHOCH' : 'BOS',
            direction: 'BEARISH',
            level,
            pivotIndex: activeLow.index,
            confirmIndex: pos,
            confirmPrice: close,
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
  return `${event.direction} ${event.kind} at ${g5(event.level)}`
}

function narrative(
  view: MarketView,
  highs: SwingPoint[],
  lows: SwingPoint[],
  lastBos: BreakEvent | null,
  lastChoch: BreakEvent | null,
): string {
  const parts: string[] = []
  const lastHigh = highs.length ? highs[highs.length - 1].label : '—'
  const lastLow = lows.length ? lows[lows.length - 1].label : '—'
  parts.push(`Last swing labels: high ${lastHigh || '—'}, low ${lastLow || '—'}`)
  if (lastBos) parts.push(`Last BOS: ${eventSummary(lastBos)}`)
  if (lastChoch) parts.push(`Last CHoCH: ${eventSummary(lastChoch)}`)
  if (view === 'RANGING') {
    parts.push('No clear HH/HL or LH/LL sequence and no recent confirmed break')
  } else {
    parts.push(`${view.charAt(0)}${view.slice(1).toLowerCase()} structure`)
  }
  return parts.join('; ')
}

export type StructureOptions = {
  lookback?: number
  lastPos?: number
  close?: number
  breakBuffer?: number
}

export function emptyStructure(): Structure {
  return {
    view: 'RANGING',
    bias: 'RANGING',
    support: null,
    resistance: null,
    rangeHigh: null,
    rangeLow: null,
    lastBos: null,
    lastChoch: null,
    swingHighs: [],
    swingLows: [],
    recentLabels: [],
    narrative: '',
  }
}

export function analyzeStructure(candles: Candle[], options: StructureOptions = {}): Structure {
  if (!candles.length) return emptyStructure()

  const lookback = options.lookback ?? 2
  const pos = options.lastPos ?? candles.length - 1
  const lastClose = options.close ?? candles[pos].close
  const breakBuffer = options.breakBuffer ?? 0

  const highs = pivots(candles, 'HIGH', lookback, pos)
  const lows = pivots(candles, 'LOW', lookback, pos)
  const { events, bias } = scanBreaks(candles, highs, lows, pos, breakBuffer)
  const view = structureView(highs, lows, events, bias, pos)

  const resistanceLevels = highs.filter(point => point.price > lastClose).map(point => point.price)
  const supportLevels = lows.filter(point => point.price < lastClose).map(point => point.price)
  const resistance = resistanceLevels.length ? Math.min(...resistanceLevels) : null
  const support = supportLevels.length ? Math.max(...supportLevels) : null

  const recentHighs = highs.slice(-MIN_RANGE_PIVOTS)
  const recentLows = lows.slice(-MIN_RANGE_PIVOTS)
  let rangeHigh: number | null = recentHighs.length
    ? Math.max(...recentHighs.map(point => point.price))
    : null
  let rangeLow: number | null = recentLows.length
    ? Math.min(...recentLows.map(point => point.price))
    : null
  if (rangeHigh !== null && rangeLow !== null && rangeHigh <= rangeLow) {
    rangeHigh = null
    rangeLow = null
  }

  const recentLabels = highs.slice(-3).map(point => `H:${point.label || '—'}`)
  recentLabels.push(...lows.slice(-3).map(point => `L:${point.label || '—'}`))

  const lastBos = lastEvent(events, 'BOS')
  const lastChoch = lastEvent(events, 'CHOCH')

  return {
    view,
    bias: view !== 'RANGING' ? view : bias,
    support,
    resistance,
    rangeHigh,
    rangeLow,
    lastBos,
    lastChoch,
    swingHighs: highs.slice(-20),
    swingLows: lows.slice(-20),
    recentLabels,
    narrative: narrative(view, highs, lows, lastBos, lastChoch),
  }
}
