/**
 * Signal projection for the terminal "Analyze" button.
 *
 * All trading decisions happen on the server. This module only turns the V1
 * FREE and V2 PLUS analysis payloads into the grouped view the existing panel
 * renders, so the browser cannot bypass limits, duplicate checks or strategy
 * gates.
 *
 * V1 and V2 are projected separately on purpose: the two engines have different
 * score dimensions, so sharing one builder would silently mix their rules.
 */

import { api } from './services/api'
import type {
  Candle,
  Levels,
  MarketView,
  Score,
  Signal as V1Signal,
  SignalStatus,
  Structure,
  V1Analysis,
} from './v1/types'
import { g5 } from './v1/types'
import type {
  PriceAction,
  ScanResult as V2ScanResult,
  Signal as V2Signal,
  SMCMap,
  Score as V2Score,
  Structure as V2Structure,
  V2Analysis,
} from './v2/types'
import type {
  MarketRegime,
  ProRiskProfile,
  PriceAction as V3PriceAction,
  ScanResult as V3ScanResult,
  Signal as V3Signal,
  SMCMap as V3SMCMap,
  Score as V3Score,
  Structure as V3Structure,
  StrategyName,
  V3Analysis,
} from './v3/types'
import { STRATEGY_LABELS } from './v3/types'

export type Bias = 'buy' | 'sell' | 'neutral'
export type SignalBias = 'buy' | 'sell' | 'wait'
export type StrategyTag = 'V1' | 'V2' | 'V3'

export type SignalReason = {
  label: string
  detail: string
  bias: Bias
}

export type SignalGroup = {
  id:
    | 'ema'
    | 'trend'
    | 'momentum'
    | 'supertrend'
    | 'structure'
    | 'smc'
    | 'priceAction'
    | 'regime'
    | 'entry'
    | 'volume'
    | 'volatility'
    | 'strategy'
  label: string
  bias: Bias
  score: number
  max: number
  reasons: SignalReason[]
}

/** Compact setup row used for open setups and the daily best-setups list. */
export type SetupSummary = {
  signalId: string
  symbol: string
  timeframe: string
  direction: 'BUY' | 'SELL'
  status: SignalStatus
  score: number
  entry: number
  stopLoss: number
  tp1: number
  tp2: number | null
  tp3: number | null
  strategyName?: StrategyName
  barTime: number
}

export type SignalResult = {
  strategy: StrategyTag
  symbol: string
  timeframe: string
  generatedAt: string
  bias: SignalBias
  /** Legacy UI field: raw weighted setup score, never a probability. */
  confidence: number
  headline: string
  summary: string
  groups: SignalGroup[]
  /** Kept for the panel; the engines are connected. */
  preview: boolean
  action: 'BUY' | 'SELL' | 'NO_SIGNAL'
  view: MarketView
  score: Score | V2Score | V3Score
  levels: (Levels & { tp1CloseFraction?: number }) | null
  structure: Structure | V2Structure | V3Structure
  smc: SMCMap | V3SMCMap | null
  priceAction: PriceAction | V3PriceAction | null
  /** V3 only. */
  strategyName?: StrategyName | null
  strategyReasons?: string[]
  requestedStrategy?: StrategyName | null
  riskProfile?: ProRiskProfile
  suggestedRiskPercent?: number
  regime?: MarketRegime | null
  reason: string
  barTime: number | null
  dataNotes: string[]
  existingActive: V1Signal | V2Signal | V3Signal | null
  status: SignalStatus | null
  limits: { analyses: number; signals: number; bestSetups: number; scans: number }
  openSignals: SetupSummary[]
  bestSetups: SetupSummary[]
  /** V3 chart overlay: recent BUY/SELL history. */
  history?: SetupSummary[]
  /** V3 chart overlay: last closed candles. */
  candles?: Candle[]
  provider: string
}

export type ScanSetupSummary = {
  symbol: string
  timeframe: string
  action: 'BUY' | 'SELL' | 'NO_SIGNAL'
  view: MarketView
  score: number
  band: string
  strategyName?: StrategyName | null
  reason: string
  rrTp1: number | null
  result: SignalResult
}

export type ScanResponse = {
  strategy?: StrategyTag
  timeframe: string
  scanned: number
  scannedAt: string
  remainingScans: number
  provider: string
  notes: string[]
  setups: ScanSetupSummary[]
}

export const STRATEGY_CONNECTED = true

export type AnalyzeInput = {
  symbol: string
  timeframe: string
  playbook?: 'AUTO' | StrategyName
  riskProfile?: ProRiskProfile
}

/* ------------------------------------------------------------------ shared --- */

function groupBias(score: number, max: number, direction: 'BUY' | 'SELL' | null): Bias {
  if (!direction || score <= 0) return 'neutral'
  if (score / max < 0.4) return 'neutral'
  return direction === 'BUY' ? 'buy' : 'sell'
}

function shortReason(reason: string): string {
  const first = reason.split(';')[0]?.trim() || reason
  return first.length > 110 ? `${first.slice(0, 107)}…` : first
}

