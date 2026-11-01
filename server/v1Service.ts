/**
 * One manual V1 analysis, end to end.
 *
 * Order matters: refresh the active signal from closed candles, count the
 * analysis, refuse a duplicate or an occupied active slot, evaluate the newest
 * closed candle, then persist a BUY/SELL only when every rule and the daily
 * signal cap allow it. The client can never skip a step because the engine runs
 * here, not in the browser.
 */

import { evaluate } from '../src/v1/engine.ts'
import { advanceSignal, occupiesActiveSlot } from '../src/v1/lifecycle.ts'
import type { Signal, Timeframe, V1Analysis } from '../src/v1/types.ts'
import { isTimeframe } from '../src/v1/types.ts'
import type { Plan, UserRow } from './db.ts'
import { HttpError } from './http.ts'
import { fetchCandles, isMarketSymbol } from './marketData.ts'
import {
  findActive,
  findTracked,
  getUsage,
  isDuplicateBar,
  latestSignal,
  recordAnalysis,
  saveSignal,
  updateSignal,
  utcDay,
} from './v1Store.ts'

export const FREE_ANALYSES_PER_DAY = 20
export const FREE_SIGNALS_PER_DAY = 3

type DailyLimits = { analyses: number; signals: number }

function limitsFor(plan: Plan): DailyLimits {
  // -1 means unlimited. Paid plans run the same deterministic engine without a
  // daily cap; the single active-signal rule still applies to every plan.
  return plan === 'free'
    ? { analyses: FREE_ANALYSES_PER_DAY, signals: FREE_SIGNALS_PER_DAY }
    : { analyses: -1, signals: -1 }
}

function remaining(limit: number, used: number): number {
  return limit < 0 ? -1 : Math.max(0, limit - used)
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

function withLimits(
  analysis: V1Analysis,
  limits: DailyLimits,
  usage: { analyses: number; signals: number },
  provider: string,
): V1Analysis {
  return {
    ...analysis,
    remainingAnalyses: remaining(limits.analyses, usage.analyses),
    remainingSignals: remaining(limits.signals, usage.signals),
    provider,
    candles: analysis.candles,
  }
}

function blockedAnalysis(
  analysis: V1Analysis,
  reason: string,
  existingActive: Signal | null,
  now: number,
): V1Analysis {
  return {
    ...analysis,
    action: 'NO_SIGNAL',
    signal: null,
    levels: null,
    score: { ...analysis.score, band: 'NO_SIGNAL' },
    reason,
    generatedAt: now,
    existingActive,
  }
}

async function refreshSignal(signal: Signal, now: number): Promise<Signal> {
  const data = await fetchCandles(signal.symbol, signal.timeframe)
  const updated = advanceSignal(signal, data.candles, now)
  if (updated !== signal) await updateSignal(updated)
  return updated
}

export async function runV1Analysis(user: UserRow, body: Record<string, unknown>): Promise<V1Analysis> {
  const symbol = normaliseSymbol(body.symbol)
  const timeframe = normaliseTimeframe(body.timeframe)
  const now = Date.now()
  const day = utcDay(now)
  const limits = limitsFor(user.plan)

  const before = await getUsage(user.id, day, now)
  if (limits.analyses >= 0 && before.analyses >= limits.analyses) {
    throw new HttpError(
      429,
      `Daily FREE analysis limit reached (${limits.analyses}). It resets at 00:00 UTC, or upgrade for unlimited analyses.`,
    )
  }

  // A new analysis is always based on fresh closed candles for the requested
  // market. This also fails fast for an upstream outage.
  const data = await fetchCandles(symbol, timeframe)
  const lastCandle = data.candles[data.candles.length - 1]
  if (!lastCandle) throw new HttpError(502, 'No closed candles were returned for this market.')

  // Advance the active signal from its own market first. This is what releases
  // the single slot once TP1 has been reached, even when the user is now
  // analysing a different market.
  let active = await findActive(user.id)
  let unlockedNote = ''
  if (active) {
    try {
      const refreshed = await refreshSignal(active, now)
      if (!occupiesActiveSlot(refreshed.status)) {
        unlockedNote = `${refreshed.symbol} ${refreshed.timeframe} ${refreshed.direction} reached TP1 — the active slot is now open.`
      }
    } catch {
      // Keep the active signal if its market data cannot be refreshed. Blocking
      // is safer than silently freeing a slot that may still be in play.
    }
  }

  // Keep TP2/TP3 runners on this market alive as well.
  for (const tracked of await findTracked(user.id, symbol, timeframe)) {
    if (active && tracked.signalId === active.signalId && active.symbol === symbol && active.timeframe === timeframe) {
      continue
    }
    const updated = advanceSignal(tracked, data.candles, now)
    if (updated !== tracked) await updateSignal(updated)
  }

  active = await findActive(user.id)
  const usage = await recordAnalysis(user.id, day, now)
  const analysis = evaluate({ symbol, timeframe, candles: data.candles, now })
  analysis.candles = data.candles
  const base = {
    ...withLimits(analysis, limits, usage, data.provider),
    dataNotes: [...analysis.dataNotes, ...(unlockedNote ? [unlockedNote] : [])],
    candles: data.candles,
  }

  if (active) {
    return blockedAnalysis(
      base,
      `An active ${active.direction} setup on ${active.symbol} ${active.timeframe} is still open. Free Strategy keeps one active setup at a time; a new setup unlocks after TP1 is hit.`,
      active,
      now,
    )
  }

  const last = await latestSignal(user.id, symbol, timeframe)
  if (last && isDuplicateBar(last, lastCandle.time, timeframe)) {
    return blockedAnalysis(
      base,
      `Duplicate setup: ${symbol} ${timeframe} already produced a signal on this candle. Wait for a new closed candle before analysing again.`,
      last.status === 'ACTIVE' ? last : null,
      now,
    )
  }

  if (analysis.action === 'NO_SIGNAL' || !analysis.signal) {
    return base
  }

  if (limits.signals >= 0 && usage.signals >= limits.signals) {
    return blockedAnalysis(
      base,
      `Daily FREE signal limit reached (${limits.signals} valid signals). It resets at 00:00 UTC, or upgrade for unlimited signals.`,
      null,
      now,
    )
  }

  try {
    const savedUsage = await saveSignal(user.id, analysis.signal, day, now)
    return {
      ...analysis,
      signal: analysis.signal,
      remainingAnalyses: remaining(limits.analyses, savedUsage.analyses),
      remainingSignals: remaining(limits.signals, savedUsage.signals),
      provider: data.provider,
      candles: data.candles,
    }
  } catch (error) {
    // The partial unique index enforces one active signal even if two requests
    // race. Re-read the winner and return it instead of a 500.
    const winner = await findActive(user.id)
    if (winner) {
      return blockedAnalysis(base, 'Another active setup was created at the same time. Free Strategy keeps one active setup at a time.', winner, now)
    }
    throw error
  }
}
