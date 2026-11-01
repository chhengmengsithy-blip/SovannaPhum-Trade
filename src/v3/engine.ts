/**
 * Deterministic V3 PRO strategy engine.
 *
 * Fixed evaluation order:
 *
 *     closed candles -> indicators -> structure -> SMC -> price action
 *     -> regime -> strategy candidates -> score -> hard gates
 *     -> SMC entry zone -> swing+ATR stop -> structure targets
 *     -> BUY / SELL / NO SIGNAL
 *
 * The engine never forces every indicator to agree. It requires a valid
 * strategy thesis, structure/reversal confirmation, momentum support, an SMC or
 * dynamic entry zone and a risk-validated level set. Correlated momentum
 * readings are capped so RSI, MACD, ROC and Stochastic cannot dominate the
 * score by measuring the same move four times.
 */

import {
  atrRatioAt,
  buildIndicatorSeries,
  snapshotAt,
  widthPercentileAt,
  type IndicatorSeries,
} from './indicators.ts'
import { analyzePriceAction, priceActionPointsForTest } from './priceAction.ts'
import { classifyRegime } from './regime.ts'
import { analyzeSMC } from './smc.ts'
import {
  V3_PIVOT_LOOKBACK,
  analyzeStructureV3,
  emptyStructureV3,
  latestStructureBreak,
} from './structure.ts'
import { evaluateStrategies, type StrategyInput } from './strategies.ts'
import type {
  AnalysisAction,
  Candle,
  IndicatorSnapshot,
  Levels,
  MarketRegime,
  MarketView,
  PriceAction,
  PriceActionEvent,
  ProRiskProfile,
  Score,
  Signal,
  SMCMap,
  StrategyName,
  StrategySelection,
  Structure,
  Timeframe,
  TradeAction,
  V3Analysis,
} from './types.ts'
import {
  STRATEGY_LABELS,
  V3_ATR_BUFFER,
  V3_MAX_RISK_FRACTION,
  V3_STRATEGY,
  g5,
  marketClass,
} from './types.ts'
import { validateV3Candles } from './validate.ts'

export const V3_MIN_SCORE = 70
export const V3_STRONG_SCORE = 85
export const V3_BREAK_RECENCY = 30
export const V3_ENTRY_MAX_DISTANCE_ATR = 2.0
export const V3_CHASE_LIMIT_ATR = 0.75
export const V3_MIN_STOP_ATR = 0.25
export const V3_MAX_STOP_ATR = 3.5
export const V3_GOLD_MAX_STOP_ATR = 4.0
export const V3_TARGET_DEDUPE_ATR = 0.1
export const V3_TP1_R = 1
export const V3_TP2_R = 2
export const V3_TP3_R = 3
export const V3_PA_RECENT_BARS = 6
export const V3_REVERSAL_WINDOW = 10

