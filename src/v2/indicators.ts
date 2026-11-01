/**
 * V2 PLUS indicator layer.
 *
 * The V2 engine needs eleven indicator families. Recomputing each one at every
 * call site (as a naive port would) is wasteful, so `buildIndicatorSeries`
 * calculates every array exactly once per analysis and `snapshotAt` reads a
 * single index from that cache. No indicator ever looks at a future candle.
 *
 * V1's deterministic primitives (EMA, RSI, MACD, ATR, Supertrend and the
 * confirmed-pivot scanners) are imported read-only. Nothing here mutates V1.
 */

import { atr, ema, ewm, macd, rsi, sma, supertrend } from '../v1/indicators.ts'
import type { Candle, IndicatorSnapshot, Timeframe } from './types.ts'
import { TIMEFRAME_SECONDS } from '../v1/types.ts'

const NaN_ = Number.NaN

function finite(value: number | undefined | null): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** SMA that only emits a value when the whole window is finite. */
function windowSma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN_)
  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0
    let ok = true
    for (let j = i - period + 1; j <= i; j += 1) {
      if (!finite(values[j])) {
        ok = false
        break
      }
      sum += values[j]
    }
    if (ok) out[i] = sum / period
  }
  return out
}

export type AdxSeries = {
  adx: number[]
  plusDi: number[]
  minusDi: number[]
}

/**
 * Average Directional Index (14) with Wilder-style smoothing.
 *
 * The DI lines answer "which side is stronger" while ADX answers "is there a
 * trend at all". The engine uses ADX only to discount a choppy trend score, so
 * it is never a mandatory confirmation on its own.
 */
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
 * Volume Weighted Average Price anchored to the UTC session.
 *
 * Yahoo returns `volume: 0` for several FX feeds. When a session has no volume,
 * the value gracefully falls back to the 20-bar typical-price mean, so the
 * indicator is still deterministic instead of disappearing.
 */
export function vwapSeries(candles: Candle[], intervalMs: number): number[] {
  const n = candles.length
  const out = new Array<number>(n).fill(NaN_)
  const typical = candles.map(candle => (candle.high + candle.low + candle.close) / 3)
  let day = ''
  let pv = 0
  let volume = 0

  for (let i = 0; i < n; i += 1) {
    const openTime = candles[i].time - intervalMs
    const key = new Date(openTime).toISOString().slice(0, 10)
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

  const fallback = windowSma(typical, 20)
  for (let i = 0; i < n; i += 1) {
    if (!finite(out[i]) && finite(fallback[i])) out[i] = fallback[i]
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
  const middle = windowSma(values, period)
  const upper = new Array<number>(values.length).fill(NaN_)
  const lower = new Array<number>(values.length).fill(NaN_)
  const width = new Array<number>(values.length).fill(NaN_)

  for (let i = period - 1; i < values.length; i += 1) {
    if (!finite(middle[i])) continue
    let variance = 0
    let ok = true
    for (let j = i - period + 1; j <= i; j += 1) {
      if (!finite(values[j])) {
        ok = false
        break
      }
      variance += (values[j] - middle[i]) ** 2
    }
    if (!ok) continue
    const deviation = Math.sqrt(variance / period)
    upper[i] = middle[i] + multiplier * deviation
    lower[i] = middle[i] - multiplier * deviation
    if (middle[i] > 0) width[i] = ((upper[i] - lower[i]) / middle[i]) * 100
  }

  return { upper, middle, lower, width }
}

export type StochasticSeries = {
  k: number[]
  d: number[]
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
  const n = closes.length
  const raw = new Array<number>(n).fill(NaN_)
  for (let i = kPeriod - 1; i < n; i += 1) {
    let highest = -Infinity
    let lowest = Infinity
    let ok = true
    for (let j = i - kPeriod + 1; j <= i; j += 1) {
      if (![highs[j], lows[j], closes[j]].every(finite)) {
        ok = false
        break
      }
      highest = Math.max(highest, highs[j])
      lowest = Math.min(lowest, lows[j])
    }
    if (!ok) continue
    raw[i] = highest === lowest ? 50 : (100 * (closes[i] - lowest)) / (highest - lowest)
  }

  const k = windowSma(raw, kSmooth)
  return { k, d: windowSma(k, dSmooth) }
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
  volumeMa: number[]
}

/** Compute every V2 indicator exactly once for one candle series. */
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

  return {
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi14: rsi(closes, 14),
    macdLine: macdFrame.macd,
    macdSignal: macdFrame.signal,
    macdHistogram: macdFrame.histogram,
    supertrendLine: supertrendFrame.line,
    supertrendDirection: supertrendFrame.direction,
    atr14: atr(highs, lows, closes, 14),
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
    volumeMa: sma(volumes, 20),
  }
}

/** Read one indicator snapshot, or `null` while anything core is still warming up. */
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
  ]
  if (!core.every(finite)) return null
  if (!(series.atr14[pos] > 0)) return null

  const volume = finite(candles[pos]?.volume) ? candles[pos].volume : null
  const volumeMa = finite(series.volumeMa[pos]) && series.volumeMa[pos] > 0 ? series.volumeMa[pos] : null
  const volumeRatio = volume !== null && volumeMa !== null ? volume / volumeMa : null

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
    close,
    volume,
    volumeMa,
    volumeRatio,
    barTime: candles[pos]?.time ?? null,
  }
}