function customerReason(value: string): string {
  return value
    .replace(/\bstrategies\b/gi, 'playbooks')
    .replace(/\bstrategy\b/gi, 'playbook')
    .replace(/\bengine\b/gi, 'analysis')
    .replace(/\bV3(?:_PRO)?\b/gi, 'Pro')
    .replace(/\bV2(?:_PLUS)?\b/gi, 'Plus')
    .replace(/\bV1(?:_FREE)?\b/gi, 'Free')
}

function limitsOf(remaining: number): number {
  return typeof remaining === 'number' ? remaining : -1
}

function summaryOf(signal: V1Signal | V2Signal | V3Signal): SetupSummary {
  const levels = signal.levels
  return {
    signalId: signal.signalId,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    direction: signal.direction,
    status: signal.status,
    score: signal.score.total,
    entry: levels.entry,
    stopLoss: signal.currentStopLoss ?? levels.stopLoss,
    tp1: levels.tp1,
    tp2: 'tp2' in levels ? levels.tp2 : null,
    tp3: 'tp3' in levels ? levels.tp3 : null,
    strategyName: 'strategyName' in signal ? signal.strategyName : undefined,
    barTime: signal.barTime,
  }
}

/* ---------------------------------------------------------------------- V1 --- */

function directionOf(analysis: V1Analysis): 'BUY' | 'SELL' | null {
  if (analysis.action === 'BUY' || analysis.action === 'SELL') return analysis.action
  if (analysis.view === 'BULLISH') return 'BUY'
  if (analysis.view === 'BEARISH') return 'SELL'
  return null
}

function buildV1Groups(analysis: V1Analysis): SignalGroup[] {
  const direction = directionOf(analysis)
  const snapshot = analysis.indicators
  const structure = analysis.structure
  const score = analysis.score

  const emaReasons: SignalReason[] = snapshot
    ? [
        {
          label: 'EMA 20 / 50 / 200',
          detail: `${g5(snapshot.ema20)} · ${g5(snapshot.ema50)} · ${g5(snapshot.ema200)}`,
          bias: snapshot.ema20 > snapshot.ema50 ? 'buy' : snapshot.ema20 < snapshot.ema50 ? 'sell' : 'neutral',
        },
        {
          label: 'Price location',
          detail: `Last closed price ${g5(snapshot.close)} is ${snapshot.close > snapshot.ema50 ? 'above' : 'below'} EMA 50 and ${snapshot.close > snapshot.ema200 ? 'above' : 'below'} EMA 200.`,
          bias: snapshot.close > snapshot.ema50 ? 'buy' : snapshot.close < snapshot.ema50 ? 'sell' : 'neutral',
        },
      ]
    : [{ label: 'EMA trend', detail: 'Waiting for enough closed candles to warm up EMA 200.', bias: 'neutral' }]

  const momentumReasons: SignalReason[] = snapshot
    ? [
        {
          label: 'RSI (14)',
          detail: `${snapshot.rsi.toFixed(1)} — ${snapshot.rsi > 50 ? 'bullish' : snapshot.rsi < 50 ? 'bearish' : 'neutral'} momentum.`,
          bias: snapshot.rsi > 50 ? 'buy' : snapshot.rsi < 50 ? 'sell' : 'neutral',
        },
        {
          label: 'MACD (12 / 26 / 9)',
          detail: `MACD ${g5(snapshot.macd)} ${snapshot.macd > snapshot.macdSignal ? 'above' : 'below'} signal ${g5(snapshot.macdSignal)}; histogram ${g5(snapshot.macdHistogram)}.`,
          bias: snapshot.macd > snapshot.macdSignal ? 'buy' : snapshot.macd < snapshot.macdSignal ? 'sell' : 'neutral',
        },
      ]
    : [{ label: 'RSI + MACD', detail: 'Momentum is not available until the indicators warm up.', bias: 'neutral' }]

  const supertrendReasons: SignalReason[] = snapshot
    ? [
        {
          label: 'Supertrend (10 / 3)',
          detail: `${snapshot.supertrendDirection > 0 ? 'Bullish' : 'Bearish'} at ${g5(snapshot.supertrend)}.`,
          bias: snapshot.supertrendDirection > 0 ? 'buy' : 'sell',
        },
        {
          label: 'ATR (14)',
          detail: `Volatility ${g5(snapshot.atr)}; stop buffer is fixed by market class.`,
          bias: 'neutral',
        },
      ]
    : [{ label: 'Supertrend', detail: 'Supertrend is still warming up.', bias: 'neutral' }]

  const latest = structure.lastBos && structure.lastChoch
    ? (structure.lastBos.confirmIndex >= structure.lastChoch.confirmIndex ? structure.lastBos : structure.lastChoch)
    : structure.lastBos ?? structure.lastChoch
  const structureReasons: SignalReason[] = [
    {
      label: 'Market view',
      detail: structure.narrative || 'No confirmed structure yet.',
      bias: structure.view === 'BULLISH' ? 'buy' : structure.view === 'BEARISH' ? 'sell' : 'neutral',
    },
    {
      label: latest ? `${latest.kind} confirmation` : 'BOS / CHoCH',
      detail: latest
        ? `${latest.direction} ${latest.kind} at ${g5(latest.level)}; support ${g5(structure.support)}, resistance ${g5(structure.resistance)}.`
        : `No confirmed break yet; support ${g5(structure.support)}, resistance ${g5(structure.resistance)}.`,
      bias: latest ? (latest.direction === 'BULLISH' ? 'buy' : 'sell') : 'neutral',
    },
  ]

  return [
    { id: 'ema', label: 'EMA trend', bias: groupBias(score.ema, 30, direction), score: score.ema, max: 30, reasons: emaReasons },
    { id: 'momentum', label: 'RSI + MACD', bias: groupBias(score.momentum, 25, direction), score: score.momentum, max: 25, reasons: momentumReasons },
    { id: 'supertrend', label: 'Supertrend', bias: groupBias(score.supertrend, 20, direction), score: score.supertrend, max: 20, reasons: supertrendReasons },
    { id: 'structure', label: 'Market structure', bias: groupBias(score.structure, 25, direction), score: score.structure, max: 25, reasons: structureReasons },
  ]
}

