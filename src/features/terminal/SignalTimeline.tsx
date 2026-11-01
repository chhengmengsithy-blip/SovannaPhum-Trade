import { useMemo, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, Clock3, History, ShieldCheck } from 'lucide-react'
import type { SignalHistoryItem } from '../../services/api'
import { CAMBODIA_TIME_ZONE } from '../../marketSession'
import { STRATEGY_LABELS, type StrategyName } from '../../v3/types'
import { g5 } from '../../v1/types'

type Filter = 'ALL' | 'BUY' | 'SELL'

function strategyLabel(value: string | null): string {
  if (!value || !Object.prototype.hasOwnProperty.call(STRATEGY_LABELS, value)) return 'Core Playbook'
  return STRATEGY_LABELS[value as StrategyName]
}

function tradeState(value: string): string {
  return ({
    ACTIVE: 'Open',
    TP1_HIT: 'TP1 reached',
    TP2_HIT: 'TP2 reached',
    TP3_HIT: 'Completed',
    STOP_LOSS_HIT: 'Stop reached',
    CLOSED: 'Closed',
    CANCELLED: 'Cancelled',
  } as Record<string, string>)[value] ?? value.replace(/_/g, ' ').toLowerCase()
}

function eventTime(value: number): string {
  return new Date(value).toLocaleString('en-GB', {
    timeZone: CAMBODIA_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export default function SignalTimeline({
  signals,
  symbol,
  timeframe,
  marketOpen,
}: {
  signals: SignalHistoryItem[]
  symbol: string
  timeframe: string
  marketOpen: boolean
}) {
  const [filter, setFilter] = useState<Filter>('ALL')
  const visible = useMemo(() => signals
    .filter(signal => filter === 'ALL' || signal.direction === filter)
    .sort((left, right) => right.barTime - left.barTime)
    .slice(0, 100), [filter, signals])

  return (
    <section className="signal-timeline">
      <header className="signal-timeline-head">
        <div>
          <span className="signal-kicker"><History size={12} /> SIGNAL EVENTS · ICT</span>
          <h3>{symbol} <span>· ALL TIMEFRAMES · viewing {timeframe}</span></h3>
          <small>{signals.length} saved event{signals.length === 1 ? '' : 's'} · markers remain visible when the market is closed</small>
        </div>
        <div className="signal-timeline-actions">
          {!marketOpen && <span className="timeline-closed"><Clock3 size={11} /> Market closed</span>}
          <div>{(['ALL', 'BUY', 'SELL'] as Filter[]).map(item => <button type="button" key={item} className={filter === item ? 'is-active' : ''} onClick={() => setFilter(item)}>{item}</button>)}</div>
        </div>
      </header>
      {visible.length ? <div className="signal-timeline-list">
        {visible.map(signal => {
          const buy = signal.direction === 'BUY'
          return <article className={`signal-event is-${buy ? 'buy' : 'sell'}`} key={signal.signalId}>
            <span className="signal-event-icon">{buy ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}</span>
            <div className="signal-event-main">
              <strong>{signal.direction} <span>{signal.score.toFixed(0)}/100</span></strong>
              <small>{eventTime(signal.barTime)} ICT · {signal.timeframe} · {signal.engine === 'V3' ? 'Pro' : signal.engine === 'V2' ? 'Plus' : 'Free'} · {strategyLabel(signal.strategyName)}</small>
            </div>
            <div className="signal-event-levels">
              <span>ENTRY <b>{g5(signal.entry)}</b></span>
              <span>SL <b>{g5(signal.stopLoss)}</b></span>
              <span>TP1 <b>{g5(signal.tp1)}</b></span>
            </div>
            <span className="signal-event-status"><ShieldCheck size={10} />{tradeState(signal.status)}</span>
          </article>
        })}
      </div> : <div className="signal-timeline-empty"><History size={18} /><span>No saved {filter === 'ALL' ? '' : `${filter} `}signals on this chart yet.</span></div>}
    </section>
  )
}
