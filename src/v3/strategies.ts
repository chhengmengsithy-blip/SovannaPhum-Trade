/**
 * V3 PRO strategy engines.
 *
 * Five independent strategy models are evaluated on every analysis, and the
 * highest-fit one is selected. They all share the same structure, SMC, price
 * action and risk plan; only the entry thesis and its confirmation differ.
 *
 * The engines are intentionally additive: a low-fit strategy is simply not
 * selected, it never forces a trade. The main engine still applies the score,
 * structure and risk gates afterwards.
 */

import type {
  IndicatorSnapshot,
  MarketRegime,
  PriceAction,
  PriceActionEvent,
  SMCMap,
  StrategyName,
  StrategySelection,
  Structure,
  TradeAction,
} from './types.ts'
import { latestStructureBreak } from './structure.ts'

const REVERSAL_WINDOW = 10
const BREAKOUT_WINDOW = 10
const SWEEP_WINDOW = 15

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function directionOf(view: string): TradeAction | null {
  return view === 'BULLISH' ? 'BUY' : view === 'BEARISH' ? 'SELL' : null
}

function wantedDirection(direction: TradeAction): 'BULLISH' | 'BEARISH' {
  return direction === 'BUY' ? 'BULLISH' : 'BEARISH'
}

function recentEvent(
  pa: PriceAction,
  direction: TradeAction,
  kinds: PriceActionEvent['kind'][],
  lastPos: number,
  window: number,
): PriceActionEvent | null {
  const wanted = wantedDirection(direction)
  return [...pa.events].reverse().find(event => (
    event.direction === wanted
    && kinds.includes(event.kind)
    && lastPos - event.index <= window
  )) ?? null
}

function latestSweep(smc: SMCMap, direction: TradeAction, lastPos: number) {
  const wanted = wantedDirection(direction)
  return [...smc.sweeps].reverse().find(sweep => (
    sweep.direction === wanted && lastPos - sweep.index <= SWEEP_WINDOW
  )) ?? null
}

function rangePosition(structure: Structure, close: number): number | null {
  if (!finite(structure.rangeHigh) || !finite(structure.rangeLow) || structure.rangeHigh <= structure.rangeLow) return null
  return (close - structure.rangeLow) / (structure.rangeHigh - structure.rangeLow)
}

type Candidate = StrategySelection

function trendContinuation(
  snapshot: IndicatorSnapshot,
  structure: Structure,
  regime: MarketRegime,
  lastPos: number,
): Candidate | null {
  const direction = directionOf(regime.direction) ?? directionOf(structure.view)
  if (!direction) return null
  const buy = direction === 'BUY'
  const reasons: string[] = []
  let fit = 0

  const aligned = buy
    ? snapshot.ema20 > snapshot.ema50 && snapshot.ema50 > snapshot.ema200
    : snapshot.ema20 < snapshot.ema50 && snapshot.ema50 < snapshot.ema200
  fit += aligned ? 30 : (snapshot.ema20 > snapshot.ema50) === buy ? 18 : 0
  reasons.push(aligned ? 'EMA 20/50/200 are fully aligned.' : 'EMA stack is only partially aligned.')

  if (snapshot.adx >= 25) fit += 20
  else if (snapshot.adx >= 18) fit += 12
  reasons.push(`ADX ${snapshot.adx.toFixed(1)} (${snapshot.adx >= 25 ? 'trending' : snapshot.adx >= 18 ? 'developing' : 'choppy'}).`)

  if ((snapshot.supertrendDirection > 0) === buy) {
    fit += 15
    reasons.push('Supertrend confirms the trend direction.')
  }

  const momentumOk = buy
    ? snapshot.rsi >= 50 && snapshot.macdHistogram >= 0
    : snapshot.rsi <= 50 && snapshot.macdHistogram <= 0
  if (momentumOk) {
    fit += 15
    reasons.push('RSI and MACD histogram support continuation.')
  }

  const location = buy
    ? Math.min(Math.abs(snapshot.close - snapshot.ema20), Math.abs(snapshot.close - snapshot.ema50))
    : Math.min(Math.abs(snapshot.close - snapshot.ema20), Math.abs(snapshot.close - snapshot.ema50))
  if (location <= 1.2 * snapshot.atr) {
    fit += 20
    reasons.push('Price is inside a 1.2 ATR pullback of the dynamic support/resistance.')
  } else if (location <= 2.5 * snapshot.atr) {
    fit += 10
    reasons.push('Price is within 2.5 ATR of the EMA pullback area.')
  }

  if (structure.view !== regime.direction && regime.strength === 'STRONG') {
    fit -= 15
    reasons.push('Structure is not yet aligned with the strong trend regime.')
  }

  if (fit < 35) return null
  return { name: 'TREND_CONTINUATION', direction, fit: clamp(fit), reasons }
}

