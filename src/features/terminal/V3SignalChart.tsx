import { Activity, ArrowDownRight, ArrowUpRight, Target } from 'lucide-react'
import type { SignalResult, SetupSummary } from '../../strategy'
import { g5 } from '../../v1/types'
import { CAMBODIA_TIME_ZONE } from '../../marketSession'

/**
 * Companion chart for V3 PRO.
 *
 * Legacy read-only companion retained for the standalone V3 result view. The
 * terminal itself now uses native Lightweight Charts markers and price lines.
 * This SVG renders the same closed candles returned with an analysis and draws
 * its history, entry zone, stop loss and TP1/TP2/TP3 in one place.
 *
 * It is read-only: nothing here recomputes a level or moves a stop.
 */

const W = 960
const H = 340
const PAD_L = 10
const PAD_R = 84
const PAD_T = 18
const PAD_B = 26
const PLOT_W = W - PAD_L - PAD_R
const PLOT_H = H - PAD_T - PAD_B

type Marker = { item: SetupSummary; index: number }

const terminalStatuses = new Set(['TP3_HIT', 'STOP_LOSS_HIT', 'CLOSED', 'CANCELLED'])

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function markerIndex(times: number[], time: number, interval: number): number | null {
  if (!times.length) return null
  if (time < times[0] - interval * 0.75 || time > times[times.length - 1] + interval * 0.75) return null
  let best = 0
  let bestDiff = Number.POSITIVE_INFINITY
  for (let index = 0; index < times.length; index += 1) {
    const diff = Math.abs(times[index] - time)
    if (diff < bestDiff) {
      best = index
      bestDiff = diff
    }
  }
  return bestDiff <= interval * 1.5 ? best : null
}

function statusLabel(status: string): string {
  switch (status) {
    case 'TP1_HIT': return 'TP1 hit · slot unlocked'
    case 'TP2_HIT': return 'TP2 hit'
    case 'TP3_HIT': return 'TP3 hit · closed'
    case 'STOP_LOSS_HIT': return 'Stop hit'
    case 'CLOSED': return 'Closed'
    case 'CANCELLED': return 'Cancelled'
    default: return 'Active'
  }
}

function LevelLine({
  y,
  color,
  label,
  value,
  dashed,
}: {
  y: number
  color: string
  label: string
  value: string
  dashed?: boolean
}) {
  return (
    <g>
      <line
        x1={PAD_L}
        x2={W - PAD_R}
        y1={y}
        y2={y}
        stroke={color}
        strokeWidth={1.1}
        strokeDasharray={dashed ? '4 4' : undefined}
        opacity={0.85}
      />
      <text x={W - PAD_R + 7} y={y + 3} fill={color} fontSize={9} fontWeight={700}>
        {label}
      </text>
      <text x={W - PAD_R + 7} y={y + 13} fill={color} fontSize={8} opacity={0.8}>
        {value}
      </text>
    </g>
  )
}

