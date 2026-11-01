/**
 * Durable V1 usage and signal state in PostgreSQL.
 *
 * The store owns the FREE daily counters, the single active-signal slot,
 * duplicate/cooldown protection and lifecycle persistence. Trade levels are
 * written once and never recomputed; only status, stop and timestamps change.
 */

import { db, transaction } from './db.ts'
import type { Signal, SignalStatus, Timeframe } from '../src/v1/types.ts'
import { TIMEFRAME_SECONDS } from '../src/v1/types.ts'

export type Usage = {
  day: string
  analyses: number
  signals: number
}

type UsageRow = {
  user_id: string
  day: string
  analyses: number
  signals: number
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
  active: number
  payload: string
  created_at: string
  updated_at: string
}

const OPEN_STATUSES: SignalStatus[] = ['ACTIVE', 'TP1_HIT', 'TP2_HIT']

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

async function ensureUsage(userId: string, day: string, now: number): Promise<void> {
  await db.prepare(
    `INSERT INTO v1_usage (user_id, day, analyses, signals, updated_at)
     VALUES (?, ?, 0, 0, ?)
     ON CONFLICT (user_id, day) DO NOTHING`,
  ).run(userId, day, new Date(now).toISOString())
}

export async function getUsage(userId: string, day: string, now = Date.now()): Promise<Usage> {
  await ensureUsage(userId, day, now)
  const row = await db
    .prepare('SELECT * FROM v1_usage WHERE user_id = ? AND day = ?')
    .get<UsageRow>(userId, day)
  return { day, analyses: row?.analyses ?? 0, signals: row?.signals ?? 0 }
}

export function recordAnalysis(userId: string, day: string, now = Date.now()): Promise<Usage> {
  return transaction(async () => {
    await ensureUsage(userId, day, now)
    await db.prepare(
      `UPDATE v1_usage SET analyses = analyses + 1, updated_at = ? WHERE user_id = ? AND day = ?`,
    ).run(new Date(now).toISOString(), userId, day)
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

export async function findActive(userId: string): Promise<Signal | null> {
  const row = await db
    .prepare('SELECT * FROM v1_signals WHERE user_id = ? AND active = 1 LIMIT 1')
    .get<SignalRow>(userId)
  return row ? decode(row) : null
}

export async function findTracked(userId: string, symbol: string, timeframe: Timeframe): Promise<Signal[]> {
  const placeholders = OPEN_STATUSES.map(() => '?').join(', ')
  const rows = await db
    .prepare(
      `SELECT * FROM v1_signals
       WHERE user_id = ? AND symbol = ? AND timeframe = ? AND status IN (${placeholders})
       ORDER BY created_at ASC`,
    )
    .all<SignalRow>(userId, symbol.toUpperCase(), timeframe, ...OPEN_STATUSES)
  return rows.map(decode).filter((signal): signal is Signal => signal !== null)
}

/** Persisted V1 signals for chart/history display, newest first. */
export async function history(userId: string, limit = 200): Promise<Signal[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM v1_signals
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all<SignalRow>(userId, limit)
  return rows.map(decode).filter((signal): signal is Signal => signal !== null)
}

export async function latestSignal(userId: string, symbol: string, timeframe: Timeframe): Promise<Signal | null> {
  const row = await db
    .prepare(
      `SELECT * FROM v1_signals
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

/** Persist a new signal and spend one daily signal slot atomically. */
export function saveSignal(userId: string, signal: Signal, day: string, now = Date.now()): Promise<Usage> {
  return transaction(async () => {
    await db.prepare(
      `INSERT INTO v1_signals
         (signal_id, user_id, symbol, timeframe, direction, status, bar_time, active, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      signal.signalId,
      userId,
      signal.symbol,
      signal.timeframe,
      signal.direction,
      signal.status,
      signal.barTime,
      signal.status === 'ACTIVE' ? 1 : 0,
      encode(signal),
      new Date(signal.createdAt).toISOString(),
      new Date(signal.updatedAt).toISOString(),
    )
    await ensureUsage(userId, day, now)
    await db.prepare(
      `UPDATE v1_usage SET signals = signals + 1, updated_at = ? WHERE user_id = ? AND day = ?`,
    ).run(new Date(now).toISOString(), userId, day)
    return getUsage(userId, day, now)
  })
}

/** Persist lifecycle-only changes without touching the frozen trade levels. */
export async function updateSignal(signal: Signal): Promise<void> {
  await db.prepare(
    `UPDATE v1_signals
     SET status = ?, active = ?, payload = ?, updated_at = ?
     WHERE signal_id = ?`,
  ).run(
    signal.status,
    signal.status === 'ACTIVE' ? 1 : 0,
    encode(signal),
    new Date(signal.updatedAt).toISOString(),
    signal.signalId,
  )
}
