import { useEffect, useRef, useState } from 'react'
import { Focus, Maximize2, Minimize2, ZoomOut } from 'lucide-react'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
} from 'lightweight-charts'
import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  LineWidth,
  MouseEventParams,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from 'lightweight-charts'
import type { SignalHistoryItem } from '../../services/api'
import type { SignalResult } from '../../strategy'
import { fetchCandles } from '../../services/marketData'
import { formatCambodiaChartTime } from '../../marketSession'

export type CandleData = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type LivePrice = {
  price: number
  time: number
  change24h?: number
}

type HistoricalResponse = {
  symbol: string
  timeframe: string
  candles: CandleData[]
  provider: string
}

type Props = {
  symbol: string
  timeframe: string
  analysis: SignalResult | null
  existingSignals?: SignalHistoryItem[]
  livePrice?: LivePrice | null
  streamConnected?: boolean
  height?: number
}

type CandleApi = ISeriesApi<'Candlestick', Time>
type VolumeApi = ISeriesApi<'Histogram', Time>
type MarkersApi = ISeriesMarkersPluginApi<Time>

const TIMEFRAME_MS: Record<string, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1H': 60 * 60_000,
  '4H': 4 * 60 * 60_000,
}

function asTime(milliseconds: number): UTCTimestamp {
  return Math.floor(milliseconds / 1000) as UTCTimestamp
}

function precisionFor(symbol: string): number {
  if (symbol === 'USDJPY') return 3
  if (['EURUSD', 'GBPUSD', 'AUDUSD', 'XRPUSD'].includes(symbol)) return 5
  return 2
}

function validCandle(value: CandleData): boolean {
  return Number.isFinite(value.time)
    && Number.isFinite(value.open)
    && Number.isFinite(value.high)
    && Number.isFinite(value.low)
    && Number.isFinite(value.close)
    && value.time > 0
    && value.open > 0
    && value.close > 0
    && value.high >= Math.max(value.open, value.close)
    && value.low <= Math.min(value.open, value.close)
}

function normaliseCandles(values: CandleData[]): CandleData[] {
  const byTime = new Map<number, CandleData>()
  for (const value of values) {
    if (!validCandle(value)) continue
    byTime.set(value.time, { ...value, volume: Number.isFinite(value.volume) ? value.volume : 0 })
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time)
}

function candlePoint(candle: CandleData) {
  return {
    time: asTime(candle.time),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  }
}

function volumePoint(candle: CandleData) {
  return {
    time: asTime(candle.time),
    value: candle.volume || 0,
    color: candle.close >= candle.open
      ? 'rgba(66, 198, 165, 0.42)'
      : 'rgba(240, 116, 128, 0.42)',
  }
}