function toV1Result(analysis: V1Analysis): SignalResult {
  const bias: SignalBias = analysis.action === 'BUY' ? 'buy' : analysis.action === 'SELL' ? 'sell' : 'wait'
  const signal = analysis.signal
  const levels = analysis.levels

  const headline = bias === 'wait'
    ? `No signal — ${shortReason(customerReason(analysis.reason))}`
    : `${analysis.action} setup — ${analysis.score.total.toFixed(0)}/100 (${analysis.score.band})`

  let summary = customerReason(analysis.reason)
  if (signal && levels) {
    summary = `Entry zone ${g5(levels.entryZoneLow)}–${g5(levels.entryZoneHigh)} · Stop ${g5(levels.stopLoss)} · TP1 ${g5(levels.tp1)} (${levels.rrTp1.toFixed(2)}R)`
      + (levels.tp2 !== null ? ` · TP2 ${g5(levels.tp2)} (${levels.rrTp2!.toFixed(2)}R)` : '')
      + (levels.tp3 !== null ? ` · TP3 ${g5(levels.tp3)} (${levels.rrTp3!.toFixed(2)}R)` : '')
      + '.'
  }

  return {
    strategy: 'V1',
    symbol: analysis.symbol,
    timeframe: analysis.timeframe,
    generatedAt: new Date(analysis.generatedAt).toISOString(),
    bias,
    confidence: Math.round(analysis.score.total),
    headline,
    summary,
    groups: buildV1Groups(analysis),
    preview: false,
    action: analysis.action,
    view: analysis.view,
    score: analysis.score,
    levels,
    structure: analysis.structure,
    smc: null,
    priceAction: null,
    reason: customerReason(analysis.reason),
    barTime: analysis.barTime,
    dataNotes: analysis.dataNotes,
    existingActive: analysis.existingActive,
    status: signal?.status ?? null,
    limits: {
      analyses: limitsOf(analysis.remainingAnalyses),
      signals: limitsOf(analysis.remainingSignals),
      bestSetups: -1,
      scans: -1,
    },
    openSignals: [],
    bestSetups: [],
    provider: analysis.provider || 'Yahoo Finance',
    candles: analysis.candles,
  }
}

/* ---------------------------------------------------------------------- V2 --- */

