/**
 * Durable V2 PLUS usage and signal state.
 *
 * V2 is stored in its own tables so V1 FREE counters and signals are untouched.
 * The store owns:
 *
 *  * daily analyses / signals / scanner counters (UTC day),
 *  * duplicate protection on the same symbol + timeframe + bar,
 *  * the 30-day history retention,
 *  * the daily "best setups" ranking (top 10 by score).
 *
 * V2 allows more than one open setup, so there is no single-active-slot index.
 */

import { db, transaction } from './db.ts'
import type { Signal, Timeframe } from '../src/v2/types.ts'
import { TIMEFRAME_SECONDS } from '../src/v1/types.ts'
import { isTerminalV2 } from '../src/v2/lifecycle.ts'

export type V2Usage = {
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
    `INSERT INTO v2_usage (user_id, day, analyses, signals, scans, updated_at)
     VALUES (?, ?, 0, 0, 0, ?)
     ON CONFLICT (user_id, day) DO NOTHING`,
  ).run(userId, day, new Date(now).toISOString())
}

export async function getUsage(userId: string, day: string, now = Date.now()): Promise<V2Usage> {
  await ensureUsage(userId, day, now)
  const row = await db
    .prepare('SELECT * FROM v2_usage WHERE user_id = ? AND day = ?')
    .get<UsageRow>(userId, day)
  return {
    day,
    analyses: row?.analyses ?? 0,
    signals: row?.signals ?? 0,
    scans: row?.scans ?? 0,
  }
}

export function recordAnalysis(userId: string, day: string, now = Date.now()): Promise<V2Usage> {
  return transaction(async () => {
    await ensureUsage(userId, day, now)
    await db.prepare(
      'UPDATE v2_usage SET analyses = analyses + 1, updated_at = ? WHERE user_id = ? AND day = ?',
    ).run(new Date(now).toISOString(), userId, day)
    return getUsage(userId, day, now)
  })
}

/** Spend scanner analyses for a multi-symbol scan. */
export function recordScans(userId: string, day: string, count: number, now = Date.now()): Promise<V2Usage> {
  return transaction(async () => {
    await ensureUsage(userId, day, now)
    await db.prepare(
      'UPDATE v2_usage SET scans = scans + ?, updated_at = ? WHERE user_id = ? AND day = ?',
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

/** Remove signals older than the 30-day PLUS history window. */
export async function purgeHistory(userId: string, now = Date.now()): Promise<void> {
  const cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
  await db.prepare('DELETE FROM v2_signals WHERE user_id = ? AND created_at < ?').run(userId, cutoff)
}

export async function findOpen(userId: string, now = Date.now()): Promise<Signal[]> {
  await purgeHistory(userId, now)
  const placeholders = OPEN_STATUSES.map(() => '?').join(', ')
  const rows = await db
    .prepare(
      `SELECT * FROM v2_signals
       WHERE user_id = ? AND status IN (${placeholders})
       ORDER BY created_at DESC`,
    )
    .all<SignalRow>(userId, ...OPEN_STATUSES)
  return rows
    .map(decode)
    .filter((signal): signal is Signal => signal !== null && !isTerminalV2(signal))
}

export async function findOpenFor(
  userId: string,
  symbol: string,
  timeframe: Timeframe,
): Promise<Signal[]> {
  const placeholders = OPEN_STATUSES.map(() => '?').join(', ')
  const rows = await db
    .prepare(
      `SELECT * FROM v2_signals
       WHERE user_id = ? AND symbol = ? AND timeframe = ? AND status IN (${placeholders})
       ORDER BY created_at ASC`,
    )
    .all<SignalRow>(userId, symbol.toUpperCase(), timeframe, ...OPEN_STATUSES)
  return rows
    .map(decode)
    .filter((signal): signal is Signal => signal !== null && !isTerminalV2(signal))
}

export async function latestSignal(userId: string, symbol: string, timeframe: Timeframe): Promise<Signal | null> {
  const row = await db
    .prepare(
      `SELECT * FROM v2_signals
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

/** Persist a signal and spend one daily signal slot atomically. */
export function saveSignal(userId: string, signal: Signal, day: string, now = Date.now()): Promise<V2Usage> {
  return transaction(async () => {
    await db.prepare(
      `INSERT INTO v2_signals
         (signal_id, user_id, symbol, timeframe, direction, status, bar_time, score, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      signal.signalId,
      userId,
      signal.symbol,
      signal.timeframe,
      signal.direction,
      signal.status,
      signal.barTime,
      signal.score.total,
      encode(signal),
      new Date(signal.createdAt).toISOString(),
      new Date(signal.updatedAt).toISOString(),
    )
    await ensureUsage(userId, day, now)
    await db.prepare(
      'UPDATE v2_usage SET signals = signals + 1, updated_at = ? WHERE user_id = ? AND day = ?',
    ).run(new Date(now).toISOString(), userId, day)
    return getUsage(userId, day, now)
  })
}

/** Persist lifecycle-only changes without touching the frozen trade levels. */
export async function updateSignal(signal: Signal): Promise<void> {
  await db.prepare(
    `UPDATE v2_signals
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
export async function bestSetups(userId: string, day: string, limit = 10): Promise<Signal[]> {
  const { start, end } = dayBounds(day)
  const rows = await db
    .prepare(
      `SELECT * FROM v2_signals
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
  const cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
  const rows = await db
    .prepare(
      `SELECT * FROM v2_signals
       WHERE user_id = ? AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all<SignalRow>(userId, cutoff, limit)
  return rows.map(decode).filter((signal): signal is Signal => signal !== null)
}
