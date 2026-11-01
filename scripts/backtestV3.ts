/**
 * V3 PRO backtest harness.
 *
 * Replays real closed candles only. For every symbol/timeframe it walks the
 * series bar by bar, asks the V3 engine for a decision on a rolling window that
 * ends at that closed bar, then fills the resulting limit entry on a later bar
 * and manages it with the same 50%-at-TP1 / breakeven rule as the live
 * lifecycle.
 *
 * Every strategy is measured separately: the engine's backtest-only override
 * evaluates Trend Continuation, Breakout & Retest, Liquidity Sweep Reversal,
 * Range Mean Reversion and Volatility Expansion independently on the same
 * history. `--mode=auto` measures the live auto-selection instead, and
 * `--mode=both` runs both.
 *
 * Costs are charged on every fill:
 *   spread  — half at entry and half at exit
 *   slippage — per side
 *   commission — price units per round turn
 *
 * Usage:
 *   node scripts/backtestV3.ts
 *   node scripts/backtestV3.ts --symbols=XAUUSD,EURUSD --timeframes=1H,4H
 *   node scripts/backtestV3.ts --mode=both --replay=150 --window=320
 *
 * Nothing here invents a result: a dataset that cannot be fetched or does not
 * produce a trade is reported as such.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { evaluateV3 } from '../src/v3/engine.ts'
import type { Candle, Signal, StrategyName, Timeframe } from '../src/v3/types.ts'
import { STRATEGY_LABELS } from '../src/v3/types.ts'
import { TIMEFRAMES } from '../src/v1/types.ts'
import { MARKET_SYMBOLS, fetchCandles } from '../server/marketData.ts'
import { saveBacktestReport } from '../server/v3Store.ts'
import { closeDatabase, initializeDatabase } from '../server/db.ts'

type CostModel = {
  /** Full bid/ask spread in price units. Half is charged at each fill. */
  spread: number
  /** Commission in price units per round turn. */
  commission: number
  /** Slippage in price units per side. */
  slippage: number
}

const COSTS: Record<string, CostModel> = {
  XAUUSD: { spread: 0.3, commission: 0, slippage: 0.05 },
  XAGUSD: { spread: 0.025, commission: 0, slippage: 0.004 },
  USOIL: { spread: 0.03, commission: 0, slippage: 0.01 },
  EURUSD: { spread: 0.00012, commission: 0.00005, slippage: 0.00002 },
  GBPUSD: { spread: 0.00014, commission: 0.00005, slippage: 0.00002 },
  USDJPY: { spread: 0.012, commission: 0.005, slippage: 0.002 },
  AUDUSD: { spread: 0.00014, commission: 0.00005, slippage: 0.00002 },
  BTCUSD: { spread: 12, commission: 0, slippage: 3 },
  ETHUSD: { spread: 0.6, commission: 0, slippage: 0.15 },
  SOLUSD: { spread: 0.03, commission: 0, slippage: 0.01 },
  XRPUSD: { spread: 0.0006, commission: 0, slippage: 0.0002 },
  US100: { spread: 1.6, commission: 0, slippage: 0.4 },
}

const DEFAULT_COST: CostModel = { spread: 0.0002, commission: 0.00005, slippage: 0.00002 }

const WINDOW = 320
const MIN_HISTORY = 260
const MAX_FILL_BARS = 12
const COOLDOWN_BARS = 3
const STRATEGIES = Object.keys(STRATEGY_LABELS) as StrategyName[]

type ExitReason = 'TP3' | 'TP2' | 'BREAKEVEN' | 'STOP' | 'END'

type Trade = {
  mode: string
  symbol: string
  timeframe: Timeframe
  strategy: StrategyName
  direction: 'BUY' | 'SELL'
  score: number
  signalTime: number
  fillTime: number
  exitTime: number
  entry: number
  stopLoss: number
  tp1: number
  tp2: number | null
  tp3: number | null
  plannedRr: number
  exitReason: ExitReason
  r: number
  barsHeld: number
  costs: CostModel
}