function buildV2Groups(analysis: V2Analysis): SignalGroup[] {
  const direction: 'BUY' | 'SELL' | null = analysis.action === 'BUY'
    ? 'BUY'
    : analysis.action === 'SELL'
      ? 'SELL'
      : analysis.view === 'BULLISH' ? 'BUY' : analysis.view === 'BEARISH' ? 'SELL' : null
  const snapshot = analysis.indicators
  const structure = analysis.structure
  const smc = analysis.smc
  const pa = analysis.priceAction
  const score = analysis.score

  const trendReasons: SignalReason[] = snapshot
    ? [
        {
          label: 'EMA 20 / 50 / 200',
          detail: `${g5(snapshot.ema20)} · ${g5(snapshot.ema50)} · ${g5(snapshot.ema200)}`,
          bias: snapshot.ema20 > snapshot.ema50 ? 'buy' : snapshot.ema20 < snapshot.ema50 ? 'sell' : 'neutral',
        },
        {
          label: 'ADX (14)',
          detail: `${snapshot.adx.toFixed(1)} — ${snapshot.adx >= 25 ? 'trending' : snapshot.adx >= 18 ? 'developing' : 'choppy'} market, +DI ${snapshot.plusDi.toFixed(1)} / −DI ${snapshot.minusDi.toFixed(1)}.`,
          bias: snapshot.plusDi > snapshot.minusDi ? 'buy' : snapshot.plusDi < snapshot.minusDi ? 'sell' : 'neutral',
        },
        {
          label: 'VWAP',
          detail: `Session VWAP ${g5(snapshot.vwap)}; price is ${snapshot.close > snapshot.vwap ? 'above' : 'below'} it.`,
          bias: snapshot.close > snapshot.vwap ? 'buy' : snapshot.close < snapshot.vwap ? 'sell' : 'neutral',
        },
      ]
    : [{ label: 'Trend filter', detail: 'Waiting for the EMA 200, ADX and VWAP warm-up.', bias: 'neutral' }]

  const momentumReasons: SignalReason[] = snapshot
    ? [
        {
          label: 'RSI (14)',
          detail: `${snapshot.rsi.toFixed(1)} — ${snapshot.rsi > 55 ? 'bullish' : snapshot.rsi < 45 ? 'bearish' : 'balanced'}.`,
          bias: snapshot.rsi > 55 ? 'buy' : snapshot.rsi < 45 ? 'sell' : 'neutral',
        },
        {
          label: 'MACD (12 / 26 / 9)',
          detail: `MACD ${g5(snapshot.macd)} ${snapshot.macd > snapshot.macdSignal ? 'above' : 'below'} signal; histogram ${g5(snapshot.macdHistogram)}.`,
          bias: snapshot.macd > snapshot.macdSignal ? 'buy' : snapshot.macd < snapshot.macdSignal ? 'sell' : 'neutral',
        },
        {
          label: 'Stochastic (14 / 3 / 3)',
          detail: `%K ${snapshot.stochK.toFixed(1)} / %D ${snapshot.stochD.toFixed(1)}.`,
          bias: snapshot.stochK > snapshot.stochD ? 'buy' : snapshot.stochK < snapshot.stochD ? 'sell' : 'neutral',
        },
      ]
    : [{ label: 'Momentum', detail: 'RSI, MACD and Stochastic are still warming up.', bias: 'neutral' }]

  const supertrendReasons: SignalReason[] = snapshot
    ? [
        {
          label: 'Supertrend (10 / 3)',
          detail: `${snapshot.supertrendDirection > 0 ? 'Bullish' : 'Bearish'} at ${g5(snapshot.supertrend)}.`,
          bias: snapshot.supertrendDirection > 0 ? 'buy' : 'sell',
        },
        {
          label: 'ATR (14) & Bollinger',
          detail: `ATR ${g5(snapshot.atr)}; Bollinger 20/2 width ${snapshot.bbWidth.toFixed(2)}% (${g5(snapshot.bbLower)} – ${g5(snapshot.bbUpper)}).`,
          bias: 'neutral',
        },
      ]
    : [{ label: 'Supertrend', detail: 'Supertrend is still warming up.', bias: 'neutral' }]

  const latestBreak = structure.lastMss ?? structure.lastChoch ?? structure.lastBos
  const structureReasons: SignalReason[] = [
    {
      label: 'Market structure',
      detail: structure.narrative || 'No confirmed 3L/3R structure yet.',
      bias: structure.view === 'BULLISH' ? 'buy' : structure.view === 'BEARISH' ? 'sell' : 'neutral',
    },
    {
      label: latestBreak ? `${latestBreak.kind} confirmation` : 'BOS / CHoCH / MSS',
      detail: latestBreak
        ? `${latestBreak.direction} ${latestBreak.kind} at ${g5(latestBreak.level)}${latestBreak.displacement ? ' (displacement)' : ''}; support ${g5(structure.support)}, resistance ${g5(structure.resistance)}.`
        : `No confirmed break yet; support ${g5(structure.support)}, resistance ${g5(structure.resistance)}.`,
      bias: latestBreak ? (latestBreak.direction === 'BULLISH' ? 'buy' : 'sell') : 'neutral',
    },
    {
      label: 'Confirmed key levels',
      detail: structure.keyLevels.length
        ? structure.keyLevels.map(level => `${level.kind === 'SUPPORT' ? 'S' : 'R'} ${g5(level.price)} (${level.strength.toLowerCase()}, ${level.touches} touch${level.touches === 1 ? '' : 'es'})`).join(' · ')
        : 'No confirmed key-level cluster is close enough to the current market.',
      bias: 'neutral',
    },
  ]

  const openGaps = smc.fvgs.filter(gap => !gap.mitigated)
  const openBlocks = smc.orderBlocks.filter(block => !block.mitigated)
  const smcReasons: SignalReason[] = [
    {
      label: 'Premium / discount',
      detail: `${smc.premiumDiscount} of the dealing range ${g5(smc.dealingRangeLow)}–${g5(smc.dealingRangeHigh)}; equilibrium ${g5(smc.equilibrium)}.`,
      bias: smc.premiumDiscount === 'DISCOUNT' ? 'buy' : smc.premiumDiscount === 'PREMIUM' ? 'sell' : 'neutral',
    },
    {
      label: 'FVG / order blocks',
      detail: `${openGaps.length} open fair value gap${openGaps.length === 1 ? '' : 's'}, ${openBlocks.length} unmitigated order block${openBlocks.length === 1 ? '' : 's'} in the recent window.`,
      bias: 'neutral',
    },
    {
      label: 'Liquidity',
      detail: smc.sweeps.length
        ? `${smc.sweeps.length} liquidity sweep${smc.sweeps.length === 1 ? '' : 's'} recorded; EQH ${smc.equalHighs.length}, EQL ${smc.equalLows.length}.`
        : `No recent sweep; EQH ${smc.equalHighs.length}, EQL ${smc.equalLows.length}.`,
      bias: smc.sweeps.length ? (smc.sweeps[smc.sweeps.length - 1].direction === 'BULLISH' ? 'buy' : 'sell') : 'neutral',
    },
  ]

  const paReasons: SignalReason[] = [{
    label: 'Candle confirmation',
    detail: pa.narrative,
    bias: pa.bias === 'BULLISH' ? 'buy' : pa.bias === 'BEARISH' ? 'sell' : 'neutral',
  }]

  return [
    { id: 'trend', label: 'Trend & volatility', bias: groupBias(score.trend, 20, direction), score: score.trend, max: 20, reasons: trendReasons },
    { id: 'momentum', label: 'Momentum', bias: groupBias(score.momentum, 20, direction), score: score.momentum, max: 20, reasons: momentumReasons },
    { id: 'supertrend', label: 'Supertrend', bias: groupBias(score.supertrend, 10, direction), score: score.supertrend, max: 10, reasons: supertrendReasons },
    { id: 'structure', label: 'Market structure', bias: groupBias(score.structure, 25, direction), score: score.structure, max: 25, reasons: structureReasons },
    { id: 'smc', label: 'SMC / ICT', bias: groupBias(score.smc, 20, direction), score: score.smc, max: 20, reasons: smcReasons },
    { id: 'priceAction', label: 'Price action', bias: groupBias(score.priceAction, 5, direction), score: score.priceAction, max: 5, reasons: paReasons },
  ]
}

