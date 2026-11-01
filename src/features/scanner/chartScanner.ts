export type ScanBias = 'LONG' | 'SHORT' | 'WAIT'
export type ScanTone = 'up' | 'down' | 'flat'

export interface ScanMetric {
  label: string
  value: string
  tone: ScanTone
}

export interface ChartScanResult {
  bias: ScanBias
  strength: number
  summary: string
  metrics: ScanMetric[]
  reasons: string[]
  sampled: number
}

interface Point { x: number; y: number }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => { URL.revokeObjectURL(url); resolve(image) }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be read. Try a PNG or JPG file.')) }
    image.src = url
  })
}

function dominantLuminance(data: Uint8ClampedArray, width: number, height: number) {
  const bins = new Array(64).fill(0)
  const step = 3
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4
      const r = data[i], g = data[i + 1], b = data[i + 2]
      const max = Math.max(r, g, b), min = Math.min(r, g, b)
      if (max - min > 55) continue
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
      bins[Math.min(63, Math.floor((lum / 255) * 63))] += 1
    }
  }
  let best = 0, bestCount = -1
  bins.forEach((count, index) => { if (count > bestCount) { best = index; bestCount = count } })
  return ((best + 0.5) / 64) * 255
}

function regression(points: Point[]) {
  if (points.length < 2) return { slope: 0, intercept: points[0]?.y ?? 0 }
  let sumX = 0, sumY = 0
  for (const point of points) { sumX += point.x; sumY += point.y }
  const meanX = sumX / points.length
  const meanY = sumY / points.length
  let numerator = 0, denominator = 0
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY)
    denominator += (point.x - meanX) * (point.x - meanX)
  }
  const slope = denominator === 0 ? 0 : numerator / denominator
  return { slope, intercept: meanY - slope * meanX }
}

function stdDev(points: Point[], slope: number, intercept: number) {
  if (!points.length) return 0
  const residuals = points.map(point => point.y - (slope * point.x + intercept))
  const mean = residuals.reduce((total, value) => total + value, 0) / residuals.length
  let variance = 0
  for (const residual of residuals) variance += (residual - mean) ** 2
  return Math.sqrt(variance / residuals.length)
}