type Metrics = {
  trades: number
  wins: number
  losses: number
  breakeven: number
  winRate: number
  grossProfitR: number
  grossLossR: number
  profitFactor: number | null
  expectancyR: number
  totalR: number
  avgR: number
  avgWinR: number
  avgLossR: number
  payoffRatio: number | null
  avgPlannedRr: number
  maxDrawdownR: number
}

function metrics(trades: Trade[]): Metrics {
  const wins = trades.filter(trade => trade.r > 0.0001)
  const losses = trades.filter(trade => trade.r < -0.0001)
  const breakeven = trades.length - wins.length - losses.length
  const grossProfit = wins.reduce((total, trade) => total + trade.r, 0)
  const grossLoss = losses.reduce((total, trade) => total + trade.r, 0)
  const totalR = trades.reduce((total, trade) => total + trade.r, 0)
  const ordered = [...trades].sort((left, right) => left.exitTime - right.exitTime)
  let equity = 0
  let peak = 0
  let maxDrawdown = 0
  for (const trade of ordered) {
    equity += trade.r
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, peak - equity)
  }
  const avgWin = wins.length ? grossProfit / wins.length : 0
  const avgLoss = losses.length ? Math.abs(grossLoss) / losses.length : 0
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven,
    winRate: trades.length ? wins.length / trades.length : 0,
    grossProfitR: grossProfit,
    grossLossR: grossLoss,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
    expectancyR: trades.length ? totalR / trades.length : 0,
    totalR,
    avgR: trades.length ? totalR / trades.length : 0,
    avgWinR: avgWin,
    avgLossR: avgLoss,
    payoffRatio: avgLoss > 0 ? avgWin / avgLoss : null,
    avgPlannedRr: trades.length
      ? trades.reduce((total, trade) => total + trade.plannedRr, 0) / trades.length
      : 0,
    maxDrawdownR: maxDrawdown,
  }
}

type SimResult = {
  fillIndex: number
  tp1Index: number | null
  exitIndex: number
  exitReason: ExitReason
  r: number
}

/**
 * Fill the limit entry after the signal and manage the position. A bar that
 * touches both the stop and a target resolves as a stop (conservative), which
 * matches the live lifecycle.
 */
