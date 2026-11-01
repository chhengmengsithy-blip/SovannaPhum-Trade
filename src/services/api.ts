export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      method: options.method || 'GET',
      credentials: 'include',
      headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch {
    throw new ApiError(0, 'Live services are unavailable. Check your internet and try again.')
  }

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const message = data && typeof data.error === 'string' ? data.error : `Request failed (${response.status}).`
    throw new ApiError(response.status, message)
  }
  return data as T
}

export type KhqrConfig = {
  bakongId: string
  merchantName: string
  city: string
  demo: boolean
  ready: boolean
}

export type PaymentRecord = {
  id: string
  plan: 'plus' | 'pro'
  amount: number
  currency: string
  billNumber: string
  status: 'pending' | 'paid' | 'failed' | 'expired'
  qrPayload: string
  demo: boolean
  createdAt: string
  paidAt?: string
}

export type AdminPayment = PaymentRecord & { email: string }

export type SignalHistoryItem = {
  signalId: string
  engine: 'V1' | 'V2' | 'V3'
  symbol: string
  timeframe: string
  direction: 'BUY' | 'SELL'
  status: string
  strategyName: string | null
  riskProfile: 'LOW' | 'MEDIUM' | 'HIGH' | null
  score: number
  entry: number
  stopLoss: number
  tp1: number
  tp2: number | null
  tp3: number | null
  barTime: number
  createdAt: number
}

export type SignalsResponse = {
  open: SignalHistoryItem[]
  history: SignalHistoryItem[]
}

export async function fetchSignals(filters?: { symbol?: string; timeframe?: string }): Promise<SignalsResponse> {
  const params = new URLSearchParams()
  if (filters?.symbol) params.set('symbol', filters.symbol)
  if (filters?.timeframe) params.set('timeframe', filters.timeframe)
  if (filters?.symbol || filters?.timeframe) params.set('limit', '5000')
  const query = params.size ? `?${params}` : ''
  return api<SignalsResponse>(`/signals${query}`)
}

export type ProResearchReport = {
  engine: string
  generatedAt: string
  symbol: string
  timeframe: string
  candles: number
  market: {
    trend: string
    researchDirection: string
    close: number
    atr14: number
    volatilityPercent: number
    volumeRatio: number
    support: number
    resistance: number
    rangePosition: number
  }
  fibonacci: Record<string, number>
  risk: { profile: 'LOW' | 'MEDIUM' | 'HIGH'; suggestedRiskPercent: number; qualityFloor: number; minimumR: number }
  playbooks: Array<{ id: string; label: string; score: number; detail: string }>
  disclaimer: string
}

export async function runProResearch(input: {
  symbol: string
  timeframe: string
  playbook: string
  riskProfile: 'LOW' | 'MEDIUM' | 'HIGH'
}): Promise<ProResearchReport> {
  return api<ProResearchReport>('/pro/research', { method: 'POST', body: input })
}

export type PlatformHealth = {
  ok: boolean
  users: number
  paidPayments: number
  bakongConfigured: boolean
  khqrReady: boolean
  time: string
}

export type PublicMarketQuote = {
  symbol: string
  price: number | null
  time: number | null
  change24h: number | null
  available: boolean
}

export type PublicMarketResponse = {
  connected: boolean
  provider: string
  updatedAt: number
  markets: PublicMarketQuote[]
  series?: {
    symbol: string
    timeframe: string
    candles: Array<{ time: number; close: number }>
  }
}

export async function fetchPlatformHealth(): Promise<PlatformHealth> {
  return api<PlatformHealth>('/health')
}

export async function fetchPublicMarkets(): Promise<PublicMarketResponse> {
  return api<PublicMarketResponse>('/market/public')
}
