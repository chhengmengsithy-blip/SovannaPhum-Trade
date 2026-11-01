/**
 * V3 PRO indicator layer.
 *
 * Performance choices:
 *  * every series is calculated exactly once per analysis (`buildIndicatorSeries`);
 *  * MACD reuses the same EMA pass instead of recomputing fast/slow averages;
 *  * Bollinger uses rolling sums (O(n)) rather than re-scanning each window;
 *  * Donchian and Stochastic use monotonic deques for O(n) rolling extremes;
 *  * MFI degrades to `null` when a feed reports no volume (several FX feeds).
 *
 * No indicator ever reads a candle after the analysis index, so the snapshot is
 * final on a closed bar and cannot repaint.
 */

import { atr, ema, ewm, rsi, supertrend } from '../v1/indicators.ts'
import { TIMEFRAME_SECONDS } from '../v1/types.ts'
import type { Candle, IndicatorSnapshot, Timeframe } from './types.ts'

const NaN_ = Number.NaN

function finite(value: number | undefined | null): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Rolling standard deviation via prefix sums. */
function rollingStats(values: number[], period: number): { mean: number[]; deviation: number[] } {
  const n = values.length
  const mean = new Array<number>(n).fill(NaN_)
  const deviation = new Array<number>(n).fill(NaN_)
  let sum = 0
  let sumSquares = 0

  for (let i = 0; i < n; i += 1) {
    const value = values[i]
    if (!finite(value)) {
      sum = 0
      sumSquares = 0
      continue
    }
    sum += value
    sumSquares += value * value
    if (i >= period) {
      const outgoing = values[i - period]
      if (finite(outgoing)) {
        sum -= outgoing
        sumSquares -= outgoing * outgoing
      }
    }
    if (i >= period - 1) {
      const average = sum / period
      const variance = Math.max(0, sumSquares / period - average * average)
      mean[i] = average
      deviation[i] = Math.sqrt(variance)
    }
  }
  return { mean, deviation }
}

export type AdxSeries = {
  adx: number[]
  plusDi: number[]
  minusDi: number[]
}

/** ADX (14) with Wilder smoothing. */
export function adx(highs: number[], lows: number[], closes: number[], period = 14): AdxSeries {
  const n = closes.length
  const tr = new Array<number>(n).fill(NaN_)
  const plusDm = new Array<number>(n).fill(NaN_)
  const minusDm = new Array<number>(n).fill(NaN_)

  for (let i = 1; i < n; i += 1) {
    if (![highs[i], lows[i], closes[i], closes[i - 1]].every(finite)) continue
    const previousClose = closes[i - 1]
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - previousClose),
      Math.abs(lows[i] - previousClose),
    )
    const up = highs[i] - highs[i - 1]
    const down = lows[i - 1] - lows[i]
    plusDm[i] = up > down && up > 0 ? up : 0
    minusDm[i] = down > up && down > 0 ? down : 0
  }

  const smoothTr = ewm(tr, period)
  const smoothPlus = ewm(plusDm, period)
  const smoothMinus = ewm(minusDm, period)
  const plusDi = new Array<number>(n).fill(NaN_)
  const minusDi = new Array<number>(n).fill(NaN_)
  const dx = new Array<number>(n).fill(NaN_)

  for (let i = 0; i < n; i += 1) {
    if (!finite(smoothTr[i]) || smoothTr[i] <= 0) continue
    plusDi[i] = (100 * smoothPlus[i]) / smoothTr[i]
    minusDi[i] = (100 * smoothMinus[i]) / smoothTr[i]
    const sum = plusDi[i] + minusDi[i]
    if (sum > 0) dx[i] = (100 * Math.abs(plusDi[i] - minusDi[i])) / sum
  }

  return { adx: ewm(dx, period), plusDi, minusDi }
}

/**
 * Session VWAP (UTC anchor) with a 20-bar typical-price fallback when the feed
 * has no volume.
 */
export function vwapSeries(candles: Candle[], intervalMs: number): number[] {
  const n = candles.length
  const out = new Array<number>(n).fill(NaN_)
  const typical = candles.map(candle => (candle.high + candle.low + candle.close) / 3)
  let day = ''
  let pv = 0
  let volume = 0

  for (let i = 0; i < n; i += 1) {
    const key = new Date(candles[i].time - intervalMs).toISOString().slice(0, 10)
    if (key !== day) {
      day = key
      pv = 0
      volume = 0
    }
    const barVolume = finite(candles[i].volume) && candles[i].volume > 0 ? candles[i].volume : 0
    pv += typical[i] * barVolume
    volume += barVolume
    if (volume > 0) out[i] = pv / volume
  }

  const { mean } = rollingStats(typical, 20)
  for (let i = 0; i < n; i += 1) {
    if (!finite(out[i]) && finite(mean[i])) out[i] = mean[i]
  }
  return out
}

