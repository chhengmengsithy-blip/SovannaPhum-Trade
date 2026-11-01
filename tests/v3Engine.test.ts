/**
 * Deterministic V3 PRO engine tests.
 *
 * Run with: npm run test:v3
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { evaluateV3, V3_MIN_SCORE } from '../src/v3/engine.ts'
import { advanceSignalV3, isTerminalV3, slotUnlockedV3 } from '../src/v3/lifecycle.ts'
import { evaluateStrategies } from '../src/v3/strategies.ts'
import { validateV3Candles } from '../src/v3/validate.ts'
import type {
  Candle,
  IndicatorSnapshot,
  MarketRegime,
  PriceAction,
  PriceActionEvent,
  Signal,
  SMCMap,
  Structure,
  Timeframe,
  TradeAction,
} from '../src/v3/types.ts'
import { v2PlanAllowed } from '../src/v2/types.ts'
import { v3PlanAllowed } from '../src/v3/types.ts'
import { V3_BASES, buildV3Series } from './v3Data.ts'

const SYMBOLS = Object.keys(V3_BASES)
const TIMEFRAMES: Timeframe[] = ['5m', '15m', '30m', '1H', '4H']

test('V3 derives confirmed support and resistance key levels without future bars', () => {
  const { candles, now } = buildV3Series('XAUUSD', '1H', 'range')
  const result = evaluateV3({ symbol: 'XAUUSD', timeframe: '1H', candles, now })
  const levels = result.structure.keyLevels
  assert.ok(levels.some(level => level.kind === 'SUPPORT'))
  assert.ok(levels.some(level => level.kind === 'RESISTANCE'))
  assert.ok(levels.every(level => Number.isFinite(level.price) && level.touches >= 1))
  assert.ok(levels.every(level => level.lastConfirmedIndex < candles.length))
  assert.ok(levels.some(level => level.strength === 'STRONG' && level.touches >= 3))
})

function assertLevels(direction: TradeAction, signal: Signal, symbol: string): void {
  const levels = signal.levels
  assert.ok(levels.risk > 0, `${symbol} risk must be positive`)
  const maxRiskAtr = symbol === 'XAUUSD' ? 4 : 3.5
  const maxRiskFraction = symbol === 'XAUUSD' ? 0.04 : symbol === 'BTCUSD' ? 0.07 : 0.025
  assert.ok(levels.risk / signal.indicators.atr <= maxRiskAtr + 1e-9, `${symbol} stop exceeds ${maxRiskAtr} ATR`)
  assert.ok(levels.risk / levels.entry <= maxRiskFraction + 1e-9, `${symbol} stop exceeds price-distance cap`)
  if (direction === 'BUY') {
    assert.ok(levels.stopLoss < levels.entry, `${symbol} BUY stop must be below entry`)
    assert.ok(levels.entry < levels.tp1, `${symbol} BUY TP1 must be above entry`)
    if (levels.tp2 !== null) assert.ok(levels.tp2 > levels.tp1, `${symbol} BUY TP2 must be above TP1`)
    if (levels.tp3 !== null) assert.ok(levels.tp3 > levels.tp2!, `${symbol} BUY TP3 must be above TP2`)
  } else {
    assert.ok(levels.stopLoss > levels.entry, `${symbol} SELL stop must be above entry`)
    assert.ok(levels.entry > levels.tp1, `${symbol} SELL TP1 must be below entry`)
    if (levels.tp2 !== null) assert.ok(levels.tp2 < levels.tp1, `${symbol} SELL TP2 must be below TP1`)
    if (levels.tp3 !== null) assert.ok(levels.tp3 < levels.tp2!, `${symbol} SELL TP3 must be below TP2`)
  }
  assert.ok(levels.rrTp1 >= 1 - 1e-9, `${symbol} TP1 must reach 1R`)
  if (levels.rrTp2 !== null) assert.ok(levels.rrTp2 >= 2 - 1e-9, `${symbol} TP2 must reach 2R`)
  if (levels.rrTp3 !== null) assert.ok(levels.rrTp3 >= 3 - 1e-9, `${symbol} TP3 must reach 3R`)
  assert.equal(levels.tp1CloseFraction, 0.5)
  if (direction === 'BUY') assert.ok(levels.breakevenStop > levels.entry)
  else assert.ok(levels.breakevenStop < levels.entry)
}

function assertScore(signal: Signal): void {
  const score = signal.score
  const sum = score.regime + score.structure + score.entry + score.momentum
    + score.priceAction + score.volume + score.volatility + score.strategy
  assert.ok(Math.abs(sum - score.total) <= 0.02, `score components ${sum} != total ${score.total}`)
  assert.ok(score.regime >= 0 && score.regime <= 15)
  assert.ok(score.structure >= 0 && score.structure <= 20)
  assert.ok(score.entry >= 0 && score.entry <= 20)
  assert.ok(score.momentum >= 0 && score.momentum <= 15)
  assert.ok(score.priceAction >= 0 && score.priceAction <= 10)
  assert.ok(score.volume >= 0 && score.volume <= 5)
  assert.ok(score.volatility >= 0 && score.volatility <= 10)
  assert.ok(score.strategy >= 0 && score.strategy <= 5)
  assert.ok(score.total > V3_MIN_SCORE && score.total <= 100)
}

test('trend profile produces a risk-valid BUY on every symbol and timeframe', () => {
  for (const symbol of SYMBOLS) {
    for (const timeframe of TIMEFRAMES) {
      const { candles, now } = buildV3Series(symbol, timeframe, 'trend')
      const result = evaluateV3({ symbol, timeframe, candles, now })
      assert.equal(result.action, 'BUY', `${symbol} ${timeframe}: ${result.reason}`)
      assert.ok(result.signal, `${symbol} ${timeframe} must persist a signal`)
      assert.equal(result.signal!.direction, 'BUY')
      assert.equal(result.signal!.strategy, 'V3_PRO')
      assert.equal(result.signal!.status, 'ACTIVE')
      assert.ok(result.signal!.strategyName, 'a strategy must be selected')
      assert.ok(result.score.total > V3_MIN_SCORE, `${symbol} score ${result.score.total}`)
      assertScore(result.signal!)
      assertLevels('BUY', result.signal!, symbol)
      assert.equal(result.chartCandles.length, Math.min(100, candles.length))
      assert.ok(result.barTime !== null)
    }
  }
})

test('mirrored sell profile produces a risk-valid SELL above 70 on every symbol and timeframe', () => {
  for (const symbol of SYMBOLS) {
    for (const timeframe of TIMEFRAMES) {
      const { candles, now } = buildV3Series(symbol, timeframe, 'sell', 320)
      const result = evaluateV3({ symbol, timeframe, candles, now })
      assert.equal(result.action, 'SELL', `${symbol} ${timeframe}: ${result.reason}`)
      assert.ok(result.score.total > V3_MIN_SCORE)
      assert.ok(result.signal)
      assert.equal(result.signal!.direction, 'SELL')
      assertScore(result.signal!)
      assertLevels('SELL', result.signal!, symbol)
    }
  }
})

test('Pro rejects a setup scoring exactly 70', () => {
  const { candles, now } = buildV3Series('XAUUSD', '1H', 'sell', 360)
  const result = evaluateV3({ symbol: 'XAUUSD', timeframe: '1H', candles, now })
  assert.equal(result.score.total, V3_MIN_SCORE)
  assert.equal(result.action, 'NO_SIGNAL')
  assert.equal(result.signal, null)
  assert.equal(result.levels, null)
})

test('flat range profile never forces a trade', () => {
  for (const symbol of SYMBOLS) {
    for (const timeframe of TIMEFRAMES) {
      const { candles, now } = buildV3Series(symbol, timeframe, 'range')
      const result = evaluateV3({ symbol, timeframe, candles, now })
      assert.equal(result.action, 'NO_SIGNAL', `${symbol} ${timeframe} range should not force a trade`)
      assert.equal(result.signal, null)
      assert.equal(result.levels, null)
      assert.equal(result.score.band, 'NO_SIGNAL')
    }
  }
})

test('insufficient history, duplicates and stale data are rejected before scoring', () => {
  const { candles, now } = buildV3Series('XAUUSD', '1H', 'trend', 259)
  const short = evaluateV3({ symbol: 'XAUUSD', timeframe: '1H', candles, now })
  assert.equal(short.action, 'NO_SIGNAL')
  assert.equal(short.dataOk, false)
  assert.ok(short.dataNotes.some(note => note.includes('Insufficient history')))

  const full = buildV3Series('XAUUSD', '1H', 'trend')
  const duplicate = [...full.candles.slice(0, -1), { ...full.candles[full.candles.length - 1], time: full.candles[full.candles.length - 2].time }]
  const invalid = validateV3Candles(duplicate, '1H', full.now)
  assert.equal(invalid.ok, false)
  assert.ok(invalid.notes.some(note => note.includes('ascending') || note.includes('Duplicate')))

  const stale = validateV3Candles(full.candles, '1H', full.now + 30 * 24 * 3600 * 1000)
  assert.equal(stale.ok, false)
  assert.ok(stale.notes.some(note => note.includes('stale')))
})

test('evaluation ignores an unclosed future candle and never repaints the closed bar', () => {
  const { candles, now } = buildV3Series('XAUUSD', '15m', 'trend')
  const baseline = evaluateV3({ symbol: 'XAUUSD', timeframe: '15m', candles, now })
  const withFuture = evaluateV3({
    symbol: 'XAUUSD',
    timeframe: '15m',
    candles: [
      ...candles,
      { time: now + 900_000, open: 1, high: 10_000, low: 0.5, close: 9_000, volume: 1 },
    ],
    now,
  })
  assert.equal(withFuture.action, baseline.action)
  assert.equal(withFuture.score.total, baseline.score.total)
  assert.deepEqual(withFuture.levels, baseline.levels)
  assert.equal(withFuture.barTime, baseline.barTime)

  const replay = evaluateV3({ symbol: 'XAUUSD', timeframe: '15m', candles, now })
  assert.deepEqual(replay.levels, baseline.levels)
  assert.equal(replay.score.total, baseline.score.total)
})

test('V3 lifecycle takes 50% at TP1, moves to breakeven and never replays a bar', () => {
  const { candles, now } = buildV3Series('XAUUSD', '1H', 'trend')
  const result = evaluateV3({ symbol: 'XAUUSD', timeframe: '1H', candles, now })
  const signal = result.signal!
  const levels = signal.levels
  const bar = 3_600_000

  const tp1Bar: Candle = {
    time: signal.barTime + bar,
    open: levels.entry,
    high: levels.tp1,
    low: levels.entry - levels.risk * 0.2,
    close: levels.tp1,
    volume: 150,
  }
  const afterTp1 = advanceSignalV3(signal, [tp1Bar], now + bar)
  assert.equal(afterTp1.status, 'TP1_HIT')
  assert.equal(afterTp1.closedFraction, 0.5)
  assert.equal(afterTp1.breakevenApplied, true)
  assert.equal(afterTp1.currentStopLoss, levels.breakevenStop)
  assert.equal(slotUnlockedV3(afterTp1), true)
  assert.equal(isTerminalV3(afterTp1), false)

  // Replaying the same bar is a no-op.
  assert.equal(advanceSignalV3(afterTp1, [tp1Bar], now + 2 * bar), afterTp1)

  const stopBar: Candle = {
    time: signal.barTime + 2 * bar,
    open: levels.breakevenStop,
    high: levels.breakevenStop,
    low: levels.breakevenStop - 0.1,
    close: levels.breakevenStop - 0.05,
    volume: 150,
  }
  const stopped = advanceSignalV3(afterTp1, [stopBar], now + 2 * bar)
  assert.equal(stopped.status, 'STOP_LOSS_HIT')
  assert.equal(stopped.closedFraction, 1)
  assert.equal(isTerminalV3(stopped), true)
})

test('a bar that touches both the stop and a target resolves as a stop', () => {
  const { candles, now } = buildV3Series('XAUUSD', '1H', 'trend')
  const signal = evaluateV3({ symbol: 'XAUUSD', timeframe: '1H', candles, now }).signal!
  const conflicting: Candle = {
    time: signal.barTime + 3_600_000,
    open: signal.levels.entry,
    high: signal.levels.tp1 + signal.levels.risk,
    low: signal.levels.stopLoss - 0.01,
    close: signal.levels.entry,
    volume: 100,
  }
  const resolved = advanceSignalV3(signal, [conflicting], now + 3_600_000)
  assert.equal(resolved.status, 'STOP_LOSS_HIT')
  assert.equal(resolved.closedFraction, 1)
})

/* ------------------------------------------------------- strategy selectors --- */

