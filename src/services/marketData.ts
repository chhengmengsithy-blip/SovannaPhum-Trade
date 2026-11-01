import { useEffect, useRef, useState, useCallback } from 'react'

export interface PriceUpdate {
  type: 'price'
  symbol: string
  price: number
  time: number
  change24h: number
}

export interface MarketSubscription {
  subscribe: (symbols: string[]) => void
  unsubscribe: (symbols: string[]) => void
  prices: Map<string, { price: number; time: number; change24h: number }>
  connected: boolean
  error: string | null
}

export function useMarketData(): MarketSubscription {
  const wsRef = useRef<WebSocket | null>(null)
  const subscriptionsRef = useRef<Set<string>>(new Set())
  const [prices, setPrices] = useState<Map<string, { price: number; time: number; change24h: number }>>(new Map())
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const reconnectAttemptsRef = useRef(0)

  const connect = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws/market`
    const ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      setConnected(true)
      setError(null)
      reconnectAttemptsRef.current = 0

      // Resubscribe to previous symbols
      if (subscriptionsRef.current.size > 0) {
        ws.send(JSON.stringify({
          type: 'subscribe',
          symbols: Array.from(subscriptionsRef.current),
        }))
      }
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as {
          type?: string
          symbol?: unknown
          price?: unknown
          time?: unknown
          change24h?: unknown
          message?: unknown
        }
        if (
          msg.type === 'price'
          && typeof msg.symbol === 'string'
          && typeof msg.price === 'number'
          && Number.isFinite(msg.price)
          && typeof msg.time === 'number'
          && Number.isFinite(msg.time)
        ) {
          const symbol = msg.symbol.toUpperCase()
          const price = msg.price
          const time = msg.time
          const change24h = typeof msg.change24h === 'number' && Number.isFinite(msg.change24h) ? msg.change24h : 0
          setPrices(prev => {
            const next = new Map(prev)
            next.set(symbol, { price, time, change24h })
            return next
          })
          setError(null)
        } else if (msg.type === 'market-error' && typeof msg.message === 'string') {
          setError(msg.message)
        }
      } catch {
        // Ignore malformed frames; valid market frames are schema-checked above.
      }
    }

    ws.onclose = event => {
      setConnected(false)
      wsRef.current = null
      if (event.code === 1008) {
        setError('Live market stream requires an active session.')
        return
      }
      // Attempt reconnect with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000)
      reconnectTimeoutRef.current = window.setTimeout(() => {
        reconnectAttemptsRef.current++
        connect()
      }, delay)
    }

    ws.onerror = () => {
      setError('Live quote stream is reconnecting…')
    }

    wsRef.current = ws
  }, [])

  const subscribe = useCallback((symbols: string[]) => {
    const upper = symbols.map(s => s.toUpperCase())
    symbols.forEach(s => subscriptionsRef.current.add(s.toUpperCase()))
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'subscribe',
        symbols: upper,
      }))
    }
  }, [])

  const unsubscribe = useCallback((symbols: string[]) => {
    const upper = symbols.map(s => s.toUpperCase())
    symbols.forEach(s => subscriptionsRef.current.delete(s.toUpperCase()))
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'unsubscribe',
        symbols: upper,
      }))
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current)
      const ws = wsRef.current
      if (ws) {
        // Detach handlers first so the teardown does not schedule a reconnect.
        ws.onopen = null
        ws.onmessage = null
        ws.onclose = null
        ws.onerror = null
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
      }
      wsRef.current = null
    }
  }, [connect])

  return {
    subscribe,
    unsubscribe,
    prices,
    connected,
    error,
  }
}

// Hook for a specific symbol's live price
export function useSymbolPrice(symbol: string | null) {
  const { prices, subscribe, unsubscribe, connected, error } = useMarketData()
  const [priceData, setPriceData] = useState<{ price: number; time: number; change24h: number } | null>(null)

  useEffect(() => {
    if (!symbol) return
    const upper = symbol.toUpperCase()
    subscribe([upper])
    return () => {
      unsubscribe([upper])
    }
  }, [symbol, subscribe, unsubscribe])

  // Update local state when prices change, and clear it when switching markets.
  useEffect(() => {
    if (!symbol) {
      setPriceData(null)
      return
    }
    setPriceData(prices.get(symbol.toUpperCase()) ?? null)
  }, [prices, symbol])

  return { priceData, connected, error }
}

// Hook for historical candles
export async function fetchCandles(symbol: string, timeframe: string, limit = 500) {
  const params = new URLSearchParams({ symbol, timeframe, limit: String(limit) })
  const res = await fetch(`/api/market/candles?${params}`, {
    credentials: 'include',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: unknown } | null
    throw new Error(typeof body?.error === 'string' ? body.error : `Failed to fetch candles (${res.status}).`)
  }
  return res.json()
}

export async function fetchCurrentPrice(symbol: string) {
  const params = new URLSearchParams({ symbol })
  const res = await fetch(`/api/market/price?${params}`, {
    credentials: 'include',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: unknown } | null
    throw new Error(typeof body?.error === 'string' ? body.error : `Failed to fetch price (${res.status}).`)
  }
  return res.json()
}
