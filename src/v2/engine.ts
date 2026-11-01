/**
 * Deterministic V2 PLUS strategy engine.
 *
 * Fixed evaluation order:
 *
 *     closed candles -> structure -> SMC map -> price action -> direction
 *     -> score -> hard gates -> SMC entry zone -> swing+ATR stop -> structure
 *     targets -> BUY / SELL / NO SIGNAL
 *
 * The engine never forces every indicator and SMC concept to agree. It requires
 * a directional trend or a valid reversal, bullish/bearish structure, a fresh
 * BOS/CHoCH/MSS, momentum support and a validated entry/stop/target set. Price
 * action, VWAP, Bollinger and ADX add or subtract score instead of acting as
 * mandatory confirmations.
 */

import { buildIndicatorSeries, snapshotAt } from './indicators.ts'
import { analyzePriceAction } from './priceAction.ts'
import { analyzeSMC } from './smc.ts'
import {
  V2_PIVOT_LOOKBACK,
  analyzeStructureV2,
  emptyStructureV2,
  latestStructureBreak,
} from './structure.ts'
import type {
  AnalysisAction,
  BreakEvent,
  Candle,
  IndicatorSnapshot,
  Levels,
  MarketView,
  PriceAction,
  PriceActionEvent,
  Score,
  Signal,
  SMCMap,
  Structure,
  Timeframe,
  TradeAction,
  V2Analysis,
} from './types.ts'
import {
  V2_ATR_BUFFER,
  V2_MAX_RISK_FRACTION,
  V2_STRATEGY,
  g5,
  marketClass,
} from './types.ts'
import { validateV2Candles } from './validate.ts'

export const V2_MIN_SCORE = 60
export const V2_STRONG_SCORE = 80
export const V2_BREAK_RECENCY = 30
export const V2_ENTRY_MAX_DISTANCE_ATR = 2.0
export const V2_CHASE_LIMIT_ATR = 0.75
export const V2_MIN_STOP_ATR = 0.25
export const V2_MAX_STOP_ATR = 3.5
export const V2_GOLD_MAX_STOP_ATR = 4.0
export const V2_GOLD_TRANSITION_SCORE = 70
export const V2_TARGET_DEDUPE_ATR = 0.1
export const V2_TP1_R = 1
export const V2_TP2_R = 2
export const V2_TP3_R = 3
export const V2_PA_RECENT_BARS = 3
const V2_PA_WINDOW_BARS = 6
const REVERSAL_WINDOW_BARS = 8

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function maxStopAtr(symbol: string): number {
  return marketClass(symbol) === 'GOLD' ? V2_GOLD_MAX_STOP_ATR : V2_MAX_STOP_ATR
}

