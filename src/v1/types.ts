/**
 * Shared V1 FREE strategy types.
 *
 * The same file is used by the browser bundle and by the Node server, so every
 * timestamp is a Unix millisecond number (never a `Date`) and every field is
 * JSON-safe. The engine itself is a pure function of these values.
 */

export type Timeframe = '5m' | '15m' | '30m' | '1H' | '4H'

export const TIMEFRAMES: readonly Timeframe[] = ['5m', '15m', '30m', '1H', '4H']

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '5m': 5 * 60,
  '15m': 15 * 60,
  '30m': 30 * 60,
  '1H': 60 * 60,
  '4H': 4 * 60 * 60,
}

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === 'string' && (TIMEFRAMES as readonly string[]).includes(value)
}

export type TradeAction = 'BUY' | 'SELL'
export type AnalysisAction = 'BUY' | 'SELL' | 'NO_SIGNAL'
export type MarketView = 'BULLISH' | 'BEARISH' | 'RANGING'
export type BreakKind = 'BOS' | 'CHOCH'
export type ScoreBand = 'NO_SIGNAL' | 'VALID' | 'STRONG'

export type SignalStatus =
  | 'ACTIVE'
  | 'TP1_HIT'
  | 'TP2_HIT'
  | 'TP3_HIT'
  | 'STOP_LOSS_HIT'
  | 'CLOSED'
  | 'CANCELLED'

/** One closed OHLCV candle. `time` is the bar CLOSE time in epoch ms. */
export type Candle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
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
  time: number | null
}

export type Structure = {
  view: MarketView
  bias: MarketView
  support: number | null
  resistance: number | null
  rangeHigh: number | null
  rangeLow: number | null
  lastBos: BreakEvent | null
  lastChoch: BreakEvent | null
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
  close: number
  volume: number | null
  volumeMa: number | null
  volumeRatio: number | null
  barTime: number | null
}

export type Score = {
  ema: number
  momentum: number
  supertrend: number
  structure: number
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
  allocations: number[]
  breakevenStop: number
  references: string[]
}

export type Signal = {
  signalId: string
  symbol: string
  timeframe: Timeframe
  direction: TradeAction
  status: SignalStatus
  score: Score
  levels: Levels
  structure: Structure
  indicators: IndicatorSnapshot
  reasons: string[]
  barTime: number
  createdAt: number
  updatedAt: number
  currentStopLoss: number | null
  breakevenApplied: boolean
}

export type V1Analysis = {
  symbol: string
  timeframe: Timeframe
  action: AnalysisAction
  view: MarketView
  score: Score
  structure: Structure
  indicators: IndicatorSnapshot | null
  levels: Levels | null
  signal: Signal | null
  reason: string
  dataOk: boolean
  dataNotes: string[]
  barTime: number | null
  generatedAt: number
  existingActive: Signal | null
  /** -1 means the plan has no daily cap. */
  remainingAnalyses: number
  /** -1 means the plan has no daily cap. */
  remainingSignals: number
  /** Human-readable candle source, when the server supplied one. */
  provider?: string
  /** Last closed candles used for the analysis (for chart overlay). */
  candles?: Candle[]
}

export type MarketClass = 'GOLD' | 'ENERGY' | 'FOREX' | 'BTC'

export const MARKET_ATR_BUFFER: Record<MarketClass, number> = {
  GOLD: 0.2,
  ENERGY: 0.22,
  FOREX: 0.15,
  BTC: 0.25,
}

export const MARKET_MAX_RISK_FRACTION: Record<MarketClass, number> = {
  GOLD: 0.03,
  ENERGY: 0.035,
  FOREX: 0.02,
  BTC: 0.06,
}

/** Classify a ticker into the V1 risk buckets. */
export function marketClass(symbol: string): MarketClass {
  const text = symbol.toUpperCase()
  if (text.includes('XAU') || text.includes('XAG') || text.includes('GOLD') || text.includes('SILVER')) {
    return 'GOLD'
  }
  if (text.includes('OIL') || text.includes('WTI') || text.includes('BRENT')) return 'ENERGY'
  if (['BTC', 'XBT', 'ETH', 'SOL', 'XRP'].some(token => text.includes(token))) return 'BTC'
  return 'FOREX'
}

/** Format a price the way the V1 reference (`:.5g`) does. */
export function g5(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return String(Number(value.toPrecision(5)))
}
