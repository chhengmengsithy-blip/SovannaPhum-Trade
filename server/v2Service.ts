/**
 * V2 PLUS analysis and scanner service.
 *
 * The plan gate, daily counters, duplicate protection and persistence all live
 * here, on the server. The browser cannot run V2 directly, skip a limit or write
 * a signal that was never validated.
 */

import { evaluateV2 } from '../src/v2/engine.ts'
import { advanceSignalV2 } from '../src/v2/lifecycle.ts'
import type { Signal, Timeframe, V2Analysis, ScanResult, ScanSetup } from '../src/v2/types.ts'
import { isTimeframe } from '../src/v1/types.ts'
import {
  V2_ANALYSES_PER_DAY,
  V2_BEST_SETUPS_PER_DAY,
  V2_SCANS_PER_DAY,
  V2_SCAN_SYMBOL_LIMIT,
  V2_SIGNALS_PER_DAY,
  V2_STRATEGY,
  v2PlanAllowed,
} from '../src/v2/types.ts'
import type { Plan, UserRow } from './db.ts'
import { HttpError } from './http.ts'
import { MARKET_SYMBOLS, fetchCandles, isMarketSymbol } from './marketData.ts'
import {
  bestSetups,
  findOpen,
  findOpenFor,
  getUsage,
  isDuplicateBar,
  latestSignal,
  purgeHistory,
  recordAnalysis,
  recordScans,
  saveSignal,
  updateSignal,
  utcDay,
} from './v2Store.ts'

export {
  V2_ANALYSES_PER_DAY,
  V2_BEST_SETUPS_PER_DAY,
  V2_SCANS_PER_DAY,
  V2_SCAN_SYMBOL_LIMIT,
  V2_SIGNALS_PER_DAY,
}

export function v2Allowed(plan: Plan): boolean {
  return v2PlanAllowed(plan)
}

function assertV2Plan(plan: Plan): void {
  if (!v2Allowed(plan)) {
    throw new HttpError(403, 'Plus Strategy is available on the Plus plan. Pro accounts use Pro Strategy.')
  }
}

function normaliseTimeframe(value: unknown): Timeframe {
  if (typeof value !== 'string') throw new HttpError(400, 'Choose a timeframe.')
  const compact = value.trim()
  const upper = compact.toUpperCase()
  if (isTimeframe(compact)) return compact
  if (upper === '1H' || upper === 'H1' || upper === '60M') return '1H'
  if (upper === '4H' || upper === 'H4' || upper === '240M') return '4H'
  throw new HttpError(400, 'Timeframe must be 5m, 15m, 30m, 1H or 4H.')
}

function normaliseSymbol(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'Choose a market.')
  const symbol = value.trim().toUpperCase()
  if (!isMarketSymbol(symbol)) throw new HttpError(400, `Unsupported market: ${value}`)
  return symbol
}

function remaining(limit: number, used: number): number {
  return Math.max(0, limit - used)
}

function decorate(
  analysis: V2Analysis,
  usage: { analyses: number; signals: number; scans: number },
  extras: {
    best: Signal[]
    open: Signal[]
    provider: string
    notes?: string[]
  },
): V2Analysis {
  return {
    ...analysis,
    remainingAnalyses: remaining(V2_ANALYSES_PER_DAY, usage.analyses),
    remainingSignals: remaining(V2_SIGNALS_PER_DAY, usage.signals),
    remainingBestSetups: Math.max(0, V2_BEST_SETUPS_PER_DAY - extras.best.length),
    remainingScans: remaining(V2_SCANS_PER_DAY, usage.scans),
    bestSetups: extras.best,
    openSignals: extras.open,
    provider: extras.provider,
    dataNotes: [...analysis.dataNotes, ...(extras.notes ?? [])],
    candles: analysis.candles,
  }
}

function blocked(analysis: V2Analysis, reason: string, now: number): V2Analysis {
  return {
    ...analysis,
    action: 'NO_SIGNAL',
    signal: null,
    levels: null,
    score: { ...analysis.score, band: 'NO_SIGNAL' },
    reason,
    generatedAt: now,
    candles: analysis.candles,
  }
}

/** Refresh every open setup for the requested market from the same candle set. */
async function refreshOpen(userId: string, symbol: string, timeframe: Timeframe, candles: Parameters<typeof advanceSignalV2>[1], now: number): Promise<void> {
  for (const open of await findOpenFor(userId, symbol, timeframe)) {
    const updated = advanceSignalV2(open, candles, now)
    if (updated !== open) await updateSignal(updated)
  }
}