export type BollingerSeries = {
  upper: number[]
  middle: number[]
  lower: number[]
  width: number[]
}

/** Bollinger Bands (20, 2) with a population standard deviation. */
export function bollinger(values: number[], period = 20, multiplier = 2): BollingerSeries {
  const { mean, deviation } = rollingStats(values, period)
  const upper = new Array<number>(values.length).fill(NaN_)
  const lower = new Array<number>(values.length).fill(NaN_)
  const width = new Array<number>(values.length).fill(NaN_)

  for (let i = 0; i < values.length; i += 1) {
    if (!finite(mean[i]) || !finite(deviation[i])) continue
    upper[i] = mean[i] + multiplier * deviation[i]
    lower[i] = mean[i] - multiplier * deviation[i]
    if (mean[i] > 0) width[i] = ((upper[i] - lower[i]) / mean[i]) * 100
  }

  return { upper, middle: mean, lower, width }
}

export type StochasticSeries = {
  k: number[]
  d: number[]
}

/** Rolling extremes with a monotonic deque (O(n) instead of O(n·period)). */
function rollingExtremes(values: number[], period: number, mode: 'max' | 'min'): number[] {
  const n = values.length
  const out = new Array<number>(n).fill(NaN_)
  const deque: number[] = []
  const better = (candidate: number, current: number) => (mode === 'max' ? candidate >= current : candidate <= current)

  for (let i = 0; i < n; i += 1) {
    const value = values[i]
    if (!finite(value)) {
      deque.length = 0
      continue
    }
    while (deque.length && better(value, values[deque[deque.length - 1]])) deque.pop()
    deque.push(i)
    if (deque[0] <= i - period) deque.shift()
    if (i >= period - 1) out[i] = values[deque[0]]
  }
  return out
}

function windowSma(values: number[], period: number): number[] {
  const n = values.length
  const out = new Array<number>(n).fill(NaN_)
  const valid = new Array<boolean>(n).fill(false)
  let sum = 0
  let count = 0

  for (let i = 0; i < n; i += 1) {
    const value = values[i]
    if (finite(value)) {
      sum += value
      count += 1
      valid[i] = true
    }
    if (i >= period && valid[i - period]) {
      sum -= values[i - period]
      count -= 1
    }
    if (i >= period - 1 && count === period) out[i] = sum / period
  }
  return out
}

/** Stochastic Oscillator (14, 3, 3). */
export function stochastic(
  highs: number[],
  lows: number[],
  closes: number[],
  kPeriod = 14,
  kSmooth = 3,
  dSmooth = 3,
): StochasticSeries {
  const highest = rollingExtremes(highs, kPeriod, 'max')
  const lowest = rollingExtremes(lows, kPeriod, 'min')
  const raw = new Array<number>(closes.length).fill(NaN_)

  for (let i = 0; i < closes.length; i += 1) {
    if (!finite(highest[i]) || !finite(lowest[i]) || !finite(closes[i])) continue
    raw[i] = highest[i] === lowest[i] ? 50 : (100 * (closes[i] - lowest[i])) / (highest[i] - lowest[i])
  }

  const k = windowSma(raw, kSmooth)
  return { k, d: windowSma(k, dSmooth) }
}

export type MacdSeries = {
  /** Fast EMA and slow EMA are re-used by callers that need the raw averages. */
  fast: number[]
  slow: number[]
  macd: number[]
  signal: number[]
  histogram: number[]
}

/**
 * MACD (12/26/9) with the fast and slow EMA computed once.
 * The signal line is an EMA of the MACD line, never a second full price pass.
 */
export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdSeries {
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
  return { fast: fastLine, slow: slowLine, macd: line, signal, histogram }
}

/** Rate of Change (9) in percent. */
export function roc(values: number[], period = 9): number[] {
  const out = new Array<number>(values.length).fill(NaN_)
  for (let i = period; i < values.length; i += 1) {
    if (!finite(values[i]) || !finite(values[i - period]) || values[i - period] === 0) continue
    out[i] = (100 * (values[i] - values[i - period])) / values[i - period]
  }
  return out
}

export type DonchianSeries = {
  upper: number[]
  middle: number[]
  lower: number[]
}

/** Donchian Channels (20). */
export function donchian(highs: number[], lows: number[], period = 20): DonchianSeries {
  const upper = rollingExtremes(highs, period, 'max')
  const lower = rollingExtremes(lows, period, 'min')
  const middle = new Array<number>(highs.length).fill(NaN_)
  for (let i = 0; i < highs.length; i += 1) {
    if (finite(upper[i]) && finite(lower[i])) middle[i] = (upper[i] + lower[i]) / 2
  }
  return { upper, middle, lower }
}