function breakoutRetest(
  snapshot: IndicatorSnapshot,
  structure: Structure,
  smc: SMCMap,
  pa: PriceAction,
  lastPos: number,
): Candidate | null {
  const event = recentEvent(pa, 'BUY', ['BREAKOUT', 'RETEST'], lastPos, BREAKOUT_WINDOW)
    ?? recentEvent(pa, 'SELL', ['BREAKOUT', 'RETEST'], lastPos, BREAKOUT_WINDOW)
  const latest = latestStructureBreak(structure)
  const direction = event
    ? (event.direction === 'BULLISH' ? 'BUY' : 'SELL')
    : latest && lastPos - latest.confirmIndex <= BREAKOUT_WINDOW
      ? directionOf(latest.direction)
      : null
  if (!direction) return null
  const buy = direction === 'BUY'
  const reasons: string[] = []
  let fit = 0

  if (event) {
    fit += lastPos - event.index <= 3 ? 25 : 15
    reasons.push(`${event.kind.replace('_', ' ').toLowerCase()} ${event.direction.toLowerCase()} on the latest closed bars.`)
  } else {
    reasons.push('No fresh price-action breakout; structure break used as the trigger.')
  }

  if (latest && latest.direction === wantedDirection(direction) && lastPos - latest.confirmIndex <= BREAKOUT_WINDOW) {
    fit += 20
    reasons.push(`${latest.kind} ${latest.direction.toLowerCase()} at ${latest.level.toFixed(5)} confirms the break.`)
  }

  if (snapshot.volumeRatio !== null && snapshot.volumeRatio >= 1.2) {
    fit += 15
    reasons.push(`Volume is ${snapshot.volumeRatio.toFixed(2)}x its 20-bar average.`)
  } else if (snapshot.volumeRatio !== null && snapshot.volumeRatio >= 1) {
    fit += 8
  }

  if (snapshot.adx >= 22) {
    fit += 15
    reasons.push(`ADX ${snapshot.adx.toFixed(1)} shows a directional market.`)
  } else if (snapshot.adx >= 18) {
    fit += 8
  }

  const strongClose = recentEvent(pa, direction, ['STRONG_CLOSE', 'OUTSIDE_BAR'], lastPos, 5)
  if (strongClose) {
    fit += 15
    reasons.push('A strong close/outside bar confirms the breakout.')
  }

  const overextended = buy
    ? snapshot.close > snapshot.bbUpper && snapshot.close > snapshot.donchianUpper
    : snapshot.close < snapshot.bbLower && snapshot.close < snapshot.donchianLower
  if (!overextended) {
    fit += 10
    reasons.push('Price is not beyond both Bollinger and Donchian extremes, so the retest is reachable.')
  } else {
    fit -= 10
    reasons.push('Price is already beyond both channel extremes; chasing risk is high.')
  }

  const zone = smc.fvgs.some(gap => gap.direction === wantedDirection(direction) && !gap.mitigated)
    || smc.breakers.some(block => block.direction === wantedDirection(direction) && !block.mitigated)
  if (zone) {
    fit += 10
    reasons.push('An open SMC zone sits on the retest side.')
  }

  if (fit < 35) return null
  return { name: 'BREAKOUT_RETEST', direction, fit: clamp(fit), reasons }
}

