/**
 * Price-action confirmation for V3 PRO.
 *
 * Price action is confirmation, not a hard requirement, but V3 gives it a
 * 10-point weight (double V2) and adds two patterns that matter for the Pro
 * strategies: a strong candle close and a failed breakout.
 *
 * Every pattern is evaluated on a closed bar, so it is final once that bar
 * closes and cannot repaint.
 */

import type { Candle, PriceAction, PriceActionEvent, PriceActionKind } from './types.ts'

const LOOKBACK_BARS = 6
const BREAKOUT_WINDOW = 20

function finite(value: number | undefined | null): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

type BarShape = {
  body: number
  range: number
  upperWick: number
  lowerWick: number
  bullish: boolean
}

function shape(candle: Candle): BarShape {
  const body = Math.abs(candle.close - candle.open)
  const range = candle.high - candle.low
  return {
    body,
    range,
    upperWick: candle.high - Math.max(candle.open, candle.close),
    lowerWick: Math.min(candle.open, candle.close) - candle.low,
    bullish: candle.close >= candle.open,
  }
}

function push(
  events: PriceActionEvent[],
  kind: PriceActionKind,
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
  index: number,
  candle: Candle,
  detail: string,
) {
  if (events.some(event => event.kind === kind && event.index === index && event.direction === direction)) return
  events.push({ kind, direction, index, time: candle.time, detail })
}

function priorRange(
  candles: Candle[],
  index: number,
): { highest: number; lowest: number } | null {
  if (index < BREAKOUT_WINDOW) return null
  let highest = -Infinity
  let lowest = Infinity
  for (let i = index - BREAKOUT_WINDOW; i < index; i += 1) {
    highest = Math.max(highest, candles[i].high)
    lowest = Math.min(lowest, candles[i].low)
  }
  return highest > lowest ? { highest, lowest } : null
}