function fakeSnapshot(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    ema20: 104,
    ema50: 103,
    ema200: 100,
    rsi: 60,
    macd: 1,
    macdSignal: 0.8,
    macdHistogram: 0.2,
    supertrend: 102,
    supertrendDirection: 1,
    atr: 2,
    adx: 30,
    plusDi: 25,
    minusDi: 10,
    vwap: 104,
    bbUpper: 106,
    bbMiddle: 104,
    bbLower: 102,
    bbWidth: 3,
    stochK: 60,
    stochD: 55,
    roc: 0.5,
    keltnerUpper: 108,
    keltnerMiddle: 104,
    keltnerLower: 100,
    donchianUpper: 106,
    donchianMiddle: 104,
    donchianLower: 102,
    mfi: 55,
    close: 105,
    volume: 120,
    volumeMa: 100,
    volumeRatio: 1.2,
    barTime: 1,
    ...overrides,
  }
}

function fakeStructure(overrides: Partial<Structure> = {}): Structure {
  return {
    view: 'BULLISH',
    bias: 'BULLISH',
    support: 102,
    resistance: 107,
    rangeHigh: 108,
    rangeLow: 100,
    equilibrium: 104,
    lastBos: {
      kind: 'BOS',
      direction: 'BULLISH',
      level: 104,
      pivotIndex: 90,
      confirmIndex: 99,
      confirmPrice: 105,
      displacement: true,
      time: 1,
    },
    lastChoch: null,
    lastMss: null,
    swingHighs: [{ kind: 'HIGH', index: 90, confirmIndex: 93, price: 107, label: 'HH', time: 1 }],
    swingLows: [{ kind: 'LOW', index: 80, confirmIndex: 83, price: 102, label: 'HL', time: 1 }],
    recentLabels: ['H:HH', 'L:HL'],
    narrative: '',
    ...overrides,
  }
}