function pullbackContinuation(
  snapshot: IndicatorSnapshot,
  structure: Structure,
  regime: MarketRegime,
  pa: PriceAction,
  lastPos: number,
): Candidate | null {
  const direction = directionOf(regime.direction) ?? directionOf(structure.view)
  if (!direction) return null
  const buy = direction === 'BUY'
  const emaAligned = buy
    ? snapshot.ema20 > snapshot.ema50 && snapshot.close >= snapshot.ema50
    : snapshot.ema20 < snapshot.ema50 && snapshot.close <= snapshot.ema50
  if (!emaAligned) return null

  const distance = Math.min(
    Math.abs(snapshot.close - snapshot.ema20),
    Math.abs(snapshot.close - snapshot.ema50),
    Math.abs(snapshot.close - snapshot.vwap),
  )
  if (distance > 1.6 * snapshot.atr) return null

  let fit = distance <= 0.5 * snapshot.atr ? 35 : distance <= snapshot.atr ? 27 : 18
  const reasons = [`Price pulled back ${Math.max(0, distance / snapshot.atr).toFixed(2)} ATR into EMA/VWAP value.`]
  if (structure.view === wantedDirection(direction)) {
    fit += 20
    reasons.push('Confirmed structure remains aligned with the continuation direction.')
  }
  if ((snapshot.supertrendDirection > 0) === buy) {
    fit += 15
    reasons.push('Supertrend remains aligned during the pullback.')
  }
  const momentum = buy
    ? snapshot.rsi >= 48 && snapshot.macdHistogram >= 0
    : snapshot.rsi <= 52 && snapshot.macdHistogram <= 0
  if (momentum) {
    fit += 15
    reasons.push('Momentum has resumed from the pullback area.')
  }
  const confirmation = recentEvent(pa, direction, ['REJECTION', 'ENGULFING', 'RETEST', 'STRONG_CLOSE'], lastPos, 6)
  if (confirmation) {
    fit += 15
    reasons.push(confirmation.detail)
  }
  return fit >= 35 ? { name: 'PULLBACK_CONTINUATION', direction, fit: clamp(fit), reasons } : null
}

function fibonacciRetracement(
  snapshot: IndicatorSnapshot,
  structure: Structure,
  regime: MarketRegime,
  pa: PriceAction,
  lastPos: number,
): Candidate | null {
  if (!finite(structure.rangeHigh) || !finite(structure.rangeLow) || structure.rangeHigh <= structure.rangeLow) return null
  const direction = directionOf(structure.view) ?? directionOf(regime.direction)
  if (!direction) return null
  const buy = direction === 'BUY'
  const span = structure.rangeHigh - structure.rangeLow
  const retracement = buy
    ? (structure.rangeHigh - snapshot.close) / span
    : (snapshot.close - structure.rangeLow) / span
  if (retracement < 0.3 || retracement > 0.72) return null

  const distanceFromGolden = Math.abs(retracement - 0.5)
  let fit = distanceFromGolden <= 0.08 ? 40 : distanceFromGolden <= 0.15 ? 32 : 22
  const reasons = [`Price is at the ${(retracement * 100).toFixed(1)}% retracement of the confirmed dealing range.`]
  if (retracement >= 0.382 && retracement <= 0.618) {
    fit += 20
    reasons.push('Retracement sits inside the 38.2%–61.8% Fibonacci value zone.')
  }
  if (structure.view === wantedDirection(direction)) fit += 15
  if ((snapshot.supertrendDirection > 0) === buy) fit += 10
  const confirmation = recentEvent(pa, direction, ['REJECTION', 'PIN_BAR', 'ENGULFING', 'STRONG_CLOSE'], lastPos, 7)
  if (confirmation) {
    fit += 15
    reasons.push(confirmation.detail)
  }
  return fit >= 35 ? { name: 'FIBONACCI_RETRACEMENT', direction, fit: clamp(fit), reasons } : null
}