function emptySMC(): SMCMap {
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

function emptyPriceAction(): PriceAction {
  return {
    events: [],
    bias: 'NEUTRAL',
    narrative: 'No price-action pattern on the closed bars yet.',
  }
}

function zeroScore(): Score {
  return {
    trend: 0,
    momentum: 0,
    supertrend: 0,
    structure: 0,
    smc: 0,
    priceAction: 0,
    total: 0,
    band: 'NO_SIGNAL',
    volumeConfirmed: false,
    volumeRatio: null,
  }
}

function newSignalId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return `v2${cryptoApi.randomUUID().replace(/-/g, '')}`
  return `v2_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
}

/** Does the latest price-action event support this direction? */
function priceActionPoints(direction: TradeAction, pa: PriceAction, lastPos: number): number {
  const wanted = direction === 'BUY' ? 'BULLISH' : 'BEARISH'
  const matching = [...pa.events].reverse().filter(event => event.direction === wanted)
  if (!matching.length) return 0
  const latest = matching[0]
  if (lastPos - latest.index <= V2_PA_RECENT_BARS) return 5
  if (lastPos - latest.index <= V2_PA_WINDOW_BARS) return 3
  return 0
}

/**
 * Weighted V2 score, 100 points:
 * trend 20, momentum 20, Supertrend 10, structure 25, SMC 20, price action 5.
 */
export function scoreV2(
  direction: TradeAction,
  snapshot: IndicatorSnapshot,
  structure: Structure,
  smc: SMCMap,
  pa: PriceAction,
  lastPos: number,
): Score {
  const buy = direction === 'BUY'
  const close = snapshot.close
  const atr = snapshot.atr

  // --- Trend + ADX, 20 points ----------------------------------------------
  let trend = 0
  if (buy) {
    if (snapshot.ema20 > snapshot.ema50) trend += 8
    if (close > snapshot.ema50) trend += 6
    if (snapshot.ema50 > snapshot.ema200) trend += 6
    else if (close > snapshot.ema200) trend += 3
  } else {
    if (snapshot.ema20 < snapshot.ema50) trend += 8
    if (close < snapshot.ema50) trend += 6
    if (snapshot.ema50 < snapshot.ema200) trend += 6
    else if (close < snapshot.ema200) trend += 3
  }
  // Choppy trend is worth less, but ADX never vetoes a setup by itself.
  if (snapshot.adx < 18) trend = Math.max(0, trend - 4)

  // --- Momentum, 20 points --------------------------------------------------
  let rsiScore: number
  let macdScore: number
  let histogramScore: number
  let stochScore: number
  if (buy) {
    rsiScore = snapshot.rsi > 78 ? 4 : snapshot.rsi >= 55 ? 7 : snapshot.rsi > 50 ? 5 : 0
    macdScore = snapshot.macd > snapshot.macdSignal ? 7 : 0
    histogramScore = snapshot.macdHistogram > 0 ? 3 : 0
    stochScore = snapshot.stochK > snapshot.stochD && snapshot.stochK < 80 ? 3 : 0
  } else {
    rsiScore = snapshot.rsi < 22 ? 4 : snapshot.rsi <= 45 ? 7 : snapshot.rsi < 50 ? 5 : 0
    macdScore = snapshot.macd < snapshot.macdSignal ? 7 : 0
    histogramScore = snapshot.macdHistogram < 0 ? 3 : 0
    stochScore = snapshot.stochK < snapshot.stochD && snapshot.stochK > 20 ? 3 : 0
  }
  const momentum = Math.min(20, rsiScore + macdScore + histogramScore + stochScore)

  // --- Supertrend, 10 points ------------------------------------------------
  const supertrend = (snapshot.supertrendDirection > 0) === buy ? 10 : 0

  // --- Structure, 25 points -------------------------------------------------
  let structureScore = 0
  if (structure.view === (buy ? 'BULLISH' : 'BEARISH')) structureScore += 12

  const latest = latestStructureBreak(structure)
  if (
    latest
    && latest.direction === (buy ? 'BULLISH' : 'BEARISH')
    && lastPos - latest.confirmIndex <= V2_BREAK_RECENCY
  ) {
    structureScore += 8
  }

  const labels = new Set(structure.recentLabels)
  if (buy && labels.has('H:HH') && labels.has('L:HL')) structureScore += 5
  if (!buy && labels.has('H:LH') && labels.has('L:LL')) structureScore += 5
  structureScore = Math.min(25, structureScore)

  // --- SMC / ICT, 20 points -------------------------------------------------
  const zoneScore = buy
    ? smc.premiumDiscount === 'DISCOUNT' ? 6 : smc.premiumDiscount === 'EQUILIBRIUM' ? 3 : 0
    : smc.premiumDiscount === 'PREMIUM' ? 6 : smc.premiumDiscount === 'EQUILIBRIUM' ? 3 : 0

  const wantedGap = buy ? 'BULLISH' : 'BEARISH'
  const nearGap = [...smc.fvgs].reverse().find(gap => (
    gap.direction === wantedGap
    && !gap.mitigated
    && gap.high >= close - 1.5 * atr
    && gap.low <= close + 0.5 * atr
  ))
  const nearBlock = [...smc.orderBlocks].reverse().find(block => (
    block.direction === wantedGap
    && !block.mitigated
    && block.high >= close - 1.5 * atr
    && block.low <= close + 0.5 * atr
  ))
  const wantedSweep = buy ? 'BULLISH' : 'BEARISH'
  const recentSweep = smc.sweeps.some(sweep => (
    sweep.direction === wantedSweep && lastPos - sweep.index <= 15
  ))

  const smcScore = Math.min(20, zoneScore + (nearGap ? 6 : 0) + (nearBlock ? 5 : 0) + (recentSweep ? 3 : 0))

  // --- Price action, 5 points ----------------------------------------------
  const paScore = priceActionPoints(direction, pa, lastPos)

  const total = Math.round((trend + momentum + supertrend + structureScore + smcScore + paScore) * 100) / 100
  const band: Score['band'] = total >= V2_STRONG_SCORE ? 'STRONG' : total > V2_MIN_SCORE ? 'VALID' : 'NO_SIGNAL'

  return {
    trend,
    momentum,
    supertrend,
    structure: structureScore,
    smc: smcScore,
    priceAction: paScore,
    total,
    band,
    volumeConfirmed: snapshot.volumeRatio !== null && snapshot.volumeRatio >= 1,
    volumeRatio: snapshot.volumeRatio,
  }
}

/** Trend or a valid reversal. A flat EMA pair alone cannot make a directional view. */
function determineView(
  snapshot: IndicatorSnapshot,
  structure: Structure,
  lastPos: number,
): { view: MarketView; latest: BreakEvent | null; reversal: boolean } {
  const latest = latestStructureBreak(structure)
  const reversal = latest !== null
    && lastPos - latest.confirmIndex <= REVERSAL_WINDOW_BARS
    && (latest.kind === 'CHOCH' || latest.kind === 'MSS')

  const emaBullish = snapshot.ema20 > snapshot.ema50 && snapshot.close >= snapshot.ema50
  const emaBearish = snapshot.ema20 < snapshot.ema50 && snapshot.close <= snapshot.ema50

  if (structure.view === 'BULLISH' && (emaBullish || (reversal && latest.direction === 'BULLISH'))) {
    return { view: 'BULLISH', latest, reversal }
  }
  if (structure.view === 'BEARISH' && (emaBearish || (reversal && latest.direction === 'BEARISH'))) {
    return { view: 'BEARISH', latest, reversal }
  }
  return { view: 'RANGING', latest, reversal }
}

type Zone = {
  low: number
  high: number
  name: string
  priority: number
}

function buildZones(
  direction: TradeAction,
  snapshot: IndicatorSnapshot,
  structure: Structure,
  smc: SMCMap,
): Zone[] {
  const buy = direction === 'BUY'
  const close = snapshot.close
  const atr = snapshot.atr
  const zones: Zone[] = []
  const push = (low: number | null | undefined, high: number | null | undefined, name: string, priority: number) => {
    if (!finite(low) || !finite(high) || !(high > low)) return
    zones.push({ low, high, name, priority })
  }

  const wantedGap = buy ? 'BULLISH' : 'BEARISH'
  for (const gap of smc.fvgs) {
    if (gap.direction === wantedGap && !gap.mitigated) push(gap.low, gap.high, `${gap.direction.toLowerCase()} fair value gap`, 0)
  }
  for (const block of smc.orderBlocks) {
    if (block.direction === wantedGap && !block.mitigated) push(block.low, block.high, `${block.direction.toLowerCase()} order block`, 1)
  }

  const narrow = 0.12 * atr
  push(snapshot.ema20 - narrow, snapshot.ema20 + narrow, 'EMA 20', 2)
  push(snapshot.ema50 - narrow, snapshot.ema50 + narrow, 'EMA 50', 2)
  const wantedKeyKind = buy ? 'SUPPORT' : 'RESISTANCE'
  for (const level of structure.keyLevels.filter(item => item.kind === wantedKeyKind)) {
    push(
      level.price - narrow,
      level.price + narrow,
      `${level.strength.toLowerCase()} key ${buy ? 'support' : 'resistance'} · ${level.touches} touch${level.touches === 1 ? '' : 'es'}`,
      4,
    )
  }
  const reactionLevel = buy ? structure.support : structure.resistance
  const rangeLevel = buy ? structure.rangeLow : structure.rangeHigh
  push(
    reactionLevel !== null ? reactionLevel - narrow : null,
    reactionLevel !== null ? reactionLevel + narrow : null,
    buy ? 'confirmed support' : 'confirmed resistance',
    3,
  )
  push(
    rangeLevel !== null ? rangeLevel - narrow : null,
    rangeLevel !== null ? rangeLevel + narrow : null,
    buy ? 'range low' : 'range high',
    3,
  )

  const latest = latestStructureBreak(structure)
  if (latest && latest.direction === (buy ? 'BULLISH' : 'BEARISH')) {
    push(latest.level - 0.15 * atr, latest.level + 0.15 * atr, `${latest.kind.toLowerCase()} retest level`, 3)
  }

  // Keep zones that price can actually reach in a pullback, not ones far behind.
  const reachable = zones.filter(zone => (
    buy
      ? zone.low <= close + 0.15 * atr && zone.high >= close - V2_ENTRY_MAX_DISTANCE_ATR * atr
      : zone.high >= close - 0.15 * atr && zone.low <= close + V2_ENTRY_MAX_DISTANCE_ATR * atr
  ))
  if (!reachable.length) return []

  const distance = (zone: Zone) => {
    if (close >= zone.low && close <= zone.high) return 0
    return buy ? Math.abs(close - zone.high) : Math.abs(zone.low - close)
  }

  return reachable.sort((left, right) => (
    left.priority - right.priority || distance(left) - distance(right)
  ))
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

function allocationsFor(tp2: number | null, tp3: number | null): number[] {
  if (tp3 !== null) return [0.5, 0.3, 0.2]
  if (tp2 !== null) return [0.5, 0.5]
  // TP1 takes half; the runner stays protected at breakeven with no fixed TP2.
  return [0.5, 0.5]
}

type PlanResult = { levels: Levels | null; reason: string }

function validatePlan(direction: TradeAction, levels: Levels): string | null {
  const buy = direction === 'BUY'
  const tol = 1e-9
  if (!(levels.risk > 0)) return 'Risk must be positive'
  if (buy) {
    if (!(levels.stopLoss < levels.entry && levels.entry < levels.tp1)) return 'Entry, stop and TP1 are in the wrong order for a BUY'
  } else {
    if (!(levels.stopLoss > levels.entry && levels.entry > levels.tp1)) return 'Entry, stop and TP1 are in the wrong order for a SELL'
  }
  if (levels.rrTp1 < V2_TP1_R - tol) return 'TP1 does not reach the 1:1 minimum reward-to-risk'
  if (levels.tp2 !== null) {
    if (levels.rrTp2 === null || levels.rrTp2 < V2_TP2_R - tol) return 'TP2 does not reach the 2R minimum'
    if (buy ? levels.tp2 <= levels.tp1 : levels.tp2 >= levels.tp1) return 'TP2 is not beyond TP1'
  }
  if (levels.tp3 !== null) {
    if (levels.rrTp3 === null || levels.rrTp3 < V2_TP3_R - tol) return 'TP3 does not reach the 3R minimum'
    const reference = levels.tp2 ?? levels.tp1
    if (buy ? levels.tp3 <= reference : levels.tp3 >= reference) return 'TP3 is not beyond TP2'
  }
  return null
}

function buildBuyPlan(
  snapshot: IndicatorSnapshot,
  structure: Structure,
  smc: SMCMap,
  symbol: string,
): PlanResult {
  const close = snapshot.close
  const atr = snapshot.atr
  const buffer = V2_ATR_BUFFER[marketClass(symbol)]
  const zones = buildZones('BUY', snapshot, structure, smc)
  if (!zones.length) {
    return { levels: null, reason: 'No valid bullish SMC or EMA entry zone within 2 ATR of price' }
  }

  const zone = zones.find(candidate =>
    close >= candidate.low - 0.1 * atr
    && close <= candidate.high + V2_CHASE_LIMIT_ATR * atr,
  )
  if (!zone) {
    return { levels: null, reason: 'Price is outside every bullish SMC/EMA entry zone or too extended to chase' }
  }

  const entry = Math.min(Math.max(close, zone.low), zone.high)

  const swingCandidates = structure.swingLows
    .map(point => point.price)
    .filter(price => price < entry - 0.05 * atr)
  if (!swingCandidates.length) {
    return { levels: null, reason: 'No confirmed 3L swing low below entry to invalidate the BUY' }
  }
  const belowZone = swingCandidates.filter(level => level < zone.low)
  const swingLow = Math.max(...(belowZone.length ? belowZone : swingCandidates))

  const stopLoss = swingLow - buffer * atr
  const risk = entry - stopLoss
  if (!(risk > 0)) return { levels: null, reason: 'Stop loss is on the wrong side of entry' }
  if (risk < V2_MIN_STOP_ATR * atr) return { levels: null, reason: 'Stop loss is too tight for the current volatility' }
  if (risk > maxStopAtr(symbol) * atr) {
    return { levels: null, reason: `Stop loss is excessively wide (${(risk / atr).toFixed(2)} ATR)` }
  }
  if (risk / entry > V2_MAX_RISK_FRACTION[marketClass(symbol)]) {
    return { levels: null, reason: 'Stop loss risk exceeds the market risk cap' }
  }

  const targets: Array<[number, string]> = []
  for (const point of structure.swingHighs) {
    if (point.price > entry + 0.1 * atr) targets.push([point.price, 'swing high'])
  }
  for (const level of structure.keyLevels) {
    if (level.kind === 'RESISTANCE' && level.price > entry + 0.1 * atr) {
      targets.push([level.price, `${level.strength.toLowerCase()} key resistance`])
    }
  }
  if (structure.resistance !== null) targets.push([structure.resistance, 'confirmed resistance'])
  if (structure.rangeHigh !== null) targets.push([structure.rangeHigh, 'range high'])
  for (const level of smc.equalHighs) targets.push([level.price, 'equal highs'])
  for (const block of smc.orderBlocks) {
    if (block.direction === 'BEARISH' && block.low > entry + 0.1 * atr) targets.push([block.low, 'bearish order block'])
  }

  const unique = dedupeTargets(targets, V2_TARGET_DEDUPE_ATR * atr)
  if (!unique.length) return { levels: null, reason: 'No structural liquidity above entry' }

  const tp1Entry = unique.find(([level]) => level - entry >= risk * (V2_TP1_R - 1e-9))
  if (!tp1Entry) return { levels: null, reason: 'No structural target reaches 1R' }
  const tp2Entry = unique.find(([level]) => level > tp1Entry[0] && level - entry >= risk * (V2_TP2_R - 1e-9)) ?? null
  const reference = tp2Entry ? tp2Entry[0] : tp1Entry[0]
  const tp3Entry = unique.find(([level]) => level > reference && level - entry >= risk * (V2_TP3_R - 1e-9)) ?? null

  const [tp1, tp1Name] = tp1Entry
  const tp2 = tp2Entry ? tp2Entry[0] : null
  const tp2Name = tp2Entry ? tp2Entry[1] : ''
  const tp3 = tp3Entry ? tp3Entry[0] : null
  const tp3Name = tp3Entry ? tp3Entry[1] : ''
  const costBuffer = Math.max(0.05 * atr, entry * 0.0002)

  const references = [
    zone.name,
    `confirmed 3L swing low ${g5(swingLow)}`,
    tp1Name,
    ...(tp2Name ? [tp2Name] : []),
    ...(tp3Name ? [tp3Name] : []),
  ]

  const levels: Levels = {
    entryZoneLow: zone.low,
    entryZoneHigh: zone.high,
    entry,
    stopLoss,
    tp1,
    tp2,
    tp3,
    risk,
    rrTp1: (tp1 - entry) / risk,
    rrTp2: tp2 !== null ? (tp2 - entry) / risk : null,
    rrTp3: tp3 !== null ? (tp3 - entry) / risk : null,
    allocations: allocationsFor(tp2, tp3),
    breakevenStop: entry + costBuffer,
    references,
    tp1CloseFraction: 0.5,
  }

  const invalid = validatePlan('BUY', levels)
  return invalid ? { levels: null, reason: invalid } : { levels, reason: '' }
}

function buildSellPlan(
  snapshot: IndicatorSnapshot,
  structure: Structure,
  smc: SMCMap,
  symbol: string,
): PlanResult {
  const close = snapshot.close
  const atr = snapshot.atr
  const buffer = V2_ATR_BUFFER[marketClass(symbol)]
  const zones = buildZones('SELL', snapshot, structure, smc)
  if (!zones.length) {
    return { levels: null, reason: 'No valid bearish SMC or EMA entry zone within 2 ATR of price' }
  }

  const zone = zones.find(candidate =>
    close <= candidate.high + 0.1 * atr
    && close >= candidate.low - V2_CHASE_LIMIT_ATR * atr,
  )
  if (!zone) {
    return { levels: null, reason: 'Price is outside every bearish SMC/EMA entry zone or too extended to chase' }
  }

  const entry = Math.max(Math.min(close, zone.high), zone.low)

  const swingCandidates = structure.swingHighs
    .map(point => point.price)
    .filter(price => price > entry + 0.05 * atr)
  if (!swingCandidates.length) {
    return { levels: null, reason: 'No confirmed 3R swing high above entry to invalidate the SELL' }
  }
  const aboveZone = swingCandidates.filter(level => level > zone.high)
  const swingHigh = Math.min(...(aboveZone.length ? aboveZone : swingCandidates))

  const stopLoss = swingHigh + buffer * atr
  const risk = stopLoss - entry
  if (!(risk > 0)) return { levels: null, reason: 'Stop loss is on the wrong side of entry' }
  if (risk < V2_MIN_STOP_ATR * atr) return { levels: null, reason: 'Stop loss is too tight for the current volatility' }
  if (risk > maxStopAtr(symbol) * atr) {
    return { levels: null, reason: `Stop loss is excessively wide (${(risk / atr).toFixed(2)} ATR)` }
  }
  if (risk / entry > V2_MAX_RISK_FRACTION[marketClass(symbol)]) {
    return { levels: null, reason: 'Stop loss risk exceeds the market risk cap' }
  }

  const targets: Array<[number, string]> = []
  for (const point of structure.swingLows) {
    if (point.price < entry - 0.1 * atr) targets.push([point.price, 'swing low'])
  }
  for (const level of structure.keyLevels) {
    if (level.kind === 'SUPPORT' && level.price < entry - 0.1 * atr) {
      targets.push([level.price, `${level.strength.toLowerCase()} key support`])
    }
  }
  if (structure.support !== null) targets.push([structure.support, 'confirmed support'])
  if (structure.rangeLow !== null) targets.push([structure.rangeLow, 'range low'])
  for (const level of smc.equalLows) targets.push([level.price, 'equal lows'])
  for (const block of smc.orderBlocks) {
    if (block.direction === 'BULLISH' && block.high < entry - 0.1 * atr) targets.push([block.high, 'bullish order block'])
  }

  const unique = dedupeTargets(targets, V2_TARGET_DEDUPE_ATR * atr)
  if (!unique.length) return { levels: null, reason: 'No structural liquidity below entry' }

  const ordered = [...unique].reverse()
  const tp1Entry = ordered.find(([level]) => entry - level >= risk * (V2_TP1_R - 1e-9))
  if (!tp1Entry) return { levels: null, reason: 'No structural target reaches 1R' }
  const tp2Entry = ordered.find(([level]) => level < tp1Entry[0] && entry - level >= risk * (V2_TP2_R - 1e-9)) ?? null
  const reference = tp2Entry ? tp2Entry[0] : tp1Entry[0]
  const tp3Entry = ordered.find(([level]) => level < reference && entry - level >= risk * (V2_TP3_R - 1e-9)) ?? null

  const [tp1, tp1Name] = tp1Entry
  const tp2 = tp2Entry ? tp2Entry[0] : null
  const tp2Name = tp2Entry ? tp2Entry[1] : ''
  const tp3 = tp3Entry ? tp3Entry[0] : null
  const tp3Name = tp3Entry ? tp3Entry[1] : ''
  const costBuffer = Math.max(0.05 * atr, entry * 0.0002)

  const references = [
    zone.name,
    `confirmed 3R swing high ${g5(swingHigh)}`,
    tp1Name,
    ...(tp2Name ? [tp2Name] : []),
    ...(tp3Name ? [tp3Name] : []),
  ]

  const levels: Levels = {
    entryZoneLow: zone.low,
    entryZoneHigh: zone.high,
    entry,
    stopLoss,
    tp1,
    tp2,
    tp3,
    risk,
    rrTp1: (entry - tp1) / risk,
    rrTp2: tp2 !== null ? (entry - tp2) / risk : null,
    rrTp3: tp3 !== null ? (entry - tp3) / risk : null,
    allocations: allocationsFor(tp2, tp3),
    breakevenStop: entry - costBuffer,
    references,
    tp1CloseFraction: 0.5,
  }

  const invalid = validatePlan('SELL', levels)
  return invalid ? { levels: null, reason: invalid } : { levels, reason: '' }
}

function reasonsFor(
  direction: TradeAction,
  view: MarketView,
  snapshot: IndicatorSnapshot,
  structure: Structure,
  smc: SMCMap,
  pa: PriceAction,
  levels: Levels,
  score: Score,
  symbol: string,
): string[] {
  const buy = direction === 'BUY'
  const buffer = V2_ATR_BUFFER[marketClass(symbol)]
  const latest = latestStructureBreak(structure)
  const emaAligned = buy ? snapshot.ema20 > snapshot.ema50 : snapshot.ema20 < snapshot.ema50
  const emaReason = emaAligned
    ? `EMA 20 ${g5(snapshot.ema20)} ${buy ? 'above' : 'below'} EMA 50 ${g5(snapshot.ema50)}`
    : `Gold transition with price beyond both fast EMAs; EMA 20 ${g5(snapshot.ema20)} is approaching EMA 50 ${g5(snapshot.ema50)}`
  const reasons = [
    `Market direction: ${view}.`,
    `${emaReason}; ADX ${snapshot.adx.toFixed(1)} (${snapshot.adx >= 25 ? 'trending' : snapshot.adx >= 18 ? 'developing' : 'choppy'}).`,
    `RSI ${snapshot.rsi.toFixed(1)}, MACD ${g5(snapshot.macd)} vs signal ${g5(snapshot.macdSignal)}, Stochastic ${snapshot.stochK.toFixed(1)}/${snapshot.stochD.toFixed(1)}.`,
    `Supertrend is ${snapshot.supertrendDirection > 0 ? 'bullish' : 'bearish'}; VWAP ${g5(snapshot.vwap)} and Bollinger width ${snapshot.bbWidth.toFixed(2)}%.`,
    structure.narrative,
    latest ? `Latest structure event: ${latest.kind} ${latest.direction.toLowerCase()} at ${g5(latest.level)}${latest.displacement ? ' with displacement' : ''}.` : 'No confirmed BOS/CHoCH/MSS yet.',
    smc.narrative,
    `Price action: ${pa.narrative}`,
    `Entry Zone ${g5(levels.entryZoneLow)}–${g5(levels.entryZoneHigh)} at ${g5(levels.entry)} from ${levels.references[0]}.`,
    `Stop Loss ${g5(levels.stopLoss)} beyond confirmed structure plus the ${buffer.toFixed(2)} ATR buffer.`,
    `TP1 ${g5(levels.tp1)} (${levels.rrTp1.toFixed(2)}R) closes 50%`
      + (levels.tp2 !== null ? `, TP2 ${g5(levels.tp2)} (${levels.rrTp2!.toFixed(2)}R)` : '')
      + (levels.tp3 !== null ? `, TP3 ${g5(levels.tp3)} (${levels.rrTp3!.toFixed(2)}R)` : '')
      + `; stop moves to breakeven ${g5(levels.breakevenStop)} after TP1.`,
    `Setup score ${score.total.toFixed(0)}/100 (${score.band}).`,
  ]
  if (score.volumeRatio !== null) {
    reasons.push(`Volume ${score.volumeRatio.toFixed(2)}x its 20-bar average${score.volumeConfirmed ? ' (confirmation).' : ' (not a gate).'}`)
  }
  reasons.push('Confirmed on a closed candle; levels are frozen after generation.')
  return reasons
}

type NoSignalInput = {
  symbol: string
  timeframe: Timeframe
  reason: string
  now: number
  view?: MarketView
  score?: Score
  structure?: Structure
  smc?: SMCMap
  pa?: PriceAction
  snapshot?: IndicatorSnapshot | null
  dataOk?: boolean
  dataNotes?: string[]
  barTime?: number | null
}

function noSignal(input: NoSignalInput): V2Analysis {
  const score = { ...(input.score ?? zeroScore()), band: 'NO_SIGNAL' as const }
  return {
    strategy: V2_STRATEGY,
    symbol: input.symbol.toUpperCase(),
    timeframe: input.timeframe,
    action: 'NO_SIGNAL',
    view: input.view ?? 'RANGING',
    score,
    structure: input.structure ?? emptyStructureV2(),
    smc: input.smc ?? emptySMC(),
    priceAction: input.pa ?? emptyPriceAction(),
    indicators: input.snapshot ?? null,
    levels: null,
    signal: null,
    reason: input.reason,
    dataOk: input.dataOk ?? true,
    dataNotes: input.dataNotes ?? [],
    barTime: input.barTime ?? null,
    generatedAt: input.now,
    existingActive: null,
    openSignals: [],
    bestSetups: [],
    remainingAnalyses: 0,
    remainingSignals: 0,
    remainingBestSetups: 0,
    remainingScans: 0,
  }
}

export type EvaluateV2Input = {
  symbol: string
  timeframe: Timeframe
  candles: Candle[]
  now?: number
}

/** Evaluate the latest closed candle and return BUY, SELL or NO SIGNAL. */
export function evaluateV2({ symbol, timeframe, candles, now = Date.now() }: EvaluateV2Input): V2Analysis {
  const upperSymbol = symbol.toUpperCase()
  const closed = candles.filter(candle => candle.time <= now)

  const validation = validateV2Candles(closed, timeframe, now)
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
  const series = buildIndicatorSeries(closed, timeframe)
  const snapshot = snapshotAt(series, closed, pos)
  if (!snapshot) {
    return noSignal({
      symbol: upperSymbol,
      timeframe,
      reason: 'Indicators are not fully warmed up on the available history',
      now,
      dataOk: false,
      dataNotes: ['EMA 200, ADX, Bollinger, Stochastic, VWAP or ATR returned an invalid value'],
      barTime,
    })
  }

  const structure = analyzeStructureV2(closed, {
    lookback: V2_PIVOT_LOOKBACK,
    lastPos: pos,
    breakBuffer: 0.1 * snapshot.atr,
    atrValues: series.atr14,
  })
  const smc = analyzeSMC(closed, structure, snapshot.atr, pos)
  const priceAction = analyzePriceAction(closed, snapshot.atr, pos)
  const detected = determineView(snapshot, structure, pos)
  let view = detected.view
  const { latest, reversal } = detected

  if (view === 'RANGING') {
    const buyScore = scoreV2('BUY', snapshot, structure, smc, priceAction, pos)
    const sellScore = scoreV2('SELL', snapshot, structure, smc, priceAction, pos)
    const display = buyScore.total >= sellScore.total ? buyScore : sellScore
    const transitionDirection: TradeAction = buyScore.total >= sellScore.total ? 'BUY' : 'SELL'
    const transitionBuy = transitionDirection === 'BUY'
    const expectedView = transitionBuy ? 'BULLISH' : 'BEARISH'
    const priceBeyondEmas = transitionBuy
      ? snapshot.close >= Math.max(snapshot.ema20, snapshot.ema50)
      : snapshot.close <= Math.min(snapshot.ema20, snapshot.ema50)
    const goldTransition = marketClass(upperSymbol) === 'GOLD'
      && display.total >= V2_GOLD_TRANSITION_SCORE
      && display.momentum >= 15
      && display.structure >= 20
      && (snapshot.supertrendDirection > 0) === transitionBuy
      && priceBeyondEmas
      && latest !== null
      && latest.direction === expectedView
      && pos - latest.confirmIndex <= V2_BREAK_RECENCY

    if (!goldTransition) {
      return noSignal({
        symbol: upperSymbol,
        timeframe,
        reason: 'No directional edge: structure and EMA trend do not agree, or the market is ranging. Plus Strategy does not force a trade.',
        now,
        view,
        score: display,
        structure,
        smc,
        pa: priceAction,
        snapshot,
        barTime,
      })
    }
    view = expectedView
  }

  const direction: TradeAction = view === 'BULLISH' ? 'BUY' : 'SELL'
  const buy = direction === 'BUY'
  const score = scoreV2(direction, snapshot, structure, smc, priceAction, pos)
  const expected = buy ? 'BULLISH' : 'BEARISH'

  if (score.momentum < 10) {
    return noSignal({
      symbol: upperSymbol,
      timeframe,
      reason: `Momentum does not support a ${direction} (RSI ${snapshot.rsi.toFixed(1)}, MACD histogram ${g5(snapshot.macdHistogram)}, Stochastic ${snapshot.stochK.toFixed(1)}/${snapshot.stochD.toFixed(1)}).`,
      now,
      view,
      score,
      structure,
      smc,
      pa: priceAction,
      snapshot,
      barTime,
    })
  }

  if (!latest || latest.direction !== expected || pos - latest.confirmIndex > V2_BREAK_RECENCY) {
    return noSignal({
      symbol: upperSymbol,
      timeframe,
      reason: `No fresh ${expected.toLowerCase()} BOS, CHoCH or MSS within the last ${V2_BREAK_RECENCY} closed candles.`,
      now,
      view,
      score,
      structure,
      smc,
      pa: priceAction,
      snapshot,
      barTime,
    })
  }

  const supertrendAgrees = (snapshot.supertrendDirection > 0) === buy
  if (!supertrendAgrees) {
    const reversalAllowed = reversal
      && latest.direction === expected
      && pos - latest.confirmIndex <= REVERSAL_WINDOW_BARS
      && score.total >= V2_STRONG_SCORE
    if (!reversalAllowed) {
      return noSignal({
        symbol: upperSymbol,
        timeframe,
        reason: `Supertrend is ${snapshot.supertrendDirection > 0 ? 'bullish' : 'bearish'} and does not confirm the ${direction}; only a fresh CHoCH/MSS scoring 80+ may override it.`,
        now,
        view,
        score,
        structure,
        smc,
        pa: priceAction,
        snapshot,
        barTime,
      })
    }
  }

  if (score.total <= V2_MIN_SCORE) {
    return noSignal({
      symbol: upperSymbol,
      timeframe,
      reason: `Setup score ${score.total.toFixed(0)}/100 must be higher than ${V2_MIN_SCORE} for a valid BUY/SELL setup.`,
      now,
      view,
      score,
      structure,
      smc,
      pa: priceAction,
      snapshot,
      barTime,
    })
  }

  const plan = buy
    ? buildBuyPlan(snapshot, structure, smc, upperSymbol)
    : buildSellPlan(snapshot, structure, smc, upperSymbol)
  if (!plan.levels) {
    return noSignal({
      symbol: upperSymbol,
      timeframe,
      reason: plan.reason,
      now,
      view,
      score,
      structure,
      smc,
      pa: priceAction,
      snapshot,
      barTime,
    })
  }

  const reasons = reasonsFor(direction, view, snapshot, structure, smc, priceAction, plan.levels, score, upperSymbol)
  const signal: Signal = {
    strategy: V2_STRATEGY,
    signalId: newSignalId(),
    symbol: upperSymbol,
    timeframe,
    direction,
    status: 'ACTIVE',
    score,
    levels: plan.levels,
    structure,
    smc,
    priceAction,
    indicators: snapshot,
    reasons,
    barTime,
    createdAt: now,
    updatedAt: now,
    currentStopLoss: plan.levels.stopLoss,
    breakevenApplied: false,
    closedFraction: 0,
    lastEvaluatedBar: barTime,
  }

  const action: AnalysisAction = buy ? 'BUY' : 'SELL'
  return {
    strategy: V2_STRATEGY,
    symbol: upperSymbol,
    timeframe,
    action,
    view,
    score,
    structure,
    smc,
    priceAction,
    indicators: snapshot,
    levels: plan.levels,
    signal,
    reason: reasons.join('; '),
    dataOk: true,
    dataNotes: validation.notes,
    barTime,
    generatedAt: now,
    existingActive: null,
    openSignals: [],
    bestSetups: [],
    remainingAnalyses: 0,
    remainingSignals: 0,
    remainingBestSetups: 0,
    remainingScans: 0,
  }
}

/** Exposed for deterministic tests of the price-action weighting. */
export function priceActionScoreForTest(direction: TradeAction, events: PriceActionEvent[], lastPos: number): number {
  return priceActionPoints(direction, { events, bias: 'NEUTRAL', narrative: '' }, lastPos)
}