/** Money Flow Index (14). `null` entries mean the feed has no volume. */
export function mfi(candles: Candle[], period = 14): Array<number | null> {
  const n = candles.length
  const out = new Array<number | null>(n).fill(null)
  const positive = new Array<number>(n).fill(0)
  const negative = new Array<number>(n).fill(0)
  const hasVolume = candles.some(candle => finite(candle.volume) && candle.volume > 0)

  for (let i = 1; i < n; i += 1) {
    const previous = (candles[i - 1].high + candles[i - 1].low + candles[i - 1].close) / 3
    const current = (candles[i].high + candles[i].low + candles[i].close) / 3
    const volume = finite(candles[i].volume) && candles[i].volume > 0 ? candles[i].volume : 0
    if (current > previous) positive[i] = current * volume
    else if (current < previous) negative[i] = current * volume
  }

  let positiveSum = 0
  let negativeSum = 0
  for (let i = 0; i < n; i += 1) {
    positiveSum += positive[i]
    negativeSum += negative[i]
    if (i >= period) {
      positiveSum -= positive[i - period]
      negativeSum -= negative[i - period]
    }
    if (i >= period && hasVolume) {
      if (positiveSum + negativeSum === 0) out[i] = 50
      else out[i] = (100 * positiveSum) / (positiveSum + negativeSum)
    }
  }
  return out
}

export type IndicatorSeries = {
  ema20: number[]
  ema50: number[]
  ema200: number[]
  rsi14: number[]
  macdLine: number[]
  macdSignal: number[]
  macdHistogram: number[]
  supertrendLine: number[]
  supertrendDirection: number[]
  atr14: number[]
  adxLine: number[]
  plusDi: number[]
  minusDi: number[]
  vwap: number[]
  bbUpper: number[]
  bbMiddle: number[]
  bbLower: number[]
  bbWidth: number[]
  stochK: number[]
  stochD: number[]
  roc9: number[]
  keltnerUpper: number[]
  keltnerMiddle: number[]
  keltnerLower: number[]
  donchianUpper: number[]
  donchianMiddle: number[]
  donchianLower: number[]
  mfi14: Array<number | null>
  volumeMa: number[]
  /** ATR / 20-bar ATR average, used by the regime classifier. */
  atrRatio: number[]
  /** Percentile rank of the current Bollinger width over the last 100 bars. */
  bbWidthPercentile: number[]
}

/** Compute every V3 indicator exactly once for one candle series. */
export function buildIndicatorSeries(candles: Candle[], timeframe: Timeframe): IndicatorSeries {
  const closes = candles.map(candle => candle.close)
  const highs = candles.map(candle => candle.high)
  const lows = candles.map(candle => candle.low)
  const volumes = candles.map(candle => (finite(candle.volume) ? Math.abs(candle.volume) : 0))

  const macdFrame = macd(closes, 12, 26, 9)
  const supertrendFrame = supertrend(highs, lows, closes, 10, 3)
  const directional = adx(highs, lows, closes, 14)
  const bands = bollinger(closes, 20, 2)
  const stoch = stochastic(highs, lows, closes, 14, 3, 3)
  const atr14 = atr(highs, lows, closes, 14)
  const atrAverage = windowSma(atr14, 20)
  const donchianFrame = donchian(highs, lows, 20)
  const atrRatio = new Array<number>(closes.length).fill(NaN_)
  for (let i = 0; i < closes.length; i += 1) {
    if (finite(atr14[i]) && finite(atrAverage[i]) && atrAverage[i] > 0) atrRatio[i] = atr14[i] / atrAverage[i]
  }

  const bbWidthPercentile = percentileRank(bands.width, 100)
  const ema20Series = ema(closes, 20)
  const keltnerUpper = new Array<number>(closes.length).fill(NaN_)
  const keltnerMiddle = new Array<number>(closes.length).fill(NaN_)
  const keltnerLower = new Array<number>(closes.length).fill(NaN_)
  for (let i = 0; i < closes.length; i += 1) {
    if (!finite(ema20Series[i]) || !finite(atr14[i])) continue
    keltnerMiddle[i] = ema20Series[i]
    keltnerUpper[i] = ema20Series[i] + 2 * atr14[i]
    keltnerLower[i] = ema20Series[i] - 2 * atr14[i]
  }

  return {
    ema20: ema20Series,
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi14: rsi(closes, 14),
    macdLine: macdFrame.macd,
    macdSignal: macdFrame.signal,
    macdHistogram: macdFrame.histogram,
    supertrendLine: supertrendFrame.line,
    supertrendDirection: supertrendFrame.direction,
    atr14,
    adxLine: directional.adx,
    plusDi: directional.plusDi,
    minusDi: directional.minusDi,
    vwap: vwapSeries(candles, TIMEFRAME_SECONDS[timeframe] * 1000),
    bbUpper: bands.upper,
    bbMiddle: bands.middle,
    bbLower: bands.lower,
    bbWidth: bands.width,
    stochK: stoch.k,
    stochD: stoch.d,
    roc9: roc(closes, 9),
    keltnerUpper,
    keltnerMiddle,
    keltnerLower,
    donchianUpper: donchianFrame.upper,
    donchianMiddle: donchianFrame.middle,
    donchianLower: donchianFrame.lower,
    mfi14: mfi(candles, 14),
    volumeMa: windowSma(volumes, 20),
    atrRatio,
    bbWidthPercentile,
  }
}

