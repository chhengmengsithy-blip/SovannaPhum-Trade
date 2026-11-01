/**
 * Deterministic V1 FREE strategy engine.
 *
 * The engine is a pure function of closed OHLCV candles and an injected clock.
 * It never reads the wall clock itself, never mutates a previous signal and never
 * evaluates an unclosed candle. The sequence is fixed:
 *
 *     direction -> structure -> pullback entry area -> indicator confirmation
 *     -> closed candle -> risk validation -> BUY/SELL or NO SIGNAL
 *
 * V1 does not require every indicator to agree, but it does not ignore the
 * specification either: trend, structure, a fresh BOS/CHoCH, momentum and
 * Supertrend are hard gates, and the weighted score must exceed 60.
 */

import {
  atr,
  ema,
  macd,
  rsi,
  sma,
  supertrend,
} from './indicators.ts'
import { analyzeStructure, emptyStructure } from './structure.ts'
import type {
  AnalysisAction,
  Candle,
  IndicatorSnapshot,
  Levels,
  MarketView,
  Score,
  Signal,
  Structure,
  Timeframe,
  TradeAction,
  V1Analysis,
} from './types.ts'
import {
  MARKET_ATR_BUFFER,
  MARKET_MAX_RISK_FRACTION,
  TIMEFRAME_SECONDS,
  g5,
  marketClass,
} from './types.ts'

