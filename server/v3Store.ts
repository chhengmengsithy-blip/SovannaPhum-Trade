/**
 * Durable V3 PRO usage and signal state.
 *
 * V3 is stored in its own tables so V1 and V2 counters/signals are untouched.
 * Unlike V2 there are no daily caps: `v3_usage` is telemetry only. The store
 * enforces:
 *
 *  * one ACTIVE signal per user + symbol + timeframe (partial unique index);
 *  * duplicate protection on the same bar and a 3-bar cooldown;
 *  * a 365-day history retention for Pro;
 *  * a ranked best-setups list.
 *
 * The slot unlocks as soon as status leaves ACTIVE (TP1 or later). The runner
 * may stay open while a new setup is allowed.
 */

import { db, transaction } from './db.ts'
import type { Signal, SignalHistoryItem, Timeframe } from '../src/v3/types.ts'
import { V3_HISTORY_DAYS } from '../src/v3/types.ts'
import { TIMEFRAME_SECONDS } from '../src/v1/types.ts'
import { isTerminalV3 } from '../src/v3/lifecycle.ts'

export type V3Usage = {
  day: string
  analyses: number
  signals: number
  scans: number
}

type UsageRow = {
  user_id: string
  day: string
  analyses: number
  signals: number
  scans: number
  updated_at: string
}

type SignalRow = {
  signal_id: string
  user_id: string
  symbol: string
  timeframe: string
  direction: string
  status: string
  strategy: string
  bar_time: number
  score: number
  payload: string
  created_at: string
  updated_at: string
}

const OPEN_STATUSES = ['ACTIVE', 'TP1_HIT', 'TP2_HIT']

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

function dayBounds(day: string): { start: string; end: string } {
  const start = `${day}T00:00:00.000Z`
  const date = new Date(start)
  date.setUTCDate(date.getUTCDate() + 1)
  return { start, end: date.toISOString() }
}

async function ensureUsage(userId: string, day: string, now: number): Promise<void> {
  await db.prepare(
    `INSERT INTO v3_usage (user_id, day, analyses, signals, scans, updated_at)
     VALUES (?, ?, 0, 0, 0, ?)
     ON CONFLICT (user_id, day) DO NOTHING`,
  ).run(userId, day, new Date(now).toISOString())
}

export async function getUsage(userId: string, day: string, now = Date.now()): Promise<V3Usage> {
  await ensureUsage(userId, day, now)
  const row = await db
    .prepare('SELECT * FROM v3_usage WHERE user_id = ? AND day = ?')
    .get<UsageRow>(userId, day)
  return {
    day,
    analyses: row?.analyses ?? 0,
    signals: row?.signals ?? 0,
    scans: row?.scans ?? 0,
  }
}

export function recordAnalysis(userId: string, day: string, now = Date.now()): Promise<V3Usage> {
  return transaction(async () => {
    await ensureUsage(userId, day, now)
    await db.prepare(
      'UPDATE v3_usage SET analyses = analyses + 1, updated_at = ? WHERE user_id = ? AND day = ?',
    ).run(new Date(now).toISOString(), userId, day)
    return getUsage(userId, day, now)
  })
}

/** Spend scanner analyses for a multi-symbol scan (telemetry only). */
export function recordScans(userId: string, day: string, count: number, now = Date.now()): Promise<V3Usage> {
  return transaction(async () => {
    await ensureUsage(userId, day, now)
    await db.prepare(
      'UPDATE v3_usage SET scans = scans + ?, updated_at = ? WHERE user_id = ? AND day = ?',
    ).run(Math.max(0, Math.floor(count)), new Date(now).toISOString(), userId, day)
    return getUsage(userId, day, now)
  })
}

function decode(row: SignalRow): Signal | null {
  try {
    return JSON.parse(row.payload) as Signal
  } catch {
    return null
  }
}

function encode(signal: Signal): string {
  return JSON.stringify(signal)
}

