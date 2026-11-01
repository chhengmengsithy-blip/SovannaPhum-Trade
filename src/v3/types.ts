/**
 * Shared V3 PRO strategy types.
 *
 * V3 is a separate engine from V1 FREE and V2 PLUS. It reuses only the
 * closed-candle/timeframe primitives, never their scoring or decision logic, so
 * all three strategies can evolve independently.
 *
 * Every value is JSON-safe: timestamps are Unix milliseconds, never `Date`.
 */

import type { Candle, MarketView, Timeframe } from '../v1/types.ts'
import type { KeyLevel } from '../shared/keyLevels.ts'

export type { Candle, MarketView, Timeframe }
export type { KeyLevel }

export const V3_STRATEGY = 'V3_PRO' as const

/** V3 PRO is unlimited. These constants exist so the UI can render "Unlimited". */
export const V3_DAILY_LIMITS = {
  analyses: -1,
  signals: -1,
  bestSetups: -1,
  scans: -1,
} as const

/** V3 keeps a deep history because Pro has no 30-day cap. */
export const V3_HISTORY_DAYS = 365

/** V3 runs on the Pro plan only. V1 stays on every plan, V2 stays on Plus. */
export function v3PlanAllowed(plan: string): boolean {
  return plan === 'pro'
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

export type StrategyName =
  | 'TREND_CONTINUATION'
  | 'BREAKOUT_RETEST'
  | 'PULLBACK_CONTINUATION'
  | 'FIBONACCI_RETRACEMENT'
  | 'SUPPLY_DEMAND'
  | 'SUPPORT_RESISTANCE_BOUNCE'
  | 'LIQUIDITY_SWEEP_REVERSAL'
  | 'RANGE_MEAN_REVERSION'
  | 'VOLATILITY_EXPANSION'

export const STRATEGY_LABELS: Record<StrategyName, string> = {
  TREND_CONTINUATION: 'Trend Continuation',
  BREAKOUT_RETEST: 'Breakout & Retest',
  PULLBACK_CONTINUATION: 'Pullback Continuation',
  FIBONACCI_RETRACEMENT: 'Fibonacci Retracement',
  SUPPLY_DEMAND: 'Supply & Demand',
  SUPPORT_RESISTANCE_BOUNCE: 'S/R Bounce',
  LIQUIDITY_SWEEP_REVERSAL: 'Liquidity Sweep Reversal',
  RANGE_MEAN_REVERSION: 'Range Mean Reversion',
  VOLATILITY_EXPANSION: 'Volatility Expansion',
}

export type ProRiskProfile = 'LOW' | 'MEDIUM' | 'HIGH'

export const PRO_RISK_LABELS: Record<ProRiskProfile, string> = {
  LOW: 'Low risk',
  MEDIUM: 'Medium risk',
  HIGH: 'High risk',
}

export type RegimeKind =
  | 'STRONG_BULL'
  | 'WEAK_BULL'
  | 'STRONG_BEAR'
  | 'WEAK_BEAR'
  | 'SIDEWAYS'
  | 'VOLATILITY_EXPANSION'
  | 'VOLATILITY_CONTRACTION'
  | 'TRANSITION'

export type VolatilityState = 'EXPANSION' | 'CONTRACTION' | 'NORMAL'

export type MarketRegime = {
  kind: RegimeKind
  label: string
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  strength: 'STRONG' | 'WEAK' | 'RANGE' | 'UNCLEAR'
  volatility: VolatilityState
  adx: number
  atrRatio: number
  bbWidthPercentile: number
  narrative: string
}

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
  roc: number
  keltnerUpper: number
  keltnerMiddle: number
  keltnerLower: number
  donchianUpper: number
  donchianMiddle: number
  donchianLower: number
  /** `null` when the feed has no usable volume (several FX feeds). */
  mfi: number | null
  close: number
  volume: number | null
  volumeMa: number | null
  volumeRatio: number | null
  barTime: number | null
}