export default function V3SignalChart({ result }: { result: SignalResult }) {
  const candles = [...(result.candles ?? [])].sort((left, right) => left.time - right.time)
  if (!candles.length) return null

  const history = result.history ?? []
  const levels = result.levels
  const times = candles.map(candle => candle.time)
  const interval = times.length > 1 ? times[1] - times[0] : 60_000

  const priceValues: number[] = []
  for (const candle of candles) priceValues.push(candle.high, candle.low)
  if (levels) {
    priceValues.push(levels.entryZoneLow, levels.entryZoneHigh, levels.stopLoss, levels.tp1)
    if (finite(levels.tp2)) priceValues.push(levels.tp2)
    if (finite(levels.tp3)) priceValues.push(levels.tp3)
  }
  let min = Math.min(...priceValues)
  let max = Math.max(...priceValues)
  const pad = Math.max((max - min) * 0.08, Number.EPSILON)
  min -= pad
  max += pad
  if (!(max > min)) return null

  const x = (index: number) => PAD_L + ((index + 0.5) / candles.length) * PLOT_W
  const y = (price: number) => PAD_T + ((max - price) / (max - min)) * PLOT_H
  const barWidth = Math.max(1.4, Math.min(8, (PLOT_W / candles.length) * 0.62))

  const markers: Marker[] = []
  for (const item of history) {
    const index = markerIndex(times, item.barTime, interval)
    if (index === null) continue
    markers.push({ item, index })
  }

  const gridPrices = Array.from({ length: 5 }, (_, step) => min + ((max - min) * step) / 4)

  const levelRows = levels
    ? [
        { label: 'TP3', value: levels.tp3, color: '#42c6a5', dashed: true },
        { label: 'TP2', value: levels.tp2, color: '#42c6a5', dashed: true },
        { label: 'TP1', value: levels.tp1, color: '#5fe0bb', dashed: false },
        { label: 'ENTRY', value: levels.entry, color: '#eab86a', dashed: false },
        { label: 'SL', value: levels.stopLoss, color: '#f07480', dashed: false },
      ].filter((row): row is { label: string; value: number; color: string; dashed: boolean } => finite(row.value))
    : []

  const recentHistory = history.slice(0, 8)

  return (
    <section className={`v3-chart is-${result.bias}`}>
      <header className="v3-chart-head">
        <div>
          <span className="signal-kicker is-v3"><Activity size={12} /> PRO STRATEGY · SIGNAL HISTORY</span>
          <h4>
            {candles.length} closed candles
            <span> · {markers.length} historical signal{markers.length === 1 ? '' : 's'} in view</span>
          </h4>
        </div>
        <div className="v3-chart-legend">
          <span className="is-buy"><i />BUY history</span>
          <span className="is-sell"><i />SELL history</span>
          {levels && <span className="is-level"><i />New signal levels</span>}
        </div>
      </header>

      <div className="v3-chart-canvas">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${result.symbol} ${result.timeframe} Pro analysis history and trade levels`}>
          <rect x={0} y={0} width={W} height={H} fill="#081625" rx={9} />

          {gridPrices.map(price => (
            <g key={`grid-${price}`}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y(price)}
                y2={y(price)}
                stroke="#17304a"
                strokeWidth={0.7}
                strokeDasharray="3 5"
              />
              <text x={W - PAD_R + 7} y={y(price) + 3} fill="#5d7793" fontSize={8}>
                {g5(price)}
              </text>
            </g>
          ))}

          {levels && (
            <rect
              x={PAD_L}
              y={y(Math.max(levels.entryZoneLow, levels.entryZoneHigh))}
              width={PLOT_W}
              height={Math.max(1, Math.abs(y(levels.entryZoneLow) - y(levels.entryZoneHigh)))}
              fill="#eab86a"
              opacity={0.1}
            />
          )}

          {candles.map((candle, index) => {
            const bullish = candle.close >= candle.open
            const color = bullish ? '#42c6a5' : '#f07480'
            const openY = y(candle.open)
            const closeY = y(candle.close)
            const top = Math.min(openY, closeY)
            const bodyHeight = Math.max(1, Math.abs(openY - closeY))
            return (
              <g key={candle.time}>
                <line x1={x(index)} x2={x(index)} y1={y(candle.high)} y2={y(candle.low)} stroke={color} strokeWidth={0.9} opacity={0.75} />
                <rect x={x(index) - barWidth / 2} y={top} width={barWidth} height={bodyHeight} fill={color} opacity={0.9} rx={0.6} />
              </g>
            )
          })}

          {markers.map(({ item, index }) => {
            const buy = item.direction === 'BUY'
            const anchorY = buy ? y(candles[index].low) + 5 : y(candles[index].high) - 5
            const muted = terminalStatuses.has(item.status)
            const color = buy ? '#5fe0bb' : '#f8919b'
            return (
              <g key={`${item.signalId}-${item.direction}`} opacity={muted ? 0.55 : 1}>
                <title>{`${item.direction} ${item.symbol} ${item.timeframe} · ${item.score.toFixed(0)}/100 · entry ${g5(item.entry)} · SL ${g5(item.stopLoss)} · TP1 ${g5(item.tp1)} · ${statusLabel(item.status)}`}</title>
                <line
                  x1={x(index)}
                  x2={x(index)}
                  y1={anchorY}
                  y2={buy ? PAD_T + PLOT_H : PAD_T}
                  stroke={color}
                  strokeWidth={0.6}
                  strokeDasharray="2 4"
                  opacity={0.25}
                />
                {buy ? (
                  <polygon
                    points={`${x(index)},${anchorY - 7} ${x(index) - 4.5},${anchorY} ${x(index) + 4.5},${anchorY}`}
                    fill={color}
                    stroke="#081625"
                    strokeWidth={0.7}
                  />
                ) : (
                  <polygon
                    points={`${x(index)},${anchorY + 7} ${x(index) - 4.5},${anchorY} ${x(index) + 4.5},${anchorY}`}
                    fill={color}
                    stroke="#081625"
                    strokeWidth={0.7}
                  />
                )}
              </g>
            )
          })}

          {levels && levelRows.map(row => (
            <LevelLine
              key={row.label}
              y={y(row.value)}
              color={row.color}
              label={row.label}
              value={g5(row.value)}
              dashed={row.dashed}
            />
          ))}

          {!levels && (
            <text x={PAD_L + 10} y={PAD_T + 16} fill="#8b9db4" fontSize={10}>
              No new trade levels — the current checks returned NO SIGNAL.
            </text>
          )}
        </svg>
      </div>

      <div className="v3-chart-foot">
        <span className="v3-chart-new">
          <Target size={12} />
          {levels
            ? `New ${result.action} · entry ${g5(levels.entry)} · SL ${g5(levels.stopLoss)} · TP1 ${g5(levels.tp1)}${finite(levels.tp2) ? ` · TP2 ${g5(levels.tp2)}` : ''}${finite(levels.tp3) ? ` · TP3 ${g5(levels.tp3)}` : ''}`
            : 'Waiting for a valid setup on a new closed candle.'}
        </span>
        {recentHistory.length > 0 && (
          <ul className="v3-chart-history">
            {recentHistory.map(item => (
              <li key={item.signalId} className={`is-${item.direction === 'BUY' ? 'buy' : 'sell'}`}>
                {item.direction === 'BUY' ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
                <strong>{item.direction}</strong>
                <span>{new Date(item.barTime).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: CAMBODIA_TIME_ZONE })}</span>
                <small>{statusLabel(item.status)} · entry {g5(item.entry)} · SL {g5(item.stopLoss)} · TP1 {g5(item.tp1)}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