function simulate(signal: Signal, candles: Candle[], signalIndex: number): SimResult | null {
  const buy = signal.direction === 'BUY'
  const levels = signal.levels
  const cost = COSTS[signal.symbol] ?? DEFAULT_COST
  const halfSpread = cost.spread / 2
  const fillWindowEnd = Math.min(candles.length - 1, signalIndex + MAX_FILL_BARS)

  let fillIndex = -1
  let fillPrice = 0
  for (let index = signalIndex + 1; index <= fillWindowEnd; index += 1) {
    const candle = candles[index]
    if (buy && candle.low <= levels.entry) {
      fillPrice = Math.min(levels.entry, candle.open) + halfSpread + cost.slippage
      fillIndex = index
      break
    }
    if (!buy && candle.high >= levels.entry) {
      fillPrice = Math.max(levels.entry, candle.open) - halfSpread - cost.slippage
      fillIndex = index
      break
    }
  }
  if (fillIndex < 0) return null

  const risk = levels.risk
  let stop = levels.stopLoss
  let remaining = 1
  let realized = 0
  let status: 'ACTIVE' | 'TP1' | 'TP2' = 'ACTIVE'
  let tp1Index: number | null = null

  const adjustedExit = (price: number) => {
    const withSpread = buy ? price - halfSpread : price + halfSpread
    return buy ? withSpread - cost.slippage : withSpread + cost.slippage
  }
  const addPortion = (fraction: number, price: number) => {
    const gross = buy ? (price - fillPrice) / risk : (fillPrice - price) / risk
    realized += fraction * (gross - cost.commission / risk)
    remaining -= fraction
  }
  const finish = (exitIndex: number, exitReason: ExitReason): SimResult => ({
    fillIndex,
    tp1Index,
    exitIndex,
    exitReason,
    r: realized,
  })

  for (let index = fillIndex; index < candles.length; index += 1) {
    const candle = candles[index]
    const stopHit = buy ? candle.low <= stop : candle.high >= stop
    if (stopHit) {
      addPortion(remaining, adjustedExit(stop))
      return finish(index, status === 'ACTIVE' ? 'STOP' : 'BREAKEVEN')
    }

    if (status === 'ACTIVE') {
      const tp1Hit = buy ? candle.high >= levels.tp1 : candle.low <= levels.tp1
      if (tp1Hit) {
        addPortion(0.5, adjustedExit(levels.tp1))
        stop = levels.breakevenStop
        status = 'TP1'
        tp1Index = index
      }
      continue
    }

    if (status === 'TP1') {
      if (levels.tp2 !== null) {
        const tp2Hit = buy ? candle.high >= levels.tp2 : candle.low <= levels.tp2
        if (tp2Hit) {
          if (levels.tp3 === null) {
            addPortion(remaining, adjustedExit(levels.tp2))
            return finish(index, 'TP2')
          }
          addPortion(0.3, adjustedExit(levels.tp2))
          status = 'TP2'
        }
      }
      continue
    }

    if (status === 'TP2' && levels.tp3 !== null) {
      const tp3Hit = buy ? candle.high >= levels.tp3 : candle.low <= levels.tp3
      if (tp3Hit) {
        addPortion(remaining, adjustedExit(levels.tp3))
        return finish(index, 'TP3')
      }
    }
  }

  addPortion(remaining, adjustedExit(candles[candles.length - 1].close))
  return finish(candles.length - 1, 'END')
}

type ReplayResult = {
  evaluations: number
  signals: number
  trades: Trade[]
}

