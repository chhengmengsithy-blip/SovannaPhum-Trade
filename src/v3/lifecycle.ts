/**
 * V3 PRO signal lifecycle.
 *
 *  * TP1 closes 50% of the position, then the runner is protected at breakeven
 *    plus costs.
 *  * `lastEvaluatedBar` makes every processed candle final, so a refresh can
 *    never replay a bar that has already been resolved.
 *  * A bar that touches both the stop and a target resolves as a stop, the
 *    conservative assumption for a closed-candle strategy.
 *
 * The symbol+timeframe slot is considered unlocked once the status is no longer
 * ACTIVE (TP1 or later); the service enforces that rule.
 */

import type { Candle, Signal, SignalStatus } from './types.ts'

const TERMINAL_STATUSES: ReadonlySet<SignalStatus> = new Set([
  'TP3_HIT',
  'STOP_LOSS_HIT',
  'CLOSED',
  'CANCELLED',
])

export function isTerminalV3(signal: Signal): boolean {
  return TERMINAL_STATUSES.has(signal.status) || signal.closedFraction >= 1
}

export function activeStopV3(signal: Signal): number {
  return signal.currentStopLoss ?? signal.levels.stopLoss
}

/** One ACTIVE signal per symbol+timeframe; TP1 and later unlock the slot. */
export function slotUnlockedV3(signal: Signal): boolean {
  return signal.status !== 'ACTIVE'
}

export function advanceSignalV3(signal: Signal, candles: Candle[], now = Date.now()): Signal {
  if (isTerminalV3(signal) || !candles.length) return signal

  let current = signal
  let changed = false
  let evaluated = current.lastEvaluatedBar ?? current.barTime

  const ordered = [...candles].sort((left, right) => left.time - right.time)

  for (const candle of ordered) {
    if (!(candle.time > evaluated)) continue
    evaluated = candle.time
    const { high, low } = candle
    const buy = current.direction === 'BUY'
    const stop = activeStopV3(current)
    const atTarget = (level: number | null) => level !== null && (buy ? high >= level : low <= level)
    const atStop = buy ? low <= stop : high >= stop

    // Conservative: a stop inside the bar wins over any target in the same bar.
    if (atStop) {
      current = {
        ...current,
        status: 'STOP_LOSS_HIT',
        updatedAt: now,
        closedFraction: 1,
        lastEvaluatedBar: evaluated,
      }
      changed = true
      break
    }

    if (current.status === 'ACTIVE') {
      if (atTarget(current.levels.tp1)) {
        const hasTp3 = current.levels.tp3 !== null
        const hasTp2 = current.levels.tp2 !== null
        let status: SignalStatus = 'TP1_HIT'
        let closed = 0.5
        if (hasTp2 && atTarget(current.levels.tp2)) {
          status = 'TP2_HIT'
          closed = hasTp3 ? 0.8 : 1
          if (hasTp3 && atTarget(current.levels.tp3)) {
            status = 'TP3_HIT'
            closed = 1
          }
        }
        current = {
          ...current,
          status,
          updatedAt: now,
          currentStopLoss: current.levels.breakevenStop,
          breakevenApplied: true,
          closedFraction: closed,
          lastEvaluatedBar: evaluated,
        }
        changed = true
        if (isTerminalV3(current)) break
      } else {
        current = { ...current, lastEvaluatedBar: evaluated }
      }
      continue
    }

    if (current.status === 'TP1_HIT') {
      if (atTarget(current.levels.tp3)) {
        current = { ...current, status: 'TP3_HIT', updatedAt: now, closedFraction: 1, lastEvaluatedBar: evaluated }
        changed = true
        break
      }
      if (atTarget(current.levels.tp2)) {
        const closesAll = current.levels.tp3 === null
        current = {
          ...current,
          status: 'TP2_HIT',
          updatedAt: now,
          closedFraction: closesAll ? 1 : 0.8,
          lastEvaluatedBar: evaluated,
        }
        changed = true
        if (isTerminalV3(current)) break
      } else {
        current = { ...current, lastEvaluatedBar: evaluated }
      }
      continue
    }

    if (current.status === 'TP2_HIT') {
      if (atTarget(current.levels.tp3)) {
        current = { ...current, status: 'TP3_HIT', updatedAt: now, closedFraction: 1, lastEvaluatedBar: evaluated }
        changed = true
        break
      }
      current = { ...current, lastEvaluatedBar: evaluated }
    }
  }

  return changed ? current : signal
}