function retentionCutoff(now: number): string {
  return new Date(now - V3_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

/** Remove signals older than the V3 history window. */
export async function purgeHistory(userId: string, now = Date.now()): Promise<void> {
  await db.prepare('DELETE FROM v3_signals WHERE user_id = ? AND created_at < ?').run(userId, retentionCutoff(now))
}

export async function findOpen(userId: string, now = Date.now()): Promise<Signal[]> {
  await purgeHistory(userId, now)
  const placeholders = OPEN_STATUSES.map(() => '?').join(', ')
  const rows = await db
    .prepare(
      `SELECT * FROM v3_signals
       WHERE user_id = ? AND status IN (${placeholders})
       ORDER BY created_at DESC`,
    )
    .all<SignalRow>(userId, ...OPEN_STATUSES)
  return rows
    .map(decode)
    .filter((signal): signal is Signal => signal !== null && !isTerminalV3(signal))
}

export async function findOpenFor(
  userId: string,
  symbol: string,
  timeframe: Timeframe,
): Promise<Signal[]> {
  const placeholders = OPEN_STATUSES.map(() => '?').join(', ')
  const rows = await db
    .prepare(
      `SELECT * FROM v3_signals
       WHERE user_id = ? AND symbol = ? AND timeframe = ? AND status IN (${placeholders})
       ORDER BY created_at ASC`,
    )
    .all<SignalRow>(userId, symbol.toUpperCase(), timeframe, ...OPEN_STATUSES)
  return rows
    .map(decode)
    .filter((signal): signal is Signal => signal !== null && !isTerminalV3(signal))
}

/** The one ACTIVE signal occupying this user's symbol+timeframe slot. */
export async function findActiveFor(
  userId: string,
  symbol: string,
  timeframe: Timeframe,
): Promise<Signal | null> {
  const row = await db
    .prepare(
      `SELECT * FROM v3_signals
       WHERE user_id = ? AND symbol = ? AND timeframe = ? AND status = 'ACTIVE'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get<SignalRow>(userId, symbol.toUpperCase(), timeframe)
  const signal = row ? decode(row) : null
  return signal && !isTerminalV3(signal) ? signal : null
}

export async function latestSignal(userId: string, symbol: string, timeframe: Timeframe): Promise<Signal | null> {
  const row = await db
    .prepare(
      `SELECT * FROM v3_signals
       WHERE user_id = ? AND symbol = ? AND timeframe = ?
       ORDER BY bar_time DESC, created_at DESC LIMIT 1`,
    )
    .get<SignalRow>(userId, symbol.toUpperCase(), timeframe)
  return row ? decode(row) : null
}

/** Same bar, or a repeat inside the 3-bar cooldown window. */
export function isDuplicateBar(
  last: Signal,
  barTime: number,
  timeframe: Timeframe,
): boolean {
  if (last.barTime === barTime) return true
  const cooldown = TIMEFRAME_SECONDS[timeframe] * 1000 * 3
  return barTime > last.barTime && barTime - last.barTime < cooldown
}

/** Persist a signal and record the signal telemetry atomically. */
export function saveSignal(userId: string, signal: Signal, day: string, now = Date.now()): Promise<V3Usage> {
  return transaction(async () => {
    await db.prepare(
      `INSERT INTO v3_signals
         (signal_id, user_id, symbol, timeframe, direction, status, strategy, bar_time, score, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      signal.signalId,
      userId,
      signal.symbol,
      signal.timeframe,
      signal.direction,
      signal.status,
      signal.strategyName,
      signal.barTime,
      signal.score.total,
      encode(signal),
      new Date(signal.createdAt).toISOString(),
      new Date(signal.updatedAt).toISOString(),
    )
    await ensureUsage(userId, day, now)
    await db.prepare(
      'UPDATE v3_usage SET signals = signals + 1, updated_at = ? WHERE user_id = ? AND day = ?',
    ).run(new Date(now).toISOString(), userId, day)
    return getUsage(userId, day, now)
  })
}

/** Persist lifecycle-only changes without touching the frozen trade levels. */
export async function updateSignal(signal: Signal): Promise<void> {
  await db.prepare(
    `UPDATE v3_signals
     SET status = ?, payload = ?, updated_at = ?
     WHERE signal_id = ?`,
  ).run(
    signal.status,
    encode(signal),
    new Date(signal.updatedAt).toISOString(),
    signal.signalId,
  )
}

/** Today's highest-scoring setups, best first. */
export async function bestSetups(userId: string, day: string, limit = 20): Promise<Signal[]> {
  const { start, end } = dayBounds(day)
  const rows = await db
    .prepare(
      `SELECT * FROM v3_signals
       WHERE user_id = ? AND created_at >= ? AND created_at < ?
       ORDER BY score DESC, created_at DESC
       LIMIT ?`,
    )
    .all<SignalRow>(userId, start, end, limit)
  return rows.map(decode).filter((signal): signal is Signal => signal !== null)
}

/** Signals from the retention window, newest first. */
export async function history(userId: string, now = Date.now(), limit = 200): Promise<Signal[]> {
  await purgeHistory(userId, now)
  const rows = await db
    .prepare(
      `SELECT * FROM v3_signals
       WHERE user_id = ? AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all<SignalRow>(userId, retentionCutoff(now), limit)
  return rows.map(decode).filter((signal): signal is Signal => signal !== null)
}

/** Compact rows used by the chart overlay. */
export function historyItems(signals: Signal[], limit = 120): SignalHistoryItem[] {
  return signals.slice(0, limit).map(signal => ({
    signalId: signal.signalId,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    direction: signal.direction,
    status: signal.status,
    strategyName: signal.strategyName,
    riskProfile: signal.riskProfile,
    score: signal.score.total,
    entry: signal.levels.entry,
    stopLoss: signal.currentStopLoss ?? signal.levels.stopLoss,
    tp1: signal.levels.tp1,
    tp2: signal.levels.tp2,
    tp3: signal.levels.tp3,
    barTime: signal.barTime,
  }))
}

/** Store the latest backtest report (one row per run). */
export async function saveBacktestReport(payload: unknown, now = Date.now()): Promise<void> {
  await db.prepare('INSERT INTO v3_backtests (run_at, payload) VALUES (?, ?)').run(
    new Date(now).toISOString(),
    JSON.stringify(payload),
  )
}

export async function latestBacktestReport(): Promise<unknown | null> {
  const row = await db
    .prepare('SELECT payload FROM v3_backtests ORDER BY id DESC LIMIT 1')
    .get<{ payload: string }>()
  if (!row) return null
  try {
    return JSON.parse(row.payload) as unknown
  } catch {
    return null
  }
}
