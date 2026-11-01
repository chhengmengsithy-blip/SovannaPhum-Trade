/**
 * Shared V2 PLUS strategy types.
 *
 * V2 is a separate engine from V1 FREE. It reuses only the closed-candle
 * primitive and timeframe helpers, never V1's scoring or decision logic, so the
 * two strategies can evolve independently.
 *
 * Every value here is JSON-safe: timestamps are Unix milliseconds, never `Date`.
 */

import type { Candle, MarketView, Timeframe } from '../v1/types.ts'
import type { KeyLevel } from '../shared/keyLevels.ts'

export type { Candle, MarketView, Timeframe }
export type { KeyLevel }

export const V2_STRATEGY = 'V2_PLUS' as const

/** PLUS limits, kept in a pure module so both the server and tests agree. */
export const V2_ANALYSES_PER_DAY = 50
export const V2_SIGNALS_PER_DAY = 15
export const V2_BEST_SETUPS_PER_DAY = 10
export const V2_SCANS_PER_DAY = 20
export const V2_SCAN_SYMBOL_LIMIT = 12

/** V2 runs on Plus only. Pro is routed to V3 PRO instead. */
export function v2PlanAllowed(plan: string): boolean {
  return plan === 'plus'
}

export type AnalysisAction = 'BUY' | 'SELL' | 'NO_SIGNAL'
export type TradeAction = 'BUY' | 'SELL'
export type BreakKind = 'BOS' | 'CHOCH' | 'MSS'
export type ScoreBand = 'NO_SIGNAL' | 'VALID' | 'STRONG'

export type SignalStatus =
  | 'ACTIVE'
  | 'TP1_HIT'
  | 'TP2_HIT'
  | 'TP3_HIT'
  | 'STOP_LOSS_HIT'
  | 'CLOSED'
  | 'CANCELLED'

export type SwingPoint = {
  kind: 'HIGH' | 'LOW'
  index: number
  confirmIndex: number
  price: number
  label: string
  time: number | null
}

export type BreakEvent = {
  kind: BreakKind
  direction: MarketView
  level: number
  pivotIndex: number
  confirmIndex: number
  confirmPrice: number
  displacement: boolean
  time: number | null
}

export type Structure = {
  view: MarketView
  bias: MarketView
  support: number | null
  resistance: number | null
  rangeHigh: number | null
  rangeLow: number | null
  equilibrium: number | null
  keyLevels: KeyLevel[]
  lastBos: BreakEvent | null
  lastChoch: BreakEvent | null
  lastMss: BreakEvent | null
  swingHighs: SwingPoint[]
  swingLows: SwingPoint[]
  recentLabels: string[]
  narrative: string
}

export type IndicatorSnapshot = {
  ema20: number
  ema50: number
  ema200: number
  rsi: number
  macd: number
  macdSignal: number
  macdHistogram: number
  supertrend: number
  supertrendDirection: number
  atr: number
  adx: number
  plusDi: number
  minusDi: number
  vwap: number
  bbUpper: number
  bbMiddle: number
  bbLower: number
  bbWidth: number
  stochK: number
  stochD: number
  close: number
  volume: number | null
  volumeMa: number | null
  volumeRatio: number | null
  barTime: number | null
}

export type Score = {
  trend: number
  momentum: number
  supertrend: number
  structure: number
  smc: number
  priceAction: number
  total: number
  band: ScoreBand
  volumeConfirmed: boolean
  volumeRatio: number | null
}

export type Levels = {
  entryZoneLow: number
  entryZoneHigh: number
  entry: number
  stopLoss: number
  tp1: number
  tp2: number | null
  tp3: number | null
  risk: number
  rrTp1: number
  rrTp2: number | null
  rrTp3: number | null
  /** TP1 always takes 50%; the remainder is split across TP2/TP3. */
  allocations: number[]
  breakevenStop: number
  references: string[]
  tp1CloseFraction: number
}

export type FairValueGap = {
  direction: 'BULLISH' | 'BEARISH'
  low: number
  high: number
  index: number
  confirmIndex: number
  time: number | null
  mitigated: boolean
}

export type OrderBlock = {
  direction: 'BULLISH' | 'BEARISH'
  low: number
  high: number
  index: number
  confirmIndex: number
  time: number | null
  mitigated: boolean
}

export type LiquidityLevel = {
  kind: 'EQH' | 'EQL'
  price: number
  index: number
  confirmIndex: number
  time: number | null
  swept: boolean
}