function toV2Result(analysis: V2Analysis): SignalResult {
  const bias: SignalBias = analysis.action === 'BUY' ? 'buy' : analysis.action === 'SELL' ? 'sell' : 'wait'
  const levels = analysis.levels

  const headline = bias === 'wait'
    ? `No signal — ${shortReason(customerReason(analysis.reason))}`
    : `${analysis.action} setup — ${analysis.score.total.toFixed(0)}/100 (${analysis.score.band})`

  let summary = customerReason(analysis.reason)
  if (levels) {
    summary = `Entry zone ${g5(levels.entryZoneLow)}–${g5(levels.entryZoneHigh)} · Stop ${g5(levels.stopLoss)} · TP1 ${g5(levels.tp1)} (${levels.rrTp1.toFixed(2)}R, close 50%)`
      + (levels.tp2 !== null ? ` · TP2 ${g5(levels.tp2)} (${levels.rrTp2!.toFixed(2)}R)` : '')
      + (levels.tp3 !== null ? ` · TP3 ${g5(levels.tp3)} (${levels.rrTp3!.toFixed(2)}R)` : '')
      + ` · stop to ${g5(levels.breakevenStop)} after TP1.`
  }

  return {
    strategy: 'V2',
    symbol: analysis.symbol,
    timeframe: analysis.timeframe,
    generatedAt: new Date(analysis.generatedAt).toISOString(),
    bias,
    confidence: Math.round(analysis.score.total),
    headline,
    summary,
    groups: buildV2Groups(analysis),
    preview: false,
    action: analysis.action,
    view: analysis.view,
    score: analysis.score,
    levels,
    structure: analysis.structure,
    smc: analysis.smc,
    priceAction: analysis.priceAction,
    reason: customerReason(analysis.reason),
    barTime: analysis.barTime,
    dataNotes: analysis.dataNotes,
    existingActive: null,
    status: analysis.signal?.status ?? null,
    limits: {
      analyses: limitsOf(analysis.remainingAnalyses),
      signals: limitsOf(analysis.remainingSignals),
      bestSetups: limitsOf(analysis.remainingBestSetups),
      scans: limitsOf(analysis.remainingScans),
    },
    openSignals: analysis.openSignals.map(summaryOf),
    bestSetups: analysis.bestSetups.map(summaryOf),
    provider: analysis.provider || 'Yahoo Finance',
    candles: analysis.candles,
  }
}

/* ---------------------------------------------------------------------- V3 --- */