function supplyDemand(
  snapshot: IndicatorSnapshot,
  structure: Structure,
  smc: SMCMap,
  pa: PriceAction,
  lastPos: number,
): Candidate | null {
  const zones = [
    ...smc.orderBlocks.map(zone => ({ ...zone, kind: 'order block' })),
    ...smc.breakers.map(zone => ({ ...zone, kind: 'breaker block' })),
    ...smc.mitigationBlocks.map(zone => ({ ...zone, kind: 'mitigation block' })),
  ].filter(zone => !zone.mitigated)
  if (!zones.length) return null

  const distance = (zone: { low: number; high: number }) => snapshot.close < zone.low
    ? zone.low - snapshot.close
    : snapshot.close > zone.high ? snapshot.close - zone.high : 0
  const zone = [...zones].sort((left, right) => distance(left) - distance(right))[0]
  if (distance(zone) > 1.5 * snapshot.atr) return null
  const direction: TradeAction = zone.direction === 'BULLISH' ? 'BUY' : 'SELL'
  const buy = direction === 'BUY'
  let fit = distance(zone) === 0 ? 40 : distance(zone) <= 0.75 * snapshot.atr ? 30 : 20
  const reasons = [`Price is ${distance(zone) === 0 ? 'inside' : 'approaching'} an unmitigated ${zone.direction.toLowerCase()} ${zone.kind}.`]
  if (structure.view === wantedDirection(direction)) fit += 20
  const correctValue = buy ? smc.premiumDiscount !== 'PREMIUM' : smc.premiumDiscount !== 'DISCOUNT'
  if (correctValue) {
    fit += 15
    reasons.push(`The zone is positioned in ${smc.premiumDiscount.toLowerCase()} value.`)
  }
  const confirmation = recentEvent(pa, direction, ['REJECTION', 'PIN_BAR', 'ENGULFING', 'FAILED_BREAKOUT'], lastPos, 6)
  if (confirmation) {
    fit += 20
    reasons.push(confirmation.detail)
  }
  if ((snapshot.supertrendDirection > 0) === buy) fit += 5
  return fit >= 35 ? { name: 'SUPPLY_DEMAND', direction, fit: clamp(fit), reasons } : null
}

function supportResistanceBounce(
  snapshot: IndicatorSnapshot,
  structure: Structure,
  pa: PriceAction,
  lastPos: number,
): Candidate | null {
  const levels: Array<{ price: number; direction: TradeAction; label: string }> = []
  if (finite(structure.support)) levels.push({ price: structure.support, direction: 'BUY', label: 'confirmed support' })
  if (finite(structure.rangeLow)) levels.push({ price: structure.rangeLow, direction: 'BUY', label: 'range support' })
  if (finite(structure.resistance)) levels.push({ price: structure.resistance, direction: 'SELL', label: 'confirmed resistance' })
  if (finite(structure.rangeHigh)) levels.push({ price: structure.rangeHigh, direction: 'SELL', label: 'range resistance' })
  if (!levels.length) return null
  const nearest = levels.sort((left, right) => Math.abs(snapshot.close - left.price) - Math.abs(snapshot.close - right.price))[0]
  const distance = Math.abs(snapshot.close - nearest.price)
  if (distance > 1.2 * snapshot.atr) return null

  const direction = nearest.direction
  const buy = direction === 'BUY'
  let fit = distance <= 0.35 * snapshot.atr ? 40 : distance <= 0.75 * snapshot.atr ? 30 : 20
  const reasons = [`Price is ${(distance / snapshot.atr).toFixed(2)} ATR from ${nearest.label} at ${nearest.price.toFixed(5)}.`]
  const bounce = recentEvent(pa, direction, ['REJECTION', 'PIN_BAR', 'ENGULFING', 'FAILED_BREAKOUT', 'STRONG_CLOSE'], lastPos, 6)
  if (bounce) {
    fit += 25
    reasons.push(bounce.detail)
  }
  if (structure.view === wantedDirection(direction)) fit += 15
  const momentumTurn = buy ? snapshot.rsi >= 40 && snapshot.rsi <= 65 : snapshot.rsi <= 60 && snapshot.rsi >= 35
  if (momentumTurn) fit += 10
  if ((snapshot.supertrendDirection > 0) === buy) fit += 10
  return fit >= 35 ? { name: 'SUPPORT_RESISTANCE_BOUNCE', direction, fit: clamp(fit), reasons } : null
}