export function analyzePriceAction(candles: Candle[], atr: number, lastPos: number): PriceAction {
  const events: PriceActionEvent[] = []
  if (!candles.length || !(atr > 0)) {
    return { events, bias: 'NEUTRAL', narrative: 'Not enough closed candles for price-action reads.' }
  }

  const start = Math.max(1, lastPos - LOOKBACK_BARS)
  const breakouts: Array<{ index: number; direction: 'BULLISH' | 'BEARISH'; level: number }> = []
  const breakoutStart = Math.max(BREAKOUT_WINDOW, lastPos - 30)
  for (let i = breakoutStart; i <= lastPos; i += 1) {
    const range = priorRange(candles, i)
    if (!range) continue
    const bar = candles[i]
    if (bar.close > range.highest) breakouts.push({ index: i, direction: 'BULLISH', level: range.highest })
    if (bar.close < range.lowest) breakouts.push({ index: i, direction: 'BEARISH', level: range.lowest })
  }

  for (let i = start; i <= lastPos; i += 1) {
    const bar = candles[i]
    const previous = candles[i - 1]
    const current = shape(bar)
    const prior = shape(previous)

    // --- Engulfing ---------------------------------------------------------
    if (current.bullish && !prior.bullish
      && bar.close >= previous.open && bar.open <= previous.close
      && current.body > prior.body) {
      push(events, 'ENGULFING', 'BULLISH', i, bar, 'Bullish engulfing closes over the previous body.')
    }
    if (!current.bullish && prior.bullish
      && bar.close <= previous.open && bar.open >= previous.close
      && current.body > prior.body) {
      push(events, 'ENGULFING', 'BEARISH', i, bar, 'Bearish engulfing closes under the previous body.')
    }

    // --- Pin bar -----------------------------------------------------------
    if (current.range >= 0.5 * atr && current.lowerWick >= 2 * current.body
      && current.lowerWick >= 0.6 * current.range && current.upperWick <= 0.25 * current.range) {
      push(events, 'PIN_BAR', 'BULLISH', i, bar, 'Bullish pin bar rejects the lows.')
    }
    if (current.range >= 0.5 * atr && current.upperWick >= 2 * current.body
      && current.upperWick >= 0.6 * current.range && current.lowerWick <= 0.25 * current.range) {
      push(events, 'PIN_BAR', 'BEARISH', i, bar, 'Bearish pin bar rejects the highs.')
    }

    // --- Rejection ---------------------------------------------------------
    if (current.range >= 0.6 * atr && current.lowerWick >= 0.5 * current.range
      && bar.close >= bar.low + 0.6 * current.range) {
      push(events, 'REJECTION', 'BULLISH', i, bar, 'Long lower wick rejected by a strong close.')
    }
    if (current.range >= 0.6 * atr && current.upperWick >= 0.5 * current.range
      && bar.close <= bar.high - 0.6 * current.range) {
      push(events, 'REJECTION', 'BEARISH', i, bar, 'Long upper wick rejected by a weak close.')
    }

    // --- Inside / outside bar ---------------------------------------------
    if (bar.high < previous.high && bar.low > previous.low) {
      push(events, 'INSIDE_BAR', 'NEUTRAL', i, bar, 'Inside bar compresses inside the previous range.')
    }
    if (bar.high > previous.high && bar.low < previous.low) {
      push(events, 'OUTSIDE_BAR', current.bullish ? 'BULLISH' : 'BEARISH', i, bar, 'Outside bar expands both sides of the range.')
    }

    // --- Strong candle close ----------------------------------------------
    if (current.body >= 0.65 * atr && current.range > 0) {
      const closePosition = (bar.close - bar.low) / current.range
      if (current.bullish && closePosition >= 0.75) {
        push(events, 'STRONG_CLOSE', 'BULLISH', i, bar, 'Strong bullish close in the top quarter of the bar range.')
      }
      if (!current.bullish && closePosition <= 0.25) {
        push(events, 'STRONG_CLOSE', 'BEARISH', i, bar, 'Strong bearish close in the bottom quarter of the bar range.')
      }
    }

    // --- Breakout / retest / failed breakout ------------------------------
    const breakout = breakouts.find(item => item.index === i)
    if (breakout && current.body >= 0.4 * atr) {
      push(
        events,
        'BREAKOUT',
        breakout.direction,
        i,
        bar,
        `${breakout.direction === 'BULLISH' ? 'Bullish' : 'Bearish'} breakout of the ${BREAKOUT_WINDOW}-bar range.`,
      )
    }

    const range = priorRange(candles, i)
    if (range) {
      // A failed breakout needs a real probe beyond the level *and* a close
      // back inside on an opposite-colour bar. Without both conditions, every
      // wick high in a healthy uptrend would be mislabelled as a failure.
      const probe = 0.05 * atr
      if (bar.high > range.highest + probe && bar.close < range.highest && bar.close < bar.open) {
        push(events, 'FAILED_BREAKOUT', 'BEARISH', i, bar, 'Bullish breakout failed and closed back inside the range.')
      }
      if (bar.low < range.lowest - probe && bar.close > range.lowest && bar.close > bar.open) {
        push(events, 'FAILED_BREAKOUT', 'BULLISH', i, bar, 'Bearish breakout failed and closed back inside the range.')
      }
    }

    const priorBreakout = [...breakouts].reverse().find(item => item.index < i && i - item.index <= 10)
    if (priorBreakout) {
      const tolerance = 0.25 * atr
      if (priorBreakout.direction === 'BULLISH'
        && bar.low <= priorBreakout.level + tolerance
        && bar.close > priorBreakout.level
        && current.bullish) {
        push(events, 'RETEST', 'BULLISH', i, bar, 'Retest of the broken range high held as support.')
      }
      if (priorBreakout.direction === 'BEARISH'
        && bar.high >= priorBreakout.level - tolerance
        && bar.close < priorBreakout.level
        && !current.bullish) {
        push(events, 'RETEST', 'BEARISH', i, bar, 'Retest of the broken range low held as resistance.')
      }
    }
  }

  const recent = events.filter(event => event.index >= lastPos - 3)
  const latestDirectional = [...events].reverse().find(event => event.direction !== 'NEUTRAL')
  let bias: PriceAction['bias'] = 'NEUTRAL'
  if (latestDirectional && lastPos - latestDirectional.index <= 2) {
    bias = latestDirectional.direction
  } else {
    const bull = recent.filter(event => event.direction === 'BULLISH').length
    const bear = recent.filter(event => event.direction === 'BEARISH').length
    bias = bull > bear ? 'BULLISH' : bear > bull ? 'BEARISH' : 'NEUTRAL'
  }

  const last = [...events].reverse().find(event => event.index >= lastPos - 3)
  const narrative = last
    ? `${last.detail} (${last.kind.replace(/_/g, ' ').toLowerCase()})`
    : 'No decisive price-action pattern on the latest closed bars.'

  return {
    events: events.slice(-12),
    bias,
    narrative,
  }
}

/** Exposed for deterministic tests of the price-action weighting. */
export function priceActionPointsForTest(
  direction: 'BUY' | 'SELL',
  events: PriceActionEvent[],
  lastPos: number,
): number {
  const wanted = direction === 'BUY' ? 'BULLISH' : 'BEARISH'
  const matching = [...events].reverse().filter(event => event.direction === wanted && event.kind !== 'INSIDE_BAR')
  if (!matching.length) return 0
  const latest = matching[0]
  if (lastPos - latest.index <= 1) return 10
  if (lastPos - latest.index <= 3) return 7
  if (lastPos - latest.index <= 6) return 4
  return 0
}