function buildV3Groups(analysis: V3Analysis): SignalGroup[] {
  const direction: 'BUY' | 'SELL' | null = analysis.action === 'BUY'
    ? 'BUY'
    : analysis.action === 'SELL'
      ? 'SELL'
      : analysis.regime.direction === 'BULLISH'
        ? 'BUY'
        : analysis.regime.direction === 'BEARISH' ? 'SELL' : null
  const snapshot = analysis.indicators
  const structure = analysis.structure
  const smc = analysis.smc
  const pa = analysis.priceAction
  const score = analysis.score
  const regime = analysis.regime
  const strategyName = analysis.strategyName
  const strategyReasons = analysis.strategyReasons

  const regimeReasons: SignalReason[] = snapshot
    ? [
        {
          label: 'Market regime',
          detail: `${regime.label} — ${regime.narrative}.`,
          bias: regime.direction === 'BULLISH' ? 'buy' : regime.direction === 'BEARISH' ? 'sell' : 'neutral',
        },
        {
          label: 'EMA 20 / 50 / 200',
          detail: `${g5(snapshot.ema20)} · ${g5(snapshot.ema50)} · ${g5(snapshot.ema200)}.`,
          bias: snapshot.ema20 > snapshot.ema50 ? 'buy' : snapshot.ema20 < snapshot.ema50 ? 'sell' : 'neutral',
        },
        {
          label: 'ADX (14) + DI',
          detail: `${snapshot.adx.toFixed(1)} — ${snapshot.adx >= 25 ? 'strong trend' : snapshot.adx >= 18 ? 'developing trend' : 'choppy'}; +DI ${snapshot.plusDi.toFixed(1)} / −DI ${snapshot.minusDi.toFixed(1)}.`,
          bias: snapshot.plusDi > snapshot.minusDi ? 'buy' : snapshot.plusDi < snapshot.minusDi ? 'sell' : 'neutral',
        },
      ]
    : [{ label: 'Regime', detail: 'Waiting for EMA 200, ADX and VWAP to warm up.', bias: 'neutral' }]

  const latestBreak = structure.lastMss ?? structure.lastChoch ?? structure.lastBos
  const structureReasons: SignalReason[] = [
    {
      label: 'Market structure',
      detail: structure.narrative || 'No confirmed 3L/3R structure yet.',
      bias: structure.view === 'BULLISH' ? 'buy' : structure.view === 'BEARISH' ? 'sell' : 'neutral',
    },
    {
      label: latestBreak ? `${latestBreak.kind} confirmation` : 'BOS / CHoCH / MSS',
      detail: latestBreak
        ? `${latestBreak.direction} ${latestBreak.kind} at ${g5(latestBreak.level)}${latestBreak.displacement ? ' (displacement)' : ''}; range ${g5(structure.rangeLow)}–${g5(structure.rangeHigh)}, equilibrium ${g5(structure.equilibrium)}.`
        : `No confirmed break yet; support ${g5(structure.support)}, resistance ${g5(structure.resistance)}.`,
      bias: latestBreak ? (latestBreak.direction === 'BULLISH' ? 'buy' : 'sell') : 'neutral',
    },
    {
      label: 'Confirmed key levels',
      detail: structure.keyLevels.length
        ? structure.keyLevels.map(level => `${level.kind === 'SUPPORT' ? 'S' : 'R'} ${g5(level.price)} (${level.strength.toLowerCase()}, ${level.touches} touch${level.touches === 1 ? '' : 'es'})`).join(' · ')
        : 'No confirmed key-level cluster is close enough to the current market.',
      bias: 'neutral',
    },
  ]

  const openGaps = smc.fvgs.filter(gap => !gap.mitigated)
  const openBlocks = smc.orderBlocks.filter(block => !block.mitigated)
  const openBreakers = smc.breakers.filter(block => !block.mitigated)
  const openMitigation = smc.mitigationBlocks.filter(block => !block.mitigated)
  const entryReasons: SignalReason[] = [
    {
      label: 'Premium / discount',
      detail: `${smc.premiumDiscount} of the dealing range ${g5(smc.dealingRangeLow)}–${g5(smc.dealingRangeHigh)}; equilibrium ${g5(smc.equilibrium)}.`,
      bias: smc.premiumDiscount === 'DISCOUNT' ? 'buy' : smc.premiumDiscount === 'PREMIUM' ? 'sell' : 'neutral',
    },
    {
      label: 'FVG / order blocks',
      detail: `${openGaps.length} open FVG, ${openBlocks.length} unmitigated order block${openBlocks.length === 1 ? '' : 's'}.`,
      bias: 'neutral',
    },
    {
      label: 'Breaker / mitigation',
      detail: `${openBreakers.length} active breaker block${openBreakers.length === 1 ? '' : 's'}, ${openMitigation.length} mitigation block${openMitigation.length === 1 ? '' : 's'}.`,
      bias: openBreakers.length ? (openBreakers[openBreakers.length - 1].direction === 'BULLISH' ? 'buy' : 'sell') : 'neutral',
    },
    {
      label: 'Liquidity',
      detail: smc.sweeps.length
        ? `${smc.sweeps.length} sweep${smc.sweeps.length === 1 ? '' : 's'}; EQH ${smc.equalHighs.length}, EQL ${smc.equalLows.length}.`
        : `No recent sweep; EQH ${smc.equalHighs.length}, EQL ${smc.equalLows.length}.`,
      bias: smc.sweeps.length ? (smc.sweeps[smc.sweeps.length - 1].direction === 'BULLISH' ? 'buy' : 'sell') : 'neutral',
    },
  ]

  const momentumReasons: SignalReason[] = snapshot
    ? [
        {
          label: 'RSI (14)',
          detail: `${snapshot.rsi.toFixed(1)} — ${snapshot.rsi > 55 ? 'bullish' : snapshot.rsi < 45 ? 'bearish' : 'balanced'}.`,
          bias: snapshot.rsi > 55 ? 'buy' : snapshot.rsi < 45 ? 'sell' : 'neutral',
        },
        {
          label: 'MACD (12 / 26 / 9)',
          detail: `MACD ${g5(snapshot.macd)} vs signal; histogram ${g5(snapshot.macdHistogram)}.`,
          bias: snapshot.macd > snapshot.macdSignal ? 'buy' : snapshot.macd < snapshot.macdSignal ? 'sell' : 'neutral',
        },
        {
          label: 'ROC (9)',
          detail: `${snapshot.roc.toFixed(2)}% over nine bars.`,
          bias: snapshot.roc > 0 ? 'buy' : snapshot.roc < 0 ? 'sell' : 'neutral',
        },
        {
          label: 'Stochastic (14 / 3 / 3)',
          detail: `%K ${snapshot.stochK.toFixed(1)} / %D ${snapshot.stochD.toFixed(1)}.`,
          bias: snapshot.stochK > snapshot.stochD ? 'buy' : snapshot.stochK < snapshot.stochD ? 'sell' : 'neutral',
        },
      ]
    : [{ label: 'Momentum', detail: 'RSI, MACD, ROC and Stochastic are still warming up.', bias: 'neutral' }]

  const paReasons: SignalReason[] = [
    {
      label: 'Candle confirmation',
      detail: pa.narrative,
      bias: pa.bias === 'BULLISH' ? 'buy' : pa.bias === 'BEARISH' ? 'sell' : 'neutral',
    },
  ]

  const volumeReasons: SignalReason[] = snapshot
    ? [
        {
          label: 'Volume',
          detail: snapshot.volumeRatio !== null
            ? `${snapshot.volumeRatio.toFixed(2)}x the 20-bar average${snapshot.volumeRatio >= 1.2 ? ' — expansion confirmed.' : '.'}`
            : 'The feed does not report volume for this market.',
          bias: 'neutral',
        },
        {
          label: 'MFI (14)',
          detail: snapshot.mfi !== null
            ? `${snapshot.mfi.toFixed(1)} — ${snapshot.mfi >= 80 ? 'overbought' : snapshot.mfi <= 20 ? 'oversold' : 'balanced'} money flow.`
            : 'MFI is unavailable because the feed has no volume.',
          bias: snapshot.mfi !== null ? (snapshot.mfi > 50 ? 'buy' : snapshot.mfi < 50 ? 'sell' : 'neutral') : 'neutral',
        },
      ]
    : [{ label: 'Volume', detail: 'Volume and MFI are not available yet.', bias: 'neutral' }]

  const volatilityReasons: SignalReason[] = snapshot
    ? [
        {
          label: 'ATR & Bollinger',
          detail: `ATR ${g5(snapshot.atr)}; Bollinger width ${snapshot.bbWidth.toFixed(2)}% at the ${Math.round(regime.bbWidthPercentile * 100)}th percentile.`,
          bias: 'neutral',
        },
        {
          label: 'Keltner / Donchian',
          detail: `Keltner ${g5(snapshot.keltnerLower)}–${g5(snapshot.keltnerUpper)}; Donchian ${g5(snapshot.donchianLower)}–${g5(snapshot.donchianUpper)}. Volatility is ${regime.volatility.toLowerCase()}.`,
          bias: 'neutral',
        },
      ]
    : [{ label: 'Volatility', detail: 'Volatility channels are still warming up.', bias: 'neutral' }]

  const strategyReasonsOut: SignalReason[] = [
    {
      label: strategyName ? STRATEGY_LABELS[strategyName] : 'Trading playbook',
      detail: strategyName
        ? `Auto-selected as the best fit for ${regime.label.toLowerCase()} at ${score.strategy * 20}/100 fit.`
        : 'No playbook fits the current market context.',
      bias: direction === 'BUY' ? 'buy' : direction === 'SELL' ? 'sell' : 'neutral',
    },
    ...strategyReasons.slice(0, 3).map(reason => ({
      label: 'Why this playbook',
      detail: customerReason(reason),
      bias: direction === 'BUY' ? 'buy' as const : direction === 'SELL' ? 'sell' as const : 'neutral' as const,
    })),
  ]

  return [
    { id: 'regime', label: 'Market regime', bias: groupBias(score.regime, 15, direction), score: score.regime, max: 15, reasons: regimeReasons },
    { id: 'structure', label: 'Market structure', bias: groupBias(score.structure, 20, direction), score: score.structure, max: 20, reasons: structureReasons },
    { id: 'entry', label: 'Entry / SMC', bias: groupBias(score.entry, 20, direction), score: score.entry, max: 20, reasons: entryReasons },
    { id: 'momentum', label: 'Momentum', bias: groupBias(score.momentum, 15, direction), score: score.momentum, max: 15, reasons: momentumReasons },
    { id: 'priceAction', label: 'Price action', bias: groupBias(score.priceAction, 10, direction), score: score.priceAction, max: 10, reasons: paReasons },
    { id: 'volume', label: 'Volume', bias: groupBias(score.volume, 5, direction), score: score.volume, max: 5, reasons: volumeReasons },
    { id: 'volatility', label: 'Volatility & quality', bias: groupBias(score.volatility, 10, direction), score: score.volatility, max: 10, reasons: volatilityReasons },
    { id: 'strategy', label: 'Playbook fit', bias: groupBias(score.strategy, 5, direction), score: score.strategy, max: 5, reasons: strategyReasonsOut },
  ]
}