function liquiditySweepReversal(
  snapshot: IndicatorSnapshot,
  structure: Structure,
  smc: SMCMap,
  pa: PriceAction,
  lastPos: number,
): Candidate | null {
  const sweep = [...smc.sweeps].reverse().find(item => lastPos - item.index <= SWEEP_WINDOW)
  if (!sweep) return null
  const direction: TradeAction = sweep.direction === 'BULLISH' ? 'BUY' : 'SELL'
  const buy = direction === 'BUY'
  const reasons: string[] = [
    `${sweep.direction === 'BULLISH' ? 'Sell-side' : 'Buy-side'} liquidity swept at ${sweep.level.toFixed(5)} (${sweep.source}).`,
  ]
  let fit = lastPos - sweep.index <= 3 ? 25 : 15

  const latest = latestStructureBreak(structure)
  if (latest && latest.direction === wantedDirection(direction) && lastPos - latest.confirmIndex <= REVERSAL_WINDOW) {
    fit += 25
    reasons.push(`${latest.kind} ${latest.direction.toLowerCase()} after the sweep.`)
  } else if (structure.view === wantedDirection(direction)) {
    fit += 12
  }

  const rejection = recentEvent(pa, direction, ['REJECTION', 'PIN_BAR', 'ENGULFING', 'FAILED_BREAKOUT'], lastPos, 5)
  if (rejection) {
    fit += 20
    reasons.push(rejection.detail)
  }

  const correctZone = buy ? smc.premiumDiscount === 'DISCOUNT' : smc.premiumDiscount === 'PREMIUM'
  if (correctZone) {
    fit += 15
    reasons.push(`Price is in ${smc.premiumDiscount.toLowerCase()} of the dealing range.`)
  }

  const rsiExtreme = buy ? snapshot.rsi <= 40 : snapshot.rsi >= 60
  if (rsiExtreme) {
    fit += 15
    reasons.push(`RSI ${snapshot.rsi.toFixed(1)} supports a mean-reversal entry.`)
  }

  if (fit < 35) return null
  return { name: 'LIQUIDITY_SWEEP_REVERSAL', direction, fit: clamp(fit), reasons }
}

function rangeMeanReversion(
  snapshot: IndicatorSnapshot,
  structure: Structure,
  regime: MarketRegime,
  pa: PriceAction,
  lastPos: number,
): Candidate | null {
  if (regime.kind !== 'SIDEWAYS' && regime.kind !== 'VOLATILITY_CONTRACTION' && regime.strength !== 'WEAK') return null
  const position = rangePosition(structure, snapshot.close)
  if (position === null) return null
  if (position > 0.3 && position < 0.7) return null

  const direction: TradeAction = position <= 0.3 ? 'BUY' : 'SELL'
  const buy = direction === 'BUY'
  const reasons: string[] = [
    `Price is at the ${Math.round(position * 100)}th percentile of the ${structure.rangeLow!.toFixed(5)}–${structure.rangeHigh!.toFixed(5)} range.`,
  ]
  let fit = position <= 0.15 || position >= 0.85 ? 35 : 25

  const rsiExtreme = buy ? snapshot.rsi <= 35 : snapshot.rsi >= 65
  if (rsiExtreme) {
    fit += 20
    reasons.push(`RSI ${snapshot.rsi.toFixed(1)} is stretched at the range edge.`)
  }

  const rejection = recentEvent(pa, direction, ['REJECTION', 'PIN_BAR', 'ENGULFING', 'FAILED_BREAKOUT'], lastPos, 6)
  if (rejection) {
    fit += 20
    reasons.push(rejection.detail)
  }

  if (snapshot.adx < 20) {
    fit += 15
    reasons.push(`ADX ${snapshot.adx.toFixed(1)} confirms a non-trending range.`)
  }

  const latest = latestStructureBreak(structure)
  if (!latest || latest.direction !== (buy ? 'BEARISH' : 'BULLISH') || lastPos - latest.confirmIndex > 10) {
    fit += 10
    reasons.push('No fresh opposing structure break invalidates the range edge.')
  } else {
    fit -= 20
    reasons.push('A fresh opposite structure break makes the range edge unsafe.')
  }

  if (fit < 35) return null
  return { name: 'RANGE_MEAN_REVERSION', direction, fit: clamp(fit), reasons }
}