function fakeSMC(overrides: Partial<SMCMap> = {}): SMCMap {
  return {
    fvgs: [],
    orderBlocks: [],
    breakers: [],
    mitigationBlocks: [],
    equalHighs: [],
    equalLows: [],
    sweeps: [],
    premiumDiscount: 'EQUILIBRIUM',
    equilibrium: 104,
    dealingRangeHigh: 108,
    dealingRangeLow: 100,
    narrative: '',
    ...overrides,
  }
}

function fakePA(events: PriceActionEvent[]): PriceAction {
  const last = [...events].reverse().find(event => event.direction !== 'NEUTRAL')
  return {
    events,
    bias: last ? last.direction : 'NEUTRAL',
    narrative: '',
  }
}

function fakeRegime(overrides: Partial<MarketRegime> = {}): MarketRegime {
  return {
    kind: 'STRONG_BULL',
    label: 'Strong bullish trend',
    direction: 'BULLISH',
    strength: 'STRONG',
    volatility: 'NORMAL',
    adx: 30,
    atrRatio: 1,
    bbWidthPercentile: 0.5,
    narrative: '',
    ...overrides,
  }
}

const LAST = 100

test('all Pro playbook engines can be selected for their own context', () => {
  const trend = evaluateStrategies({
    snapshot: fakeSnapshot(),
    structure: fakeStructure(),
    smc: fakeSMC(),
    priceAction: fakePA([]),
    regime: fakeRegime(),
    lastPos: LAST,
  })
  assert.equal(trend[0]?.name, 'TREND_CONTINUATION')
  assert.ok(trend.some(item => item.name === 'PULLBACK_CONTINUATION'))

  const breakoutEvent: PriceActionEvent = {
    kind: 'BREAKOUT',
    direction: 'BULLISH',
    index: LAST,
    time: 1,
    detail: 'Breakout',
  }
  const breakout = evaluateStrategies({
    snapshot: fakeSnapshot({ adx: 24, close: 105.5 }),
    structure: fakeStructure({
      view: 'RANGING',
      bias: 'RANGING',
      recentLabels: [],
      lastBos: { ...fakeStructure().lastBos!, confirmIndex: LAST - 1 },
    }),
    smc: fakeSMC({
      premiumDiscount: 'DISCOUNT',
      fvgs: [{ direction: 'BULLISH', low: 104, high: 105, index: 95, confirmIndex: 95, time: 1, mitigated: false }],
    }),
    priceAction: fakePA([breakoutEvent]),
    regime: fakeRegime({ kind: 'WEAK_BULL', label: 'Weak bullish trend', direction: 'NEUTRAL', strength: 'WEAK', adx: 24 }),
    lastPos: LAST,
  })
  assert.equal(breakout[0]?.name, 'BREAKOUT_RETEST', breakout.map(item => `${item.name}:${item.fit}`).join(','))

  const sweep = evaluateStrategies({
    snapshot: fakeSnapshot({ adx: 22, rsi: 35, close: 104 }),
    structure: fakeStructure({
      view: 'BULLISH',
      bias: 'BULLISH',
      lastBos: null,
      lastChoch: {
        kind: 'CHOCH',
        direction: 'BULLISH',
        level: 103,
        pivotIndex: 90,
        confirmIndex: LAST - 1,
        confirmPrice: 104,
        displacement: true,
        time: 1,
      },
      recentLabels: [],
    }),
    smc: fakeSMC({
      premiumDiscount: 'DISCOUNT',
      sweeps: [{ direction: 'BULLISH', level: 101, index: LAST - 1, time: 1, source: 'EQL' }],
    }),
    priceAction: fakePA([{
      kind: 'REJECTION',
      direction: 'BULLISH',
      index: LAST,
      time: 1,
      detail: 'Rejection',
    }]),
    regime: fakeRegime({ kind: 'SIDEWAYS', label: 'Sideways', direction: 'NEUTRAL', strength: 'RANGE', adx: 18 }),
    lastPos: LAST,
  })
  assert.equal(sweep[0]?.name, 'LIQUIDITY_SWEEP_REVERSAL', sweep.map(item => `${item.name}:${item.fit}`).join(','))
  assert.ok(sweep.some(item => item.name === 'FIBONACCI_RETRACEMENT'))

  const range = evaluateStrategies({
    snapshot: fakeSnapshot({ close: 101, adx: 15, rsi: 30 }),
    structure: fakeStructure({ view: 'RANGING', bias: 'RANGING', lastBos: null, recentLabels: [] }),
    smc: fakeSMC(),
    priceAction: fakePA([{
      kind: 'REJECTION',
      direction: 'BULLISH',
      index: LAST,
      time: 1,
      detail: 'Rejection',
    }]),
    regime: fakeRegime({
      kind: 'SIDEWAYS',
      label: 'Sideways',
      direction: 'NEUTRAL',
      strength: 'RANGE',
      volatility: 'CONTRACTION',
      adx: 15,
    }),
    lastPos: LAST,
  })
  assert.equal(range[0]?.name, 'RANGE_MEAN_REVERSION', range.map(item => `${item.name}:${item.fit}`).join(','))
  assert.ok(range.some(item => item.name === 'SUPPORT_RESISTANCE_BOUNCE'))

  const supply = evaluateStrategies({
    snapshot: fakeSnapshot({ close: 102.4, adx: 21 }),
    structure: fakeStructure(),
    smc: fakeSMC({
      premiumDiscount: 'DISCOUNT',
      orderBlocks: [{ direction: 'BULLISH', low: 102, high: 103, index: 96, confirmIndex: 97, time: 1, mitigated: false }],
    }),
    priceAction: fakePA([{ kind: 'REJECTION', direction: 'BULLISH', index: LAST, time: 1, detail: 'Demand rejection' }]),
    regime: fakeRegime(),
    lastPos: LAST,
  })
  assert.ok(supply.some(item => item.name === 'SUPPLY_DEMAND'), supply.map(item => `${item.name}:${item.fit}`).join(','))

  const expansion = evaluateStrategies({
    snapshot: fakeSnapshot({ close: 109, donchianUpper: 106, bbUpper: 107, adx: 26 }),
    structure: fakeStructure(),
    smc: fakeSMC(),
    priceAction: fakePA([{
      kind: 'BREAKOUT',
      direction: 'BULLISH',
      index: LAST,
      time: 1,
      detail: 'Breakout',
    }]),
    regime: fakeRegime({
      kind: 'VOLATILITY_EXPANSION',
      label: 'Volatility expansion',
      direction: 'NEUTRAL',
      strength: 'UNCLEAR',
      volatility: 'EXPANSION',
      atrRatio: 1.5,
      bbWidthPercentile: 0.9,
      adx: 26,
    }),
    lastPos: LAST,
  })
  assert.equal(expansion[0]?.name, 'VOLATILITY_EXPANSION', expansion.map(item => `${item.name}:${item.fit}`).join(','))
})