export const V3_RISK_CONFIG: Record<ProRiskProfile, {
  scoreFloor: number
  minFit: number
  minMomentum: number
  minTp1R: number
  supertrendOverride: number
  counterTrendScore: number
  suggestedRiskPercent: number
}> = {
  LOW: { scoreFloor: 80, minFit: 60, minMomentum: 8, minTp1R: 1.5, supertrendOverride: 101, counterTrendScore: 101, suggestedRiskPercent: 0.5 },
  MEDIUM: { scoreFloor: 70, minFit: 45, minMomentum: 5, minTp1R: 1, supertrendOverride: 85, counterTrendScore: 85, suggestedRiskPercent: 1 },
  HIGH: { scoreFloor: 62, minFit: 35, minMomentum: 3, minTp1R: 1, supertrendOverride: 78, counterTrendScore: 80, suggestedRiskPercent: 2 },
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function maxStopAtr(symbol: string): number {
  return marketClass(symbol) === 'GOLD' ? V3_GOLD_MAX_STOP_ATR : V3_MAX_STOP_ATR
}

function emptySMC(): SMCMap {
  return {
    fvgs: [],
    orderBlocks: [],
    breakers: [],
    mitigationBlocks: [],
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

function emptyRegime(): MarketRegime {
  return {
    kind: 'TRANSITION',
    label: 'Transition / unclear',
    direction: 'NEUTRAL',
    strength: 'UNCLEAR',
    volatility: 'NORMAL',
    adx: 0,
    atrRatio: 1,
    bbWidthPercentile: 0.5,
    narrative: 'No regime context is available yet.',
  }
}

function zeroScore(): Score {
  return {
    regime: 0,
    structure: 0,
    entry: 0,
    momentum: 0,
    priceAction: 0,
    volume: 0,
    volatility: 0,
    strategy: 0,
    total: 0,
    band: 'NO_SIGNAL',
    volumeConfirmed: false,
    volumeRatio: null,
    strategyName: null,
  }
}

function newSignalId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return `v3${cryptoApi.randomUUID().replace(/-/g, '')}`
  return `v3_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
}

function viewOf(direction: TradeAction): MarketView {
  return direction === 'BUY' ? 'BULLISH' : 'BEARISH'
}

function opposite(direction: TradeAction): TradeAction {
  return direction === 'BUY' ? 'SELL' : 'BUY'
}

/**
 * Weighted V3 score, exactly 100 points:
 * regime 15, structure 20, entry/SMC 20, momentum 15, price action 10,
 * volume 5, volatility/quality 10, strategy 5.
 */
export function scoreV3(
  direction: TradeAction,
  candidate: StrategySelection,
  snapshot: IndicatorSnapshot,
  structure: Structure,
  smc: SMCMap,
  pa: PriceAction,
  regime: MarketRegime,
  lastPos: number,
  series: IndicatorSeries,
  symbol = '',
): Score {
  const buy = direction === 'BUY'
  const close = snapshot.close
  const atr = snapshot.atr

  // --- Regime / trend, 15 points -------------------------------------------
  let regimeScore = 0
  if (regime.direction === viewOf(direction)) {
    regimeScore = regime.strength === 'STRONG' ? 15 : regime.strength === 'WEAK' ? 10 : 6
  } else if (regime.kind === 'VOLATILITY_EXPANSION') {
    regimeScore = candidate.name === 'VOLATILITY_EXPANSION' ? 8 : 4
  } else if (regime.kind === 'TRANSITION') {
    const alignedGoldTransition = marketClass(symbol) === 'GOLD' && structure.view === viewOf(direction)
    regimeScore = alignedGoldTransition ? 5 : 3
  } else if (regime.kind === 'SIDEWAYS') {
    regimeScore = candidate.name === 'RANGE_MEAN_REVERSION' ? 6 : 0
  }

  // --- Structure, 20 points -------------------------------------------------
  let structureScore = 0
  if (structure.view === viewOf(direction)) structureScore += 8
  const latest = latestStructureBreak(structure)
  const freshBreak = latest !== null
    && latest.direction === viewOf(direction)
    && lastPos - latest.confirmIndex <= V3_BREAK_RECENCY
  const labels = new Set(structure.recentLabels)
  const alignedLabels = buy
    ? labels.has('H:HH') && labels.has('L:HL')
    : labels.has('H:LH') && labels.has('L:LL')
  if (freshBreak) structureScore += 6
  else if (alignedLabels && structure.view === viewOf(direction)) structureScore += 3
  if (alignedLabels) structureScore += 3
  const correctZone = buy ? smc.premiumDiscount === 'DISCOUNT' : smc.premiumDiscount === 'PREMIUM'
  if (correctZone) structureScore += 3
  structureScore = Math.min(20, structureScore)

  // --- Entry / SMC, 20 points ----------------------------------------------
  const wanted = viewOf(direction)
  const nearGap = [...smc.fvgs].reverse().find(gap => (
    gap.direction === wanted
    && !gap.mitigated
    && gap.high >= close - 1.5 * atr
    && gap.low <= close + 0.5 * atr
  ))
  const nearBlock = [...smc.orderBlocks].reverse().find(block => (
    block.direction === wanted
    && !block.mitigated
    && block.high >= close - 1.5 * atr
    && block.low <= close + 0.5 * atr
  ))
  const nearBreaker = [...smc.breakers].reverse().find(block => (
    block.direction === wanted
    && !block.mitigated
    && block.high >= close - 1.5 * atr
    && block.low <= close + 0.5 * atr
  ))
  const nearMitigation = [...smc.mitigationBlocks].reverse().find(block => (
    block.direction === wanted
    && !block.mitigated
    && block.high >= close - 1.5 * atr
    && block.low <= close + 0.5 * atr
  ))
  const recentSweep = smc.sweeps.some(sweep => (
    sweep.direction === wanted && lastPos - sweep.index <= 15
  ))
  const entryScore = Math.min(
    20,
    (nearGap ? 6 : 0)
      + (nearBlock ? 4 : 0)
      + (nearBreaker ? 4 : 0)
      + (nearMitigation ? 3 : 0)
      + (recentSweep ? 3 : 0)
      + (correctZone ? 3 : 0),
  )

  // --- Momentum, 15 points --------------------------------------------------
  // Take the best three of four correlated momentum readings, then add DI.
  const rsiScore = buy
    ? snapshot.rsi > 80 ? 2 : snapshot.rsi >= 55 ? 5 : snapshot.rsi > 50 ? 3 : 0
    : snapshot.rsi < 20 ? 2 : snapshot.rsi <= 45 ? 5 : snapshot.rsi < 50 ? 3 : 0
  const macdScore = (snapshot.macdHistogram > 0) === buy ? 4 : 0
  const rocScore = (snapshot.roc > 0) === buy && Math.abs(snapshot.roc) >= 0.1 ? 4 : 0
  const stochScore = buy
    ? snapshot.stochK > snapshot.stochD && snapshot.stochK < 85 ? 3 : 0
    : snapshot.stochK < snapshot.stochD && snapshot.stochK > 15 ? 3 : 0
  const momentumTop = [rsiScore, macdScore, rocScore, stochScore]
    .sort((left, right) => right - left)
    .slice(0, 3)
    .reduce((total, value) => total + value, 0)
  const diScore = (snapshot.plusDi > snapshot.minusDi) === buy ? 3 : 0
  const momentum = Math.min(15, momentumTop + diScore)

  // --- Price action, 10 points ---------------------------------------------
  const paScore = priceActionPointsForTest(direction, pa.events, lastPos)

  // --- Volume, 5 points -----------------------------------------------------
  const ratio = snapshot.volumeRatio
  const volume = ratio === null ? 0 : ratio >= 1.2 ? 5 : ratio >= 1 ? 3 : 0

  // --- Volatility / setup quality, 10 points --------------------------------
  let volatilityScore = 0
  if (candidate.name === 'VOLATILITY_EXPANSION') {
    volatilityScore += regime.volatility === 'EXPANSION' ? 5 : 1
  } else if (candidate.name === 'RANGE_MEAN_REVERSION') {
    volatilityScore += regime.volatility === 'CONTRACTION' || regime.kind === 'SIDEWAYS' ? 5 : 2
  } else {
    volatilityScore += regime.volatility === 'NORMAL' ? 5 : regime.volatility === 'CONTRACTION' ? 3 : 2
  }
  const atrRatio = atrRatioAt(series, lastPos)
  if (atrRatio >= 0.6 && atrRatio <= 2.5) volatilityScore += 3
  else if (atrRatio > 3.5) volatilityScore -= 2
  const overextended = buy
    ? close > snapshot.bbUpper && close > snapshot.donchianUpper
    : close < snapshot.bbLower && close < snapshot.donchianLower
  if (!overextended) volatilityScore += 2
  volatilityScore = Math.max(0, Math.min(10, volatilityScore))

  // --- Strategy fit, 5 points ----------------------------------------------
  const strategyScore = Math.round((candidate.fit / 100) * 5)

  const total = Math.round((
    regimeScore
    + structureScore
    + entryScore
    + momentum
    + paScore
    + volume
    + volatilityScore
    + strategyScore
  ) * 100) / 100
  const band: Score['band'] = total >= V3_STRONG_SCORE ? 'STRONG' : total > V3_MIN_SCORE ? 'VALID' : 'NO_SIGNAL'

  return {
    regime: regimeScore,
    structure: structureScore,
    entry: entryScore,
    momentum,
    priceAction: paScore,
    volume,
    volatility: volatilityScore,
    strategy: strategyScore,
    total,
    band,
    volumeConfirmed: ratio !== null && ratio >= 1,
    volumeRatio: ratio,
    strategyName: candidate.name,
  }
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
  strategyName: StrategyName,
): Zone[] {
  const buy = direction === 'BUY'
  const close = snapshot.close
  const atr = snapshot.atr
  const zones: Zone[] = []
  const push = (low: number | null | undefined, high: number | null | undefined, name: string, priority: number) => {
    if (!finite(low) || !finite(high) || !(high > low)) return
    zones.push({ low, high, name, priority })
  }
  const wanted = viewOf(direction)

  if (strategyName === 'RANGE_MEAN_REVERSION') {
    if (buy && structure.rangeLow !== null) {
      push(structure.rangeLow - 0.15 * atr, structure.rangeLow + 0.35 * atr, 'range low', 0)
    }
    if (!buy && structure.rangeHigh !== null) {
      push(structure.rangeHigh - 0.35 * atr, structure.rangeHigh + 0.15 * atr, 'range high', 0)
    }
  }

  if (strategyName === 'FIBONACCI_RETRACEMENT' && finite(structure.rangeHigh) && finite(structure.rangeLow)) {
    const span = structure.rangeHigh - structure.rangeLow
    if (span > 0) {
      push(
        structure.rangeLow + 0.382 * span,
        structure.rangeLow + 0.618 * span,
        '38.2%–61.8% Fibonacci retracement',
        0,
      )
    }
  }

  for (const block of smc.breakers) {
    if (block.direction === wanted && !block.mitigated) {
      push(block.low, block.high, `${block.direction.toLowerCase()} breaker block`, strategyName === 'SUPPLY_DEMAND' ? -1 : 0)
    }
  }
  for (const block of smc.mitigationBlocks) {
    if (block.direction === wanted && !block.mitigated) {
      push(block.low, block.high, `${block.direction.toLowerCase()} mitigation block`, strategyName === 'SUPPLY_DEMAND' ? -1 : 0)
    }
  }
  for (const gap of smc.fvgs) {
    if (gap.direction === wanted && !gap.mitigated) {
      push(gap.low, gap.high, `${gap.direction.toLowerCase()} fair value gap`, 1)
    }
  }
  for (const block of smc.orderBlocks) {
    if (block.direction === wanted && !block.mitigated) {
      push(block.low, block.high, `${block.direction.toLowerCase()} order block`, strategyName === 'SUPPLY_DEMAND' ? -1 : 2)
    }
  }

  const narrow = 0.12 * atr
  push(snapshot.ema20 - narrow, snapshot.ema20 + narrow, 'EMA 20', 3)
  push(snapshot.ema50 - narrow, snapshot.ema50 + narrow, 'EMA 50', 3)
  const srLevel = buy ? structure.support : structure.resistance
  const rangeLevel = buy ? structure.rangeLow : structure.rangeHigh
  const srPriority = strategyName === 'SUPPORT_RESISTANCE_BOUNCE' ? 0 : 4
  const wantedKeyKind = buy ? 'SUPPORT' : 'RESISTANCE'
  for (const level of structure.keyLevels.filter(item => item.kind === wantedKeyKind)) {
    push(
      level.price - narrow,
      level.price + narrow,
      `${level.strength.toLowerCase()} key ${buy ? 'support' : 'resistance'} · ${level.touches} touch${level.touches === 1 ? '' : 'es'}`,
      strategyName === 'SUPPORT_RESISTANCE_BOUNCE' ? -1 : 5,
    )
  }
  push(srLevel !== null ? srLevel - narrow : null, srLevel !== null ? srLevel + narrow : null, buy ? 'confirmed support' : 'confirmed resistance', srPriority)
  push(rangeLevel !== null ? rangeLevel - narrow : null, rangeLevel !== null ? rangeLevel + narrow : null, buy ? 'range low' : 'range high', srPriority)

  const latest = latestStructureBreak(structure)
  if (latest && latest.direction === wanted) {
    push(latest.level - 0.15 * atr, latest.level + 0.15 * atr, `${latest.kind.toLowerCase()} retest level`, 4)
  }

  const reachable = zones.filter(zone => (
    buy
      ? zone.low <= close + 0.15 * atr && zone.high >= close - V3_ENTRY_MAX_DISTANCE_ATR * atr
      : zone.high >= close - 0.15 * atr && zone.low <= close + V3_ENTRY_MAX_DISTANCE_ATR * atr
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
  if (levels.rrTp1 < V3_TP1_R - tol) return 'TP1 does not reach the 1:1 minimum reward-to-risk'
  if (levels.tp2 !== null) {
    if (levels.rrTp2 === null || levels.rrTp2 < V3_TP2_R - tol) return 'TP2 does not reach the 2R minimum'
    if (buy ? levels.tp2 <= levels.tp1 : levels.tp2 >= levels.tp1) return 'TP2 is not beyond TP1'
  }
  if (levels.tp3 !== null) {
    if (levels.rrTp3 === null || levels.rrTp3 < V3_TP3_R - tol) return 'TP3 does not reach the 3R minimum'
    const reference = levels.tp2 ?? levels.tp1
    if (buy ? levels.tp3 <= reference : levels.tp3 >= reference) return 'TP3 is not beyond TP2'
  }
  return null
}

function buildPlan(
  direction: TradeAction,
  snapshot: IndicatorSnapshot,
  structure: Structure,
  smc: SMCMap,
  symbol: string,
  strategyName: StrategyName,
): PlanResult {
  const buy = direction === 'BUY'
  const close = snapshot.close
  const atr = snapshot.atr
  const buffer = V3_ATR_BUFFER[marketClass(symbol)]
  const zones = buildZones(direction, snapshot, structure, smc, strategyName)
  if (!zones.length) {
    return { levels: null, reason: `No valid ${buy ? 'bullish' : 'bearish'} SMC, range or EMA entry zone within 2 ATR of price` }
  }

  const zone = zones.find(candidate => (
    buy
      ? close >= candidate.low - 0.1 * atr && close <= candidate.high + V3_CHASE_LIMIT_ATR * atr
      : close <= candidate.high + 0.1 * atr && close >= candidate.low - V3_CHASE_LIMIT_ATR * atr
  ))
  if (!zone) {
    return { levels: null, reason: 'Price is outside every valid entry zone or too extended to chase' }
  }

  const entry = buy
    ? Math.min(Math.max(close, zone.low), zone.high)
    : Math.max(Math.min(close, zone.high), zone.low)

  const swingCandidates = (buy ? structure.swingLows : structure.swingHighs)
    .map(point => point.price)
    .filter(price => (buy ? price < entry - 0.05 * atr : price > entry + 0.05 * atr))
  let swingLevel: number
  if (swingCandidates.length) {
    const beyondZone = swingCandidates.filter(level => (buy ? level < zone.low : level > zone.high))
    swingLevel = buy
      ? Math.max(...(beyondZone.length ? beyondZone : swingCandidates))
      : Math.min(...(beyondZone.length ? beyondZone : swingCandidates))
  } else if (buy ? finite(structure.rangeLow) : finite(structure.rangeHigh)) {
    swingLevel = buy ? structure.rangeLow! : structure.rangeHigh!
  } else {
    return {
      levels: null,
      reason: buy
        ? 'No confirmed 3L swing low below entry to invalidate the BUY'
        : 'No confirmed 3R swing high above entry to invalidate the SELL',
    }
  }

  const stopLoss = buy ? swingLevel - buffer * atr : swingLevel + buffer * atr
  const risk = buy ? entry - stopLoss : stopLoss - entry
  if (!(risk > 0)) return { levels: null, reason: 'Stop loss is on the wrong side of entry' }
  if (risk < V3_MIN_STOP_ATR * atr) return { levels: null, reason: 'Stop loss is too tight for the current volatility' }
  if (risk > maxStopAtr(symbol) * atr) {
    return { levels: null, reason: `Stop loss is excessively wide (${(risk / atr).toFixed(2)} ATR)` }
  }
  if (risk / entry > V3_MAX_RISK_FRACTION[marketClass(symbol)]) {
    return { levels: null, reason: 'Stop loss risk exceeds the market risk cap' }
  }

  const targets: Array<[number, string]> = []
  if (buy) {
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
    if (structure.equilibrium !== null && structure.equilibrium > entry + 0.1 * atr) {
      targets.push([structure.equilibrium, 'range equilibrium'])
    }
    for (const level of smc.equalHighs) targets.push([level.price, 'equal highs'])
    for (const block of smc.orderBlocks) {
      if (block.direction === 'BEARISH' && block.low > entry + 0.1 * atr) targets.push([block.low, 'bearish order block'])
    }
    for (const block of smc.breakers) {
      if (block.direction === 'BEARISH' && block.low > entry + 0.1 * atr) targets.push([block.low, 'bearish breaker block'])
    }
  } else {
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
    if (structure.equilibrium !== null && structure.equilibrium < entry - 0.1 * atr) {
      targets.push([structure.equilibrium, 'range equilibrium'])
    }
    for (const level of smc.equalLows) targets.push([level.price, 'equal lows'])
    for (const block of smc.orderBlocks) {
      if (block.direction === 'BULLISH' && block.high < entry - 0.1 * atr) targets.push([block.high, 'bullish order block'])
    }
    for (const block of smc.breakers) {
      if (block.direction === 'BULLISH' && block.high < entry - 0.1 * atr) targets.push([block.high, 'bullish breaker block'])
    }
  }

  const unique = dedupeTargets(targets, V3_TARGET_DEDUPE_ATR * atr)
  if (!unique.length) {
    return { levels: null, reason: buy ? 'No structural liquidity above entry' : 'No structural liquidity below entry' }
  }

  const ordered = buy ? unique : [...unique].reverse()
  const tp1Entry = ordered.find(([level]) => (buy ? level - entry : entry - level) >= risk * (V3_TP1_R - 1e-9))
  if (!tp1Entry) return { levels: null, reason: 'No structural target reaches 1R' }
  const tp2Entry = ordered.find(([level]) => (
    (buy ? level > tp1Entry[0] : level < tp1Entry[0])
    && (buy ? level - entry : entry - level) >= risk * (V3_TP2_R - 1e-9)
  )) ?? null
  const reference = tp2Entry ? tp2Entry[0] : tp1Entry[0]
  const tp3Entry = ordered.find(([level]) => (
    (buy ? level > reference : level < reference)
    && (buy ? level - entry : entry - level) >= risk * (V3_TP3_R - 1e-9)
  )) ?? null

  const [tp1, tp1Name] = tp1Entry
  const tp2 = tp2Entry ? tp2Entry[0] : null
  const tp2Name = tp2Entry ? tp2Entry[1] : ''
  const tp3 = tp3Entry ? tp3Entry[0] : null
  const tp3Name = tp3Entry ? tp3Entry[1] : ''
  const costBuffer = Math.max(0.05 * atr, entry * 0.0002)

  const references = [
    zone.name,
    buy ? `confirmed 3L swing low ${g5(swingLevel)}` : `confirmed 3R swing high ${g5(swingLevel)}`,
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
    rrTp1: buy ? (tp1 - entry) / risk : (entry - tp1) / risk,
    rrTp2: tp2 !== null ? (buy ? (tp2 - entry) / risk : (entry - tp2) / risk) : null,
    rrTp3: tp3 !== null ? (buy ? (tp3 - entry) / risk : (entry - tp3) / risk) : null,
    allocations: allocationsFor(tp2, tp3),
    breakevenStop: buy ? entry + costBuffer : entry - costBuffer,
    references,
    tp1CloseFraction: 0.5,
  }

  const invalid = validatePlan(direction, levels)
  return invalid ? { levels: null, reason: invalid } : { levels, reason: '' }
}

function structureGate(
  strategyName: StrategyName,
  direction: TradeAction,
  structure: Structure,
  latest: ReturnType<typeof latestStructureBreak>,
  lastPos: number,
  pa: PriceAction,
  smc: SMCMap,
  close: number,
): string | null {
  const wanted = viewOf(direction)
  const reversed = latest !== null
    && latest.direction === wanted
    && (latest.kind === 'CHOCH' || latest.kind === 'MSS')
    && lastPos - latest.confirmIndex <= V3_REVERSAL_WINDOW

  if (strategyName === 'LIQUIDITY_SWEEP_REVERSAL') {
    if (!reversed) return `No fresh ${wanted.toLowerCase()} CHoCH or MSS after the liquidity sweep.`
    return null
  }

  if (strategyName === 'RANGE_MEAN_REVERSION') {
    const rangeOk = finite(structure.rangeHigh) && finite(structure.rangeLow)
    const rejection = pa.events.some(event => (
      event.index >= lastPos - 6
      && event.direction === wanted
      && ['REJECTION', 'PIN_BAR', 'ENGULFING', 'FAILED_BREAKOUT', 'STRONG_CLOSE'].includes(event.kind)
    ))
    const sweepOk = smc.sweeps.some(sweep => sweep.direction === wanted && lastPos - sweep.index <= 10)
    if (!rangeOk) return 'No confirmed range high and range low for a mean-reversion setup.'
    if (!rejection && !sweepOk) return 'Range edge is not confirmed by rejection, a failed breakout or a sweep.'
    return null
  }

  if (structure.view === wanted) return null
  if (latest && latest.direction === wanted && lastPos - latest.confirmIndex <= V3_BREAK_RECENCY) return null
  if (strategyName === 'VOLATILITY_EXPANSION') {
    const channelBreak = direction === 'BUY'
      ? (structure.rangeHigh !== null && close > structure.rangeHigh)
        || (structure.resistance !== null && close > structure.resistance)
      : (structure.rangeLow !== null && close < structure.rangeLow)
        || (structure.support !== null && close < structure.support)
    if (channelBreak) return null
  }
  return `Structure is ${structure.view.toLowerCase()} and does not confirm the ${direction} thesis.`
}

function reasonsFor(
  direction: TradeAction,
  candidate: StrategySelection,
  snapshot: IndicatorSnapshot,
  structure: Structure,
  smc: SMCMap,
  pa: PriceAction,
  regime: MarketRegime,
  levels: Levels,
  score: Score,
  symbol: string,
): string[] {
  const buy = direction === 'BUY'
  const buffer = V3_ATR_BUFFER[marketClass(symbol)]
  const latest = latestStructureBreak(structure)
  const emaAligned = buy ? snapshot.ema20 > snapshot.ema50 : snapshot.ema20 < snapshot.ema50
  const emaReason = emaAligned
    ? `EMA 20 ${g5(snapshot.ema20)} ${buy ? 'above' : 'below'} EMA 50 ${g5(snapshot.ema50)}`
    : `Gold transition with price beyond both fast EMAs; EMA 20 ${g5(snapshot.ema20)} is approaching EMA 50 ${g5(snapshot.ema50)}`
  const reasons = [
    `Selected strategy: ${STRATEGY_LABELS[candidate.name]} (${candidate.fit}/100 fit).`,
    ...candidate.reasons,
    `Market regime: ${regime.label}; ${regime.narrative}.`,
    `${emaReason}; ADX ${snapshot.adx.toFixed(1)} with +DI ${snapshot.plusDi.toFixed(1)} / −DI ${snapshot.minusDi.toFixed(1)}.`,
    `RSI ${snapshot.rsi.toFixed(1)}, MACD histogram ${g5(snapshot.macdHistogram)}, ROC ${snapshot.roc.toFixed(2)}%, Stochastic ${snapshot.stochK.toFixed(1)}/${snapshot.stochD.toFixed(1)}.`,
    `Supertrend ${snapshot.supertrendDirection > 0 ? 'bullish' : 'bearish'}; VWAP ${g5(snapshot.vwap)}, Bollinger width ${snapshot.bbWidth.toFixed(2)}%, Keltner ${g5(snapshot.keltnerLower)}–${g5(snapshot.keltnerUpper)}, Donchian ${g5(snapshot.donchianLower)}–${g5(snapshot.donchianUpper)}.`,
    structure.narrative,
    latest
      ? `Latest structure event: ${latest.kind} ${latest.direction.toLowerCase()} at ${g5(latest.level)}${latest.displacement ? ' with displacement' : ''}.`
      : 'No confirmed BOS/CHoCH/MSS yet.',
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
  strategyName?: StrategyName | null
  strategyReasons?: string[]
  regime?: MarketRegime
  score?: Score
  structure?: Structure
  smc?: SMCMap
  pa?: PriceAction
  snapshot?: IndicatorSnapshot | null
  dataOk?: boolean
  dataNotes?: string[]
  barTime?: number | null
  candles?: Candle[]
  requestedStrategy?: StrategyName | null
  riskProfile?: ProRiskProfile
}

function noSignal(input: NoSignalInput): V3Analysis {
  const score = { ...(input.score ?? zeroScore()), band: 'NO_SIGNAL' as const }
  return {
    strategy: V3_STRATEGY,
    symbol: input.symbol.toUpperCase(),
    timeframe: input.timeframe,
    action: 'NO_SIGNAL',
    view: input.view ?? 'RANGING',
    strategyName: input.strategyName ?? null,
    requestedStrategy: input.requestedStrategy ?? null,
    riskProfile: input.riskProfile ?? 'MEDIUM',
    suggestedRiskPercent: V3_RISK_CONFIG[input.riskProfile ?? 'MEDIUM'].suggestedRiskPercent,
    strategyReasons: input.strategyReasons ?? [],
    regime: input.regime ?? emptyRegime(),
    score,
    structure: input.structure ?? emptyStructureV3(),
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
    history: [],
    chartCandles: input.candles ? input.candles.slice(-100) : [],
    remainingAnalyses: -1,
    remainingSignals: -1,
    remainingBestSetups: -1,
    remainingScans: -1,
  }
}

export type EvaluateV3Input = {
  symbol: string
  timeframe: Timeframe
  candles: Candle[]
  now?: number
  /**
   * Optional playbook override. Pro users may select it manually and backtests
   * use it to measure each model independently. Omit it for Auto best-fit mode.
   */
  strategy?: StrategyName
  /** Live Pro quality preset. Backtests default to MEDIUM unless specified. */
  riskProfile?: ProRiskProfile
}

/** Evaluate the latest closed candle and return BUY, SELL or NO SIGNAL. */
export function evaluateV3({ symbol, timeframe, candles, now = Date.now(), strategy, riskProfile = 'MEDIUM' }: EvaluateV3Input): V3Analysis {
  const upperSymbol = symbol.toUpperCase()
  const closed = candles.filter(candle => candle.time <= now)
  const quality = V3_RISK_CONFIG[riskProfile]
  const reject = (input: NoSignalInput) => noSignal({
    ...input,
    requestedStrategy: strategy ?? null,
    riskProfile,
  })

  const validation = validateV3Candles(closed, timeframe, now)
  if (!validation.ok || !closed.length) {
    return reject({
      symbol: upperSymbol,
      timeframe,
      reason: validation.notes[0] ?? 'Invalid or insufficient market data',
      now,
      dataOk: false,
      dataNotes: validation.notes,
      candles: closed,
    })
  }

  const pos = closed.length - 1
  const barTime = closed[pos].time
  const series = buildIndicatorSeries(closed, timeframe)
  const snapshot = snapshotAt(series, closed, pos)
  if (!snapshot) {
    return reject({
      symbol: upperSymbol,
      timeframe,
      reason: 'Indicators are not fully warmed up on the available history',
      now,
      dataOk: false,
      dataNotes: ['EMA 200, ADX, Stochastic, ROC, Keltner, Donchian, VWAP or ATR returned an invalid value'],
      barTime,
      candles: closed,
    })
  }

  const structure = analyzeStructureV3(closed, {
    lookback: V3_PIVOT_LOOKBACK,
    lastPos: pos,
    breakBuffer: 0.1 * snapshot.atr,
    atrValues: series.atr14,
  })
  const smc = analyzeSMC(closed, structure, snapshot.atr, pos)
  const priceAction = analyzePriceAction(closed, snapshot.atr, pos)
  const regime = classifyRegime(snapshot, structure, series, pos)
  const strategyInput: StrategyInput = { snapshot, structure, smc, priceAction, regime, lastPos: pos }
  const candidates = evaluateStrategies(strategyInput)
  const candidate = strategy
    ? candidates.find(item => item.name === strategy) ?? null
    : candidates[0] ?? null

  if (!candidate) {
    const view = regime.direction === 'NEUTRAL' ? structure.view : regime.direction
    return reject({
      symbol: upperSymbol,
      timeframe,
      reason: strategy
        ? `The ${STRATEGY_LABELS[strategy]} model had no valid fit on this closed bar.`
        : 'No Pro Strategy playbook fits the current regime, structure and price action. Pro Strategy does not force a trade.',
      now,
      view,
      regime,
      structure,
      smc,
      pa: priceAction,
      snapshot,
      barTime,
      candles: closed,
    })
  }

  const direction = candidate.direction
  const expected = viewOf(direction)
  const score = scoreV3(direction, candidate, snapshot, structure, smc, priceAction, regime, pos, series, upperSymbol)
  const latest = latestStructureBreak(structure)
  const view = regime.direction !== 'NEUTRAL' ? regime.direction : structure.view

  if (candidate.fit < quality.minFit) {
    return reject({
      symbol: upperSymbol,
      timeframe,
      reason: `${STRATEGY_LABELS[candidate.name]} fit ${candidate.fit}/100 is below the ${riskProfile.toLowerCase()}-risk quality requirement of ${quality.minFit}.`,
      now,
      view,
      strategyName: candidate.name,
      strategyReasons: candidate.reasons,
      regime,
      score,
      structure,
      smc,
      pa: priceAction,
      snapshot,
      barTime,
      candles: closed,
    })
  }

  const gate = structureGate(candidate.name, direction, structure, latest, pos, priceAction, smc, snapshot.close)
  if (gate) {
    return reject({
      symbol: upperSymbol,
      timeframe,
      reason: gate,
      now,
      view,
      strategyName: candidate.name,
      strategyReasons: candidate.reasons,
      regime,
      score,
      structure,
      smc,
      pa: priceAction,
      snapshot,
      barTime,
      candles: closed,
    })
  }

  if (score.momentum < quality.minMomentum) {
    return reject({
      symbol: upperSymbol,
      timeframe,
      reason: `Momentum does not support a ${direction} (RSI ${snapshot.rsi.toFixed(1)}, MACD histogram ${g5(snapshot.macdHistogram)}, ROC ${snapshot.roc.toFixed(2)}%).`,
      now,
      view,
      strategyName: candidate.name,
      strategyReasons: candidate.reasons,
      regime,
      score,
      structure,
      smc,
      pa: priceAction,
      snapshot,
      barTime,
      candles: closed,
    })
  }

  const supertrendAgrees = (snapshot.supertrendDirection > 0) === (direction === 'BUY')
  if (!supertrendAgrees && score.total < quality.supertrendOverride) {
    return reject({
      symbol: upperSymbol,
      timeframe,
      reason: `Supertrend is ${snapshot.supertrendDirection > 0 ? 'bullish' : 'bearish'} and the setup scores ${score.total.toFixed(0)}/100; ${riskProfile.toLowerCase()} risk requires ${quality.supertrendOverride}+ to override it.`,
      now,
      view,
      strategyName: candidate.name,
      strategyReasons: candidate.reasons,
      regime,
      score,
      structure,
      smc,
      pa: priceAction,
      snapshot,
      barTime,
      candles: closed,
    })
  }

  const counterTrend = regime.strength === 'STRONG' && regime.direction !== 'NEUTRAL' && regime.direction !== expected
  if (counterTrend) {
    const reversalPlaybook = candidate.name === 'LIQUIDITY_SWEEP_REVERSAL'
      || candidate.name === 'SUPPLY_DEMAND'
      || candidate.name === 'SUPPORT_RESISTANCE_BOUNCE'
    const allowed = reversalPlaybook && score.total >= quality.counterTrendScore
    if (!allowed) {
      return reject({
        symbol: upperSymbol,
        timeframe,
        reason: `The ${regime.label.toLowerCase()} is still in force and the ${STRATEGY_LABELS[candidate.name]} scores ${score.total.toFixed(0)}/100. ${riskProfile.toLowerCase()} risk requires a confirmed reversal playbook at ${quality.counterTrendScore}+.`,
        now,
        view,
        strategyName: candidate.name,
        strategyReasons: candidate.reasons,
        regime,
        score,
        structure,
        smc,
        pa: priceAction,
        snapshot,
        barTime,
        candles: closed,
      })
    }
  }

  if (score.total <= quality.scoreFloor) {
    return reject({
      symbol: upperSymbol,
      timeframe,
      reason: `Setup score ${score.total.toFixed(0)}/100 must be higher than ${quality.scoreFloor} for ${riskProfile.toLowerCase()} risk (regime ${score.regime}/15, structure ${score.structure}/20, entry ${score.entry}/20, momentum ${score.momentum}/15, price action ${score.priceAction}/10, volume ${score.volume}/5, volatility ${score.volatility}/10, strategy ${score.strategy}/5).`,
      now,
      view,
      strategyName: candidate.name,
      strategyReasons: candidate.reasons,
      regime,
      score,
      structure,
      smc,
      pa: priceAction,
      snapshot,
      barTime,
      candles: closed,
    })
  }

  const plan = buildPlan(direction, snapshot, structure, smc, upperSymbol, candidate.name)
  if (!plan.levels) {
    return reject({
      symbol: upperSymbol,
      timeframe,
      reason: plan.reason,
      now,
      view,
      strategyName: candidate.name,
      strategyReasons: candidate.reasons,
      regime,
      score,
      structure,
      smc,
      pa: priceAction,
      snapshot,
      barTime,
      candles: closed,
    })
  }

  if (plan.levels.rrTp1 < quality.minTp1R) {
    return reject({
      symbol: upperSymbol,
      timeframe,
      reason: `TP1 offers ${plan.levels.rrTp1.toFixed(2)}R; ${riskProfile.toLowerCase()} risk requires at least ${quality.minTp1R.toFixed(2)}R.`,
      now,
      view,
      strategyName: candidate.name,
      strategyReasons: candidate.reasons,
      regime,
      score,
      structure,
      smc,
      pa: priceAction,
      snapshot,
      barTime,
      candles: closed,
    })
  }

  const reasons = reasonsFor(direction, candidate, snapshot, structure, smc, priceAction, regime, plan.levels, score, upperSymbol)
  const signal: Signal = {
    strategy: V3_STRATEGY,
    signalId: newSignalId(),
    symbol: upperSymbol,
    timeframe,
    direction,
    status: 'ACTIVE',
    strategyName: candidate.name,
    riskProfile,
    suggestedRiskPercent: quality.suggestedRiskPercent,
    regime,
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

  const action: AnalysisAction = direction
  return {
    strategy: V3_STRATEGY,
    symbol: upperSymbol,
    timeframe,
    action,
    view,
    strategyName: candidate.name,
    requestedStrategy: strategy ?? null,
    riskProfile,
    suggestedRiskPercent: quality.suggestedRiskPercent,
    strategyReasons: candidate.reasons,
    regime,
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
    history: [],
    chartCandles: closed.slice(-100),
    remainingAnalyses: -1,
    remainingSignals: -1,
    remainingBestSetups: -1,
    remainingScans: -1,
  }
}

/** Exposed for deterministic tests of the price-action weighting. */
export function priceActionScoreForTest(direction: TradeAction, events: PriceActionEvent[], lastPos: number): number {
  return priceActionPointsForTest(direction, events, lastPos)
}

/** Exposed so the server can label strategy names without importing labels twice. */
export { STRATEGY_LABELS }
export { widthPercentileAt }
