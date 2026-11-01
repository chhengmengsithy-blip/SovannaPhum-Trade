import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import {
  Plus, Trash2, Copy, Key, Play, Clock, AlertTriangle, BarChart2,
  FileText, BookOpen, Settings, RefreshCw, Loader2, Zap, Shield, CreditCard,
  TrendingUp, ArrowUpRight, Download, Eye, Edit, Filter, Bell, Target, History
} from 'lucide-react'
import { useAuth } from './auth'
import { api, type SignalHistoryItem } from './services/api'
import { g5 } from './v1/types'

type Tab = 'overview' | 'tokens' | 'backtest' | 'alerts' | 'journal' | 'analytics'

const PRO_FEATURES = [
  { key: 'advancedBacktest', label: 'Advanced Backtesting', desc: 'Run historical simulations on any symbol/timeframe', icon: BarChart2 },
  { key: 'multiTimeframe', label: 'Multi-Timeframe Analysis', desc: 'Analyze confluences across timeframes', icon: ArrowUpRight },
  { key: 'customStrategy', label: 'Custom Rules Builder', desc: 'Define your own entry/exit rules', icon: Settings },
  { key: 'portfolioAnalytics', label: 'Portfolio Analytics', desc: 'P&L, drawdown, win rate, expectancy', icon: TrendingUp },
  { key: 'apiAccess', label: 'Secure Access Keys', desc: 'Private keys for trusted trading tools', icon: Key },
  { key: 'customAlerts', label: 'Custom Alert Rules', desc: 'Signal, price, and indicator alerts', icon: Bell },
  { key: 'tradeJournal', label: 'Trade Journal', desc: 'Track, review, and improve every trade', icon: BookOpen },
  { key: 'riskAnalytics', label: 'Advanced Risk Analytics', desc: 'Position sizing, correlation, VaR', icon: Shield },
  { key: 'marketScanner', label: 'Unlimited Market Scanner', desc: 'Scan all symbols, all timeframes', icon: Zap },
  { key: 'customIndicators', label: 'Custom Indicators', desc: 'Upload and use custom Pine Script', icon: Settings },
] as const

const statusColor: Record<string, string> = {
  pending: '#f59e0b',
  running: '#3b82f6',
  completed: '#22c55e',
  failed: '#ef4444',
}

