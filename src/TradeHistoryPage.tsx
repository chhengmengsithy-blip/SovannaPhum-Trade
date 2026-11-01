import { useEffect, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, Filter, History, Target, TrendingUp, X } from 'lucide-react'
import { useAuth } from './auth'
import { api, type SignalHistoryItem, type SignalsResponse } from './services/api'
import { g5 } from './v1/types'
import { CAMBODIA_TIME_ZONE } from './marketSession'

const statusConfig: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  TP1_HIT: { label: 'TP1 Hit', color: '#42c6a5', icon: <Target size={12} /> },
  TP2_HIT: { label: 'TP2 Hit', color: '#42c6a5', icon: <TrendingUp size={12} /> },
  TP3_HIT: { label: 'TP3 Hit · Closed', color: '#42c6a5', icon: <Target size={12} /> },
  STOP_LOSS_HIT: { label: 'Stop Loss Hit', color: '#f07480', icon: <X size={12} /> },
  CLOSED: { label: 'Closed', color: '#8fa3bf', icon: <X size={12} /> },
  CANCELLED: { label: 'Cancelled', color: '#8fa3bf', icon: <X size={12} /> },
  ACTIVE: { label: 'Active', color: '#7dd3fc', icon: <Target size={12} /> },
}

function statusBadge(status: string) {
  const cfg = statusConfig[status] || { label: status, color: '#8fa3bf', icon: <X size={12} /> }
  return (
    <span className="trade-status" style={{ '--c': cfg.color } as React.CSSProperties}>
      {cfg.icon}
      <span>{cfg.label}</span>
    </span>
  )
}

function pnlClass(pnl: number) {
  return pnl > 0 ? 'profit' : pnl < 0 ? 'loss' : 'flat'
}

function formatPnl(pnl: number) {
  const sign = pnl > 0 ? '+' : ''
  return `${sign}${pnl.toFixed(2)}R`
}

export default function TradeHistoryPage() {
  const { user } = useAuth()
  const [trades, setTrades] = useState<SignalHistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'buy' | 'sell' | 'closed' | 'active'>('all')
  const [symbolFilter, setSymbolFilter] = useState('')

  useEffect(() => {
    if (!user) return
    setLoading(true)
    api<SignalsResponse>('/signals')
      .then(data => {
        // Combine open + history, sort by barTime desc
        const all = [...data.open, ...data.history]
          .sort((a, b) => b.barTime - a.barTime)
        setTrades(all)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [user])

  const filtered = trades
    .filter(t => {
      if (filter === 'buy' && t.direction !== 'BUY') return false
      if (filter === 'sell' && t.direction !== 'SELL') return false
      if (filter === 'closed' && !['TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'STOP_LOSS_HIT', 'CLOSED'].includes(t.status)) return false
      if (filter === 'active' && t.status !== 'ACTIVE') return false
      if (symbolFilter && !t.symbol.toLowerCase().includes(symbolFilter.toLowerCase())) return false
      return true
    })
    .slice(0, 200)

  // Calculate P&L in R multiples
  const tradesWithPnl = filtered.map(t => {
    if (!['TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'STOP_LOSS_HIT', 'CLOSED'].includes(t.status)) {
      return { ...t, pnlR: 0, pnlClass: 'flat' as const }
    }
    // Estimate P&L based on what was hit
    let pnlR = 0
    if (t.status === 'TP1_HIT') pnlR = 0.5 // TP1 closes 50%
    else if (t.status === 'TP2_HIT') pnlR = 0.5 + 0.3 // TP1 + TP2
    else if (t.status === 'TP3_HIT') pnlR = 1.0 // All closed
    else if (t.status === 'STOP_LOSS_HIT') pnlR = -1.0 // Full loss
    else if (t.status === 'CLOSED') pnlR = 0.5 // Assume TP1 hit then closed
    return { ...t, pnlR, pnlClass: pnlClass(pnlR) }
  })

  const stats = tradesWithPnl.reduce((acc, t) => {
    acc.total++
    if (t.direction === 'BUY') acc.buys++
    else acc.sells++
    if (t.pnlR > 0) acc.wins++
    else if (t.pnlR < 0) acc.losses++
    acc.totalPnl += t.pnlR
    return acc
  }, { total: 0, buys: 0, sells: 0, wins: 0, losses: 0, totalPnl: 0 })

  const winRate = stats.total > 0 ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1) : '0.0'

  if (loading) {
    return (
      <div className="page-loading">
        <div className="spinner"></div>
        <span>Loading trade history…</span>
      </div>
    )
  }

  return (
    <div className="trade-history-page">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">PERFORMANCE REVIEW</div>
          <h1>Trade history</h1>
          <p>All signal outcomes — closed trades, active setups, and performance metrics.</p>
        </div>
        <div className="page-title-actions">
          <button className="btn btn-secondary" onClick={() => setTrades([])}>Refresh</button>
        </div>
      </div>

      {/* Stats */}
      <div className="trade-stats">
        <div className="stat-card">
          <span className="stat-label">Total Trades</span>
          <strong>{stats.total}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">Win Rate</span>
          <strong>{winRate}%</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">Net P&L</span>
          <strong className={pnlClass(stats.totalPnl)}>{formatPnl(stats.totalPnl)}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">W / L</span>
          <strong>{stats.wins} / {stats.losses}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">Long / Short</span>
          <strong>{stats.buys} / {stats.sells}</strong>
        </div>
      </div>

      {/* Filters */}
      <div className="trade-filters">
        <div className="filter-group">
          <input
            type="text"
            placeholder="Filter symbol…"
            value={symbolFilter}
            onChange={e => setSymbolFilter(e.target.value)}
          />
          <div className="filter-chips">
            {(['all', 'buy', 'sell', 'closed', 'active'] as const).map(f => (
              <button
                key={f}
                className={`filter-chip ${filter === f ? 'active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="trade-table-wrap">
        {tradesWithPnl.length === 0 ? (
          <div className="empty-state">
            <History size={28} />
            <h3>No trades yet</h3>
            <p>Run an analysis on the terminal to generate signals. Closed outcomes appear here.</p>
          </div>
        ) : (
          <table className="trade-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>TF</th>
                <th>Dir</th>
                <th>Outcome</th>
                <th>Entry</th>
                <th>SL</th>
                <th>TP1</th>
                <th>TP2</th>
                <th>TP3</th>
                <th>P&L</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {tradesWithPnl.map(t => (
                <tr key={t.signalId} className={`trade-row ${t.pnlClass}`}>
                  <td>
                    <strong>{t.symbol}</strong>
                    <small>{t.strategyName || ''}</small>
                  </td>
                  <td>{t.timeframe}</td>
                  <td>
                    <span className={`dir-badge ${t.direction === 'BUY' ? 'buy' : 'sell'}`}>
                      {t.direction === 'BUY' ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
                      {t.direction}
                    </span>
                  </td>
                  <td>{statusBadge(t.status)}</td>
                  <td>{g5(t.entry)}</td>
                  <td>{g5(t.stopLoss)}</td>
                  <td>{t.tp1 ? g5(t.tp1) : '—'}</td>
                  <td>{t.tp2 ? g5(t.tp2) : '—'}</td>
                  <td>{t.tp3 ? g5(t.tp3) : '—'}</td>
                  <td className={pnlClass(t.pnlR)}>{formatPnl(t.pnlR)}</td>
                  <td>
                    <span>{new Date(t.barTime).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: CAMBODIA_TIME_ZONE })}</span>
                    <small>{new Date(t.barTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: CAMBODIA_TIME_ZONE })} ICT</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
