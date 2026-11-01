/**
 * Price-action confirmation for V2 PLUS.
 *
 * Price action is intentionally *confirmation*, not a hard requirement: the
 * engine gives it a small score weight and never rejects a structurally valid
 * setup just because no candle pattern printed. Every pattern is evaluated on a
 * closed bar, so it is final once that bar closes.
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
  if (events.some(event => event.kind === kind && event.index === index)) return
  events.push({ kind, direction, index, time: candle.time, detail })
}

function breakoutLevel(
  candles: Candle[],
  index: number,
): { direction: 'BULLISH' | 'BEARISH'; level: number } | null {
  if (index < BREAKOUT_WINDOW) return null
  let highest = -Infinity
  let lowest = Infinity
  for (let i = index - BREAKOUT_WINDOW; i < index; i += 1) {
    highest = Math.max(highest, candles[i].high)
    lowest = Math.min(lowest, candles[i].low)
  }
  const bar = candles[index]
  if (bar.close > highest) return { direction: 'BULLISH', level: highest }
  if (bar.close < lowest) return { direction: 'BEARISH', level: lowest }
  return null
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
    const level = breakoutLevel(candles, i)
    if (level) breakouts.push({ index: i, ...level })
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

    // --- Breakout / retest -------------------------------------------------
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
    ? `${last.detail} (${last.kind.replace('_', ' ').toLowerCase()})`
    : 'No decisive price-action pattern on the latest closed bars.'

  return {
    events: events.slice(-8),
    bias,
    narrative,
  }
}