export async function scanChartImage(file: File): Promise<ChartScanResult> {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image file (PNG, JPG or WebP).')
  if (file.size > 15 * 1024 * 1024) throw new Error('That image is larger than 15 MB. Please use a smaller file.')
  const image = await loadImage(file)
  const maxWidth = 460
  const scale = Math.min(1, maxWidth / image.naturalWidth)
  const width = Math.max(40, Math.round(image.naturalWidth * scale))
  const height = Math.max(40, Math.round(image.naturalHeight * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas is not available in this browser.')

  context.drawImage(image, 0, 0, width, height)
  const { data } = context.getImageData(0, 0, width, height)
  const background = dominantLuminance(data, width, height)

  const xStart = Math.floor(width * 0.035)
  const xEnd = Math.ceil(width * 0.965)
  const yStart = Math.floor(height * 0.04)
  const yEnd = Math.ceil(height * 0.94)

  const columns: Point[] = []
  let bullishPixels = 0
  let bearishPixels = 0
  let inkPixels = 0

  for (let x = xStart; x <= xEnd; x += 1) {
    let weightSum = 0
    let ySum = 0
    let inkCount = 0
    for (let y = yStart; y <= yEnd; y += 1) {
      const i = (y * width + x) * 4
      const r = data[i], g = data[i + 1], b = data[i + 2]
      const max = Math.max(r, g, b), min = Math.min(r, g, b)
      const saturation = max - min
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const isInk = Math.abs(lum - background) > 36 || saturation > 58
      if (!isInk) continue
      const weight = saturation > 42 ? 1.35 : 0.6
      weightSum += weight
      ySum += y * weight
      inkCount += 1
      inkPixels += 1
      if (g - r > 24 && g - b > 12) bullishPixels += 1
      else if (r - g > 24 && r - b > 8 && r > 90) bearishPixels += 1
    }
    const maxInk = (yEnd - yStart) * 0.55
    if (inkCount >= 1 && inkCount <= maxInk) columns.push({ x, y: ySum / weightSum })
  }

  if (columns.length < 16) {
    throw new Error('No chart structure was detected. Try a clearer screenshot where candles or the price line are clearly visible.')
  }

  const smooth = columns.map((point, index) => {
    const window = columns.slice(Math.max(0, index - 2), Math.min(columns.length, index + 3))
    const average = window.reduce((total, item) => total + item.y, 0) / window.length
    return { x: point.x, y: average }
  })

  const prices: Point[] = smooth.map(point => ({ x: point.x, y: -point.y }))
  const fit = regression(prices)
  const firstX = prices[0].x
  const lastX = prices[prices.length - 1].x
  const span = Math.max(1, lastX - firstX)
  const minPrice = Math.min(...prices.map(point => point.y))
  const maxPrice = Math.max(...prices.map(point => point.y))
  const range = Math.max(4, maxPrice - minPrice)

  const netMove = fit.slope * span
  const drift = clamp(netMove / range, -2, 2)
  const trend: ScanTone = drift > 0.2 ? 'up' : drift < -0.2 ? 'down' : 'flat'

  const split = Math.floor(prices.length * 0.4)
  const firstSlope = regression(prices.slice(0, split)).slope
  const lastSlope = regression(prices.slice(prices.length - split)).slope
  const momentumRaw = clamp(((lastSlope - firstSlope) * span) / range, -2, 2)
  const momentum: ScanTone = momentumRaw > 0.12 ? 'up' : momentumRaw < -0.12 ? 'down' : 'flat'

  const coloured = bullishPixels + bearishPixels
  const hasPressure = coloured > Math.max(80, inkPixels * 0.015)
  const bullishRatio = hasPressure ? bullishPixels / coloured : 0.5
  const pressure: ScanTone = !hasPressure ? 'flat' : bullishRatio > 0.56 ? 'up' : bullishRatio < 0.44 ? 'down' : 'flat'

  const residuals = stdDev(prices, fit.slope, fit.intercept)
  const volatilityRatio = residuals / range
  const volatility = volatilityRatio < 0.12 ? 'Low' : volatilityRatio < 0.24 ? 'Medium' : 'High'

  const lastPrice = prices[prices.length - 1].y
  const rangePosition = clamp((lastPrice - minPrice) / range, 0, 1)
  const rangeLabel = rangePosition > 0.7 ? 'near the upper range' : rangePosition < 0.3 ? 'near the lower range' : 'mid-range'

  const trendScore = clamp(drift / 0.45, -1, 1)
  const momentumScore = clamp(momentumRaw / 0.3, -1, 1)
  const pressureScore = hasPressure ? clamp((bullishRatio - 0.5) * 2.4, -1, 1) : 0
  const score = clamp(0.58 * trendScore + 0.27 * momentumScore + 0.15 * pressureScore, -1, 1)

  const bias: ScanBias = score >= 0.24 ? 'LONG' : score <= -0.24 ? 'SHORT' : 'WAIT'
  const strength = Math.round(clamp(28 + Math.abs(score) * 72, 24, 95))

  const trendLabel = trend === 'up' ? 'Uptrend' : trend === 'down' ? 'Downtrend' : 'Range'
  const momentumLabel = momentum === 'up' ? 'Rising' : momentum === 'down' ? 'Falling' : 'Flat'
  const pressureLabel = pressure === 'up' ? 'Bullish' : pressure === 'down' ? 'Bearish' : 'Balanced'
  const positionLabel = rangeLabel === 'mid-range' ? 'Mid-range' : rangeLabel === 'near the upper range' ? 'Upper range' : 'Lower range'

  const reasons: string[] = [
    `Structure reads ${trendLabel.toLowerCase()} with ${Math.round(Math.abs(drift) * 100)}% net drift across the visible window.`,
    `Momentum is ${momentumLabel.toLowerCase()} compared with the earlier part of the chart.`,
    hasPressure
      ? `Candle pressure is ${pressureLabel.toLowerCase()} at ${Math.round(bullishRatio * 100)}% of coloured pixels.`
      : 'Price action is monochrome, so candle pressure was left out of the score.',
    `Volatility is ${volatility.toLowerCase()} and price sits ${rangeLabel}.`,
  ]

  if (bias === 'WAIT') {
    reasons.push('Trend, momentum and pressure do not align, so the strategy does not open a setup.')
  }

  const summary = bias === 'LONG'
    ? 'Trend and momentum agree to the upside across the captured window.'
    : bias === 'SHORT'
      ? 'Trend and momentum agree to the downside across the captured window.'
      : 'Signals are mixed inside the captured window, so the strategy stays out.'

  return {
    bias,
    strength,
    summary,
    reasons,
    sampled: columns.length,
    metrics: [
      { label: 'Trend', value: trendLabel, tone: trend },
      { label: 'Momentum', value: momentumLabel, tone: momentum },
      { label: 'Candle pressure', value: pressureLabel, tone: pressure },
      { label: 'Volatility', value: volatility, tone: 'flat' },
      { label: 'Range position', value: positionLabel, tone: 'flat' },
      { label: 'Samples', value: `${columns.length} columns`, tone: 'flat' },
    ],
  }
}
