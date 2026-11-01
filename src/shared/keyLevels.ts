export type KeyLevelKind = 'SUPPORT' | 'RESISTANCE'
export type KeyLevelStrength = 'FRESH' | 'MODERATE' | 'STRONG'

export type KeyLevel = {
  kind: KeyLevelKind
  price: number
  touches: number
  strength: KeyLevelStrength
  score: number
  lastConfirmedIndex: number
}

export type ConfirmedLevelPoint = {
  price: number
  confirmIndex: number
}

type Cluster = {
  weightedPrice: number
  weight: number
  touches: number
  lastConfirmedIndex: number
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Cluster confirmed swing prices into non-repainting support/resistance levels.
 * Only points whose right-side confirmation already exists are passed here.
 */
export function deriveKeyLevels(
  points: ConfirmedLevelPoint[],
  lastClose: number,
  atr: number | null | undefined,
  lastPos: number,
  perSide = 3,
): KeyLevel[] {
  if (!finite(lastClose) || lastClose <= 0 || !points.length) return []

  const tolerance = Math.max(
    lastClose * 0.00035,
    finite(atr) && atr > 0 ? atr * 0.22 : 0,
    Number.EPSILON,
  )
  const recent = points
    .filter(point => finite(point.price) && point.price > 0 && point.confirmIndex <= lastPos)
    .sort((left, right) => left.confirmIndex - right.confirmIndex)
    .slice(-48)

  const clusters: Cluster[] = []
  for (const point of recent) {
    let nearest: Cluster | null = null
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const cluster of clusters) {
      const price = cluster.weightedPrice / cluster.weight
      const distance = Math.abs(price - point.price)
      if (distance <= tolerance && distance < nearestDistance) {
        nearest = cluster
        nearestDistance = distance
      }
    }

    // Recent confirmations receive slightly more weight without changing the
    // touch count used in the UI.
    const recencyWeight = 1 + Math.max(0, 1 - (lastPos - point.confirmIndex) / 120) * 0.35
    if (nearest) {
      nearest.weightedPrice += point.price * recencyWeight
      nearest.weight += recencyWeight
      nearest.touches += 1
      nearest.lastConfirmedIndex = Math.max(nearest.lastConfirmedIndex, point.confirmIndex)
    } else {
      clusters.push({
        weightedPrice: point.price * recencyWeight,
        weight: recencyWeight,
        touches: 1,
        lastConfirmedIndex: point.confirmIndex,
      })
    }
  }

  const levels = clusters.map(cluster => {
    const price = cluster.weightedPrice / cluster.weight
    const recency = Math.max(0, 1 - (lastPos - cluster.lastConfirmedIndex) / 120)
    const score = Math.min(100, Math.round(cluster.touches * 24 + recency * 28))
    const strength: KeyLevelStrength = cluster.touches >= 3
      ? 'STRONG'
      : cluster.touches >= 2
        ? 'MODERATE'
        : 'FRESH'
    return {
      kind: price <= lastClose ? 'SUPPORT' as const : 'RESISTANCE' as const,
      price,
      touches: cluster.touches,
      strength,
      score,
      lastConfirmedIndex: cluster.lastConfirmedIndex,
    }
  })

  const byQuality = (left: KeyLevel, right: KeyLevel) => {
    const distance = Math.abs(left.price - lastClose) - Math.abs(right.price - lastClose)
    return distance || right.score - left.score || right.lastConfirmedIndex - left.lastConfirmedIndex
  }
  const supports = levels.filter(level => level.kind === 'SUPPORT').sort(byQuality).slice(0, perSide)
  const resistances = levels.filter(level => level.kind === 'RESISTANCE').sort(byQuality).slice(0, perSide)
  return [...supports, ...resistances].sort((left, right) => left.price - right.price)
}
