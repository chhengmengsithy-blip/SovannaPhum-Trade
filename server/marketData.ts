/**
 * Yahoo Finance candle provider for the V1 engine.
 *
 * Yahoo returns bar OPEN timestamps and includes the still-forming final bar.
 * This module converts every bar to its CLOSE time and drops the forming bar, so
 * nothing downstream can evaluate an unclosed candle. The 4H timeframe has no
 * reliable native Yahoo interval, so it is aggregated from complete 1H buckets.
 */

import type { Candle, Timeframe } from '../src/v1/types.ts'
import { TIMEFRAME_SECONDS } from '../src/v1/types.ts'
import { HttpError } from './http.ts'

/** MAKE ticker -> Yahoo Finance symbol. */
export const MARKET_SYMBOLS: Record<string, string> = {
  XAUUSD: 'GC=F',
  XAGUSD: 'SI=F',
  USOIL: 'CL=F',
  EURUSD: 'EURUSD=X',
  GBPUSD: 'GBPUSD=X',
  USDJPY: 'USDJPY=X',
  AUDUSD: 'AUDUSD=X',
  BTCUSD: 'BTC-USD',
  ETHUSD: 'ETH-USD',
  SOLUSD: 'SOL-USD',
  XRPUSD: 'XRP-USD',
  US100: '^NDX',
}

const HOUR = 60 * 60 * 1000
const CACHE_TTL_MS = 15_000
const FETCH_TIMEOUT_MS = 9_000

type CacheEntry = { at: number; candles: Candle[] }
const cache = new Map<string, CacheEntry>()

type YahooQuote = {
  open?: Array<number | null>
  high?: Array<number | null>
  low?: Array<number | null>
  close?: Array<number | null>
  volume?: Array<number | null>
}

type YahooChart = {
  chart?: {
    result?: Array<{
      timestamp?: number[]
      indicators?: { quote?: YahooQuote[] }
      meta?: {
        regularMarketPrice?: number
        regularMarketTime?: number
        regularMarketChangePercent?: number
        chartPreviousClose?: number
        previousClose?: number
      }
    }>
    error?: { code?: string; description?: string } | null
  }
}

export function isMarketSymbol(value: unknown): value is string {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MARKET_SYMBOLS, value.toUpperCase())
}

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TIMEFRAME_SECONDS, value)
}

const liveCache = new Map<string, { at: number; price: LivePrice }>()
const liveRequests = new Map<string, Promise<LivePrice>>()
const LIVE_CACHE_TTL_MS = 4_000

export type LivePrice = {
  symbol: string
  price: number
  time: number
  change24h: number
}

/** Latest real quote published by Yahoo for the same instrument as the candles. */
export async function fetchLivePrice(symbol: string): Promise<LivePrice> {
  const upper = symbol.toUpperCase()
  const yahooSymbol = MARKET_SYMBOLS[upper]
  if (!yahooSymbol) throw new HttpError(400, `Unsupported market: ${symbol}`)

  const now = Date.now()
  const cached = liveCache.get(upper)
  if (cached && now - cached.at < LIVE_CACHE_TTL_MS) return cached.price

  // Several clients subscribing at once must not stampede Yahoo.
  const pending = liveRequests.get(upper)
  if (pending) return pending

  const request = (async (): Promise<LivePrice> => {
    try {
      // The 5d request remains available over weekends and market holidays. Yahoo's
      // `regularMarketPrice` is the current quote; unlike `normalise`, this path
      // intentionally keeps the forming market update out of strategy candles.
      const data = await fetchYahoo(yahooSymbol, '5m', '5d')
      const result = data.chart?.result?.[0]
      if (!result) throw new HttpError(502, `No recent price was returned for ${upper}.`)

      const meta = result.meta ?? {}
      const closes = result.indicators?.quote?.[0]?.close ?? []
      let latestIndex = closes.length - 1
      while (latestIndex >= 0 && !(typeof closes[latestIndex] === 'number' && Number.isFinite(closes[latestIndex]))) {
        latestIndex -= 1
      }

      const fallbackPrice = latestIndex >= 0 ? closes[latestIndex] : null
      const quotePrice = typeof meta.regularMarketPrice === 'number' && Number.isFinite(meta.regularMarketPrice)
        ? meta.regularMarketPrice
        : fallbackPrice
      if (typeof quotePrice !== 'number' || !Number.isFinite(quotePrice) || quotePrice <= 0) {
        throw new HttpError(502, `No recent price was returned for ${upper}.`)
      }

      const quoteTime = typeof meta.regularMarketTime === 'number' && Number.isFinite(meta.regularMarketTime)
        ? meta.regularMarketTime * 1000
        : latestIndex >= 0 && typeof result.timestamp?.[latestIndex] === 'number'
          ? result.timestamp[latestIndex] * 1000
          : now
      const previousClose = typeof meta.chartPreviousClose === 'number' && meta.chartPreviousClose > 0
        ? meta.chartPreviousClose
        : typeof meta.previousClose === 'number' && meta.previousClose > 0
          ? meta.previousClose
          : null
      const change24h = typeof meta.regularMarketChangePercent === 'number' && Number.isFinite(meta.regularMarketChangePercent)
        ? meta.regularMarketChangePercent
        : previousClose
          ? ((quotePrice - previousClose) / previousClose) * 100
          : 0

      const live: LivePrice = { symbol: upper, price: quotePrice, time: quoteTime, change24h }
      liveCache.set(upper, { at: now, price: live })
      return live
    } catch (error) {
      // A transient Yahoo timeout must not blank the live feed: keep serving
      // the last known quote until the next poll succeeds.
      if (cached) return cached.price
      throw error
    } finally {
      liveRequests.delete(upper)
    }
  })()

  liveRequests.set(upper, request)
  return request
}

