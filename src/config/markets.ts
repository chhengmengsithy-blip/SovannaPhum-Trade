export type MarketKind = 'gold' | 'energy' | 'forex' | 'crypto' | 'indices'

export type MarketDefinition = {
  name: string
  symbol: string
  kind: MarketKind
}

export const markets: MarketDefinition[] = [
  { name: 'Gold', symbol: 'XAUUSD', kind: 'gold' },
  { name: 'Silver', symbol: 'XAGUSD', kind: 'gold' },
  { name: 'WTI Crude Oil', symbol: 'USOIL', kind: 'energy' },
  { name: 'EUR / USD', symbol: 'EURUSD', kind: 'forex' },
  { name: 'GBP / USD', symbol: 'GBPUSD', kind: 'forex' },
  { name: 'USD / JPY', symbol: 'USDJPY', kind: 'forex' },
  { name: 'AUD / USD', symbol: 'AUDUSD', kind: 'forex' },
  { name: 'Bitcoin', symbol: 'BTCUSD', kind: 'crypto' },
  { name: 'Ethereum', symbol: 'ETHUSD', kind: 'crypto' },
  { name: 'Solana', symbol: 'SOLUSD', kind: 'crypto' },
  { name: 'XRP', symbol: 'XRPUSD', kind: 'crypto' },
  { name: 'US 100', symbol: 'US100', kind: 'indices' },
]

export const timeframes = ['5m', '15m', '30m', '1H', '4H'] as const

export function formatLivePrice(symbol: string, price: number): string {
  if (!Number.isFinite(price)) return '—'
  if (symbol === 'USDJPY') return price.toFixed(3)
  if (symbol === 'XAUUSD' || symbol === 'XAGUSD' || symbol === 'USOIL' || symbol === 'US100') return price.toFixed(2)
  if (['EURUSD', 'GBPUSD', 'AUDUSD'].includes(symbol)) return price.toFixed(5)
  return price.toFixed(2)
}