function toV3Result(analysis: V3Analysis): SignalResult {
  const bias: SignalBias = analysis.action === 'BUY' ? 'buy' : analysis.action === 'SELL' ? 'sell' : 'wait'
  const levels = analysis.levels
  const strategyLabel = analysis.strategyName ? STRATEGY_LABELS[analysis.strategyName] : 'No matching playbook'

  const headline = bias === 'wait'
    ? `No signal — ${shortReason(customerReason(analysis.reason))}`
    : `${analysis.action} · ${strategyLabel} — ${analysis.score.total.toFixed(0)}/100 (${analysis.score.band})`

  let summary = customerReason(analysis.reason)
  if (levels) {
    summary = `Entry zone ${g5(levels.entryZoneLow)}–${g5(levels.entryZoneHigh)} · Stop ${g5(levels.stopLoss)} · TP1 ${g5(levels.tp1)} (${levels.rrTp1.toFixed(2)}R, close 50%)`
      + (levels.tp2 !== null ? ` · TP2 ${g5(levels.tp2)} (${levels.rrTp2!.toFixed(2)}R)` : '')
      + (levels.tp3 !== null ? ` · TP3 ${g5(levels.tp3)} (${levels.rrTp3!.toFixed(2)}R)` : '')
      + ` · stop to ${g5(levels.breakevenStop)} after TP1.`
  }

  return {
    strategy: 'V3',
    symbol: analysis.symbol,
    timeframe: analysis.timeframe,
    generatedAt: new Date(analysis.generatedAt).toISOString(),
    bias,
    confidence: Math.round(analysis.score.total),
    headline,
    summary,
    groups: buildV3Groups(analysis),
    preview: false,
    action: analysis.action,
    view: analysis.view,
    score: analysis.score,
    levels,
    structure: analysis.structure,
    smc: analysis.smc,
    priceAction: analysis.priceAction,
    strategyName: analysis.strategyName,
    strategyReasons: analysis.strategyReasons.map(customerReason),
    requestedStrategy: analysis.requestedStrategy,
    riskProfile: analysis.riskProfile,
    suggestedRiskPercent: analysis.suggestedRiskPercent,
    regime: analysis.regime,
    reason: customerReason(analysis.reason),
    barTime: analysis.barTime,
    dataNotes: analysis.dataNotes,
    existingActive: analysis.existingActive,
    status: analysis.signal?.status ?? null,
    limits: {
      analyses: -1,
      signals: -1,
      bestSetups: -1,
      scans: -1,
    },
    openSignals: analysis.openSignals.map(summaryOf),
    bestSetups: analysis.bestSetups.map(summaryOf),
    history: analysis.history.map(item => ({
      signalId: item.signalId,
      symbol: item.symbol,
      timeframe: item.timeframe,
      direction: item.direction,
      status: item.status,
      score: item.score,
      entry: item.entry,
      stopLoss: item.stopLoss,
      tp1: item.tp1,
      tp2: item.tp2,
      tp3: item.tp3,
      strategyName: item.strategyName,
      barTime: item.barTime,
    })),
    candles: analysis.chartCandles,
    provider: analysis.provider || 'Yahoo Finance',
  }
}