test('engine selection is auto-picked and the best fit wins', () => {
  const result = evaluateV3({
    symbol: 'EURUSD',
    timeframe: '1H',
    ...buildV3Series('EURUSD', '1H', 'trend'),
  })
  assert.ok(result.strategyName)
  assert.ok(result.strategyReasons.length > 0)
  assert.equal(result.score.strategyName, result.strategyName)
})

test('Pro manual playbooks and quality risk presets are applied', () => {
  const data = buildV3Series('EURUSD', '1H', 'trend')
  const manual = evaluateV3({
    symbol: 'EURUSD',
    timeframe: '1H',
    ...data,
    strategy: 'TREND_CONTINUATION',
    riskProfile: 'MEDIUM',
  })
  assert.equal(manual.requestedStrategy, 'TREND_CONTINUATION')
  assert.equal(manual.strategyName, 'TREND_CONTINUATION')
  assert.equal(manual.riskProfile, 'MEDIUM')
  assert.equal(manual.suggestedRiskPercent, 1)

  const low = evaluateV3({ symbol: 'EURUSD', timeframe: '1H', ...data, riskProfile: 'LOW' })
  const high = evaluateV3({ symbol: 'EURUSD', timeframe: '1H', ...data, riskProfile: 'HIGH' })
  assert.equal(low.riskProfile, 'LOW')
  assert.equal(low.suggestedRiskPercent, 0.5)
  assert.equal(high.riskProfile, 'HIGH')
  assert.equal(high.suggestedRiskPercent, 2)
  if (low.levels) assert.ok(low.levels.rrTp1 >= 1.5)
})

test('plans are isolated: V3 is Pro only and V2 is Plus only', () => {
  assert.equal(v3PlanAllowed('pro'), true)
  assert.equal(v3PlanAllowed('plus'), false)
  assert.equal(v3PlanAllowed('free'), false)
  assert.equal(v2PlanAllowed('plus'), true)
  assert.equal(v2PlanAllowed('pro'), false)
  assert.equal(v2PlanAllowed('free'), false)
})