/** V3 weighted score, exactly 100 points. */
export type Score = {
  regime: number
  structure: number
  entry: number
  momentum: number
  priceAction: number
  volume: number
  volatility: number
  strategy: number
  total: number
  band: ScoreBand
  volumeConfirmed: boolean
  volumeRatio: number | null
  strategyName: StrategyName | null
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

export type BreakerBlock = {
  /** The direction price is expected to react in on the retest. */
  direction: 'BULLISH' | 'BEARISH'
  low: number
  high: number
  index: number
  confirmIndex: number
  time: number | null
  mitigated: boolean
}

export type MitigationBlock = {
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
  breakers: BreakerBlock[]
  mitigationBlocks: MitigationBlock[]
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
  | 'STRONG_CLOSE'
  | 'BREAKOUT'
  | 'RETEST'
  | 'FAILED_BREAKOUT'

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

export type StrategySelection = {
  name: StrategyName
  direction: TradeAction
  /** 0–100 fit score used by the 5-point strategy component. */
  fit: number
  reasons: string[]
}

export type Signal = {
  strategy: typeof V3_STRATEGY
  signalId: string
  symbol: string
  timeframe: Timeframe
  direction: TradeAction
  status: SignalStatus
  strategyName: StrategyName
  riskProfile?: ProRiskProfile
  suggestedRiskPercent?: number
  regime: MarketRegime
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

export type SignalHistoryItem = {
  signalId: string
  symbol: string
  timeframe: string
  direction: TradeAction
  status: SignalStatus
  strategyName: StrategyName
  riskProfile?: ProRiskProfile
  score: number
  entry: number
  stopLoss: number
  tp1: number
  tp2: number | null
  tp3: number | null
  barTime: number
}

export type V3Analysis = {
  strategy: typeof V3_STRATEGY
  symbol: string
  timeframe: Timeframe
  action: AnalysisAction
  view: MarketView
  strategyName: StrategyName | null
  requestedStrategy?: StrategyName | null
  riskProfile?: ProRiskProfile
  suggestedRiskPercent?: number
  strategyReasons: string[]
  regime: MarketRegime
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
  /** The ACTIVE signal already occupying this symbol+timeframe slot, if any. */
  existingActive: Signal | null
  /** Open (not yet resolved) V3 signals for this account. */
  openSignals: Signal[]
  /** Today's highest-scoring persisted setups, best first. */
  bestSetups: Signal[]
  /** Recent BUY/SELL history for the chart overlay. */
  history: SignalHistoryItem[]
  /** Last closed candles used for the companion signal chart. */
  chartCandles: Candle[]
  /** -1 means unlimited. */
  remainingAnalyses: number
  /** -1 means unlimited. */
  remainingSignals: number
  /** -1 means unlimited. */
  remainingBestSetups: number
  /** -1 means unlimited. */
  remainingScans: number
  provider?: string
}

export type ScanSetup = {
  symbol: string
  timeframe: Timeframe
  action: AnalysisAction
  view: MarketView
  strategyName: StrategyName | null
  score: number
  band: ScoreBand
  reason: string
  barTime: number | null
  rrTp1: number | null
  levels: Levels | null
  analysis: V3Analysis
}

export type ScanResult = {
  strategy: typeof V3_STRATEGY
  timeframe: Timeframe
  scannedAt: number
  scanned: number
  setups: ScanSetup[]
  remainingScans: number
  provider: string
  notes: string[]
}

export type MarketClass = 'GOLD' | 'ENERGY' | 'FOREX' | 'BTC'

/** V3 keeps the V2 risk buffers: swing + ATR, market specific. */
export const V3_ATR_BUFFER: Record<MarketClass, number> = {
  GOLD: 0.25,
  ENERGY: 0.28,
  FOREX: 0.2,
  BTC: 0.3,
}

export const V3_MAX_RISK_FRACTION: Record<MarketClass, number> = {
  GOLD: 0.04,
  ENERGY: 0.045,
  FOREX: 0.025,
  BTC: 0.07,
}

/** Same bucketing as V1/V2 so a symbol is never treated as two classes. */
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