function replay(
  all: Candle[],
  symbol: string,
  timeframe: Timeframe,
  mode: string,
  strategy: StrategyName | null,
  windowSize: number,
  replayBars: number,
): ReplayResult {
  const startIndex = Math.min(
    all.length - 1,
    Math.max(MIN_HISTORY - 1, all.length - replayBars - 1),
  )
  let evaluations = 0
  let signals = 0
  const trades: Trade[] = []
  let blockedUntil = startIndex - 1

  for (let index = startIndex; index < all.length; index += 1) {
    if (index <= blockedUntil) continue
    const from = Math.max(0, index - windowSize + 1)
    const windowCandles = all.slice(from, index + 1)
    if (windowCandles.length < MIN_HISTORY) continue
    const now = all[index].time + 1
    evaluations += 1
    const analysis = evaluateV3({
      symbol,
      timeframe,
      candles: windowCandles,
      now,
      ...(strategy ? { strategy } : {}),
    })
    if (analysis.action === 'NO_SIGNAL' || !analysis.signal) continue

    signals += 1
    blockedUntil = index + COOLDOWN_BARS
    const trade = simulate(analysis.signal, all, index)
    if (!trade) continue

    trades.push({
      mode,
      symbol,
      timeframe,
      strategy: analysis.signal.strategyName,
      direction: analysis.signal.direction,
      score: analysis.signal.score.total,
      signalTime: all[index].time,
      fillTime: all[trade.fillIndex].time,
      exitTime: all[trade.exitIndex].time,
      entry: analysis.signal.levels.entry,
      stopLoss: analysis.signal.levels.stopLoss,
      tp1: analysis.signal.levels.tp1,
      tp2: analysis.signal.levels.tp2,
      tp3: analysis.signal.levels.tp3,
      plannedRr: analysis.signal.levels.rrTp1,
      exitReason: trade.exitReason,
      r: trade.r,
      barsHeld: trade.exitIndex - trade.fillIndex,
      costs: COSTS[symbol] ?? DEFAULT_COST,
    })
    if (trade.tp1Index !== null) {
      blockedUntil = Math.max(blockedUntil, trade.tp1Index)
    } else {
      blockedUntil = Math.max(blockedUntil, trade.exitIndex)
    }
  }

  return { evaluations, signals, trades }
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find(item => item.startsWith(prefix))?.slice(prefix.length)
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function num(value: number, digits = 2): string {
  return value.toFixed(digits)
}

function factor(value: number | null): string {
  return value === null ? '∞' : value.toFixed(2)
}

type Mode = { key: string; label: string; strategy: StrategyName | null }

async function main(): Promise<void> {
  const symbols = parseList(arg('symbols'), Object.keys(MARKET_SYMBOLS))
  const timeframes = parseList(arg('timeframes'), [...TIMEFRAMES]) as Timeframe[]
  const windowSize = Math.max(MIN_HISTORY, Number(arg('window') ?? WINDOW))
  const replayBars = Math.max(1, Number(arg('replay') ?? 150))
  const modeArg = (arg('mode') ?? 'forced').toLowerCase()

  const modes: Mode[] = [
    ...(modeArg === 'auto' ? [] : STRATEGIES.map(name => ({ key: name, label: STRATEGY_LABELS[name], strategy: name }))),
    ...(modeArg === 'forced' ? [] : [{ key: 'AUTO', label: 'Auto-selected', strategy: null }]),
  ]

  const datasets: Array<{
    symbol: string
    timeframe: Timeframe
    bars: number
    from: number
    to: number
    status: 'ok' | 'error'
    notes: string[]
    runs: Array<{ mode: string; evaluations: number; signals: number; trades: number }>
  }> = []
  const trades: Trade[] = []

  for (const symbol of symbols) {
    for (const timeframe of timeframes) {
      const notes: string[] = []
      try {
        const data = await fetchCandles(symbol, timeframe)
        const all = data.candles.filter(candle => Number.isFinite(candle.close))
        if (all.length < MIN_HISTORY) {
          datasets.push({
            symbol, timeframe, bars: all.length, from: 0, to: 0,
            status: 'error', notes: [`Only ${all.length} closed candles; ${MIN_HISTORY} required`], runs: [],
          })
          continue
        }

        const runs: Array<{ mode: string; evaluations: number; signals: number; trades: number }> = []
        for (const mode of modes) {
          const result = replay(all, symbol, timeframe, mode.key, mode.strategy, windowSize, replayBars)
          trades.push(...result.trades)
          runs.push({
            mode: mode.key,
            evaluations: result.evaluations,
            signals: result.signals,
            trades: result.trades.length,
          })
        }

        const startIndex = Math.min(all.length - 1, Math.max(MIN_HISTORY - 1, all.length - replayBars - 1))
        datasets.push({
          symbol,
          timeframe,
          bars: all.length,
          from: all[startIndex].time,
          to: all[all.length - 1].time,
          status: 'ok',
          notes,
          runs,
        })
        const tradeCount = runs.reduce((total, run) => total + run.trades, 0)
        console.log(`  ${symbol} ${timeframe}: ${all.length} bars · ${modes.length} modes · ${tradeCount} trades`)
      } catch (error) {
        datasets.push({
          symbol, timeframe, bars: 0, from: 0, to: 0,
          status: 'error', notes: [error instanceof Error ? error.message : 'fetch failed'], runs: [],
        })
        console.log(`  ${symbol} ${timeframe}: error — ${datasets[datasets.length - 1].notes[0]}`)
      }
    }
  }

  const strategies = STRATEGIES
    .filter(name => modes.some(mode => mode.key === name))
    .map(name => ({
      name,
      label: STRATEGY_LABELS[name],
      metrics: metrics(trades.filter(trade => trade.mode === name)),
    }))
  const auto = modes.some(mode => mode.key === 'AUTO')
    ? { label: 'Auto-selected', metrics: metrics(trades.filter(trade => trade.mode === 'AUTO')) }
    : null
  const forcedTrades = trades.filter(trade => trade.mode !== 'AUTO')

  const report = {
    engine: 'V3_PRO',
    mode: modeArg,
    generatedAt: new Date().toISOString(),
    dataSource: 'Yahoo Finance closed candles',
    methodology: {
      window: windowSize,
      replayBars,
      maxFillBars: MAX_FILL_BARS,
      cooldownBars: COOLDOWN_BARS,
      entry: 'limit at the frozen entry zone; unfilled after the fill window is skipped',
      management: '50% at TP1, stop to breakeven plus costs, then TP2/TP3 allocations',
      conservative: 'a bar touching both the stop and a target resolves as a stop',
      strategyIsolation: 'each strategy is evaluated with the engine backtest override on identical history',
      costs: COSTS,
    },
    datasets,
    strategies,
    auto,
    combinedForced: metrics(forcedTrades),
    combinedAll: metrics(trades),
    trades,
  }

  await saveBacktestReport(report)
  const reportDirectory = 'artifacts/reports'
  const reportPath = `${reportDirectory}/backtest-v3-report.json`
  mkdirSync(reportDirectory, { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')

  const ok = datasets.filter(dataset => dataset.status === 'ok').length
  console.log(`\nV3 PRO backtest · ${ok}/${datasets.length} datasets · ${trades.length} filled trades`)
  console.log(`Window ${windowSize} bars · replay ${replayBars} bars · fill window ${MAX_FILL_BARS} bars · cooldown ${COOLDOWN_BARS}\n`)
  console.log('STRATEGY                  TRADES  WINRATE  PF     EXP R   TOTAL R  MAX DD  AVG RR  PAYOFF')
  for (const row of strategies) {
    const m = row.metrics
    console.log(
      `${row.label.padEnd(25)} ${String(m.trades).padStart(6)}  ${pct(m.winRate).padStart(7)}  ${factor(m.profitFactor).padStart(5)}  ${num(m.expectancyR).padStart(6)}  ${num(m.totalR).padStart(7)}  ${num(m.maxDrawdownR).padStart(6)}  ${num(m.avgPlannedRr).padStart(6)}  ${factor(m.payoffRatio).padStart(6)}`,
    )
  }
  if (auto) {
    const m = auto.metrics
    console.log(
      `${auto.label.padEnd(25)} ${String(m.trades).padStart(6)}  ${pct(m.winRate).padStart(7)}  ${factor(m.profitFactor).padStart(5)}  ${num(m.expectancyR).padStart(6)}  ${num(m.totalR).padStart(7)}  ${num(m.maxDrawdownR).padStart(6)}  ${num(m.avgPlannedRr).padStart(6)}  ${factor(m.payoffRatio).padStart(6)}`,
    )
  }
  const combined = report.combinedForced
  console.log(
    `${'ALL FORCED'.padEnd(25)} ${String(combined.trades).padStart(6)}  ${pct(combined.winRate).padStart(7)}  ${factor(combined.profitFactor).padStart(5)}  ${num(combined.expectancyR).padStart(6)}  ${num(combined.totalR).padStart(7)}  ${num(combined.maxDrawdownR).padStart(6)}  ${num(combined.avgPlannedRr).padStart(6)}  ${factor(combined.payoffRatio).padStart(6)}`,
  )

  const failures = datasets.filter(dataset => dataset.status === 'error')
  if (failures.length) {
    console.log('\nDatasets without data:')
    for (const failure of failures) {
      console.log(`  ${failure.symbol} ${failure.timeframe}: ${failure.notes.join('; ')}`)
    }
  }

  const empty = strategies.filter(row => row.metrics.trades === 0)
  if (empty.length) {
    console.log(`\nStrategies with no filled trade in this sample: ${empty.map(row => row.label).join(', ')}`)
  }
  console.log(`\nReport saved to ${reportPath} and the v3_backtests table.`)
}

await initializeDatabase()
try {
  await main()
} finally {
  await closeDatabase()
}