export async function runV2Analysis(user: UserRow, body: Record<string, unknown>): Promise<V2Analysis> {
  assertV2Plan(user.plan)
  const symbol = normaliseSymbol(body.symbol)
  const timeframe = normaliseTimeframe(body.timeframe)
  const now = Date.now()
  const day = utcDay(now)

  await purgeHistory(user.id, now)
  const before = await getUsage(user.id, day, now)
  if (before.analyses >= V2_ANALYSES_PER_DAY) {
    throw new HttpError(
      429,
      `Daily PLUS analysis limit reached (${V2_ANALYSES_PER_DAY}). It resets at 00:00 UTC.`,
    )
  }

  const data = await fetchCandles(symbol, timeframe)
  const lastCandle = data.candles[data.candles.length - 1]
  if (!lastCandle) throw new HttpError(502, 'No closed candles were returned for this market.')

  await refreshOpen(user.id, symbol, timeframe, data.candles, now)

  const usage = await recordAnalysis(user.id, day, now)
  const analysis = evaluateV2({ symbol, timeframe, candles: data.candles, now })
  analysis.candles = data.candles
  const [currentBest, currentOpen] = await Promise.all([
    bestSetups(user.id, day),
    findOpen(user.id, now),
  ])
  const base = decorate(analysis, usage, {
    best: currentBest,
    open: currentOpen,
    provider: data.provider,
  })

  if (analysis.action === 'NO_SIGNAL' || !analysis.signal) return base

  const last = await latestSignal(user.id, symbol, timeframe)
  if (last && isDuplicateBar(last, lastCandle.time, timeframe)) {
    return decorate(
      blocked(base, `Duplicate setup: ${symbol} ${timeframe} already produced a signal on this candle or inside the 3-bar cooldown. Wait for a new closed candle.`, now),
      usage,
      { best: base.bestSetups, open: base.openSignals, provider: data.provider },
    )
  }

  if (usage.signals >= V2_SIGNALS_PER_DAY) {
    return decorate(
      blocked(base, `Daily PLUS signal limit reached (${V2_SIGNALS_PER_DAY}). It resets at 00:00 UTC.`, now),
      usage,
      { best: base.bestSetups, open: base.openSignals, provider: data.provider },
    )
  }

  try {
    const saved = await saveSignal(user.id, analysis.signal, day, now)
    const [savedBest, savedOpen] = await Promise.all([
      bestSetups(user.id, day),
      findOpen(user.id, now),
    ])
    return decorate(
      { ...analysis, signal: analysis.signal },
      saved,
      {
        best: savedBest,
        open: savedOpen,
        provider: data.provider,
      },
    )
  } catch (error) {
    const raced = await latestSignal(user.id, symbol, timeframe)
    if (raced && isDuplicateBar(raced, lastCandle.time, timeframe)) {
      return decorate(
        blocked(base, `Duplicate setup: ${symbol} ${timeframe} was saved by another request on this candle.`, now),
        usage,
        { best: base.bestSetups, open: base.openSignals, provider: data.provider },
      )
    }
    throw error
  }
}

async function scanChunk(
  symbols: string[],
  timeframe: Timeframe,
  now: number,
): Promise<Array<{ symbol: string; analysis: V2Analysis } | { symbol: string; error: string }>> {
  return Promise.all(symbols.map(async symbol => {
    try {
      const data = await fetchCandles(symbol, timeframe)
      return { symbol, analysis: evaluateV2({ symbol, timeframe, candles: data.candles, now }) }
    } catch (error) {
      return {
        symbol,
        error: error instanceof Error ? error.message : 'Market data is unavailable.',
      }
    }
  }))
}

export async function runV2Scan(user: UserRow, body: Record<string, unknown>): Promise<ScanResult> {
  assertV2Plan(user.plan)
  const timeframe = normaliseTimeframe(body.timeframe)
  const now = Date.now()
  const day = utcDay(now)

  let symbols: string[]
  if (Array.isArray(body.symbols)) {
    const raw = body.symbols
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim().toUpperCase())
      .filter(Boolean)
    symbols = [...new Set(raw)]
    if (!symbols.length) throw new HttpError(400, 'Choose at least one market to scan.')
    if (symbols.length > V2_SCAN_SYMBOL_LIMIT) {
      throw new HttpError(400, `A single scan supports up to ${V2_SCAN_SYMBOL_LIMIT} symbols.`)
    }
    for (const symbol of symbols) {
      if (!isMarketSymbol(symbol)) throw new HttpError(400, `Unsupported market: ${symbol}`)
    }
  } else {
    symbols = Object.keys(MARKET_SYMBOLS).slice(0, V2_SCAN_SYMBOL_LIMIT)
  }

  await purgeHistory(user.id, now)
  const before = await getUsage(user.id, day, now)
  if (before.scans + symbols.length > V2_SCANS_PER_DAY) {
    throw new HttpError(
      429,
      `Scanner limit reached: ${V2_SCANS_PER_DAY} analyses per day across up to ${V2_SCAN_SYMBOL_LIMIT} symbols (${remaining(V2_SCANS_PER_DAY, before.scans)} left). It resets at 00:00 UTC.`,
    )
  }

  const notes: string[] = []
  const setups: ScanSetup[] = []
  let evaluated = 0

  for (let index = 0; index < symbols.length; index += 4) {
    const chunk = symbols.slice(index, index + 4)
    const results = await scanChunk(chunk, timeframe, now)
    for (const result of results) {
      if ('error' in result) {
        notes.push(`${result.symbol}: ${result.error}`)
        continue
      }
      evaluated += 1
      const analysis = result.analysis
      setups.push({
        symbol: result.symbol,
        timeframe,
        action: analysis.action,
        view: analysis.view,
        score: analysis.score.total,
        band: analysis.score.band,
        reason: analysis.reason,
        barTime: analysis.barTime,
        rrTp1: analysis.levels ? analysis.levels.rrTp1 : null,
        levels: analysis.levels,
        analysis,
      })
    }
  }

  const usage = evaluated ? await recordScans(user.id, day, evaluated, now) : before
  const [best, open] = await Promise.all([
    bestSetups(user.id, day),
    findOpen(user.id, now),
  ])

  const decorated = setups
    .map(setup => ({
      ...setup,
      analysis: decorate(
        setup.analysis,
        usage,
        { best, open, provider: 'Yahoo Finance', notes: [] },
      ),
    }))
    .sort((left, right) => {
      const leftAction = left.action === 'NO_SIGNAL' ? 1 : 0
      const rightAction = right.action === 'NO_SIGNAL' ? 1 : 0
      return leftAction - rightAction || right.score - left.score
    })

  return {
    strategy: V2_STRATEGY,
    timeframe,
    scannedAt: now,
    scanned: evaluated,
    setups: decorated,
    remainingScans: remaining(V2_SCANS_PER_DAY, usage.scans),
    provider: 'Yahoo Finance',
    notes,
  }
}