export default function ProDashboardPage() {
  const { user } = useAuth()
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const [tokens, setTokens] = useState<{ id: string; name: string; prefix: string; scopes: string; last_used_at: string | null; expires_at: string | null; created_at: string }[]>([])
  const [backtests, setBacktests] = useState<{ id: string; name: string; symbol: string; timeframe: string; strategy: string; status: string; progress: number; result: string | null; created_at: string; completed_at: string | null }[]>([])
  interface AlertRule {
  id: string
  name: string
  symbol: string
  timeframe: string
  condition: string
  channels: string
  is_active: number
  created_at: string
  last_triggered: string | null
}
const [alerts, setAlerts] = useState<AlertRule[]>([])
  const [journalEntries, setJournalEntries] = useState<any[]>([])
  const [journalStats, setJournalStats] = useState({ total: 0, wins: 0, losses: 0, winRate: 0, totalPnlR: 0, totalPnlUsd: 0, avgR: 0 })
  const [loading, setLoading] = useState(false)
  const [runningJobId, setRunningJobId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)

  if (!user || user.plan !== 'pro') return <Navigate to="/dashboard" replace />

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 3000)
  }

  // Load data on tab change
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        if (activeTab === 'tokens') {
          const res = await api<{ tokens: any[] }>('/pro/tokens')
          setTokens(res.tokens)
        } else if (activeTab === 'backtest') {
          const res = await api<{ jobs: any[] }>('/pro/backtest')
          setBacktests(res.jobs)
        } else if (activeTab === 'alerts') {
          const res = await api<{ alerts: AlertRule[] }>('/pro/alerts')
          setAlerts(res.alerts)
        } else if (activeTab === 'journal') {
          const [entriesRes, statsRes] = await Promise.all([
            api<{ entries: any[] }>('/pro/journal'),
            api<{ stats: any }>('/pro/journal/stats')
          ])
          setJournalEntries(entriesRes.entries)
          setJournalStats(statsRes.stats)
        }
      } catch (e: any) {
        showToast(e.message || 'Failed to load data', 'error')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [activeTab])

  const hasRunningBacktests = backtests.some(job => job.status === 'running')
  useEffect(() => {
    if (activeTab !== 'backtest' || !hasRunningBacktests) return
    let active = true
    const refresh = async () => {
      try {
        const response = await api<{ jobs: any[] }>('/pro/backtest')
        if (active) setBacktests(response.jobs)
      } catch {
        // The regular tab reload and the next polling tick can recover.
      }
    }
    const timer = window.setInterval(() => void refresh(), 2500)
    return () => { active = false; window.clearInterval(timer) }
  }, [activeTab, hasRunningBacktests])

  // Token actions
  const handleCreateToken = async () => {
    const name = prompt('Access key name:')
    if (!name) return
    const scopes = prompt('Permissions (comma-separated, e.g. read,write,backtest):')?.split(',').map(s => s.trim()).filter(Boolean) || []
    const expiresDays = Number(prompt('Expires in days (optional):') || '0') || undefined
    try {
      const res = await api<{ token: string; prefix: string }>('/pro/tokens', { method: 'POST', body: { name, scopes, expiresDays } })
      showToast(`Access key created: ${res.token}`, 'success')
      const res2 = await api<{ tokens: any[] }>('/pro/tokens')
      setTokens(res2.tokens)
    } catch (e: any) { showToast(e.message || 'Failed to create access key', 'error') }
  }

  const handleRevokeToken = async (id: string) => {
    if (!confirm('Revoke this access key?')) return
    try {
      await api('/pro/tokens', { method: 'DELETE', body: { tokenId: id } })
      showToast('Access key revoked', 'success')
      setTokens(t => t.filter(t => t.id !== id))
    } catch (e: any) { showToast(e.message || 'Failed to revoke', 'error') }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    showToast('Copied to clipboard', 'success')
  }

  // Backtest actions
  const handleCreateBacktest = async () => {
    const name = prompt('Backtest name:')
    if (!name) return
    const symbol = prompt('Symbol (e.g. XAUUSD):')?.toUpperCase()
    if (!symbol) return
    const timeframe = prompt('Timeframe (e.g. 1H):')
    if (!timeframe) return
    try {
      const res = await api<{ jobId: string }>('/pro/backtest', { method: 'POST', body: { name, symbol, timeframe, strategy: 'V3_PRO', params: {} } })
      showToast('Backtest created. Press Play to run it.', 'success')
      const res2 = await api<{ jobs: any[] }>('/pro/backtest')
      setBacktests(res2.jobs)
    } catch (e: any) { showToast(e.message || 'Failed to create backtest', 'error') }
  }

  const handleRunBacktest = async (id: string) => {
    if (runningJobId) return
    setRunningJobId(id)
    try {
      await api(`/pro/backtest/${id}`, { method: 'POST' })
      setBacktests(current => current.map(job => job.id === id ? { ...job, status: 'running', progress: Math.max(10, job.progress) } : job))
      showToast('Backtest is running with real closed candles.', 'success')
    } catch (e: any) {
      showToast(e.message || 'Failed to run backtest', 'error')
    } finally {
      setRunningJobId(null)
    }
  }

  // Alert actions
  const handleCreateAlert = async () => {
    const name = prompt('Alert name:')
    if (!name) return
    const symbol = prompt('Symbol:')?.toUpperCase()
    if (!symbol) return
    const timeframe = prompt('Timeframe (e.g. 1H):')
    if (!timeframe) return
    const condition = prompt('Condition (e.g. price > 1.2000 or RSI < 30):')
    if (!condition) return
    const channels = prompt('Channels (comma-separated: telegram,email,push):')?.split(',').map(s => s.trim()).filter(Boolean) || []
    try {
      await api('/pro/alerts', { method: 'POST', body: { name, symbol, timeframe, condition, channels } })
      showToast('Alert created', 'success')
      const res = await api<{ alerts: any[] }>('/pro/alerts')
      setAlerts(res.alerts)
    } catch (e: any) { showToast(e.message || 'Failed to create alert', 'error') }
  }

  const handleToggleAlert = async (id: string, isActive: number) => {
    try {
      await api(`/pro/alerts/${id}`, { method: 'PATCH', body: { isActive: isActive ? 0 : 1 } })
      setAlerts(a => a.map(a => a.id === id ? { ...a, is_active: isActive ? 0 : 1 } : a))
    } catch (e: any) { showToast(e.message || 'Failed to toggle alert', 'error') }
  }

  // Journal actions
  const handleCreateJournalEntry = async () => {
    const signalId = prompt('Signal ID:')
    if (!signalId) return
    const symbol = prompt('Symbol:')?.toUpperCase()
    if (!symbol) return
    const timeframe = prompt('Timeframe:')
    if (!timeframe) return
    const direction = prompt('Direction (BUY/SELL):')?.toUpperCase()
    if (!direction) return
    const entryPrice = Number(prompt('Entry price:'))
    const stopLoss = Number(prompt('Stop loss:'))
    const tp1 = Number(prompt('TP1:'))
    const positionSize = Number(prompt('Position size:'))
    const riskAmount = Number(prompt('Risk amount (USD):'))
    if (!direction || isNaN(entryPrice) || isNaN(stopLoss) || isNaN(tp1) || isNaN(positionSize) || isNaN(riskAmount)) return
    try {
      await api('/pro/journal', {
        method: 'POST',
        body: { signalId, symbol, timeframe, direction, entryPrice, stopLoss, tp1, positionSize, riskAmount, entryTime: new Date().toISOString() }
      })
      showToast('Journal entry created', 'success')
      const [entriesRes, statsRes] = await Promise.all([
        api<{ entries: any[] }>('/pro/journal'),
        api<{ stats: any }>('/pro/journal/stats')
      ])
      setJournalEntries(entriesRes.entries)
      setJournalStats(statsRes.stats)
    } catch (e: any) { showToast(e.message || 'Failed to create entry', 'error') }
  }

  const handleUpdateJournalEntry = async (id: string, updates: any) => {
    try {
      await api(`/pro/journal/${id}`, { method: 'PATCH', body: updates })
      showToast('Entry updated', 'success')
      const [entriesRes, statsRes] = await Promise.all([
        api<{ entries: any[] }>('/pro/journal'),
        api<{ stats: any }>('/pro/journal/stats')
      ])
      setJournalEntries(entriesRes.entries)
      setJournalStats(statsRes.stats)
    } catch (e: any) { showToast(e.message || 'Failed to update', 'error') }
  }

  const pnlClass = (pnl: number) => pnl > 0 ? 'profit' : pnl < 0 ? 'loss' : 'flat'

  const formatPnl = (pnl: number) => {
    const sign = pnl > 0 ? '+' : ''
    return `${sign}${pnl.toFixed(2)}R`
  }

  const renderTab = () => {
    switch (activeTab) {
      case 'overview':
        return (
          <div className="pro-overview">
            <div className="pro-hero">
              <div className="pro-hero-content">
                <h2>PRO Dashboard</h2>
                <p>Unlimited access to all advanced features. Build, test, and automate your trading edge.</p>
              </div>
              <div className="pro-hero-stats">
                <div className="stat"><span className="stat-value">Unlimited</span><span className="stat-label">Backtests</span></div>
                <div className="stat"><span className="stat-value">Unlimited</span><span className="stat-label">Scans</span></div>
                <div className="stat"><span className="stat-value">Unlimited</span><span className="stat-label">Signals</span></div>
                <div className="stat"><span className="stat-value">10</span><span className="stat-label">Access Keys</span></div>
              </div>
            </div>
            <div className="features-grid">
              {PRO_FEATURES.map(f => (
                <div key={f.key} className="feature-card">
                  <div className="feature-icon" style={{ background: 'rgba(56, 189, 248, 0.15)' }}><f.icon size={20} style={{ color: '#38bdf8' }} /></div>
                  <h4>{f.label}</h4>
                  <p>{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        )

      case 'tokens':
        return (
          <div className="pro-section">
            <div className="section-header">
              <h2><Key size={20} /> Secure Access Keys</h2>
              <button className="btn btn-primary" onClick={handleCreateToken} disabled={tokens.length >= 10}><Plus size={16} /> New Key</button>
            </div>
            {tokens.length === 0 ? (
              <div className="empty-state"><Key size={32} /><h3>No access keys yet</h3><p>Create a private key to authorize a trusted trading tool.</p></div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Name</th><th>Key Prefix</th><th>Permissions</th><th>Last Used</th><th>Expires</th><th>Created</th><th /></tr></thead>
                  <tbody>
                    {tokens.map(t => (
                      <tr key={t.id}>
                        <td><strong>{t.name}</strong></td>
                        <td><code>{t.prefix}***</code></td>
                        <td>{t.scopes}</td>
                        <td>{t.last_used_at ? new Date(t.last_used_at).toLocaleDateString() : 'Never'}</td>
                        <td>{t.expires_at ? new Date(t.expires_at).toLocaleDateString() : 'Never'}</td>
                        <td>{new Date(t.created_at).toLocaleDateString()}</td>
                        <td><button className="icon-btn" onClick={() => handleRevokeToken(t.id)}><Trash2 size={16} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )

      case 'backtest':
        return (
          <div className="pro-section">
            <div className="section-header">
              <h2><BarChart2 size={20} /> Advanced Backtesting</h2>
              <button className="btn btn-primary" onClick={handleCreateBacktest}><Plus size={16} /> New Backtest</button>
            </div>
            {backtests.length === 0 ? (
              <div className="empty-state"><BarChart2 size={32} /><h3>No backtests yet</h3><p>Run historical simulations on any symbol/timeframe</p></div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Name</th><th>Symbol</th><th>TF</th><th>Analysis plan</th><th>State</th><th>Progress</th><th>Result</th><th>Created</th><th /></tr></thead>
                  <tbody>
                    {backtests.map(b => (
                      <tr key={b.id}>
                        <td><strong>{b.name}</strong></td>
                        <td>{b.symbol}</td>
                        <td>{b.timeframe}</td>
                        <td>{b.strategy === 'V3_PRO' ? 'Pro Analysis' : b.strategy}</td>
                        <td><span className="status-badge" style={{ background: statusColor[b.status] }}>{b.status}</span></td>
                        <td><div className="progress-bar"><div className="progress-fill" style={{ width: `${b.progress}%` }} /></div></td>
                        <td>{b.result ? (() => { try { const r = JSON.parse(b.result); return `${r.totalTrades} trades, ${r.winRate}% WR, ${r.totalPnlR}R` } catch { return 'View details' } })() : '—'}</td>
                        <td>{new Date(b.created_at).toLocaleDateString()}</td>
                        <td>{b.status === 'pending' && <button className="icon-btn" aria-label={`Run ${b.name}`} title="Run backtest" disabled={runningJobId === b.id} onClick={() => void handleRunBacktest(b.id)}>{runningJobId === b.id ? <Loader2 size={16} className="spin" /> : <Play size={16} />}</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )

      case 'alerts':
        return (
          <div className="pro-section">
            <div className="section-header">
              <h2><Bell size={20} /> Custom Alert Rules</h2>
              <button className="btn btn-primary" onClick={handleCreateAlert}><Plus size={16} /> New Alert</button>
            </div>
            {alerts.length === 0 ? (
              <div className="empty-state"><Bell size={32} /><h3>No alerts yet</h3><p>Get notified on price, signals, or indicator conditions</p></div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Name</th><th>Symbol</th><th>TF</th><th>Condition</th><th>Channels</th><th>State</th><th>Created</th><th /></tr></thead>
                  <tbody>
                    {alerts.map(a => (
                      <tr key={a.id}>
                        <td><strong>{a.name}</strong></td>
                        <td>{a.symbol}</td>
                        <td>{a.timeframe}</td>
                        <td><code>{a.condition}</code></td>
                        <td>{a.channels}</td>
                        <td><span className={`status-dot ${a.is_active ? 'active' : 'inactive'}`} /></td>
                        <td>{new Date(a.created_at).toLocaleDateString()}</td>
                        <td>
                          <button className="icon-btn" onClick={() => handleToggleAlert(a.id, a.is_active)}>{a.is_active ? <AlertTriangle size={16} /> : <Play size={16} />}</button>
                          <button className="icon-btn" onClick={() => { if (confirm('Delete alert?')) { api(`/pro/alerts/${a.id}`, { method: 'DELETE' }); setAlerts(prev => prev.filter((x: AlertRule) => x.id !== a.id)) } }}><Trash2 size={16} /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )

      case 'journal':
        return (
          <div className="pro-section">
            <div className="section-header">
              <h2><BookOpen size={20} /> Trade Journal</h2>
              <button className="btn btn-primary" onClick={handleCreateJournalEntry}><Plus size={16} /> New Entry</button>
            </div>
            <div className="journal-stats">
              <div className="stat"><span className="stat-label">Total Trades</span><strong>{journalStats.total}</strong></div>
              <div className="stat"><span className="stat-label">Win Rate</span><strong>{journalStats.winRate.toFixed(1)}%</strong></div>
              <div className="stat"><span className="stat-label">Net P&L</span><strong className={pnlClass(journalStats.totalPnlR)}>{journalStats.totalPnlR > 0 ? '+' : ''}{journalStats.totalPnlR.toFixed(2)}R</strong></div>
              <div className="stat"><span className="stat-label">W/L</span><strong>{journalStats.wins} / {journalStats.losses}</strong></div>
              <div className="stat"><span className="stat-label">Avg R</span><strong>{journalStats.avgR > 0 ? '+' : ''}{journalStats.avgR.toFixed(2)}</strong></div>
              <div className="stat"><span className="stat-label">P&L USD</span><strong>{journalStats.totalPnlUsd > 0 ? '+' : ''}${journalStats.totalPnlUsd.toFixed(2)}</strong></div>
            </div>
            {journalEntries.length === 0 ? (
              <div className="empty-state"><BookOpen size={32} /><h3>No journal entries yet</h3><p>Log your trades to track performance and improve</p></div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Symbol</th><th>TF</th><th>Dir</th><th>Entry</th><th>SL</th><th>TP1</th><th>Outcome</th><th>P&L</th><th>Date</th><th /></tr></thead>
                  <tbody>
                    {journalEntries.slice(0, 100).map(e => (
                      <tr key={e.id} className={e.pnl_r > 0 ? 'profit' : e.pnl_r < 0 ? 'loss' : ''}>
                        <td>{e.symbol}</td>
                        <td>{e.timeframe}</td>
                        <td><span className={`dir-badge ${e.direction === 'BUY' ? 'buy' : 'sell'}`}>{e.direction}</span></td>
                        <td>{e.entry_price}</td>
                        <td>{e.stop_loss}</td>
                        <td>{e.tp1}</td>
                        <td>{e.status}</td>
                        <td className={e.pnl_r > 0 ? 'profit' : e.pnl_r < 0 ? 'loss' : ''}>{e.pnl_r !== null ? (e.pnl_r > 0 ? '+' : '') + e.pnl_r.toFixed(2) + 'R' : '—'}</td>
                        <td>{new Date(e.entry_time).toLocaleDateString()}</td>
                        <td><button className="icon-btn" onClick={() => handleUpdateJournalEntry(e.id, { status: 'closed', exitPrice: e.exit_price || 0 })}><Edit size={16} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )

      case 'analytics':
        return (
          <div className="pro-section">
            <h2><TrendingUp size={20} /> Portfolio Analytics</h2>
            <div className="empty-state"><TrendingUp size={32} /><h3>Advanced Analytics</h3><p>Risk metrics, correlation matrix, position sizing optimizer, and more coming soon</p></div>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <div className="pro-dashboard">
      {toast && <div className={`toast ${toast.type}`} onClick={() => setToast(null)}>{toast.message}</div>}
      <div className="pro-sidebar">
        <div className="pro-logo">
          <Zap size={24} style={{ color: '#38bdf8' }} />
          <span>SOVANNAPHUMTRADE PRO</span>
        </div>
        <nav className="pro-nav">
          {[
            { id: 'overview', label: 'Overview', icon: Zap },
            { id: 'tokens', label: 'Access Keys', icon: Key },
            { id: 'backtest', label: 'Backtesting', icon: BarChart2 },
            { id: 'alerts', label: 'Alerts', icon: Bell },
            { id: 'journal', label: 'Trade Journal', icon: BookOpen },
            { id: 'analytics', label: 'Analytics', icon: TrendingUp },
          ].map(t => (
            <button key={t.id} className={`nav-item ${activeTab === t.id ? 'active' : ''}`} onClick={() => setActiveTab(t.id as Tab)}>
              <t.icon size={18} />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      </div>
      <div className="pro-content">
        <div className="pro-header">
          <h1>PRO Dashboard</h1>
          <span className="pro-badge">PRO PLAN</span>
        </div>
        {renderTab()}
      </div>
    </div>
  )
}
