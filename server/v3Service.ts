/**
 * V3 PRO analysis and scanner service.
 *
 * The Pro plan gate, one-active-signal-per-slot rule, duplicate protection and
 * persistence all live on the server. The browser cannot run V3 directly, skip
 * the slot rule or write a signal that was never validated.
 *
 * V3 has no daily counters: analyses, signals and scans are unlimited. The
 * usage table is still updated for diagnostics.
 */

import { evaluateV3 } from '../src/v3/engine.ts'
import { advanceSignalV3 } from '../src/v3/lifecycle.ts'
import type { Candle, ProRiskProfile, ScanResult, ScanSetup, Signal, StrategyName, Timeframe, V3Analysis } from '../src/v3/types.ts'
import { STRATEGY_LABELS, V3_STRATEGY, v3PlanAllowed } from '../src/v3/types.ts'
import { isTimeframe } from '../src/v1/types.ts'
import type { Plan, UserRow } from './db.ts'
import { HttpError } from './http.ts'
import { MARKET_SYMBOLS, fetchCandles, isMarketSymbol } from './marketData.ts'
import {
  bestSetups,
  findActiveFor,
  findOpen,
  findOpenFor,
  getUsage,
  history,
  historyItems,
  isDuplicateBar,
  latestSignal,
  purgeHistory,
  recordAnalysis,
  recordScans,
  saveSignal,
  updateSignal,
  utcDay,
  type V3Usage,
} from './v3Store.ts'

export function v3Allowed(plan: Plan): boolean {
  return v3PlanAllowed(plan)
}

