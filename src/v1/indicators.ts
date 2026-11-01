/**
 * Deterministic technical indicators used by the V1 FREE strategy.
 *
 * Every function returns an array aligned with the input. `NaN` means the value
 * is not defined yet (warm-up), never zero. The implementations mirror the
 * bar-by-bar formulas the reference engine used, so a value is final the moment
 * its candle closes and never repaints.
 */

const NaN_ = Number.NaN

function finite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Exponential moving average with `adjust=False` and a warm-up count. */
export function ewm(values: number[], span: number, minPeriods = span): number[] {
  if (!Number.isInteger(span) || span <= 0) throw new Error(`span must be a positive integer, got ${span}`)
  const alpha = 2 / (span + 1)
  const out = new Array<number>(values.length).fill(NaN_)
  let previous = NaN_
  let seen = 0
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]
    if (!finite(value)) continue
    previous = finite(previous) ? alpha * value + (1 - alpha) * previous : value
    seen += 1
    if (seen >= minPeriods) out[i] = previous
  }
  return out
}

export function ema(values: number[], period = 20): number[] {
  return ewm(values, period, period)
}

export function sma(values: number[], period = 20): number[] {
  const out = new Array<number>(values.length).fill(NaN_)
  let sum = 0
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]
    if (!finite(value)) {
      sum = 0
      continue
    }
    sum += value
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/** Relative Strength Index with Wilder's smoothing. */
export function rsi(values: number[], period = 14): number[] {
  const out = new Array<number>(values.length).fill(NaN_)
  const gains: number[] = new Array(values.length).fill(NaN_)
  const losses: number[] = new Array(values.length).fill(NaN_)
  for (let i = 1; i < values.length; i += 1) {
    if (!finite(values[i]) || !finite(values[i - 1])) continue
    const delta = values[i] - values[i - 1]
    gains[i] = delta > 0 ? delta : 0
    losses[i] = delta < 0 ? -delta : 0
  }
  const avgGain = ewm(gains, period, period)
  const avgLoss = ewm(losses, period, period)
  for (let i = 0; i < values.length; i += 1) {
    const gain = avgGain[i]
    const loss = avgLoss[i]
    if (!finite(gain) || !finite(loss)) continue
    if (loss === 0 && gain === 0) out[i] = 50
    else if (loss === 0) out[i] = 100
    else out[i] = 100 - 100 / (1 + gain / loss)
  }
  return out
}

export type MacdSeries = {
  macd: number[]
  signal: number[]
  histogram: number[]
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdSeries {
  if (fast >= slow) throw new Error(`fast (${fast}) must be smaller than slow (${slow})`)
  const fastLine = ema(values, fast)
  const slowLine = ema(values, slow)
  const line = new Array<number>(values.length).fill(NaN_)
  for (let i = 0; i < values.length; i += 1) {
    if (finite(fastLine[i]) && finite(slowLine[i])) line[i] = fastLine[i] - slowLine[i]
  }
  const signal = ewm(line, signalPeriod, signalPeriod)
  const histogram = new Array<number>(values.length).fill(NaN_)
  for (let i = 0; i < values.length; i += 1) {
    if (finite(line[i]) && finite(signal[i])) histogram[i] = line[i] - signal[i]
  }
  return { macd: line, signal, histogram }
}

function trueRange(highs: number[], lows: number[], closes: number[]): number[] {
  const out = new Array<number>(closes.length).fill(NaN_)
  for (let i = 1; i < closes.length; i += 1) {
    const previousClose = closes[i - 1]
    if (!finite(highs[i]) || !finite(lows[i]) || !finite(previousClose)) continue
    out[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - previousClose),
      Math.abs(lows[i] - previousClose),
    )
  }
  return out
}

/** Average True Range with Wilder's smoothing. */
export function atr(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  return ewm(trueRange(highs, lows, closes), period, period)
}

export type SupertrendSeries = {
  line: number[]
  direction: number[]
}

/**
 * Supertrend (period 10, multiplier 3 by default).
 *
 * The band flip on bar `i` reads bar `i - 1`'s close, so the value is known when
 * bar `i` closes. Both arrays stay `NaN` until the ATR seed fills.
 */
export function supertrend(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 10,
  multiplier = 3,
): SupertrendSeries {
  if (multiplier <= 0) throw new Error(`multiplier must be positive, got ${multiplier}`)
  const atrValues = atr(highs, lows, closes, period)
  const n = closes.length
  const line = new Array<number>(n).fill(NaN_)
  const direction = new Array<number>(n).fill(NaN_)
  const finalUpper = new Array<number>(n).fill(NaN_)
  const finalLower = new Array<number>(n).fill(NaN_)
  const trend = new Array<number>(n).fill(NaN_)
  let started = false

  for (let i = 0; i < n; i += 1) {
    if (!finite(atrValues[i])) continue
    const upper = (highs[i] + lows[i]) / 2 + multiplier * atrValues[i]
    const lower = (highs[i] + lows[i]) / 2 - multiplier * atrValues[i]

    if (!started) {
      finalUpper[i] = upper
      finalLower[i] = lower
      trend[i] = 1
      started = true
    } else {
      const previousClose = closes[i - 1]
      finalUpper[i] = upper < finalUpper[i - 1] || previousClose > finalUpper[i - 1]
        ? upper
        : finalUpper[i - 1]
      finalLower[i] = lower > finalLower[i - 1] || previousClose < finalLower[i - 1]
        ? lower
        : finalLower[i - 1]
      if (closes[i] > finalUpper[i]) trend[i] = 1
      else if (closes[i] < finalLower[i]) trend[i] = -1
      else trend[i] = trend[i - 1]
    }

    direction[i] = trend[i]
    line[i] = trend[i] > 0 ? finalLower[i] : finalUpper[i]
  }

  return { line, direction }
}

export type Pivot = {
  pivotPos: number
  confirmPos: number
  price: number
}

/**
 * Confirmed swing highs.
 *
 * A bar is a pivot when its high is the strict maximum of the `2 * lookback + 1`
 * bars centred on it. The pivot at position `p` only becomes knowable at
 * `p + lookback`, which is the `confirmPos` callers must respect.
 */
export function confirmedSwingHighs(highs: number[], lookback = 2): Pivot[] {
  const out: Pivot[] = []
  for (let i = lookback; i + lookback < highs.length; i += 1) {
    if (!finite(highs[i])) continue
    let pivot = true
    for (let j = i - lookback; j <= i + lookback; j += 1) {
      if (j === i) continue
      if (!finite(highs[j]) || !(highs[i] > highs[j])) {
        pivot = false
        break
      }
    }
    if (pivot) out.push({ pivotPos: i, confirmPos: i + lookback, price: highs[i] })
  }
  return out
}

/** Confirmed swing lows; the mirror of {@link confirmedSwingHighs}. */
export function confirmedSwingLows(lows: number[], lookback = 2): Pivot[] {
  const out: Pivot[] = []
  for (let i = lookback; i + lookback < lows.length; i += 1) {
    if (!finite(lows[i])) continue
    let pivot = true
    for (let j = i - lookback; j <= i + lookback; j += 1) {
      if (j === i) continue
      if (!finite(lows[j]) || !(lows[i] < lows[j])) {
        pivot = false
        break
      }
    }
    if (pivot) out.push({ pivotPos: i, confirmPos: i + lookback, price: lows[i] })
  }
  return out
}