export const PIVOT_LOOKBACK = 2
export const MIN_HISTORY_BARS = 220
export const MIN_SCORE = 60
export const STRONG_SCORE = 80
export const ENTRY_MAX_DISTANCE_ATR = 2.0
export const CHASE_LIMIT_ATR = 0.75
export const MAX_STOP_ATR = 3.0
export const MIN_STOP_ATR = 0.2
export const TARGET_DEDUPE_ATR = 0.1
export const BREAK_RECENCY_BARS = 30

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** Validate closed OHLCV history before any calculation. */
export function validateCandles(
  candles: Candle[],
  timeframe: Timeframe,
  now: number,
): { ok: boolean; notes: string[] } {
  const notes: string[] = []
  if (!candles.length) return { ok: false, notes: ['No closed candles were returned by the market-data feed'] }

  if (candles.length < MIN_HISTORY_BARS) {
    notes.push(
      `Insufficient history: ${candles.length} closed candles, ${MIN_HISTORY_BARS} required for EMA 200 and confirmed pivots`,
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

function snapshotAt(candles: Candle[], pos: number): IndicatorSnapshot | null {
  const closes = candles.map(candle => candle.close)
  const highs = candles.map(candle => candle.high)
  const lows = candles.map(candle => candle.low)
  const volumes = candles.map(candle => candle.volume)

  const ema20 = ema(closes, 20)[pos]
  const ema50 = ema(closes, 50)[pos]
  const ema200 = ema(closes, 200)[pos]
  const rsi14 = rsi(closes, 14)[pos]
  const macdFrame = macd(closes, 12, 26, 9)
  const macdLine = macdFrame.macd[pos]
  const macdSignal = macdFrame.signal[pos]
  const macdHistogram = macdFrame.histogram[pos]
  const st = supertrend(highs, lows, closes, 10, 3)
  const stLine = st.line[pos]
  const stDirection = st.direction[pos]
  const atr14 = atr(highs, lows, closes, 14)[pos]

  if (
    !finite(ema20) || !finite(ema50) || !finite(ema200) || !finite(rsi14)
    || !finite(macdLine) || !finite(macdSignal) || !finite(macdHistogram)
    || !finite(stLine) || !finite(stDirection) || !finite(atr14) || atr14 <= 0
  ) {
    return null
  }

  const volumeTotal = volumes.reduce((total, value) => total + Math.abs(value || 0), 0)
  let volume: number | null = null
  let volumeMa: number | null = null
  let volumeRatio: number | null = null
  if (volumeTotal > 0) {
    volume = volumes[pos]
    const average = sma(volumes, 20)[pos]
    if (finite(average) && average > 0) {
      volumeMa = average
      volumeRatio = volume / average
    }
  }

  return {
    ema20,
    ema50,
    ema200,
    rsi: rsi14,
    macd: macdLine,
    macdSignal,
    macdHistogram,
    supertrend: stLine,
    supertrendDirection: stDirection,
    atr: atr14,
    close: closes[pos],
    volume,
    volumeMa,
    volumeRatio,
    barTime: candles[pos].time,
  }
}

function latestBreak(structure: Structure) {
  if (structure.lastBos && structure.lastChoch) {
    return structure.lastBos.confirmIndex >= structure.lastChoch.confirmIndex
      ? structure.lastBos
      : structure.lastChoch
  }
  return structure.lastBos ?? structure.lastChoch
}

export function scoreDirection(
  direction: TradeAction,
  snapshot: IndicatorSnapshot,
  structure: Structure,
  lastPos: number,
): Score {
  const buy = direction === 'BUY'

  // --- EMA trend, 30 points -------------------------------------------------
  let emaScore = 0
  if (buy) {
    if (snapshot.ema20 > snapshot.ema50) emaScore += 12
    if (snapshot.close > snapshot.ema50) emaScore += 10
    if (snapshot.ema50 > snapshot.ema200) emaScore += 8
    else if (snapshot.close > snapshot.ema200) emaScore += 4
  } else {
    if (snapshot.ema20 < snapshot.ema50) emaScore += 12
    if (snapshot.close < snapshot.ema50) emaScore += 10
    if (snapshot.ema50 < snapshot.ema200) emaScore += 8
    else if (snapshot.close < snapshot.ema200) emaScore += 4
  }

  // --- RSI + MACD, 25 points ------------------------------------------------
  let rsiScore: number
  let macdScore: number
  let histScore: number
  if (buy) {
    rsiScore = snapshot.rsi > 50 ? 12 : 0
    if (snapshot.rsi > 78) rsiScore = 8 // still bullish, but do not reward chasing
    macdScore = snapshot.macd > snapshot.macdSignal ? 8 : 0
    histScore = snapshot.macdHistogram > 0 ? 5 : 0
  } else {
    rsiScore = snapshot.rsi < 50 ? 12 : 0
    if (snapshot.rsi < 22) rsiScore = 8
    macdScore = snapshot.macd < snapshot.macdSignal ? 8 : 0
    histScore = snapshot.macdHistogram < 0 ? 5 : 0
  }
  const momentumScore = Math.min(25, rsiScore + macdScore + histScore)

  // --- Supertrend, 20 points ------------------------------------------------
  const supertrendScore = (snapshot.supertrendDirection > 0) === buy ? 20 : 0

  // --- Market structure, 25 points -----------------------------------------
  let structureScore = 0
  if (structure.view === (buy ? 'BULLISH' : 'BEARISH')) structureScore += 15

  const latest = latestBreak(structure)
  if (
    latest
    && latest.direction === (buy ? 'BULLISH' : 'BEARISH')
    && lastPos - latest.confirmIndex <= BREAK_RECENCY_BARS
  ) {
    structureScore += 10
  } else {
    const labels = new Set(structure.recentLabels)
    if (buy && labels.has('H:HH') && labels.has('L:HL')) structureScore += 5
    if (!buy && labels.has('H:LH') && labels.has('L:LL')) structureScore += 5
  }
  structureScore = Math.min(25, structureScore)

  const total = Math.round((emaScore + momentumScore + supertrendScore + structureScore) * 100) / 100
  const band: Score['band'] = total >= STRONG_SCORE ? 'STRONG' : total > MIN_SCORE ? 'VALID' : 'NO_SIGNAL'

  return {
    ema: emaScore,
    momentum: momentumScore,
    supertrend: supertrendScore,
    structure: structureScore,
    total,
    band,
    volumeConfirmed: snapshot.volumeRatio !== null && snapshot.volumeRatio >= 1,
    volumeRatio: snapshot.volumeRatio,
  }
}

function dedupeTargets(targets: Array<[number, string]>, tolerance: number): Array<[number, string]> {
  const unique: Array<[number, string]> = []
  for (const [level, name] of [...targets].sort((left, right) => left[0] - right[0])) {
    if (!unique.length || Math.abs(level - unique[unique.length - 1][0]) > tolerance) {
      unique.push([level, name])
    }
  }
  return unique
}

type PlanResult = { levels: Levels | null; reason: string; references: string[] }

function buildBuyPlan(snapshot: IndicatorSnapshot, structure: Structure, symbol: string): PlanResult {
  const close = snapshot.close
  const atrValue = snapshot.atr
  const market = marketClass(symbol)
  const buffer = MARKET_ATR_BUFFER[market]
  const references: string[] = []
  const candidates: Array<[number, string]> = []

  const addCandidate = (level: number | null | undefined, name: string) => {
    if (!finite(level) || level <= 0) return
    if (level < close && close - level <= ENTRY_MAX_DISTANCE_ATR * atrValue) {
      candidates.push([level, name])
    }
  }
  addCandidate(snapshot.ema20, 'EMA 20')
  addCandidate(snapshot.ema50, 'EMA 50')
  addCandidate(structure.support, 'confirmed support')
  addCandidate(structure.rangeLow, 'range low')
  if (structure.swingLows.length) {
    addCandidate(structure.swingLows[structure.swingLows.length - 1].price, 'previous swing low')
  }
  if (structure.lastBos && structure.lastBos.direction === 'BULLISH') {
    addCandidate(structure.lastBos.level, 'previous breakout level')
  }

  if (!candidates.length) {
    return { levels: null, reason: 'No suitable pullback entry area within 2 ATR of price', references }
  }

  const [center, centerName] = candidates.reduce((best, item) => (item[0] > best[0] ? item : best))
  const half = Math.max(0.1 * atrValue, center * 0.00005)
  const zoneLow = center - half
  const zoneHigh = center + half

  if (close < zoneLow - 0.3 * atrValue) {
    return { levels: null, reason: 'Price closed below the bullish entry zone', references }
  }
  if (close > zoneHigh + CHASE_LIMIT_ATR * atrValue) {
    return { levels: null, reason: 'Price is too extended above the entry zone (do not chase)', references }
  }

  const entry = Math.max(zoneLow, Math.min(center, close))

  const swingCandidates = structure.swingLows
    .map(point => point.price)
    .filter(price => price < entry - 0.05 * atrValue)
  if (!swingCandidates.length) {
    return { levels: null, reason: 'No confirmed swing low below entry to invalidate the BUY', references }
  }
  const belowZone = swingCandidates.filter(level => level < zoneLow)
  const swingLow = Math.max(...(belowZone.length ? belowZone : swingCandidates))

  const stopLoss = swingLow - buffer * atrValue
  const risk = entry - stopLoss
  if (risk <= 0) return { levels: null, reason: 'Stop loss is on the wrong side of entry', references }
  if (risk < MIN_STOP_ATR * atrValue) {
    return { levels: null, reason: 'Stop loss is too tight for the current volatility', references }
  }
  if (risk > MAX_STOP_ATR * atrValue) {
    return { levels: null, reason: `Stop loss is excessively wide (${(risk / atrValue).toFixed(2)} ATR)`, references }
  }
  if (risk / entry > MARKET_MAX_RISK_FRACTION[market]) {
    return { levels: null, reason: 'Stop loss risk exceeds the market risk cap', references }
  }

  const targets: Array<[number, string]> = []
  for (const point of structure.swingHighs) {
    if (point.price > entry + 0.05 * atrValue) targets.push([point.price, 'swing high'])
  }
  if (structure.resistance !== null) targets.push([structure.resistance, 'confirmed resistance'])
  if (structure.rangeHigh !== null) targets.push([structure.rangeHigh, 'range high'])
  const unique = dedupeTargets(targets, TARGET_DEDUPE_ATR * atrValue)
  if (!unique.length) return { levels: null, reason: 'No structural target above entry', references }

  let tp1Index: number | null = null
  for (let i = 0; i < unique.length; i += 1) {
    if (unique[i][0] - entry >= risk * (1 - 1e-9)) {
      tp1Index = i
      break
    }
  }
  if (tp1Index === null) {
    return { levels: null, reason: 'No structural target reaches 1:1 reward-to-risk', references }
  }

  const [tp1, tp1Name] = unique[tp1Index]
  let [tp2, tp2Name] = tp1Index + 1 < unique.length ? unique[tp1Index + 1] : [null, ''] as [null, string]
  let [tp3, tp3Name] = tp1Index + 2 < unique.length ? unique[tp1Index + 2] : [null, ''] as [null, string]
  if (tp2 !== null && tp2 <= tp1) {
    tp2 = null
    tp2Name = ''
  }
  if (tp3 !== null && (tp2 === null || tp3 <= tp2)) {
    tp3 = null
    tp3Name = ''
  }

  const allocations = tp3 !== null ? [0.4, 0.3, 0.3] : tp2 !== null ? [0.5, 0.5] : [1]
  const costBuffer = Math.max(0.05 * atrValue, entry * 0.0002)

  references.push(centerName, `confirmed swing low ${g5(swingLow)}`, tp1Name)
  if (tp2Name) references.push(tp2Name)
  if (tp3Name) references.push(tp3Name)

  return {
    levels: {
      entryZoneLow: zoneLow,
      entryZoneHigh: zoneHigh,
      entry,
      stopLoss,
      tp1,
      tp2,
      tp3,
      risk,
      rrTp1: (tp1 - entry) / risk,
      rrTp2: tp2 !== null ? (tp2 - entry) / risk : null,
      rrTp3: tp3 !== null ? (tp3 - entry) / risk : null,
      allocations,
      breakevenStop: entry + costBuffer,
      references,
    },
    reason: '',
    references,
  }
}

function buildSellPlan(snapshot: IndicatorSnapshot, structure: Structure, symbol: string): PlanResult {
  const close = snapshot.close
  const atrValue = snapshot.atr
  const market = marketClass(symbol)
  const buffer = MARKET_ATR_BUFFER[market]
  const references: string[] = []
  const candidates: Array<[number, string]> = []

  const addCandidate = (level: number | null | undefined, name: string) => {
    if (!finite(level) || level <= 0) return
    if (level > close && level - close <= ENTRY_MAX_DISTANCE_ATR * atrValue) {
      candidates.push([level, name])
    }
  }
  addCandidate(snapshot.ema20, 'EMA 20')
  addCandidate(snapshot.ema50, 'EMA 50')
  addCandidate(structure.resistance, 'confirmed resistance')
  addCandidate(structure.rangeHigh, 'range high')
  if (structure.swingHighs.length) {
    addCandidate(structure.swingHighs[structure.swingHighs.length - 1].price, 'previous swing high')
  }
  if (structure.lastBos && structure.lastBos.direction === 'BEARISH') {
    addCandidate(structure.lastBos.level, 'previous breakdown level')
  }

  if (!candidates.length) {
    return { levels: null, reason: 'No suitable pullback entry area within 2 ATR of price', references }
  }

  const [center, centerName] = candidates.reduce((best, item) => (item[0] < best[0] ? item : best))
  const half = Math.max(0.1 * atrValue, center * 0.00005)
  const zoneLow = center - half
  const zoneHigh = center + half

  if (close > zoneHigh + 0.3 * atrValue) {
    return { levels: null, reason: 'Price closed above the bearish entry zone', references }
  }
  if (close < zoneLow - CHASE_LIMIT_ATR * atrValue) {
    return { levels: null, reason: 'Price is too extended below the entry zone (do not chase)', references }
  }

  const entry = Math.min(zoneHigh, Math.max(center, close))

  const swingCandidates = structure.swingHighs
    .map(point => point.price)
    .filter(price => price > entry + 0.05 * atrValue)
  if (!swingCandidates.length) {
    return { levels: null, reason: 'No confirmed swing high above entry to invalidate the SELL', references }
  }
  const aboveZone = swingCandidates.filter(level => level > zoneHigh)
  const swingHigh = Math.min(...(aboveZone.length ? aboveZone : swingCandidates))

  const stopLoss = swingHigh + buffer * atrValue
  const risk = stopLoss - entry
  if (risk <= 0) return { levels: null, reason: 'Stop loss is on the wrong side of entry', references }
  if (risk < MIN_STOP_ATR * atrValue) {
    return { levels: null, reason: 'Stop loss is too tight for the current volatility', references }
  }
  if (risk > MAX_STOP_ATR * atrValue) {
    return { levels: null, reason: `Stop loss is excessively wide (${(risk / atrValue).toFixed(2)} ATR)`, references }
  }
  if (risk / entry > MARKET_MAX_RISK_FRACTION[market]) {
    return { levels: null, reason: 'Stop loss risk exceeds the market risk cap', references }
  }

  const targets: Array<[number, string]> = []
  for (const point of structure.swingLows) {
    if (point.price < entry - 0.05 * atrValue) targets.push([point.price, 'swing low'])
  }
  if (structure.support !== null) targets.push([structure.support, 'confirmed support'])
  if (structure.rangeLow !== null) targets.push([structure.rangeLow, 'range low'])
  const unique = dedupeTargets(targets, TARGET_DEDUPE_ATR * atrValue)
  if (!unique.length) return { levels: null, reason: 'No structural target below entry', references }

  // For a SELL the nearest target is the highest structural level below entry.
  const ordered = [...unique].reverse()
  let tp1Index: number | null = null
  for (let i = 0; i < ordered.length; i += 1) {
    if (entry - ordered[i][0] >= risk * (1 - 1e-9)) {
      tp1Index = i
      break
    }
  }
  if (tp1Index === null) {
    return { levels: null, reason: 'No structural target reaches 1:1 reward-to-risk', references }
  }

  const [tp1, tp1Name] = ordered[tp1Index]
  let [tp2, tp2Name] = tp1Index + 1 < ordered.length ? ordered[tp1Index + 1] : [null, ''] as [null, string]
  let [tp3, tp3Name] = tp1Index + 2 < ordered.length ? ordered[tp1Index + 2] : [null, ''] as [null, string]
  if (tp2 !== null && tp2 >= tp1) {
    tp2 = null
    tp2Name = ''
  }
  if (tp3 !== null && (tp2 === null || tp3 >= tp2)) {
    tp3 = null
    tp3Name = ''
  }

  const allocations = tp3 !== null ? [0.4, 0.3, 0.3] : tp2 !== null ? [0.5, 0.5] : [1]
  const costBuffer = Math.max(0.05 * atrValue, entry * 0.0002)

  references.push(centerName, `confirmed swing high ${g5(swingHigh)}`, tp1Name)
  if (tp2Name) references.push(tp2Name)
  if (tp3Name) references.push(tp3Name)

  return {
    levels: {
      entryZoneLow: zoneLow,
      entryZoneHigh: zoneHigh,
      entry,
      stopLoss,
      tp1,
      tp2,
      tp3,
      risk,
      rrTp1: (entry - tp1) / risk,
      rrTp2: tp2 !== null ? (entry - tp2) / risk : null,
      rrTp3: tp3 !== null ? (entry - tp3) / risk : null,
      allocations,
      breakevenStop: entry - costBuffer,
      references,
    },
    reason: '',
    references,
  }
}

function reasonsFor(
  direction: TradeAction,
  view: MarketView,
  snapshot: IndicatorSnapshot,
  structure: Structure,
  levels: Levels,
  score: Score,
  symbol: string,
): string[] {
  const buy = direction === 'BUY'
  const buffer = MARKET_ATR_BUFFER[marketClass(symbol)]
  const emaAligned = buy ? snapshot.ema20 > snapshot.ema50 : snapshot.ema20 < snapshot.ema50
  const emaReason = emaAligned
    ? `EMA 20 ${g5(snapshot.ema20)} ${buy ? 'above' : 'below'} EMA 50 ${g5(snapshot.ema50)}; price ${buy ? 'above' : 'below'} EMA 50.`
    : `Gold transition: price is already ${buy ? 'above' : 'below'} EMA 50 while EMA 20 ${g5(snapshot.ema20)} approaches EMA 50 ${g5(snapshot.ema50)}.`
  const reasons = [
    `Market direction: ${view}.`,
    emaReason,
    `RSI(14) ${snapshot.rsi.toFixed(1)} supports ${buy ? 'bullish' : 'bearish'} momentum.`,
    `MACD ${g5(snapshot.macd)} is ${buy ? 'above' : 'below'} its signal ${g5(snapshot.macdSignal)}.`,
    `Supertrend is ${snapshot.supertrendDirection > 0 ? 'bullish' : 'bearish'}.`,
    structure.narrative,
    `Entry Zone ${g5(levels.entryZoneLow)}–${g5(levels.entryZoneHigh)} from ${levels.references[0] ?? 'structure'}.`,
    `Stop Loss ${g5(levels.stopLoss)} beyond the confirmed structure plus the ${buffer.toFixed(2)} ATR buffer.`,
    `TP1 ${g5(levels.tp1)} (${levels.rrTp1.toFixed(2)}R)`
      + (levels.tp2 !== null ? `, TP2 ${g5(levels.tp2)} (${levels.rrTp2!.toFixed(2)}R)` : '')
      + (levels.tp3 !== null ? `, TP3 ${g5(levels.tp3)} (${levels.rrTp3!.toFixed(2)}R)` : ''),
    `Setup score ${score.total.toFixed(0)}/100 (${score.band}).`,
  ]
  if (score.volumeRatio !== null) {
    reasons.push(`Volume ${score.volumeRatio.toFixed(2)}x its 20-bar average${score.volumeConfirmed ? ' (confirmation).' : ' (not a gate).'}`)
  }
  reasons.push('Confirmed on a closed candle; levels are frozen after generation.')
  return reasons
}

function zeroScore(): Score {
  return {
    ema: 0,
    momentum: 0,
    supertrend: 0,
    structure: 0,
    total: 0,
    band: 'NO_SIGNAL',
    volumeConfirmed: false,
    volumeRatio: null,
  }
}

type NoSignalInput = {
  symbol: string
  timeframe: Timeframe
  reason: string
  now: number
  view?: MarketView
  score?: Score
  structure?: Structure
  snapshot?: IndicatorSnapshot | null
  dataOk?: boolean
  dataNotes?: string[]
  barTime?: number | null
  existingActive?: Signal | null
}

function noSignal(input: NoSignalInput): V1Analysis {
  const score = { ...(input.score ?? zeroScore()), band: 'NO_SIGNAL' as const }
  return {
    symbol: input.symbol.toUpperCase(),
    timeframe: input.timeframe,
    action: 'NO_SIGNAL',
    view: input.view ?? 'RANGING',
    score,
    structure: input.structure ?? emptyStructure(),
    indicators: input.snapshot ?? null,
    levels: null,
    signal: null,
    reason: input.reason,
    dataOk: input.dataOk ?? true,
    dataNotes: input.dataNotes ?? [],
    barTime: input.barTime ?? null,
    generatedAt: input.now,
    existingActive: input.existingActive ?? null,
    remainingAnalyses: 0,
    remainingSignals: 0,
  }
}

function newSignalId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID().replace(/-/g, '')
  return `v1_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
}

export type EvaluateInput = {
  symbol: string
  timeframe: Timeframe
  candles: Candle[]
  now?: number
}

/** Evaluate the latest closed candle and return BUY, SELL or NO SIGNAL. */
export function evaluate({ symbol, timeframe, candles, now = Date.now() }: EvaluateInput): V1Analysis {
  const upperSymbol = symbol.toUpperCase()
  const closed = candles.filter(candle => candle.time <= now)

  const validation = validateCandles(closed, timeframe, now)
  if (!validation.ok || !closed.length) {
    return noSignal({
      symbol: upperSymbol,
      timeframe,
      reason: validation.notes[0] ?? 'Invalid or insufficient market data',
      now,
      dataOk: false,
      dataNotes: validation.notes,
    })
  }

  const pos = closed.length - 1
  const barTime = closed[pos].time
  const snapshot = snapshotAt(closed, pos)
  if (!snapshot) {
    return noSignal({
      symbol: upperSymbol,
      timeframe,
      reason: 'Indicators are not fully warmed up on the available history',
      now,
      dataOk: false,
      dataNotes: ['EMA 200, Supertrend or ATR returned an invalid value'],
      barTime,
    })
  }

  const structure = analyzeStructure(closed, {
    lookback: PIVOT_LOOKBACK,
    lastPos: pos,
    breakBuffer: 0.1 * snapshot.atr,
  })

  const emaBullish = snapshot.ema20 > snapshot.ema50 && snapshot.close >= snapshot.ema50
  const emaBearish = snapshot.ema20 < snapshot.ema50 && snapshot.close <= snapshot.ema50
  const flatEmas = Math.abs(snapshot.ema20 - snapshot.ema50) < 0.2 * snapshot.atr

  let view: MarketView
  if (structure.view === 'RANGING' || flatEmas) view = 'RANGING'
  else if (structure.view === 'BULLISH' && emaBullish) view = 'BULLISH'
  else if (structure.view === 'BEARISH' && emaBearish) view = 'BEARISH'
  else if (!emaBullish && !emaBearish) view = structure.view
  else view = 'RANGING'

  if (view === 'RANGING') {
    const buyScore = scoreDirection('BUY', snapshot, structure, pos)
    const sellScore = scoreDirection('SELL', snapshot, structure, pos)
    const display = buyScore.total >= sellScore.total ? buyScore : sellScore
    return noSignal({
      symbol: upperSymbol,
      timeframe,
      reason: 'Ranging or conflicting market direction. Free Strategy does not force a trade without clear structure and trend.',
      now,
      view,
      score: display,
      structure,
      snapshot,
      barTime,
    })
  }

  const direction: TradeAction = view === 'BULLISH' ? 'BUY' : 'SELL'
  const buy = direction === 'BUY'
  const score = scoreDirection(direction, snapshot, structure, pos)
  const goldTransition = marketClass(upperSymbol) === 'GOLD'
    && score.total >= STRONG_SCORE
    && (buy
      ? snapshot.close >= snapshot.ema50 && snapshot.ema20 >= snapshot.ema50 - 1.25 * snapshot.atr
      : snapshot.close <= snapshot.ema50 && snapshot.ema20 <= snapshot.ema50 + 1.25 * snapshot.atr)

  // Hard specification gates. These are intentionally stricter than the score:
  // A score above 60 alone must not buy a setup without required confirmation.
  if (!(buy ? emaBullish : emaBearish) && !goldTransition) {
    return noSignal({
      symbol: upperSymbol,
      timeframe,
      reason: `EMA trend does not confirm a ${direction}: EMA 20 must be ${buy ? 'above' : 'below'} EMA 50 with price on the same side.`,
      now,
      view,
      score,
      structure,
      snapshot,
      barTime,
    })
  }
  if ((snapshot.supertrendDirection > 0) !== buy) {
    return noSignal({
      symbol: upperSymbol,
      timeframe,
      reason: `Supertrend is ${snapshot.supertrendDirection > 0 ? 'bullish' : 'bearish'} and does not confirm the ${direction}.`,
      now,
      view,
      score,
      structure,
      snapshot,
      barTime,
    })
  }
  if (score.momentum <= 0) {
    return noSignal({
      symbol: upperSymbol,
      timeframe,
      reason: `RSI and MACD do not support ${buy ? 'bullish' : 'bearish'} momentum on this candle.`,
      now,
      view,
      score,
      structure,
      snapshot,
      barTime,
    })
  }

  const latest = latestBreak(structure)
  const freshBreak = latest
    && latest.direction === (buy ? 'BULLISH' : 'BEARISH')
    && pos - latest.confirmIndex <= BREAK_RECENCY_BARS
  if (!freshBreak) {
    return noSignal({
      symbol: upperSymbol,
      timeframe,
      reason: `No fresh ${buy ? 'bullish' : 'bearish'} BOS or CHoCH within the last ${BREAK_RECENCY_BARS} closed candles.`,
      now,
      view,
      score,
      structure,
      snapshot,
      barTime,
    })
  }

  if (score.total <= MIN_SCORE) {
    return noSignal({
      symbol: upperSymbol,
      timeframe,
      reason: `Setup score ${score.total.toFixed(0)}/100 must be higher than ${MIN_SCORE} for a valid BUY/SELL setup.`,
      now,
      view,
      score,
      structure,
      snapshot,
      barTime,
    })
  }

  const plan = buy
    ? buildBuyPlan(snapshot, structure, upperSymbol)
    : buildSellPlan(snapshot, structure, upperSymbol)
  if (!plan.levels) {
    return noSignal({
      symbol: upperSymbol,
      timeframe,
      reason: plan.reason,
      now,
      view,
      score,
      structure,
      snapshot,
      barTime,
    })
  }

  const reasons = reasonsFor(direction, view, snapshot, structure, plan.levels, score, upperSymbol)
  const signal: Signal = {
    signalId: newSignalId(),
    symbol: upperSymbol,
    timeframe,
    direction,
    status: 'ACTIVE',
    score,
    levels: plan.levels,
    structure,
    indicators: snapshot,
    reasons,
    barTime,
    createdAt: now,
    updatedAt: now,
    currentStopLoss: plan.levels.stopLoss,
    breakevenApplied: false,
  }

  const action: AnalysisAction = buy ? 'BUY' : 'SELL'
  return {
    symbol: upperSymbol,
    timeframe,
    action,
    view,
    score,
    structure,
    indicators: snapshot,
    levels: plan.levels,
    signal,
    reason: reasons.join('; '),
    dataOk: true,
    dataNotes: validation.notes,
    barTime,
    generatedAt: now,
    existingActive: null,
    remainingAnalyses: 0,
    remainingSignals: 0,
  }
}