function volatilityExpansion(
  snapshot: IndicatorSnapshot,
  structure: Structure,
  regime: MarketRegime,
  pa: PriceAction,
  lastPos: number,
): Candidate | null {
  if (regime.volatility !== 'EXPANSION') return null

  const buyBreak = snapshot.close > snapshot.donchianUpper
  const sellBreak = snapshot.close < snapshot.donchianLower
  const breakout = recentEvent(pa, 'BUY', ['BREAKOUT', 'STRONG_CLOSE'], lastPos, 5)
    ?? recentEvent(pa, 'SELL', ['BREAKOUT', 'STRONG_CLOSE'], lastPos, 5)
  const direction: TradeAction | null = buyBreak ? 'BUY' : sellBreak ? 'SELL' : breakout
    ? (breakout.direction === 'BULLISH' ? 'BUY' : 'SELL')
    : null
  if (!direction) return null

  const reasons: string[] = [
    `Volatility is expanding: ATR ${regime.atrRatio.toFixed(2)}x its 20-bar average and Bollinger width at the ${Math.round(regime.bbWidthPercentile * 100)}th percentile.`,
  ]
  let fit = 30

  if (buyBreak || sellBreak) {
    fit += 25
    reasons.push(direction === 'BUY' ? 'Price closed above the 20-bar Donchian high.' : 'Price closed below the 20-bar Donchian low.')
  }

  if (snapshot.adx >= 20) {
    fit += 15
    reasons.push(`ADX ${snapshot.adx.toFixed(1)} is rising with the expansion.`)
  }

  const strongClose = recentEvent(pa, direction, ['STRONG_CLOSE', 'BREAKOUT', 'OUTSIDE_BAR'], lastPos, 5)
  if (strongClose) {
    fit += 20
    reasons.push(strongClose.detail)
  }

  if (snapshot.volumeRatio !== null && snapshot.volumeRatio >= 1.2) {
    fit += 10
    reasons.push(`Volume ${snapshot.volumeRatio.toFixed(2)}x average confirms participation.`)
  }

  if (structure.view === wantedDirection(direction)) {
    fit += 5
  }

  if (fit < 35) return null
  return { name: 'VOLATILITY_EXPANSION', direction, fit: clamp(fit), reasons }
}

export type StrategyInput = {
  snapshot: IndicatorSnapshot
  structure: Structure
  smc: SMCMap
  priceAction: PriceAction
  regime: MarketRegime
  lastPos: number
}

/** All applicable strategy candidates, best fit first. */
export function evaluateStrategies(input: StrategyInput): Candidate[] {
  const { snapshot, structure, smc, priceAction, regime, lastPos } = input
  const candidates = [
    trendContinuation(snapshot, structure, regime, lastPos),
    breakoutRetest(snapshot, structure, smc, priceAction, lastPos),
    liquiditySweepReversal(snapshot, structure, smc, priceAction, lastPos),
    rangeMeanReversion(snapshot, structure, regime, priceAction, lastPos),
    volatilityExpansion(snapshot, structure, regime, priceAction, lastPos),
    pullbackContinuation(snapshot, structure, regime, priceAction, lastPos),
    fibonacciRetracement(snapshot, structure, regime, priceAction, lastPos),
    supplyDemand(snapshot, structure, smc, priceAction, lastPos),
    supportResistanceBounce(snapshot, structure, priceAction, lastPos),
  ].filter((candidate): candidate is Candidate => candidate !== null)

  return candidates.sort((left, right) => right.fit - left.fit)
}

export function selectStrategy(input: StrategyInput): Candidate | null {
  return evaluateStrategies(input)[0] ?? null
}

export function strategyLabel(name: StrategyName): string {
  switch (name) {
    case 'TREND_CONTINUATION': return 'Trend Continuation'
    case 'BREAKOUT_RETEST': return 'Breakout & Retest'
    case 'PULLBACK_CONTINUATION': return 'Pullback Continuation'
    case 'FIBONACCI_RETRACEMENT': return 'Fibonacci Retracement'
    case 'SUPPLY_DEMAND': return 'Supply & Demand'
    case 'SUPPORT_RESISTANCE_BOUNCE': return 'S/R Bounce'
    case 'LIQUIDITY_SWEEP_REVERSAL': return 'Liquidity Sweep Reversal'
    case 'RANGE_MEAN_REVERSION': return 'Range Mean Reversion'
    case 'VOLATILITY_EXPANSION': return 'Volatility Expansion'
  }
}