/** Percentile rank of each value within the trailing `window` values. */
function percentileRank(values: number[], window: number): number[] {
  const out = new Array<number>(values.length).fill(NaN_)
  for (let i = 0; i < values.length; i += 1) {
    if (!finite(values[i])) continue
    const start = Math.max(0, i - window + 1)
    let below = 0
    let count = 0
    for (let j = start; j <= i; j += 1) {
      if (!finite(values[j])) continue
      count += 1
      if (values[j] <= values[i]) below += 1
    }
    if (count > 20) out[i] = below / count
  }
  return out
}

/** Read one indicator snapshot, or `null` while anything core is warming up. */
export function snapshotAt(
  series: IndicatorSeries,
  candles: Candle[],
  pos: number,
): IndicatorSnapshot | null {
  const close = candles[pos]?.close
  if (!finite(close)) return null

  const core = [
    series.ema20[pos],
    series.ema50[pos],
    series.ema200[pos],
    series.rsi14[pos],
    series.macdLine[pos],
    series.macdSignal[pos],
    series.macdHistogram[pos],
    series.supertrendLine[pos],
    series.supertrendDirection[pos],
    series.atr14[pos],
    series.adxLine[pos],
    series.plusDi[pos],
    series.minusDi[pos],
    series.vwap[pos],
    series.bbUpper[pos],
    series.bbMiddle[pos],
    series.bbLower[pos],
    series.stochK[pos],
    series.stochD[pos],
    series.roc9[pos],
    series.keltnerUpper[pos],
    series.keltnerMiddle[pos],
    series.keltnerLower[pos],
    series.donchianUpper[pos],
    series.donchianMiddle[pos],
    series.donchianLower[pos],
  ]
  if (!core.every(finite)) return null
  if (!(series.atr14[pos] > 0)) return null

  const volume = finite(candles[pos]?.volume) ? candles[pos].volume : null
  const volumeMa = finite(series.volumeMa[pos]) && series.volumeMa[pos] > 0 ? series.volumeMa[pos] : null
  const volumeRatio = volume !== null && volumeMa !== null ? volume / volumeMa : null
  const mfiValue = series.mfi14[pos]

  return {
    ema20: series.ema20[pos],
    ema50: series.ema50[pos],
    ema200: series.ema200[pos],
    rsi: series.rsi14[pos],
    macd: series.macdLine[pos],
    macdSignal: series.macdSignal[pos],
    macdHistogram: series.macdHistogram[pos],
    supertrend: series.supertrendLine[pos],
    supertrendDirection: series.supertrendDirection[pos],
    atr: series.atr14[pos],
    adx: series.adxLine[pos],
    plusDi: series.plusDi[pos],
    minusDi: series.minusDi[pos],
    vwap: series.vwap[pos],
    bbUpper: series.bbUpper[pos],
    bbMiddle: series.bbMiddle[pos],
    bbLower: series.bbLower[pos],
    bbWidth: series.bbWidth[pos],
    stochK: series.stochK[pos],
    stochD: series.stochD[pos],
    roc: series.roc9[pos],
    keltnerUpper: series.keltnerUpper[pos],
    keltnerMiddle: series.keltnerMiddle[pos],
    keltnerLower: series.keltnerLower[pos],
    donchianUpper: series.donchianUpper[pos],
    donchianMiddle: series.donchianMiddle[pos],
    donchianLower: series.donchianLower[pos],
    mfi: finite(mfiValue) ? mfiValue : null,
    close,
    volume,
    volumeMa,
    volumeRatio,
    barTime: candles[pos]?.time ?? null,
  }
}

/** The 100-bar Bollinger-width percentile at a position, for scoring/regime. */
export function widthPercentileAt(series: IndicatorSeries, pos: number): number {
  const value = series.bbWidthPercentile[pos]
  return finite(value) ? value : 0.5
}

export function atrRatioAt(series: IndicatorSeries, pos: number): number {
  const value = series.atrRatio[pos]
  return finite(value) ? value : 1
}
