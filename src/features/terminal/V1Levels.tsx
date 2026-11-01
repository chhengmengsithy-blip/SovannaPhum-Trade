import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import type { SignalResult } from '../../strategy'
import { g5 } from '../../v1/types'

function Icon({ action }: { action: SignalResult['action'] }) {
  if (action === 'BUY') return <ArrowUpRight size={14} />
  if (action === 'SELL') return <ArrowDownRight size={14} />
  return <Minus size={14} />
}

/**
 * Compact V1 levels strip shown under the Lightweight Chart.
 *
 * The chart itself is an iframe, so the engine's frozen levels live in this DOM
 * strip instead of being drawn on the widget.
 */
export default function V1LevelsStrip({ result }: { result: SignalResult }) {
  const levels = result.levels
  if (!levels) {
    return (
      <div className={`v1-levels-strip is-empty is-${result.bias}`}>
        <span className="v1-strip-tag"><Icon action={result.action} /> {result.action.replace('_', ' ')}</span>
        <span className="v1-strip-reason">{result.headline}</span>
        <span className="v1-strip-meta">View {result.view} · Score {result.score.total.toFixed(0)}/100</span>
      </div>
    )
  }

  return (
    <div className={`v1-levels-strip is-${result.bias}`}>
      <span className="v1-strip-tag"><Icon action={result.action} /> {result.action}</span>
      <span className="v1-strip-cell"><small>Entry zone</small><strong>{g5(levels.entryZoneLow)} – {g5(levels.entryZoneHigh)}</strong></span>
      <span className="v1-strip-cell is-stop"><small>Stop</small><strong>{g5(levels.stopLoss)}</strong></span>
      <span className="v1-strip-cell"><small>TP1</small><strong>{g5(levels.tp1)}</strong><em>{levels.rrTp1.toFixed(2)}R</em></span>
      {levels.tp2 !== null && <span className="v1-strip-cell"><small>TP2</small><strong>{g5(levels.tp2)}</strong><em>{levels.rrTp2!.toFixed(2)}R</em></span>}
      {levels.tp3 !== null && <span className="v1-strip-cell"><small>TP3</small><strong>{g5(levels.tp3)}</strong><em>{levels.rrTp3!.toFixed(2)}R</em></span>}
      <span className="v1-strip-score">{result.score.total.toFixed(0)}/100 · {result.score.band}</span>
    </div>
  )
}