/* --------------------------------------------------------------------- API --- */

/** V1 FREE analysis — one active signal at a time. */
export async function analyzeSignal({ symbol, timeframe }: AnalyzeInput): Promise<SignalResult> {
  const analysis = await api<V1Analysis>('/analyze', {
    method: 'POST',
    body: { symbol, timeframe },
  })
  return toV1Result(analysis)
}

/** V2 PLUS analysis — Plus and Pro only, up to 15 signals per day. */
export async function analyzeV2Signal({ symbol, timeframe }: AnalyzeInput): Promise<SignalResult> {
  const analysis = await api<V2Analysis>('/analyze/v2', {
    method: 'POST',
    body: { symbol, timeframe },
  })
  return toV2Result(analysis)
}

/** V2 PLUS multi-symbol market scan. Each symbol spends one scanner analysis. */
export async function scanV2(input: { timeframe: string; symbols?: string[] }): Promise<ScanResponse> {
  const result = await api<V2ScanResult>('/scan/v2', {
    method: 'POST',
    body: { timeframe: input.timeframe, symbols: input.symbols },
  })
  return {
    strategy: 'V2',
    timeframe: result.timeframe,
    scanned: result.scanned,
    scannedAt: new Date(result.scannedAt).toISOString(),
    remainingScans: limitsOf(result.remainingScans),
    provider: result.provider,
    notes: result.notes,
    setups: result.setups.map(setup => ({
      symbol: setup.symbol,
      timeframe: setup.timeframe,
      action: setup.action,
      view: setup.view,
      score: setup.score,
      band: setup.band,
      reason: customerReason(setup.reason),
      rrTp1: setup.rrTp1,
      result: toV2Result(setup.analysis),
    })),
  }
}

/** V3 PRO analysis — Pro only, unlimited analyses and signals. */
export async function analyzeV3Signal({ symbol, timeframe, playbook, riskProfile }: AnalyzeInput): Promise<SignalResult> {
  const analysis = await api<V3Analysis>('/analyze/v3', {
    method: 'POST',
    body: { symbol, timeframe, playbook, riskProfile },
  })
  return toV3Result(analysis)
}

/** V3 PRO multi-symbol market scan. Pro has no scanner cap. */
export async function scanV3(input: { timeframe: string; symbols?: string[]; playbook?: 'AUTO' | StrategyName; riskProfile?: ProRiskProfile }): Promise<ScanResponse> {
  const result = await api<V3ScanResult>('/scan/v3', {
    method: 'POST',
    body: { timeframe: input.timeframe, symbols: input.symbols, playbook: input.playbook, riskProfile: input.riskProfile },
  })
  return {
    strategy: 'V3',
    timeframe: result.timeframe,
    scanned: result.scanned,
    scannedAt: new Date(result.scannedAt).toISOString(),
    remainingScans: limitsOf(result.remainingScans),
    provider: result.provider,
    notes: result.notes,
    setups: result.setups.map(setup => ({
      symbol: setup.symbol,
      timeframe: setup.timeframe,
      action: setup.action,
      view: setup.view,
      score: setup.score,
      band: setup.band,
      strategyName: setup.strategyName,
      reason: customerReason(setup.reason),
      rrTp1: setup.rrTp1,
      result: toV3Result(setup.analysis),
    })),
  }
}