export type LiquiditySweep = {
  /** BULLISH means sell-side liquidity below a low was swept. */
  direction: 'BULLISH' | 'BEARISH'
  level: number
  index: number
  time: number | null
  source: 'EQH' | 'EQL' | 'SWING'
}

export type PremiumDiscount = 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM'

export type SMCMap = {
  fvgs: FairValueGap[]
  orderBlocks: OrderBlock[]
  equalHighs: LiquidityLevel[]
  equalLows: LiquidityLevel[]
  sweeps: LiquiditySweep[]
  premiumDiscount: PremiumDiscount
  equilibrium: number | null
  dealingRangeHigh: number | null
  dealingRangeLow: number | null
  narrative: string
}

export type PriceActionKind =
  | 'ENGULFING'
  | 'PIN_BAR'
  | 'REJECTION'
  | 'INSIDE_BAR'
  | 'OUTSIDE_BAR'
  | 'BREAKOUT'
  | 'RETEST'

export type PriceActionEvent = {
  kind: PriceActionKind
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  index: number
  time: number | null
  detail: string
}

export type PriceAction = {
  events: PriceActionEvent[]
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  narrative: string
}

export type Signal = {
  strategy: typeof V2_STRATEGY
  signalId: string
  symbol: string
  timeframe: Timeframe
  direction: TradeAction
  status: SignalStatus
  score: Score
  levels: Levels
  structure: Structure
  smc: SMCMap
  priceAction: PriceAction
  indicators: IndicatorSnapshot
  reasons: string[]
  barTime: number
  createdAt: number
  updatedAt: number
  currentStopLoss: number | null
  breakevenApplied: boolean
  /** Cumulative fraction of the position closed by targets or a final stop. */
  closedFraction: number
  /** Last candle already processed by the lifecycle, so bars are never replayed. */
  lastEvaluatedBar: number
}

export type V2Analysis = {
  strategy: typeof V2_STRATEGY
  symbol: string
  timeframe: Timeframe
  action: AnalysisAction
  view: MarketView
  score: Score
  structure: Structure
  smc: SMCMap
  priceAction: PriceAction
  indicators: IndicatorSnapshot | null
  levels: Levels | null
  signal: Signal | null
  reason: string
  dataOk: boolean
  dataNotes: string[]
  barTime: number | null
  generatedAt: number
  /** V2 allows multiple concurrent setups, so this stays null. */
  existingActive: Signal | null
  /** Open (not yet resolved) V2 signals for this account. */
  openSignals: Signal[]
  /** Today's highest-scoring persisted setups, best first. */
  bestSetups: Signal[]
  /** -1 means unlimited. */
  remainingAnalyses: number
  /** -1 means unlimited. */
  remainingSignals: number
  /** -1 means unlimited. */
  remainingBestSetups: number
  /** -1 means unlimited. */
  remainingScans: number
  provider?: string
  /** Last closed candles used for the analysis (for chart overlay). */
  candles?: Candle[]
}

export type ScanSetup = {
  symbol: string
  timeframe: Timeframe
  action: AnalysisAction
  view: MarketView
  score: number
  band: ScoreBand
  reason: string
  barTime: number | null
  rrTp1: number | null
  levels: Levels | null
  analysis: V2Analysis
}

export type ScanResult = {
  strategy: typeof V2_STRATEGY
  timeframe: Timeframe
  scannedAt: number
  scanned: number
  setups: ScanSetup[]
  remainingScans: number
  provider: string
  notes: string[]
}

export type MarketClass = 'GOLD' | 'ENERGY' | 'FOREX' | 'BTC'

/** V2 risk buffers are wider than V1 by design. */
export const V2_ATR_BUFFER: Record<MarketClass, number> = {
  GOLD: 0.25,
  ENERGY: 0.28,
  FOREX: 0.2,
  BTC: 0.3,
}

export const V2_MAX_RISK_FRACTION: Record<MarketClass, number> = {
  GOLD: 0.04,
  ENERGY: 0.045,
  FOREX: 0.025,
  BTC: 0.07,
}

/** Same bucketing as V1 so a symbol is never treated as two different classes. */
export function marketClass(symbol: string): MarketClass {
  const text = symbol.toUpperCase()
  if (text.includes('XAU') || text.includes('XAG') || text.includes('GOLD') || text.includes('SILVER')) {
    return 'GOLD'
  }
  if (text.includes('OIL') || text.includes('WTI') || text.includes('BRENT')) return 'ENERGY'
  if (['BTC', 'XBT', 'ETH', 'SOL', 'XRP'].some(token => text.includes(token))) return 'BTC'
  return 'FOREX'
}

export function g5(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return String(Number(value.toPrecision(5)))
}