function yahooRequest(timeframe: Timeframe): { interval: string; range: string; aggregate: boolean } {
  switch (timeframe) {
    case '5m':
      return { interval: '5m', range: '5d', aggregate: false }
    case '15m':
      return { interval: '15m', range: '1mo', aggregate: false }
    case '30m':
      return { interval: '30m', range: '1mo', aggregate: false }
    case '1H':
      return { interval: '1h', range: '1y', aggregate: false }
    case '4H':
      return { interval: '1h', range: '1y', aggregate: true }
  }
}

async function fetchYahoo(yahooSymbol: string, interval: string, range: string): Promise<YahooChart> {
  const encoded = encodeURIComponent(yahooSymbol)
  const path = `/v8/finance/chart/${encoded}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`
  let lastError = ''

  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const response = await fetch(`https://${host}${path}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SOVANNAPHUMTRADE/1.0)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) {
        lastError = `Yahoo responded ${response.status}`
        continue
      }
      return (await response.json()) as YahooChart
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'network error'
    }
  }

  throw new HttpError(502, `Market data is unavailable right now (${lastError || 'no response'}).`)
}

function normalise(data: YahooChart, intervalMs: number, now: number): Candle[] {
  const result = data.chart?.result?.[0]
  if (!result) {
    const description = data.chart?.error?.description
    throw new HttpError(502, description ? `Market data error: ${description}` : 'Market data is unavailable for this symbol.')
  }

  const timestamps = result.timestamp ?? []
  const quote = result.indicators?.quote?.[0] ?? {}
  const opens = quote.open ?? []
  const highs = quote.high ?? []
  const lows = quote.low ?? []
  const closes = quote.close ?? []
  const volumes = quote.volume ?? []

  const byTime = new Map<number, Candle>()
  for (let i = 0; i < timestamps.length; i += 1) {
    const open = opens[i]
    const high = highs[i]
    const low = lows[i]
    const close = closes[i]
    if (![open, high, low, close].every(value => typeof value === 'number' && Number.isFinite(value))) continue
    if (high! < low! || high! < Math.max(open!, close!) || low! > Math.min(open!, close!)) continue
    if (open! <= 0 || close! <= 0) continue

    const closeTime = timestamps[i] * 1000 + intervalMs
    if (closeTime > now) continue
    const volume = typeof volumes[i] === 'number' && Number.isFinite(volumes[i]) ? volumes[i]! : 0
    byTime.set(closeTime, { time: closeTime, open: open!, high: high!, low: low!, close: close!, volume })
  }

  return [...byTime.values()].sort((left, right) => left.time - right.time)
}

function aggregateFourHour(hourly: Candle[], now: number): Candle[] {
  const bucketMs = 4 * HOUR
  const groups = new Map<number, Candle[]>()
  for (const candle of hourly) {
    const openTime = candle.time - HOUR
    const bucket = Math.floor(openTime / bucketMs) * bucketMs
    const group = groups.get(bucket)
    if (group) group.push(candle)
    else groups.set(bucket, [candle])
  }

  const out: Candle[] = []
  for (const [bucket, bars] of [...groups.entries()].sort((left, right) => left[0] - right[0])) {
    if (bars.length !== 4) continue
    const closeTime = bucket + bucketMs
    if (closeTime > now) continue
    out.push({
      time: closeTime,
      open: bars[0].open,
      high: Math.max(...bars.map(bar => bar.high)),
      low: Math.min(...bars.map(bar => bar.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((total, bar) => total + bar.volume, 0),
    })
  }
  return out
}

export type CandleSet = {
  symbol: string
  timeframe: Timeframe
  candles: Candle[]
  provider: string
}

export async function fetchCandles(symbol: string, timeframe: Timeframe): Promise<CandleSet> {
  const upper = symbol.toUpperCase()
  const yahooSymbol = MARKET_SYMBOLS[upper]
  if (!yahooSymbol) throw new HttpError(400, `Unsupported market: ${symbol}`)

  const key = `${upper}|${timeframe}`
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return { symbol: upper, timeframe, candles: cached.candles, provider: `Yahoo Finance · ${yahooSymbol}` }
  }

  const request = yahooRequest(timeframe)
  const data = await fetchYahoo(yahooSymbol, request.interval, request.range)
  // 4H is built from 1H bars, so the source bar interval stays one hour.
  const sourceIntervalMs = request.aggregate ? HOUR : TIMEFRAME_SECONDS[timeframe] * 1000
  const raw = normalise(data, sourceIntervalMs, now)
  const candles = request.aggregate ? aggregateFourHour(raw, now) : raw
  if (!candles.length) {
    throw new HttpError(502, `No closed candles were returned for ${upper} on ${timeframe}.`)
  }

  cache.set(key, { at: now, candles })
  return { symbol: upper, timeframe, candles, provider: `Yahoo Finance · ${yahooSymbol}` }
}
