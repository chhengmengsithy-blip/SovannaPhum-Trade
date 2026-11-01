/**
 * V3 PRO market-regime classifier.
 *
 * The regime is a summary of three independent facts:
 *  * trend direction and alignment (EMA 20/50/200 plus DI+/DI−);
 *  * trend strength (ADX);
 *  * volatility state (ATR ratio and the 100-bar Bollinger-width percentile).
 *
 * It is used to choose a strategy and to weight the 15-point regime score. It
 * never replaces structure or the risk plan.
 */

import type { IndicatorSnapshot, MarketRegime, RegimeKind, Structure, VolatilityState } from './types.ts'
import { atrRatioAt, widthPercentileAt, type IndicatorSeries } from './indicators.ts'

function volatilityState(atrRatio: number, widthPercentile: number): VolatilityState {
  if (atrRatio >= 1.3 || widthPercentile >= 0.8) return 'EXPANSION'
  if (atrRatio <= 0.78 || widthPercentile <= 0.2) return 'CONTRACTION'
  return 'NORMAL'
}

function trendDirection(snapshot: IndicatorSnapshot): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  const emaBull = snapshot.ema20 > snapshot.ema50 && snapshot.close > snapshot.ema50
  const emaBear = snapshot.ema20 < snapshot.ema50 && snapshot.close < snapshot.ema50
  const diBull = snapshot.plusDi > snapshot.minusDi
  const diBear = snapshot.minusDi > snapshot.plusDi

  if (emaBull && diBull) return 'BULLISH'
  if (emaBear && diBear) return 'BEARISH'
  if (emaBull || (diBull && snapshot.close > snapshot.ema200)) return 'BULLISH'
  if (emaBear || (diBear && snapshot.close < snapshot.ema200)) return 'BEARISH'
  return 'NEUTRAL'
}

function labelFor(kind: RegimeKind): string {
  switch (kind) {
    case 'STRONG_BULL': return 'Strong bullish trend'
    case 'WEAK_BULL': return 'Weak bullish trend'
    case 'STRONG_BEAR': return 'Strong bearish trend'
    case 'WEAK_BEAR': return 'Weak bearish trend'
    case 'SIDEWAYS': return 'Sideways / range'
    case 'VOLATILITY_EXPANSION': return 'Volatility expansion'
    case 'VOLATILITY_CONTRACTION': return 'Volatility contraction'
    case 'TRANSITION': return 'Transition / unclear'
  }
}

export function classifyRegime(
  snapshot: IndicatorSnapshot,
  structure: Structure,
  series: IndicatorSeries,
  pos: number,
): MarketRegime {
  const atrRatio = atrRatioAt(series, pos)
  const bbWidthPercentile = widthPercentileAt(series, pos)
  const volatility = volatilityState(atrRatio, bbWidthPercentile)
  const direction = trendDirection(snapshot)
  const alignedBull = snapshot.ema20 > snapshot.ema50 && snapshot.ema50 > snapshot.ema200
  const alignedBear = snapshot.ema20 < snapshot.ema50 && snapshot.ema50 < snapshot.ema200
  const structureAgrees = (direction === 'BULLISH' && structure.view === 'BULLISH')
    || (direction === 'BEARISH' && structure.view === 'BEARISH')

  let kind: RegimeKind
  let strength: MarketRegime['strength']

  if (direction !== 'NEUTRAL' && snapshot.adx >= 25 && structureAgrees && (alignedBull || alignedBear)) {
    kind = direction === 'BULLISH' ? 'STRONG_BULL' : 'STRONG_BEAR'
    strength = 'STRONG'
  } else if (direction !== 'NEUTRAL' && (snapshot.adx >= 18 || structureAgrees)) {
    kind = direction === 'BULLISH' ? 'WEAK_BULL' : 'WEAK_BEAR'
    strength = 'WEAK'
  } else if (structure.view === 'RANGING' && snapshot.adx < 22 && volatility !== 'EXPANSION') {
    kind = 'SIDEWAYS'
    strength = 'RANGE'
  } else if (volatility === 'EXPANSION' && direction === 'NEUTRAL') {
    kind = 'VOLATILITY_EXPANSION'
    strength = 'UNCLEAR'
  } else if (volatility === 'CONTRACTION') {
    kind = 'VOLATILITY_CONTRACTION'
    strength = 'UNCLEAR'
  } else {
    kind = 'TRANSITION'
    strength = 'UNCLEAR'
  }

  const narrative = [
    `${labelFor(kind)}: EMA 20 ${snapshot.ema20 > snapshot.ema50 ? 'above' : 'below'} EMA 50, price ${snapshot.close > snapshot.ema50 ? 'above' : 'below'} EMA 50`,
    `ADX ${snapshot.adx.toFixed(1)} with +DI ${snapshot.plusDi.toFixed(1)} / −DI ${snapshot.minusDi.toFixed(1)}`,
    `volatility ${volatility.toLowerCase()} (ATR ${atrRatio.toFixed(2)}x its 20-bar average, Bollinger width at the ${Math.round(bbWidthPercentile * 100)}th percentile)`,
    `structure is ${structure.view.toLowerCase()}`,
  ].join('; ')

  return {
    kind,
    label: labelFor(kind),
    direction,
    strength,
    volatility,
    adx: snapshot.adx,
    atrRatio,
    bbWidthPercentile,
    narrative,
  }
}
