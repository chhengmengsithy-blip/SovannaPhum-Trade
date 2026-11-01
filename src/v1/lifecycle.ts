/**
 * Signal lifecycle for V1.
 *
 * A signal is advanced only by closed candles that printed after the signal's
 * own bar. A bar that touches both the stop and a target is resolved
 * conservatively as a stop. After TP1 the protective stop moves to the frozen
 * breakeven level and the single active slot is released, while TP2/TP3 continue
 * to be tracked for the same signal.
 */

import type { Candle, Signal, SignalStatus } from './types.ts'

const TERMINAL: ReadonlySet<SignalStatus> = new Set([
  'TP3_HIT',
  'STOP_LOSS_HIT',
  'CLOSED',
  'CANCELLED',
])

export function isTerminal(status: SignalStatus): boolean {
  return TERMINAL.has(status)
}

/** A status that no longer occupies the single active-signal slot. */
export function occupiesActiveSlot(status: SignalStatus): boolean {
  return status === 'ACTIVE'
}

export function activeStop(signal: Signal): number {
  return signal.currentStopLoss ?? signal.levels.stopLoss
}

export function advanceSignal(signal: Signal, candles: Candle[], now = Date.now()): Signal {
  if (isTerminal(signal.status) || !candles.length) return signal

  let current = signal
  let changed = false

  for (const candle of candles) {
    if (!(candle.time > signal.barTime)) continue
    const { high, low } = candle

    if (current.direction === 'BUY') {
      if (current.status === 'ACTIVE') {
        if (low <= activeStop(current)) {
          current = { ...current, status: 'STOP_LOSS_HIT', updatedAt: now }
          changed = true
          break
        }
        if (high >= current.levels.tp1) {
          const status: SignalStatus = current.levels.tp3 !== null && high >= current.levels.tp3
            ? 'TP3_HIT'
            : current.levels.tp2 !== null && high >= current.levels.tp2
              ? 'TP2_HIT'
              : 'TP1_HIT'
          current = {
            ...current,
            status,
            updatedAt: now,
            currentStopLoss: current.levels.breakevenStop,
            breakevenApplied: true,
          }
          changed = true
          if (isTerminal(status)) break
        }
      } else if (current.status === 'TP1_HIT') {
        if (low <= activeStop(current)) {
          current = { ...current, status: 'STOP_LOSS_HIT', updatedAt: now }
          changed = true
          break
        }
        if (current.levels.tp3 !== null && high >= current.levels.tp3) {
          current = { ...current, status: 'TP3_HIT', updatedAt: now }
          changed = true
          break
        }
        if (current.levels.tp2 !== null && high >= current.levels.tp2) {
          current = { ...current, status: 'TP2_HIT', updatedAt: now }
          changed = true
        }
      } else if (current.status === 'TP2_HIT') {
        if (low <= activeStop(current)) {
          current = { ...current, status: 'STOP_LOSS_HIT', updatedAt: now }
          changed = true
          break
        }
        if (current.levels.tp3 !== null && high >= current.levels.tp3) {
          current = { ...current, status: 'TP3_HIT', updatedAt: now }
          changed = true
          break
        }
      }
    } else {
      if (current.status === 'ACTIVE') {
        if (high >= activeStop(current)) {
          current = { ...current, status: 'STOP_LOSS_HIT', updatedAt: now }
          changed = true
          break
        }
        if (low <= current.levels.tp1) {
          const status: SignalStatus = current.levels.tp3 !== null && low <= current.levels.tp3
            ? 'TP3_HIT'
            : current.levels.tp2 !== null && low <= current.levels.tp2
              ? 'TP2_HIT'
              : 'TP1_HIT'
          current = {
            ...current,
            status,
            updatedAt: now,
            currentStopLoss: current.levels.breakevenStop,
            breakevenApplied: true,
          }
          changed = true
          if (isTerminal(status)) break
        }
      } else if (current.status === 'TP1_HIT') {
        if (high >= activeStop(current)) {
          current = { ...current, status: 'STOP_LOSS_HIT', updatedAt: now }
          changed = true
          break
        }
        if (current.levels.tp3 !== null && low <= current.levels.tp3) {
          current = { ...current, status: 'TP3_HIT', updatedAt: now }
          changed = true
          break
        }
        if (current.levels.tp2 !== null && low <= current.levels.tp2) {
          current = { ...current, status: 'TP2_HIT', updatedAt: now }
          changed = true
        }
      } else if (current.status === 'TP2_HIT') {
        if (high >= activeStop(current)) {
          current = { ...current, status: 'STOP_LOSS_HIT', updatedAt: now }
          changed = true
          break
        }
        if (current.levels.tp3 !== null && low <= current.levels.tp3) {
          current = { ...current, status: 'TP3_HIT', updatedAt: now }
          changed = true
          break
        }
      }
    }
  }

  return changed ? current : signal
}
