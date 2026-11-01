import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDownRight, ArrowRight, ArrowUpRight, Filter, History, Loader2, RadioTower, RefreshCw, ShieldCheck, Target, Zap } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ApiError, fetchSignals, type SignalHistoryItem } from '../../services/api'
import { CAMBODIA_TIME_ZONE } from '../../marketSession'
import { STRATEGY_LABELS, type StrategyName } from '../../v3/types'
import { g5 } from '../../v1/types'

const openStatuses = new Set(['ACTIVE', 'TP1_HIT', 'TP2_HIT'])

function timestamp(value: number): string {
  return new Date(value).toLocaleString('en-GB', {
    timeZone: CAMBODIA_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function strategyName(value: string | null): string {
  if (!value || !Object.prototype.hasOwnProperty.call(STRATEGY_LABELS, value)) return 'Core Playbook'
  return STRATEGY_LABELS[value as StrategyName]
}
function tier(value: 'V1' | 'V2' | 'V3'): string { return value === 'V3' ? 'Pro' : value === 'V2' ? 'Plus' : 'Free' }
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

function mergeSignals(open: SignalHistoryItem[], history: SignalHistoryItem[]): SignalHistoryItem[] {
  return [...new Map([...open, ...history].map(signal => [signal.signalId, signal])).values()]
    .sort((left, right) => right.barTime - left.barTime)
}

function SignalCard({ signal, compact = false }: { signal: SignalHistoryItem; compact?: boolean }) {
  const buy = signal.direction === 'BUY'
  return <article className={`backend-signal-card is-${buy ? 'buy' : 'sell'} ${compact ? 'is-compact' : ''}`}>
    <span className="backend-signal-icon">{buy ? <ArrowUpRight size={17} /> : <ArrowDownRight size={17} />}</span>
    <div className="backend-signal-main">
      <div><strong>{signal.direction} {signal.symbol}</strong><span>{signal.timeframe} · {tier(signal.engine)}</span></div>
      <small>{timestamp(signal.barTime)} ICT · {strategyName(signal.strategyName)}</small>
    </div>
    {!compact && <div className="backend-signal-levels">
      <span>ENTRY <b>{g5(signal.entry)}</b></span>
      <span>SL <b>{g5(signal.stopLoss)}</b></span>
      <span>TP1 <b>{g5(signal.tp1)}</b></span>
      {signal.tp2 !== null && <span>TP2 <b>{g5(signal.tp2)}</b></span>}
      {signal.tp3 !== null && <span>TP3 <b>{g5(signal.tp3)}</b></span>}
    </div>}
    <div className="backend-signal-side">
      <strong>{signal.score.toFixed(0)}<small>/100</small></strong>
      <span className={`backend-status ${openStatuses.has(signal.status) ? 'is-open' : ''}`}><ShieldCheck size={10} />{tradeState(signal.status)}</span>
    </div>
    <Link to={`/terminal?symbol=${signal.symbol}`} className="backend-signal-open" aria-label={`Open ${signal.symbol} chart`}><ArrowRight size={13} /></Link>
  </article>
}

export function RecentSignalsPanel() {
  const [signals, setSignals] = useState<SignalHistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    fetchSignals().then(data => { if (active) setSignals(mergeSignals(data.open, data.history).slice(0, 5)) })
      .catch(() => undefined).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  return <section className="panel dashboard-lower-panel backend-recent-panel">
    <div className="panel-header"><div><h2>Recent signals</h2><p>Saved Free, Plus and Pro trade setups.</p></div><Link className="text-link" to="/signals">View all <ArrowRight size={14} /></Link></div>
    {loading ? <div className="backend-signal-empty"><Loader2 className="spin" size={17} /> Loading signals…</div>
      : signals.length ? <div className="backend-recent-list">{signals.map(signal => <SignalCard signal={signal} compact key={signal.signalId} />)}</div>
        : <div className="backend-signal-empty"><RadioTower size={18} /> No saved trade setups yet. Run Analyze in the terminal.</div>}
  </section>
}

export default function SignalsPage() {
  const [signals, setSignals] = useState<SignalHistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [direction, setDirection] = useState<'ALL' | 'BUY' | 'SELL'>('ALL')
  const [state, setState] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL')
  const [engine, setEngine] = useState<'ALL' | 'V1' | 'V2' | 'V3'>('ALL')
  const [query, setQuery] = useState('')

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      const data = await fetchSignals()
      setSignals(mergeSignals(data.open, data.history))
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load saved trade setups.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => signals.filter(signal => {
    if (direction !== 'ALL' && signal.direction !== direction) return false
    const isOpen = openStatuses.has(signal.status)
    if (state === 'OPEN' && !isOpen) return false
    if (state === 'CLOSED' && isOpen) return false
    if (engine !== 'ALL' && signal.engine !== engine) return false
    if (query && !`${signal.symbol} ${signal.timeframe} ${signal.strategyName ?? ''}`.toLowerCase().includes(query.toLowerCase())) return false
    return true
  }), [direction, engine, query, signals, state])

  const openCount = signals.filter(signal => openStatuses.has(signal.status)).length
  const buys = signals.filter(signal => signal.direction === 'BUY').length
  const sells = signals.filter(signal => signal.direction === 'SELL').length

  return <div className="backend-signals-page">
    <header className="backend-signals-hero">
      <div><span className="signal-kicker"><Zap size={12} /> VERIFIED TRADE SETUPS</span><h1>Signals</h1><p>Saved Free, Plus and Pro setups—open, completed and stopped.</p></div>
      <button type="button" className="btn btn-secondary" onClick={() => void load(true)} disabled={refreshing}>{refreshing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Refresh</button>
    </header>
    <div className="backend-signal-stats">
      <div><span>TOTAL</span><strong>{signals.length}</strong><small>saved records</small></div>
      <div><span>OPEN</span><strong>{openCount}</strong><small>active/runners</small></div>
      <div><span>BUY</span><strong className="is-buy">{buys}</strong><small>long setups</small></div>
      <div><span>SELL</span><strong className="is-sell">{sells}</strong><small>short setups</small></div>
    </div>
    <section className="backend-signal-browser">
      <div className="backend-signal-filters">
        <Filter size={14} />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search symbol or playbook…" />
        <select value={direction} onChange={event => setDirection(event.target.value as typeof direction)}><option value="ALL">All directions</option><option value="BUY">BUY</option><option value="SELL">SELL</option></select>
        <select value={state} onChange={event => setState(event.target.value as typeof state)}><option value="ALL">All states</option><option value="OPEN">Open</option><option value="CLOSED">Closed</option></select>
        <select value={engine} onChange={event => setEngine(event.target.value as typeof engine)}><option value="ALL">All analysis plans</option><option value="V1">Free</option><option value="V2">Plus</option><option value="V3">Pro</option></select>
      </div>
      {error && <div className="backend-signal-error">{error}</div>}
      {loading ? <div className="backend-signal-empty"><Loader2 size={18} className="spin" /> Loading saved trade setups…</div>
        : filtered.length ? <div className="backend-signal-list">{filtered.map(signal => <SignalCard signal={signal} key={signal.signalId} />)}</div>
          : <div className="backend-signal-empty"><History size={18} /> No signals match these filters.</div>}
    </section>
  </div>
}