export default function LightweightChart({
  symbol,
  timeframe,
  analysis,
  existingSignals = [],
  livePrice = null,
  streamConnected = false,
  height = 500,
}: Props) {
  const shellRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<CandleApi | null>(null)
  const volumeSeriesRef = useRef<VolumeApi | null>(null)
  const markersRef = useRef<MarkersApi | null>(null)
  const signalLinesRef = useRef<IPriceLine[]>([])
  const lastPriceLineRef = useRef<IPriceLine | null>(null)
  const formingCandleRef = useRef<CandleData | null>(null)
  const fittedMarketRef = useRef('')
  const focusedSignalRef = useRef('')
  const requestSequenceRef = useRef(0)

  const [candles, setCandles] = useState<CandleData[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState('')
  const [retry, setRetry] = useState(0)
  const [chartReady, setChartReady] = useState(false)
  const [hoveredCandle, setHoveredCandle] = useState<Pick<CandleData, 'open' | 'high' | 'low' | 'close'> | null>(null)
  const [fullscreen, setFullscreen] = useState(false)

  // The chart REST endpoint calls the exact same fetchCandles function used by
  // V1/V2/V3. Refreshing replaces only display data; engines still evaluate
  // their immutable closed-candle arrays on the server.
  useEffect(() => {
    let cancelled = false
    const sequence = requestSequenceRef.current + 1
    requestSequenceRef.current = sequence

    const load = async (initial: boolean) => {
      if (initial) {
        setStatus('loading')
        setErrorMessage('')
        setCandles([])
      }
      try {
        const response = await fetchCandles(symbol, timeframe, 10_000) as HistoricalResponse
        if (cancelled || requestSequenceRef.current !== sequence) return
        const next = normaliseCandles(Array.isArray(response.candles) ? response.candles : [])
        if (!next.length) throw new Error(`No closed candles returned for ${symbol} ${timeframe}.`)
        setCandles(next)
        setStatus('ready')
        setErrorMessage('')
      } catch (error) {
        if (cancelled || requestSequenceRef.current !== sequence) return
        if (initial) {
          setStatus('error')
          setErrorMessage(error instanceof Error ? error.message : 'Failed to load market data.')
        }
      }
    }

    void load(true)
    const refresh = window.setInterval(() => void load(false), 60_000)
    return () => {
      cancelled = true
      window.clearInterval(refresh)
    }
  }, [retry, symbol, timeframe])

  // An analysis response includes the precise closed candles evaluated by the
  // strategy. Reusing them guarantees the visible bars and calculations match.
  useEffect(() => {
    if (!analysis?.candles?.length) return
    if (analysis.symbol.toUpperCase() !== symbol.toUpperCase() || analysis.timeframe !== timeframe) return
    const exact = normaliseCandles(analysis.candles)
    if (exact.length) {
      setCandles(exact)
      setStatus('ready')
      setErrorMessage('')
    }
  }, [analysis, symbol, timeframe])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const precision = precisionFor(symbol)
    const chart = createChart(container, {
      autoSize: true,
      width: container.clientWidth || 800,
      height: container.clientHeight || height,
      layout: {
        background: { type: ColorType.Solid, color: '#081625' },
        textColor: '#8fa5bf',
        fontSize: 11,
        fontFamily: "'DM Sans', system-ui, sans-serif",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(35, 65, 94, 0.42)' },
        horzLines: { color: 'rgba(35, 65, 94, 0.42)' },
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: '#52708f', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#23415f' },
        horzLine: { color: '#52708f', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#23415f' },
      },
      rightPriceScale: {
        borderColor: '#1d344c',
        scaleMargins: { top: 0.08, bottom: 0.17 },
        autoScale: true,
      },
      timeScale: {
        borderColor: '#1d344c',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time) => formatCambodiaChartTime(Number(time)),
        rightOffset: 8,
        barSpacing: 6,
        minBarSpacing: 1.5,
        lockVisibleTimeRangeOnResize: true,
      },
      localization: {
        locale: 'en-US',
        timeFormatter: (time: Time) => formatCambodiaChartTime(Number(time)),
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true } },
    })

    const candlesApi = chart.addSeries(CandlestickSeries, {
      upColor: '#42c6a5',
      downColor: '#f07480',
      borderUpColor: '#42c6a5',
      borderDownColor: '#f07480',
      wickUpColor: '#69d8bb',
      wickDownColor: '#f4939c',
      priceFormat: { type: 'price', precision, minMove: 10 ** -precision },
      priceScaleId: 'right',
      priceLineVisible: false,
      lastValueVisible: false,
    })
    const volumeApi = chart.addSeries(HistogramSeries, {
      color: 'rgba(56, 189, 248, 0.35)',
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    })
    volumeApi.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } })

    const markers = createSeriesMarkers(candlesApi, [])
    const handleCrosshairMove = (param: MouseEventParams<Time>) => {
      const point = param.seriesData.get(candlesApi)
      if (
        point
        && 'open' in point
        && 'high' in point
        && 'low' in point
        && 'close' in point
      ) {
        setHoveredCandle({
          open: Number(point.open),
          high: Number(point.high),
          low: Number(point.low),
          close: Number(point.close),
        })
      } else {
        setHoveredCandle(null)
      }
    }
    chart.subscribeCrosshairMove(handleCrosshairMove)
    chartRef.current = chart
    candleSeriesRef.current = candlesApi
    volumeSeriesRef.current = volumeApi
    markersRef.current = markers
    setChartReady(true)

    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshairMove)
      markers.detach()
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
      markersRef.current = null
      signalLinesRef.current = []
      lastPriceLineRef.current = null
      formingCandleRef.current = null
      setChartReady(false)
    }
  }, [height, symbol])

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === shellRef.current)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    formingCandleRef.current = null
  }, [symbol, timeframe])

  // Replace the closed series without changing the user's visible range after
  // the initial fit. Markers are chart-native and remain candle-anchored.
  useEffect(() => {
    const chart = chartRef.current
    const candlesApi = candleSeriesRef.current
    const volumeApi = volumeSeriesRef.current
    if (!chartReady || !chart || !candlesApi || !volumeApi) return
    if (!candles.length) {
      candlesApi.setData([])
      volumeApi.setData([])
      return
    }

    candlesApi.setData(candles.map(candlePoint))
    volumeApi.setData(candles.map(volumePoint))

    const lastClosedTime = candles[candles.length - 1].time
    if (formingCandleRef.current && formingCandleRef.current.time <= lastClosedTime) {
      formingCandleRef.current = null
    }
    if (formingCandleRef.current) {
      candlesApi.update(candlePoint(formingCandleRef.current))
      volumeApi.update(volumePoint(formingCandleRef.current))
    }

    const marketKey = `${symbol}|${timeframe}`
    if (fittedMarketRef.current !== marketKey) {
      if (candles.length > 140) {
        chart.timeScale().setVisibleLogicalRange({
          from: candles.length - 140,
          to: candles.length + 8,
        })
      } else {
        chart.timeScale().fitContent()
      }
      fittedMarketRef.current = marketKey
    }
  }, [candles, chartReady, symbol, timeframe])

  // Build/update the current forming display candle from genuine quote ticks.
  // This candle is never passed into any strategy calculation.
  useEffect(() => {
    const candlesApi = candleSeriesRef.current
    const volumeApi = volumeSeriesRef.current
    if (!chartReady || !candlesApi || !volumeApi || !candles.length || !livePrice) return
    if (!Number.isFinite(livePrice.price) || !Number.isFinite(livePrice.time) || livePrice.price <= 0) return

    const interval = TIMEFRAME_MS[timeframe]
    if (!interval) return
    const lastClosed = candles[candles.length - 1]
    const closeTime = Math.floor(livePrice.time / interval) * interval + interval
    if (closeTime <= lastClosed.time) return

    const previous = formingCandleRef.current
    const forming = previous && previous.time === closeTime
      ? {
          ...previous,
          high: Math.max(previous.high, livePrice.price),
          low: Math.min(previous.low, livePrice.price),
          close: livePrice.price,
        }
      : {
          time: closeTime,
          open: previous?.close ?? lastClosed.close,
          high: Math.max(previous?.close ?? lastClosed.close, livePrice.price),
          low: Math.min(previous?.close ?? lastClosed.close, livePrice.price),
          close: livePrice.price,
          volume: 0,
        }

    formingCandleRef.current = forming
    candlesApi.update(candlePoint(forming))
    volumeApi.update(volumePoint(forming))
  }, [candles, chartReady, livePrice, timeframe])

  // The LAST line follows WebSocket quotes, falling back to the last REST close.
  useEffect(() => {
    const series = candleSeriesRef.current
    if (!chartReady || !series) return
    const fallback = candles.length ? candles[candles.length - 1].close : undefined
    const price = livePrice && Number.isFinite(livePrice.price) ? livePrice.price : fallback
    if (typeof price !== 'number' || !Number.isFinite(price)) return

    if (!lastPriceLineRef.current) {
      lastPriceLineRef.current = series.createPriceLine({
        price,
        color: '#8ca1b8',
        lineWidth: 1 as LineWidth,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: 'LAST',
      })
    } else {
      lastPriceLineRef.current.applyOptions({ price })
    }
  }, [candles, chartReady, livePrice])

  // All BUY/SELL arrows use Lightweight Charts series markers, so they stay on
  // their original candle through zooming, panning and responsive resizing.
  useEffect(() => {
    const series = candleSeriesRef.current
    const markers = markersRef.current
    if (!chartReady || !series || !markers) return

    for (const line of signalLinesRef.current) {
      try { series.removePriceLine(line) } catch { /* chart instance changed */ }
    }
    signalLinesRef.current = []

    const addLine = (
      price: number | null | undefined,
      color: string,
      title: string,
      style: LineStyle,
      width: LineWidth,
    ) => {
      if (typeof price !== 'number' || !Number.isFinite(price)) return
      signalLinesRef.current.push(series.createPriceLine({
        price,
        color,
        lineWidth: width,
        lineStyle: style,
        axisLabelVisible: true,
        title,
      }))
    }

    const isCurrentMarket = (value: { symbol: string; timeframe: string }) =>
      value.symbol.toUpperCase() === symbol.toUpperCase() && value.timeframe === timeframe
    const candleTimes = new Set(candles.map(candle => Math.floor(candle.time / 1000)))
    const intervalMs = TIMEFRAME_MS[timeframe] ?? 60_000
    const resolveMarkerTime = (barTime: number): number | null => {
      const exact = Math.floor(barTime / 1000)
      if (candleTimes.has(exact)) return exact

      // Legacy signals were sometimes stored at an intra-candle event time.
      // Anchor them to that interval's actual close candle instead of hiding or
      // drawing them at an arbitrary screen coordinate.
      const expectedCloseMs = Math.floor(barTime / intervalMs) * intervalMs + intervalMs
      const expectedClose = Math.floor(expectedCloseMs / 1000)
      if (candleTimes.has(expectedClose)) return expectedClose

      let nearest: number | null = null
      let nearestDistance = Number.POSITIVE_INFINITY
      for (const candle of candles) {
        const distance = Math.abs(candle.time - barTime)
        if (distance < nearestDistance) {
          nearestDistance = distance
          nearest = Math.floor(candle.time / 1000)
        }
      }
      return nearestDistance <= intervalMs ? nearest : null
    }
    const output: SeriesMarker<Time>[] = []
    const seen = new Set<string>()

    const addMarker = (
      direction: 'BUY' | 'SELL',
      barTime: number,
      dimmed: boolean,
      text?: string,
      size = 1.2,
    ) => {
      const time = resolveMarkerTime(barTime)
      if (time === null || !Number.isFinite(time)) return
      const key = `${time}|${direction}`
      if (seen.has(key)) return
      seen.add(key)
      const activeColor = direction === 'BUY' ? '#22c55e' : '#ef4444'
      output.push({
        time: time as UTCTimestamp,
        position: direction === 'BUY' ? 'belowBar' : 'aboveBar',
        shape: direction === 'BUY' ? 'arrowUp' : 'arrowDown',
        color: dimmed
          ? direction === 'BUY' ? 'rgba(34, 197, 94, 0.58)' : 'rgba(239, 68, 68, 0.58)'
          : activeColor,
        text: text ?? direction,
        size,
      })
    }

    const current = analysis && isCurrentMarket(analysis) ? analysis : null
    if (current && current.action !== 'NO_SIGNAL' && current.barTime) {
      addMarker(current.action, current.barTime, false, current.action, 2.2)
    }

    for (const signal of existingSignals) {
      if (!isCurrentMarket(signal)) continue
      if (current && current.action !== 'NO_SIGNAL' && signal.timeframe === timeframe && signal.direction === current.action && signal.barTime === current.barTime) continue
      addMarker(signal.direction, signal.barTime, signal.status !== 'ACTIVE')
    }

    output.sort((left, right) => Number(left.time) - Number(right.time))
    markers.setMarkers(output)

    // Plus/Pro return confirmed, non-repainting key levels. Keep them visually
    // quieter than Entry/SL/TP so the trade plan remains the primary layer.
    const keyLevels = current
      && current.strategy !== 'V1'
      && 'keyLevels' in current.structure
      && Array.isArray(current.structure.keyLevels)
        ? current.structure.keyLevels
        : []
    const lastClose = candles[candles.length - 1]?.close ?? 0
    const nearestLevels = [...keyLevels]
      .sort((left, right) => Math.abs(left.price - lastClose) - Math.abs(right.price - lastClose))
      .slice(0, 4)
      .sort((left, right) => left.price - right.price)
    let supportIndex = 0
    let resistanceIndex = 0
    for (const level of nearestLevels) {
      const support = level.kind === 'SUPPORT'
      const index = support ? ++supportIndex : ++resistanceIndex
      addLine(
        level.price,
        support ? 'rgba(61, 220, 155, 0.52)' : 'rgba(255, 112, 134, 0.52)',
        `KEY ${support ? 'S' : 'R'}${index}`,
        LineStyle.Dotted,
        1 as LineWidth,
      )
    }

    // A fresh Analyze result has priority. If the server blocks a duplicate or
    // active slot, keep showing that persisted setup. This also restores active
    // levels immediately after reload and while the market is closed.
    const analysisSetup = current && current.action !== 'NO_SIGNAL' && current.levels && current.barTime
      ? {
          direction: current.action,
          barTime: current.barTime,
          entryZoneLow: current.levels.entryZoneLow,
          entryZoneHigh: current.levels.entryZoneHigh,
          entry: current.levels.entry,
          stopLoss: current.levels.stopLoss,
          tp1: current.levels.tp1,
          tp2: current.levels.tp2,
          tp3: current.levels.tp3,
        }
      : null
    const active = current?.existingActive && isCurrentMarket(current.existingActive) ? current.existingActive : null
    const activeSetup = active ? {
      direction: active.direction,
      barTime: active.barTime,
      entryZoneLow: active.levels.entryZoneLow,
      entryZoneHigh: active.levels.entryZoneHigh,
      entry: active.levels.entry,
      stopLoss: active.currentStopLoss ?? active.levels.stopLoss,
      tp1: active.levels.tp1,
      tp2: active.levels.tp2,
      tp3: active.levels.tp3,
    } : null
    const persisted = existingSignals.find(signal => isCurrentMarket(signal) && signal.status === 'ACTIVE')
    const persistedSetup = persisted ? {
      direction: persisted.direction,
      barTime: persisted.barTime,
      entryZoneLow: null,
      entryZoneHigh: null,
      entry: persisted.entry,
      stopLoss: persisted.stopLoss,
      tp1: persisted.tp1,
      tp2: persisted.tp2,
      tp3: persisted.tp3,
    } : null
    const setup = analysisSetup ?? activeSetup ?? persistedSetup
    if (!setup) return
    const directionColor = setup.direction === 'BUY' ? '#22c55e' : '#ef4444'

    const focusKey = `${symbol}|${timeframe}|${setup.barTime}|${setup.direction}`
    if (focusedSignalRef.current !== focusKey) {
      const resolved = resolveMarkerTime(setup.barTime)
      const signalIndex = resolved === null ? -1 : candles.findIndex(candle => Math.floor(candle.time / 1000) === resolved)
      if (signalIndex >= 0) {
        chartRef.current?.timeScale().setVisibleLogicalRange({
          from: Math.max(0, signalIndex - 105),
          to: signalIndex + 18,
        })
      }
      focusedSignalRef.current = focusKey
    }

    addLine(setup.entryZoneLow, 'rgba(56, 189, 248, 0.72)', 'ENTRY ZONE LOW', LineStyle.Dotted, 1 as LineWidth)
    addLine(setup.entryZoneHigh, 'rgba(56, 189, 248, 0.72)', 'ENTRY ZONE HIGH', LineStyle.Dotted, 1 as LineWidth)
    addLine(setup.entry, directionColor, `${setup.direction} ENTRY`, LineStyle.Dashed, 2 as LineWidth)
    addLine(setup.stopLoss, '#f07480', 'SL', LineStyle.Solid, 2 as LineWidth)
    addLine(setup.tp1, '#42c6a5', 'TP1', LineStyle.Solid, 2 as LineWidth)
    addLine(setup.tp2, '#42c6a5', 'TP2', LineStyle.Dashed, 1 as LineWidth)
    addLine(setup.tp3, '#42c6a5', 'TP3', LineStyle.Dashed, 1 as LineWidth)
  }, [analysis, candles, chartReady, existingSignals, symbol, timeframe])

  const focusLatest = () => {
    const chart = chartRef.current
    if (!chart || !candles.length) return
    const count = candles.length + (formingCandleRef.current ? 1 : 0)
    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, count - 140),
      to: count + 8,
    })
  }

  const fitAll = () => chartRef.current?.timeScale().fitContent()

  const toggleFullscreen = async () => {
    const shell = shellRef.current
    if (!shell) return
    try {
      if (document.fullscreenElement === shell) await document.exitFullscreen()
      else await shell.requestFullscreen()
    } catch {
      // Fullscreen can be denied by browser policy; the chart remains usable.
    }
  }

  const precision = precisionFor(symbol)
  const displayCandle = hoveredCandle ?? formingCandleRef.current ?? (candles.length ? candles[candles.length - 1] : null)
  const candleChange = displayCandle && displayCandle.open
    ? ((displayCandle.close - displayCandle.open) / displayCandle.open) * 100
    : 0
  const formatPrice = (value: number) => value.toFixed(precision)
  return (
    <div ref={shellRef} className="lwc-chart-shell">
      <div ref={containerRef} className="lwc-chart-canvas" />
      {displayCandle && status === 'ready' && (
        <div className="lwc-ohlc" aria-label="Current candle prices">
          <span className="lwc-ohlc-market"><i className={streamConnected ? 'is-live' : ''} />{symbol} · {timeframe}</span>
          <span><b>O</b>{formatPrice(displayCandle.open)}</span>
          <span><b>H</b>{formatPrice(displayCandle.high)}</span>
          <span><b>L</b>{formatPrice(displayCandle.low)}</span>
          <span><b>C</b>{formatPrice(displayCandle.close)}</span>
          <em className={candleChange >= 0 ? 'is-up' : 'is-down'}>{candleChange >= 0 ? '+' : ''}{candleChange.toFixed(2)}%</em>
        </div>
      )}
      <div className="lwc-chart-tools" aria-label="Chart view controls">
        <button type="button" onClick={focusLatest} title="Go to latest candles" aria-label="Go to latest candles"><Focus size={14} /></button>
        <button type="button" onClick={fitAll} title="Fit all history" aria-label="Fit all history"><ZoomOut size={14} /></button>
        <button type="button" onClick={toggleFullscreen} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} aria-label={fullscreen ? 'Exit fullscreen' : 'Open fullscreen'}>
          {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </div>
      {status === 'loading' && (
        <div className="lwc-chart-loading" role="status">
          <span className="lwc-spinner" />
          <span>Loading {symbol} {timeframe} candles…</span>
        </div>
      )}
      {status === 'error' && (
        <div className="lwc-chart-loading is-error" role="alert">
          <strong>Market data unavailable</strong>
          <span>{errorMessage}</span>
          <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button>
        </div>
      )}
      <span className="lwc-source">Yahoo Finance · Cambodia time (ICT) · live market data</span>
    </div>
  )
}