function assertV3Plan(plan: Plan): void {
  if (!v3Allowed(plan)) {
    throw new HttpError(403, 'Pro Strategy is available on the Pro plan only. Upgrade to Pro to unlock it.')
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

function normaliseStrategy(value: unknown): StrategyName | undefined {
  if (value === undefined || value === null || value === '' || value === 'AUTO') return undefined
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(STRATEGY_LABELS, value)) {
    throw new HttpError(400, 'Choose Auto or a valid Pro playbook.')
  }
  return value as StrategyName
}

function normaliseRiskProfile(value: unknown): ProRiskProfile {
  if (value === undefined || value === null || value === '') return 'MEDIUM'
  if (value === 'LOW' || value === 'MEDIUM' || value === 'HIGH') return value
  throw new HttpError(400, 'Risk profile must be LOW, MEDIUM or HIGH.')
}

function decorate(
  analysis: V3Analysis,
  usage: V3Usage,
  extras: {
    best: Signal[]
    open: Signal[]
    history: V3Analysis['history']
    existingActive?: Signal | null
    provider: string
    notes?: string[]
  },
): V3Analysis {
  return {
    ...analysis,
    remainingAnalyses: -1,
    remainingSignals: -1,
    remainingBestSetups: -1,
    remainingScans: -1,
    bestSetups: extras.best,
    openSignals: extras.open,
    history: extras.history,
    existingActive: extras.existingActive ?? null,
    provider: extras.provider,
    dataNotes: [...analysis.dataNotes, ...(extras.notes ?? [])],
    chartCandles: analysis.chartCandles,
  }
}

function blocked(analysis: V3Analysis, reason: string, now: number, existingActive: Signal | null): V3Analysis {
  return {
    ...analysis,
    action: 'NO_SIGNAL',
    signal: null,
    levels: null,
    score: { ...analysis.score, band: 'NO_SIGNAL' },
    existingActive,
    reason,
    generatedAt: now,
    chartCandles: analysis.chartCandles,
  }
}

/** Refresh every open setup for the requested market from the same candle set. */
async function refreshOpen(
  userId: string,
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  now: number,
): Promise<void> {
  for (const open of await findOpenFor(userId, symbol, timeframe)) {
    const updated = advanceSignalV3(open, candles, now)
    if (updated !== open) await updateSignal(updated)
  }
}

export async function runV3Analysis(user: UserRow, body: Record<string, unknown>): Promise<V3Analysis> {
  assertV3Plan(user.plan)
  const symbol = normaliseSymbol(body.symbol)
  const timeframe = normaliseTimeframe(body.timeframe)
  const strategy = normaliseStrategy(body.playbook)
  const riskProfile = normaliseRiskProfile(body.riskProfile)
  const now = Date.now()
  const day = utcDay(now)

  await purgeHistory(user.id, now)
  await getUsage(user.id, day, now)

  const data = await fetchCandles(symbol, timeframe)
  const lastCandle = data.candles[data.candles.length - 1]
  if (!lastCandle) throw new HttpError(502, 'No closed candles were returned for this market.')

  await refreshOpen(user.id, symbol, timeframe, data.candles, now)

  const usage = await recordAnalysis(user.id, day, now)
  const analysis = evaluateV3({ symbol, timeframe, candles: data.candles, now, strategy, riskProfile })
  analysis.chartCandles = data.candles
  const [active, currentBest, currentOpen, recent] = await Promise.all([
    findActiveFor(user.id, symbol, timeframe),
    bestSetups(user.id, day),
    findOpen(user.id, now),
    history(user.id, now),
  ])
  const extras = {
    best: currentBest,
    open: currentOpen,
    history: historyItems(recent),
    existingActive: active,
    provider: data.provider,
  }
  const base = decorate(analysis, usage, extras)

  if (analysis.action === 'NO_SIGNAL' || !analysis.signal) return base

  const last = await latestSignal(user.id, symbol, timeframe)
  if (last && isDuplicateBar(last, lastCandle.time, timeframe)) {
    return decorate(
      blocked(
        base,
        `Duplicate setup: ${symbol} ${timeframe} already produced a signal on this candle or inside the 3-bar cooldown. Wait for a new closed candle.`,
        now,
        active,
      ),
      usage,
      { ...extras, existingActive: active },
    )
  }

  if (active) {
    return decorate(
      blocked(
        base,
        `One active signal per setup: ${symbol} ${timeframe} already has an ACTIVE ${active.direction} ${active.strategyName.replace(/_/g, ' ').toLowerCase()}. The slot unlocks after TP1 or when the runner is resolved.`,
        now,
        active,
      ),
      usage,
      { ...extras, existingActive: active },
    )
  }

  try {
    const saved = await saveSignal(user.id, analysis.signal, day, now)
    const [savedBest, open, savedHistory] = await Promise.all([
      bestSetups(user.id, day),
      findOpen(user.id, now),
      history(user.id, now),
    ])
    return decorate(
      { ...analysis, signal: analysis.signal, existingActive: null },
      saved,
      {
        best: savedBest,
        open,
        history: historyItems(savedHistory),
        existingActive: null,
        provider: data.provider,
      },
    )
  } catch (error) {
    const raced = await latestSignal(user.id, symbol, timeframe)
    if (raced && isDuplicateBar(raced, lastCandle.time, timeframe)) {
      return decorate(
        blocked(base, `Duplicate setup: ${symbol} ${timeframe} was saved by another request on this candle.`, now, active),
        usage,
        { ...extras, existingActive: active },
      )
    }
    const racedActive = await findActiveFor(user.id, symbol, timeframe)
    if (racedActive) {
      return decorate(
        blocked(
          base,
          `One active signal per setup: another request already opened an ACTIVE ${racedActive.direction} on ${symbol} ${timeframe}. The slot unlocks after TP1.`,
          now,
          racedActive,
        ),
        usage,
        { ...extras, existingActive: racedActive },
      )
    }
    throw error
  }
}

async function scanChunk(
  symbols: string[],
  timeframe: Timeframe,
  now: number,
  strategy: StrategyName | undefined,
  riskProfile: ProRiskProfile,
): Promise<Array<{ symbol: string; analysis: V3Analysis } | { symbol: string; error: string }>> {
  return Promise.all(symbols.map(async symbol => {
    try {
      const data = await fetchCandles(symbol, timeframe)
      return { symbol, analysis: evaluateV3({ symbol, timeframe, candles: data.candles, now, strategy, riskProfile }) }
    } catch (error) {
      return {
        symbol,
        error: error instanceof Error ? error.message : 'Market data is unavailable.',
      }
    }
  }))
}

export async function runV3Scan(user: UserRow, body: Record<string, unknown>): Promise<ScanResult> {
  assertV3Plan(user.plan)
  const timeframe = normaliseTimeframe(body.timeframe)
  const strategy = normaliseStrategy(body.playbook)
  const riskProfile = normaliseRiskProfile(body.riskProfile)
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
    for (const symbol of symbols) {
      if (!isMarketSymbol(symbol)) throw new HttpError(400, `Unsupported market: ${symbol}`)
    }
  } else {
    symbols = Object.keys(MARKET_SYMBOLS)
  }

  await purgeHistory(user.id, now)
  const before = await getUsage(user.id, day, now)

  const notes: string[] = []
  const setups: ScanSetup[] = []
  let evaluated = 0

  for (let index = 0; index < symbols.length; index += 4) {
    const chunk = symbols.slice(index, index + 4)
    const results = await scanChunk(chunk, timeframe, now, strategy, riskProfile)
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
        strategyName: analysis.strategyName,
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
  const [best, open, recentSignals] = await Promise.all([
    bestSetups(user.id, day),
    findOpen(user.id, now),
    history(user.id, now),
  ])
  const recent = historyItems(recentSignals)

  const decorated = setups
    .map(setup => ({
      ...setup,
      analysis: decorate(
        setup.analysis,
        usage,
        { best, open, history: recent, existingActive: null, provider: 'Yahoo Finance', notes: [] },
      ),
    }))
    .sort((left, right) => {
      const leftAction = left.action === 'NO_SIGNAL' ? 1 : 0
      const rightAction = right.action === 'NO_SIGNAL' ? 1 : 0
      return leftAction - rightAction || right.score - left.score
    })

  return {
    strategy: V3_STRATEGY,
    timeframe,
    scannedAt: now,
    scanned: evaluated,
    setups: decorated,
    remainingScans: -1,
    provider: 'Yahoo Finance',
    notes,
  }
}
