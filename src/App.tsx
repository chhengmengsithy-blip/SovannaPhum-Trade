import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, Bell, Check, ChevronDown, ChevronRight,
  CircleHelp, CreditCard, Crown, Database, Gauge, History, LayoutDashboard,
  Loader2, LockKeyhole, Menu, MessageCircle, PanelLeftClose, PanelLeft, RadioTower, ScanLine, Search,
  Settings2, ShieldAlert, ShieldCheck, Sparkles, Target, Wallet, X, Zap, CandlestickChart, Clock3,
} from 'lucide-react'
import LandingPage from './Landing'
import { LoginPage, SignupPage } from './AuthPages'
import CheckoutPage from './CheckoutPage'
import AdminPage from './AdminPage'
import TelegramPage from './TelegramPage'
import SubscriptionPage from './SubscriptionPage'
import TradeHistoryPage from './TradeHistoryPage'
import ProDashboardPage from './ProDashboardPage'
import ChartAnalyzer from './features/scanner/ChartAnalyzer'
import LightweightChart from './features/terminal/LightweightChart'
import SignalPanel from './features/terminal/SignalPanel'
import SignalTimeline from './features/terminal/SignalTimeline'
import ProResearchPanel from './features/terminal/ProResearchPanel'
import V1LevelsStrip from './features/terminal/V1Levels'
import SignalsPage, { RecentSignalsPanel } from './features/signals/SignalsPage'
import { fetchPlatformHealth, fetchPublicMarkets, fetchSignals, type PlatformHealth, type PublicMarketQuote, type SignalHistoryItem } from './services/api'
import { useSymbolPrice } from './services/marketData'
import { useAuth } from './auth'
import { engineForPlan, hasScanner, planName } from './plan'
import { analyzeSignal, analyzeV2Signal, analyzeV3Signal, scanV2, scanV3, type ScanResponse, type ScanSetupSummary, type SignalResult } from './strategy'
import { PRO_RISK_LABELS, STRATEGY_LABELS, type ProRiskProfile, type StrategyName } from './v3/types'
import { g5 } from './v1/types'
import { formatCambodiaDate, formatCambodiaTime, marketSession } from './marketSession'
import { formatLivePrice, markets, timeframes } from './config/markets'

type IconType = typeof Activity

function BrandMark() { return <img className="brand-logo" src="/sovan-mark.png" alt="" /> }
function Brand() { return <Link to="/" className="brand" aria-label="SOVANNAPHUMTRADE homepage"><span className="brand-mark"><BrandMark /></span><span className="brand-name">SOVANNAPHUMTRADE</span></Link> }

const FX_PAIRS: Record<string, { base: string; quote: string; baseColor: string; quoteColor: string }> = {
  EURUSD: { base: '€', quote: '$', baseColor: '#1B3FA0', quoteColor: '#2775CA' },
  GBPUSD: { base: '£', quote: '$', baseColor: '#B23A48', quoteColor: '#2775CA' },
  USDJPY: { base: '$', quote: '¥', baseColor: '#2775CA', quoteColor: '#C0392B' },
  AUDUSD: { base: 'A$', quote: '$', baseColor: '#0E7C66', quoteColor: '#2775CA' },
}

function MarketLogo({ kind, symbol, size = 31 }: { kind?: string; symbol?: string; size?: number }) {
  const cls = `market-icon market-logo market-logo-${kind ?? 'generic'}`
  if (symbol === 'XAGUSD') return <span className={cls} style={{ width: size, height: size }}><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="#8C99A8"/><path d="M10 20.5h16l-3 7H13Z" fill="#E7EDF4"/><path d="m13.5 12 10-2.5 2 6-10 2.5Z" fill="#F5F9FD"/></svg></span>
  if (symbol === 'ETHUSD') return <span className={cls} style={{ width: size, height: size }}><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="#627EEA"/><path d="M18 6v9.4l7.6 3.2L18 23l-7.6-4.4Z" fill="#fff" opacity=".82"/><path d="M18 30.4v-6.2l7.6-4.1Z" fill="#fff"/></svg></span>
  if (symbol === 'SOLUSD') return <span className={cls} style={{ width: size, height: size }}><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="#12161f"/><path d="M11 23h14l-2.4 3H8.6Zm-2.4-6.5h14l3 3H11Zm2.4-6.5h14l-2.4 3h-14Z" fill="#14F195"/></svg></span>
  if (symbol === 'XRPUSD') return <span className={cls} style={{ width: size, height: size }}><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="#23292F"/><path d="M10.5 11.5c2.8 2.9 4 3.9 7.5 3.9s4.7-1 7.5-3.9M10.5 24.5c2.8-2.9 4-3.9 7.5-3.9s4.7 1 7.5 3.9" stroke="#fff" strokeWidth="2.1" fill="none"/></svg></span>
  if (kind === 'gold' || symbol === 'XAUUSD') return <span className={cls} style={{ width: size, height: size }}><svg viewBox="0 0 36 36"><path d="M6 19.5 10 10h16l4 9.5-12 8Z" fill="#D6A94E"/><path d="M10 10h16l-4 5H8Z" fill="#F6D987"/><path d="M8 15h14l-4 13Z" fill="#B9852F"/></svg></span>
  if (kind === 'energy' || symbol === 'USOIL') return <span className={cls} style={{ width: size, height: size }}><svg viewBox="0 0 36 36"><defs><linearGradient id="oil-drop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#84E7FF"/><stop offset="1" stopColor="#2677C9"/></linearGradient></defs><circle cx="18" cy="18" r="15" fill="#0B1E31"/><path d="M18 7c4.4 6.2 8 10.2 8 15a8 8 0 1 1-16 0c0-4.8 3.6-8.8 8-15Z" fill="url(#oil-drop)"/><path d="M14 23c.8 2.2 2.4 3.3 4.8 3.3" stroke="#D7F7FF" strokeWidth="1.7" strokeLinecap="round" fill="none"/></svg></span>
  if (kind === 'forex') { const pair = FX_PAIRS[symbol ?? ''] ?? FX_PAIRS.EURUSD; return <span className={cls} style={{ width: size, height: size }}><svg viewBox="0 0 36 36"><circle cx="12" cy="18" r="9" fill={pair.baseColor}/><circle cx="24" cy="18" r="9" fill={pair.quoteColor} stroke="#0a192a" strokeWidth="2"/><text x="9.5" y="21.4" textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff">{pair.base}</text><text x="26.5" y="21.4" textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff">{pair.quote}</text></svg></span> }
  if (kind === 'crypto' || symbol === 'BTCUSD') return <span className={cls} style={{ width: size, height: size }}><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="#F7931A"/><path d="M15 8.5v3M20.5 8.5v3M14 12h7.2c3.3 0 4.6 4.3 1.3 5.8 4.4.9 3.6 6.8-.8 6.8H14m2-12.6v13.5m4.5-13.5v13.5" stroke="#fff" strokeWidth="2" fill="none"/></svg></span>
  if (kind === 'indices' || symbol === 'US100') return <span className={cls} style={{ width: size, height: size }}><svg viewBox="0 0 36 36"><rect x="5" y="20" width="5" height="10" rx="1" fill="#6FD8B1"/><rect x="14" y="14" width="5" height="16" rx="1" fill="#6FD8B1"/><rect x="23" y="7" width="5" height="23" rx="1" fill="#6FD8B1"/></svg></span>
  return <span className={cls} style={{ width: size, height: size }}><Activity size={size * .55}/></span>
}

function StatusPill({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted'|'blue'|'green'|'amber' }) { return <span className={`status-pill status-${tone}`}><span className="status-dot"/>{children}</span> }
function Button({ children, variant = 'primary', onClick, to, className = '', disabled = false }: { children: ReactNode; variant?: 'primary'|'secondary'|'ghost'; onClick?: () => void; to?: string; className?: string; disabled?: boolean }) { const cls=`btn btn-${variant} ${className}`; return to ? <Link className={cls} to={to}>{children}</Link> : <button className={cls} onClick={onClick} disabled={disabled}>{children}</button> }
function PageTitle({ eyebrow, title, description, right }: { eyebrow: string; title: string; description: string; right?: ReactNode }) { return <div className="page-title-row"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{right && <div className="page-title-actions">{right}</div>}</div> }
function EmptyState({ icon: Icon = Database, title, description, action }: { icon?: IconType; title: string; description: string; action?: ReactNode }) { return <div className="empty-state"><div className="empty-state-icon"><Icon size={21}/></div><h3>{title}</h3><p>{description}</p>{action}</div> }
function strategyTier(version: 'V1'|'V2'|'V3') { return version === 'V3' ? 'Pro Analysis' : version === 'V2' ? 'Plus Analysis' : 'Free Analysis' }
function tradeState(value: string) { return ({ ACTIVE:'Open', TP1_HIT:'TP1 reached', TP2_HIT:'TP2 reached', TP3_HIT:'Completed', STOP_LOSS_HIT:'Stop reached', CLOSED:'Closed', CANCELLED:'Cancelled' } as Record<string,string>)[value] ?? value.replace(/_/g,' ').toLowerCase() }

const sideItems: { label: string; path: string; icon: IconType; section: string }[] = [
  { label:'Overview',path:'/dashboard',icon:LayoutDashboard,section:'WORKSPACE' }, { label:'Terminal',path:'/terminal',icon:CandlestickChart,section:'WORKSPACE' },
  { label:'Chart scanner',path:'/scanner',icon:ScanLine,section:'WORKSPACE' }, { label:'Signals',path:'/signals',icon:Zap,section:'WORKSPACE' },
  { label:'Trade history',path:'/history',icon:History,section:'WORKSPACE' }, { label:'Telegram alerts',path:'/telegram',icon:MessageCircle,section:'INTEGRATIONS' },
  { label:'Subscription',path:'/subscription',icon:CreditCard,section:'ACCOUNT' }, { label:'Settings',path:'/settings',icon:Settings2,section:'ACCOUNT' },
  { label:'Admin dashboard',path:'/admin',icon:ShieldCheck,section:'ADMIN' },
]

function MarketClock() {
  const [now,setNow]=useState(()=>new Date()); useEffect(()=>{const t=setInterval(()=>setNow(new Date()),1000);return()=>clearInterval(t)},[])
  const hour=now.getUTCHours()+now.getUTCMinutes()/60, fx=marketSession('EURUSD',now).open
  const sessions=[{label:'SYD',open:fx&&(hour>=21||hour<6)},{label:'TYO',open:fx&&hour>=0&&hour<9},{label:'LDN',open:fx&&hour>=7&&hour<16},{label:'NYC',open:fx&&hour>=12&&hour<21}]
  return <div className="market-clock"><Clock3 size={14}/><span className="clock-date">{formatCambodiaDate(now)}</span><span className="clock-time">{formatCambodiaTime(now)}</span><span className="clock-zone">ICT</span><span className="session-dots">{sessions.map(s=><span className={`session ${s.open?'is-open':''}`} key={s.label}><i/>{s.label}</span>)}</span></div>
}

function TradingPerformancePanel({ signals }: { signals: SignalHistoryItem[] }) {
  const active = signals.filter(signal => signal.status === 'ACTIVE').length
  const protectedCount = signals.filter(signal => signal.status === 'TP1_HIT' || signal.status === 'TP2_HIT').length
  const completed = signals.filter(signal => signal.status === 'TP3_HIT' || signal.status === 'CLOSED').length
  const stopped = signals.filter(signal => signal.status === 'STOP_LOSS_HIT').length
  const resolved = completed + stopped
  const completionRate = resolved ? Math.round((completed / resolved) * 100) : null
  const averageScore = signals.length ? Math.round(signals.reduce((total, signal) => total + signal.score, 0) / signals.length) : null
  const symbolCounts = signals.reduce<Record<string, number>>((counts, signal) => ({ ...counts, [signal.symbol]: (counts[signal.symbol] ?? 0) + 1 }), {})
  const mostTracked = Object.entries(symbolCounts).sort((left, right) => right[1] - left[1])[0]?.[0] ?? '—'

  return <section className="panel trading-performance-panel">
    <div className="panel-header"><div><h2>Trading performance</h2><p>Calculated only from your saved setup outcomes.</p></div><span className="performance-sample"><i /> {resolved} resolved</span></div>
    {signals.length ? <div className="performance-body">
      <div className="performance-ring" style={{ '--rate': `${completionRate ?? 0}%` } as React.CSSProperties}><div><strong>{completionRate === null ? '—' : `${completionRate}%`}</strong><span>completion rate</span></div></div>
      <div className="performance-stats">
        <div><span>OPEN</span><strong>{active}</strong></div>
        <div><span>PROTECTED</span><strong className="is-blue">{protectedCount}</strong></div>
        <div><span>COMPLETED</span><strong className="is-green">{completed}</strong></div>
        <div><span>STOPPED</span><strong className="is-red">{stopped}</strong></div>
      </div>
      <div className="performance-foot"><span><small>AVG SETUP SCORE</small><strong>{averageScore ?? '—'}{averageScore !== null ? '/100' : ''}</strong></span><span><small>MOST TRACKED</small><strong>{mostTracked}</strong></span></div>
    </div> : <div className="performance-empty"><Gauge size={19}/><strong>No resolved performance yet</strong><span>Saved setup outcomes will appear here.</span></div>}
  </section>
}

function AppShell({ children }: { children: ReactNode }) {
  const location=useLocation(),navigate=useNavigate(); const [sidebarOpen,setSidebarOpen]=useState(false),[collapsed,setCollapsed]=useState(location.pathname==='/terminal'); const {user,logout}=useAuth(); const plan=user?.plan??'free',admin=user?.role==='admin',initial=(user?.name?.[0]??'U').toUpperCase()
  useEffect(()=>{setCollapsed(location.pathname==='/terminal')},[location.pathname])
  const items=sideItems.filter(i=>(i.path!=='/scanner'||hasScanner(plan))&&(i.section!=='ADMIN'||admin)); const title=sideItems.find(i=>i.path===location.pathname)?.label??'Workspace'
  return <div className={`app-shell ${collapsed?'sidebar-collapsed':''}`}>{sidebarOpen&&<button className="sidebar-scrim" aria-label="Close navigation" onClick={()=>setSidebarOpen(false)}/>}<aside className={`app-sidebar ${sidebarOpen?'sidebar-open':''}`}><div className="sidebar-brand-row"><Brand/><button className="icon-button sidebar-collapse" aria-label={collapsed?'Expand navigation':'Collapse navigation'} title={collapsed?'Expand navigation':'Collapse navigation'} onClick={()=>setCollapsed(v=>!v)}>{collapsed?<PanelLeft size={17}/>:<PanelLeftClose size={17}/>}</button><button className="icon-button mobile-sidebar-close" aria-label="Close navigation" onClick={()=>setSidebarOpen(false)}><X size={17}/></button></div><div className="workspace-switch"><div className="workspace-avatar">{initial}</div><div className="workspace-meta"><strong>{user?.name}</strong><small>{planName(plan)} workspace</small></div><ChevronDown size={15}/></div><nav className="sidebar-nav">{['WORKSPACE','INTEGRATIONS','ACCOUNT','ADMIN'].filter(s=>items.some(i=>i.section===s)).map(s=><div className="nav-section" key={s}><span className="nav-section-label">{s}</span>{items.filter(i=>i.section===s).map(({label,path,icon:Icon})=><NavLink key={path} to={path} onClick={()=>setSidebarOpen(false)} className={({isActive})=>`sidebar-link ${isActive?'active':''}`}><Icon size={17}/><span>{label}</span>{label==='Signals'&&<span className="nav-link-indicator"/>}</NavLink>)}</div>)}</nav><div className="sidebar-bottom"><div className="sidebar-help"><div className="help-icon"><CircleHelp size={17}/></div><div><strong>Need a hand?</strong><small>Explore the workspace guide.</small></div><ChevronRight size={15}/></div><div className="sidebar-profile"><div className="profile-avatar">{initial}</div><div className="profile-meta"><strong>{user?.name}</strong><small>{planName(plan)} plan</small></div><div className="profile-actions"><Link to="/subscription" className="icon-button"><Settings2 size={16}/></Link><button className="icon-button profile-logout" onClick={()=>void logout().then(()=>navigate('/'))}><ArrowRight size={16}/></button></div></div></div></aside><main className="app-main"><header className="app-topbar"><div className="topbar-left"><button className="icon-button mobile-sidebar-toggle" onClick={()=>setSidebarOpen(true)}><Menu size={19}/></button><div className="breadcrumb"><span>Workspace</span><ChevronRight size={14}/><strong>{title}</strong></div></div><div className="topbar-actions"><MarketClock/><div className="connection-indicator"><span className="connection-dot is-connected"/>Market data live</div><Link to="/terminal" className="icon-button"><Search size={17}/></Link><Link to="/telegram" className="icon-button"><Bell size={17}/></Link><div className="topbar-avatar">{initial}</div></div></header><div className="app-content">{children}</div></main></div>
}

function DashboardPage() {
  const {user}=useAuth(); const [now,setNow]=useState(()=>new Date()),[health,setHealth]=useState<PlatformHealth|null>(null),[quotes,setQuotes]=useState<Record<string,PublicMarketQuote>>({}),[signals,setSignals]=useState<SignalHistoryItem[]>([]),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState('')
  useEffect(()=>{const tick=setInterval(()=>setNow(new Date()),30000);return()=>clearInterval(tick)},[])
  useEffect(()=>{let active=true;const load=async()=>{const [h,m,s]=await Promise.allSettled([fetchPlatformHealth(),fetchPublicMarkets(),fetchSignals()]);if(!active)return;if(h.status==='fulfilled')setHealth(h.value);if(m.status==='fulfilled'){setQuotes(Object.fromEntries(m.value.markets.map(q=>[q.symbol,q])));setLoadError('')}else setLoadError('Live market data could not be refreshed. The workspace will retry automatically.');if(s.status==='fulfilled')setSignals([...s.value.open,...s.value.history]);setLoading(false)};void load();const t=setInterval(load,30000);return()=>{active=false;clearInterval(t)}},[])
  const plan=user?.plan??'free',tier=planName(plan),telegram=Boolean(user?.telegram),unique=[...new Map(signals.map(s=>[s.signalId,s])).values()],open=unique.filter(s=>['ACTIVE','TP1_HIT','TP2_HIT'].includes(s.status)).length,quoteCount=Object.values(quotes).filter(q=>q.available).length
  const heroMarkets=['XAUUSD','BTCUSD','EURUSD'].flatMap(symbol=>{const market=markets.find(item=>item.symbol===symbol);return market?[market]:[]})
  const metrics=[{icon:Database,label:'Market data',value:'Yahoo Finance',foot:`${quoteCount} verified market quotes`,status:health?.ok?'Live':'Loading',tone:'gold'},{icon:Zap,label:'Analysis',value:tier,foot:'Closed-candle rules and quality checks',status:'Ready',tone:'emerald'},{icon:MessageCircle,label:'Telegram',value:telegram?`@${user?.telegram}`:'Available',foot:telegram?'Signal delivery linked':'Ready to link',status:telegram?'Linked':'Ready',tone:'teal'},{icon:History,label:'Trade setups',value:`${unique.length} saved`,foot:`${open} open setups`,status:'Updated',tone:'slate'}]
  return <div className={`dashboard-page ${loading?'is-loading':''}`}><PageTitle eyebrow="YOUR WORKSPACE" title="Good to see you." description="Live market charts and saved trade setups are ready." right={<Button to="/terminal">Open terminal <ArrowRight size={15}/></Button>}/>{loadError&&<div className="dashboard-data-error"><ShieldAlert size={14}/><span>{loadError}</span></div>}<section className="overview-hero"><div className="overview-hero-aurora"/><div className="overview-hero-copy"><div className="hero-badge"><span className="hero-badge-pulse"/> LIVE WORKSPACE</div><h2>Your market desk,<br/><span>now with live charts.</span></h2><p>Real Yahoo Finance candles, confirmed key levels and saved trade setups in one professional workspace.</p><div className="overview-hero-actions"><Button to="/terminal">Open the terminal <ArrowRight size={15}/></Button><Button to="/signals" variant="secondary">View trade setups <ChevronRight size={15}/></Button></div><div className="overview-status-row"><span><i className="status-dot-gold"/> Market data {health?.ok?'live':'loading'}</span><span><i className="status-dot-gold"/> {tier} ready</span><span><i className={telegram?'status-dot-gold':'status-dot-muted'}/> Telegram {telegram?'linked':'ready'}</span></div></div><div className="overview-hero-visual"><div className="overview-market-board"><div className="overview-board-head"><span>LIVE MARKET PULSE</span><span className="pipeline-online"><i/> {quoteCount} live</span></div>{heroMarkets.map(m=>{const q=quotes[m.symbol],up=(q?.change24h??0)>=0;return <Link className="overview-market-row" to={`/terminal?symbol=${m.symbol}`} key={m.symbol}><MarketLogo kind={m.kind} symbol={m.symbol}/><span className="overview-market-name"><strong>{m.symbol}</strong><small>{m.name}</small></span><span className={`overview-market-price ${up?'is-up':'is-down'}`}><strong>{q?.price?formatLivePrice(m.symbol,q.price):'—'}</strong><small>{typeof q?.change24h==='number'?`${q.change24h>=0?'+':''}${q.change24h.toFixed(2)}%`:'Loading'}</small></span><ChevronRight size={13}/></Link>})}<div className="overview-board-foot"><span><Clock3 size={12}/> Cambodia time</span><span>{now.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})} ICT</span></div></div></div></section><div className="metric-grid">{metrics.map(({icon:Icon,...m})=><div className="metric-card" key={m.label}><div className="metric-top"><span className={`metric-icon tone-${m.tone}`}><Icon size={18}/></span><StatusPill tone={m.status==='Loading'?'amber':'green'}>{m.status}</StatusPill></div><span className="metric-label">{m.label}</span><strong className="metric-value">{m.value}</strong><span className="metric-foot">{m.foot}</span></div>)}</div><div className="dashboard-main-grid"><section className="panel market-watch-panel"><div className="panel-header"><div><h2>Market watch</h2><p>Real prices and current sessions.</p></div><Button to="/terminal" variant="ghost">View terminal <ArrowRight size={14}/></Button></div><div className="market-table"><div className="market-table-head"><span>MARKET</span><span>SESSION</span><span>REAL PRICE</span><span/></div>{markets.map(m=>{const session=marketSession(m.symbol,now),q=quotes[m.symbol];return <Link to={`/terminal?symbol=${m.symbol}`} className="market-table-row" key={m.symbol}><span className="market-cell"><MarketLogo kind={m.kind} symbol={m.symbol}/><span><strong>{m.symbol}</strong><small>{m.name}</small></span></span><StatusPill tone={session.open?'green':'amber'}>{session.label}</StatusPill><span className="dashboard-live-price"><strong>{q?.price?formatLivePrice(m.symbol,q.price):'—'}</strong><small className={(q?.change24h??0)>=0?'is-up':'is-down'}>{typeof q?.change24h==='number'?`${q.change24h>=0?'+':''}${q.change24h.toFixed(2)}%`:'Loading'}</small></span><ChevronRight size={15}/></Link>})}</div></section><div className="dashboard-side-stack"><section className="panel quick-actions-panel"><div className="panel-header"><div><h2>Workspace shortcuts</h2><p>Open your trading tools.</p></div></div><Link to="/terminal" className="quick-action"><span className="quick-action-icon"><CandlestickChart size={18}/></span><span><strong>Open terminal</strong><small>Chart markets and run analysis</small></span><ArrowUpRight size={16}/></Link><Link to="/telegram" className="quick-action"><span className="quick-action-icon"><MessageCircle size={18}/></span><span><strong>Telegram alerts</strong><small>Manage signal notifications</small></span><ArrowUpRight size={16}/></Link><Link to="/signals" className="quick-action"><span className="quick-action-icon"><Zap size={18}/></span><span><strong>Trade setups</strong><small>Review saved decisions</small></span><ArrowUpRight size={16}/></Link></section><section className="panel dashboard-pipeline-panel"><div className="panel-header"><div><h2>Trading workflow</h2><p>Live data to saved decision.</p></div><span className="pipeline-online"><i/> LIVE</span></div><div className="dashboard-pipeline"><div className="is-complete"><span><Database size={14}/></span><div><strong>Market feed</strong><small>Yahoo history and quotes</small></div><Check size={13}/></div><div className="is-complete"><span><ScanLine size={14}/></span><div><strong>{tier} analysis</strong><small>Closed-candle validation</small></div><Check size={13}/></div><div className="is-complete"><span><ShieldCheck size={14}/></span><div><strong>Saved records</strong><small>{unique.length} trade setups available</small></div><Check size={13}/></div><div className={telegram?'is-complete':''}><span><MessageCircle size={14}/></span><div><strong>Telegram delivery</strong><small>{telegram?`Linked to @${user?.telegram}`:'Ready to link'}</small></div>{telegram?<Check size={13}/>:<ChevronRight size={13}/>}</div></div></section></div></div><div className="dashboard-insight-grid"><TradingPerformancePanel signals={unique}/><RecentSignalsPanel/></div></div>
}

function ScanResults({scan,onSelect,onClose}:{scan:ScanResponse;onSelect:(s:ScanSetupSummary)=>void;onClose:()=>void}) { return <section className="scan-panel"><header className="scan-head"><div><span className="signal-kicker"><ScanLine size={12}/> MARKET SCAN</span><h3>{scan.scanned} markets <span>· {scan.timeframe}</span></h3><small>{scan.provider}</small></div><button className="icon-button" onClick={onClose}><X size={15}/></button></header><div className="scan-list">{scan.setups.map(s=><button key={s.symbol} className={`scan-row is-${s.action==='BUY'?'buy':s.action==='SELL'?'sell':'wait'}`} onClick={()=>onSelect(s)}><span className="scan-symbol"><MarketLogo kind={markets.find(m=>m.symbol===s.symbol)?.kind} symbol={s.symbol} size={24}/><strong>{s.symbol}</strong></span><span className="scan-action">{s.action.replace('_',' ')}</span><span className="scan-points">{s.score.toFixed(0)}/100</span><span className="scan-reason">{s.reason.split(';')[0]}</span></button>)}</div></section> }
function SignalStatus({analysis,version}:{analysis:SignalResult|null;version:'V1'|'V2'|'V3'}) { if(!analysis)return <div className="signal-status waiting"><RadioTower size={16}/><div className="signal-status-text"><strong>Ready to analyze</strong><span>Run the {strategyTier(version)} on the current closed candle.</span></div></div>; if(analysis.action!=='NO_SIGNAL')return <div className="signal-status has-signal"><RadioTower size={16}/><div className="signal-status-text"><strong>Signal generated: {analysis.action} {analysis.symbol} {analysis.timeframe}</strong><span>Score {analysis.score.total.toFixed(0)}/100 · Entry {analysis.levels?g5(analysis.levels.entry):'—'}</span></div></div>; return <div className="signal-status no-signal"><RadioTower size={16}/><div className="signal-status-text"><strong>No signal on this closed candle</strong><span>{analysis.reason}</span></div></div> }

function TerminalPage() {
  const { user } = useAuth()
  const plan = user?.plan ?? 'free'
  const version = engineForPlan(plan)
  const paid = version !== 'V1'
  const pro = version === 'V3'
  const [params] = useSearchParams()
  const requested = params.get('symbol') ?? ''
  const requestedTimeframe = params.get('timeframe') ?? ''
  const [symbol, setSymbol] = useState(markets.some(market => market.symbol === requested) ? requested : 'XAUUSD')
  const [timeframe, setTimeframe] = useState<string>((timeframes as readonly string[]).includes(requestedTimeframe) ? requestedTimeframe : '15m')
  const [watch, setWatch] = useState(true)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [inspector, setInspector] = useState(false)
  const [tab, setTab] = useState<'ANALYSIS'|'HISTORY'|'MANAGE'>('ANALYSIS')
  const [analysis, setAnalysis] = useState<SignalResult|null>(null)
  const [chartSignal, setChartSignal] = useState<SignalResult|null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [scan, setScan] = useState<ScanResponse|null>(null)
  const [scanning, setScanning] = useState(false)
  const [signals, setSignals] = useState<SignalHistoryItem[]>([])
  const [quotes, setQuotes] = useState<Record<string, PublicMarketQuote>>({})
  const [now, setNow] = useState(() => new Date())
  const [playbook, setPlaybook] = useState<'AUTO'|StrategyName>('AUTO')
  const [risk, setRisk] = useState<ProRiskProfile>('MEDIUM')
  const { priceData, connected, error: streamError } = useSymbolPrice(symbol)
  const session = marketSession(symbol, now)
  const request = useRef(0)
  const analysisDrawerRef = useRef<HTMLElement>(null)

  useEffect(() => {
    let active = true
    fetchSignals({ symbol }).then(data => {
      if (active) setSignals([...data.open, ...data.history].filter(item => item.symbol === symbol).sort((left, right) => right.barTime - left.barTime))
    }).catch(() => {})
    return () => { active = false }
  }, [symbol, timeframe])

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const response = await fetchPublicMarkets()
        if (active) setQuotes(Object.fromEntries(response.markets.map(quote => [quote.symbol, quote])))
      } catch { /* Current-symbol streaming remains available. */ }
    }
    void load()
    const timer = window.setInterval(load, 30_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    setAnalysis(null)
    setChartSignal(null)
    setError('')
    setInspector(false)
    request.current += 1
  }, [symbol, timeframe, playbook, risk])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!inspector) return
    const timer = window.setTimeout(() => analysisDrawerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 180)
    return () => window.clearTimeout(timer)
  }, [inspector, tab])

  const analyze = async () => {
    const id = ++request.current
    setBusy(true)
    setError('')
    try {
      const result = version === 'V3'
        ? await analyzeV3Signal({ symbol, timeframe, playbook, riskProfile: risk })
        : version === 'V2'
          ? await analyzeV2Signal({ symbol, timeframe })
          : await analyzeSignal({ symbol, timeframe })
      if (id === request.current) {
        setAnalysis(result)
        setChartSignal(result)
        setTab('ANALYSIS')
        setInspector(true)
        const data = await fetchSignals({ symbol })
        if (id === request.current) setSignals([...data.open, ...data.history].filter(item => item.symbol === symbol).sort((left, right) => right.barTime - left.barTime))
      }
    } catch (caught) {
      if (id === request.current) setError(caught instanceof Error ? caught.message : 'Analysis failed.')
    } finally {
      if (id === request.current) setBusy(false)
    }
  }

  const runScan = async () => {
    if (!paid) return
    setScanning(true)
    try {
      const result = version === 'V3'
        ? await scanV3({ timeframe, symbols: markets.map(market => market.symbol), playbook, riskProfile: risk })
        : await scanV2({ timeframe, symbols: markets.map(market => market.symbol) })
      setScan(result)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Scan failed.')
    } finally {
      setScanning(false)
    }
  }

  const choose = (setup: ScanSetupSummary) => {
    if (setup.symbol !== symbol) setSymbol(setup.symbol)
    if (setup.timeframe !== timeframe) setTimeframe(setup.timeframe)
    window.setTimeout(() => {
      setAnalysis(setup.result)
      setChartSignal(setup.result)
      setTab('ANALYSIS')
      setInspector(true)
    }, 0)
  }

  const tier = strategyTier(version)
  const open = signals.filter(item => ['ACTIVE', 'TP1_HIT', 'TP2_HIT'].includes(item.status))
  const activeMarket = markets.find(market => market.symbol === symbol) ?? markets[0]
  const marketGroups = [
    { id: 'metals', label: 'GOLD & METALS', kinds: ['gold'] },
    { id: 'energy', label: 'ENERGY', kinds: ['energy'] },
    { id: 'forex', label: 'FOREX MAJORS', kinds: ['forex'] },
    { id: 'crypto', label: 'CRYPTO 24/7', kinds: ['crypto'] },
    { id: 'indices', label: 'INDICES', kinds: ['indices'] },
  ]
  const normalizedQuery = query.trim().toLowerCase()

  return (
    <div className="terminal-page terminal-v2-layout">
      <PageTitle eyebrow="TRADING WORKSPACE" title="Terminal" description="Real market candles, confirmed key levels and complete trade plans." right={<span className={`terminal-session ${session.open ? 'is-live' : 'is-closed'}`}><span className="inline-status-dot" />{session.label}</span>} />
      <div className="terminal-shell">
        <div className="terminal-toolbar">
          <div className="terminal-active-market">
            <MarketLogo kind={activeMarket.kind} symbol={activeMarket.symbol} size={28} />
            <span><strong>{activeMarket.symbol}</strong><small>{activeMarket.name}</small></span>
          </div>
          <div className="timeframe-group">{timeframes.map(item => <button type="button" key={item} className={timeframe === item ? 'timeframe-active' : ''} onClick={() => setTimeframe(item)}>{item}</button>)}</div>
          <div className="toolbar-tools">
            <span className={`engine-badge is-${version.toLowerCase()}`}>{tier}</span>
            <button className={`icon-button ${watch ? 'is-active' : ''}`} onClick={() => setWatch(value => !value)} title="Toggle market selector"><PanelLeft size={16} /></button>
            <button className={`icon-button ${inspector ? 'is-active' : ''}`} onClick={() => setInspector(value => !value)} title="Toggle analysis panel"><Activity size={16} /></button>
          </div>
        </div>

        {pro && <div className="pro-playbook-bar"><div className="pro-playbook-select"><span><Crown size={13} /> PRO ANALYSIS · PLAYBOOK</span><select value={playbook} onChange={event => setPlaybook(event.target.value as 'AUTO'|StrategyName)}><option value="AUTO">Auto · Best fit</option>{Object.entries(STRATEGY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div className="pro-risk-control"><span>QUALITY / RISK</span><div>{(['LOW', 'MEDIUM', 'HIGH'] as ProRiskProfile[]).map(profile => <button type="button" key={profile} className={risk === profile ? 'is-active' : ''} onClick={() => setRisk(profile)}>{profile}</button>)}</div></div><p>{PRO_RISK_LABELS[risk]} checks · protected structural levels</p></div>}

        <div className={`terminal-layout ${watch ? '' : 'no-watchlist'}`}>
          {watch && <aside className="terminal-watchlist terminal-market-rail">
            <div className="terminal-subhead"><div><span>MARKET SELECTOR</span><strong>Choose a symbol</strong></div><button className={`icon-button ${searching ? 'is-active' : ''}`} onClick={() => setSearching(value => !value)} aria-label="Search markets"><Search size={14} /></button></div>
            {searching && <div className="watchlist-search"><Search size={12} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search symbol…" autoFocus /></div>}
            <div className="market-rail-scroll">
              {marketGroups.map(group => {
                const groupMarkets = markets.filter(market => group.kinds.includes(market.kind) && (!normalizedQuery || `${market.symbol} ${market.name}`.toLowerCase().includes(normalizedQuery)))
                if (!groupMarkets.length) return null
                return <section className="market-rail-group" key={group.id}><header><span>{group.label}</span><b>{groupMarkets.length}</b></header>{groupMarkets.map(market => {
                  const quote = quotes[market.symbol]
                  const marketState = marketSession(market.symbol, now)
                  const change = quote?.change24h
                  return <button type="button" className={`watchlist-row ${symbol === market.symbol ? 'selected' : ''}`} key={market.symbol} onClick={() => setSymbol(market.symbol)}><MarketLogo kind={market.kind} symbol={market.symbol} size={30} /><span className="watchlist-name"><strong>{market.symbol}</strong><small>{market.name}</small></span><span className="watchlist-quote"><strong>{quote?.price != null ? formatLivePrice(market.symbol, quote.price) : '—'}</strong><small className={typeof change === 'number' ? change >= 0 ? 'is-up' : 'is-down' : ''}>{typeof change === 'number' ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : marketState.label}</small></span><i className={marketState.open ? 'is-open' : ''} /></button>
                })}</section>
              })}
            </div>
            <div className="watchlist-footer"><Clock3 size={11} /> Cambodia time · real quotes</div>
          </aside>}

          <div className="terminal-workspace-main">
            <div className="terminal-chart-column">
              <div className="chart-instrument-bar">
                <div><strong>{symbol}</strong><span className="muted"> · {activeMarket.name}</span><div className="instrument-subtitle">{timeframe} · Cambodia time · closed candles</div></div>
                <div className="chart-status-row">
                  {paid && <Button variant="secondary" onClick={runScan} disabled={scanning} className="chart-scan-quick">{scanning ? <Loader2 size={13} className="spin" /> : <><ScanLine size={13} /> Scan</>}</Button>}
                  <Button onClick={analyze} disabled={busy} className="chart-analyze-quick">{busy ? <><Loader2 size={13} className="spin" />Analyzing…</> : <><Sparkles size={13} />Analyze</>}</Button>
                  <StatusPill tone={session.open && connected ? 'green' : 'amber'}>{session.open ? connected ? 'Streaming' : 'Loading' : 'Closed'} · Yahoo Finance</StatusPill>
                  {priceData && <span className="live-price-display"><strong>{formatLivePrice(symbol, priceData.price)}</strong><small className={priceData.change24h >= 0 ? 'is-up' : 'is-down'}>{priceData.change24h >= 0 ? '+' : ''}{priceData.change24h.toFixed(2)}%</small></span>}
                </div>
              </div>
              <LightweightChart key={`${symbol}:${timeframe}`} symbol={symbol} timeframe={timeframe} analysis={chartSignal} existingSignals={signals} livePrice={priceData} streamConnected={connected && session.open} />
              {chartSignal && <V1LevelsStrip result={chartSignal} />}
              {(error || streamError) && <div className="terminal-error-banner">{error || streamError}</div>}
              {scan && <ScanResults scan={scan} onSelect={choose} onClose={() => setScan(null)} />}
            </div>

            <section ref={analysisDrawerRef} className={`terminal-analysis-drawer ${inspector ? 'is-open' : 'is-collapsed'}`}>
              <button type="button" className="analysis-drawer-toggle" onClick={() => setInspector(value => !value)} aria-expanded={inspector}>
                <span className="analysis-drawer-title"><span className="analysis-drawer-icon"><Activity size={15} /></span><span><small>TRADE DESK</small><strong>{analysis ? `${analysis.action.replace('_', ' ')} · ${Math.round(analysis.score.total)}/100` : 'Analysis & key levels'}</strong></span></span>
                <span className="analysis-drawer-meta">{symbol} · {timeframe}<ChevronDown size={15} /></span>
              </button>
              {inspector && <>
                <nav className="terminal-inspector-tabs"><button className={tab === 'ANALYSIS' ? 'is-active' : ''} onClick={() => setTab('ANALYSIS')}><Activity size={12} />Analysis</button><button className={tab === 'HISTORY' ? 'is-active' : ''} onClick={() => setTab('HISTORY')}><History size={12} />History</button><button className={tab === 'MANAGE' ? 'is-active' : ''} onClick={() => setTab('MANAGE')}><Target size={12} />Manage</button></nav>
                <div className="terminal-inspector-body">
                  {tab === 'ANALYSIS' && <div className="integrated-analysis-stack">
                    {pro && <details className="integrated-playbook-context"><summary><span><Crown size={13}/><span><small>PLAYBOOK CONTEXT</small><strong>{playbook === 'AUTO' ? 'Auto · Best fit' : STRATEGY_LABELS[playbook]}</strong></span></span><ChevronDown size={14}/></summary><ProResearchPanel symbol={symbol} timeframe={timeframe} playbook={playbook} riskProfile={risk}/></details>}
                    {analysis
                    ? <SignalPanel result={analysis} onClose={() => { setAnalysis(null); setInspector(false) }} />
                    : <div className="inspector-empty"><Activity size={20} /><strong>No analysis selected</strong><p>Run Analyze to map structure, key levels and trade quality.</p><Button onClick={analyze}>Analyze now</Button><div className="inspector-glance"><span className="inspector-section-title">MARKET SNAPSHOT</span><div className="glance-row"><span>Last price</span><strong>{priceData ? formatLivePrice(symbol, priceData.price) : '—'}{priceData && <em className={priceData.change24h >= 0 ? 'is-up' : 'is-down'}>{priceData.change24h >= 0 ? '+' : ''}{priceData.change24h.toFixed(2)}%</em>}</strong></div><div className="glance-row"><span>Session</span><strong>{session.label}</strong></div><div className="glance-row"><span>Timeframe</span><strong>{timeframe} · ICT</strong></div><div className="glance-row"><span>Analysis plan</span><strong>{tier}</strong></div><div className="glance-row"><span>Open setups</span><strong>{open.length}</strong></div></div></div>}
                  </div>}
                  {tab === 'HISTORY' && <SignalTimeline signals={signals} symbol={symbol} timeframe={timeframe} marketOpen={session.open} />}
                  {tab === 'MANAGE' && <div className="inspector-manage"><div className="inspector-section-title"><span>OPEN SETUPS</span><b>{open.length}</b></div>{open.length ? open.map(item => <article key={item.signalId} className={`manage-setup is-${item.direction.toLowerCase()}`}><div><strong>{item.direction} {item.symbol}</strong><span>{item.timeframe} · {strategyTier(item.engine)}</span></div><small>Entry {g5(item.entry)} · SL {g5(item.stopLoss)}</small><small>TP1 {g5(item.tp1)} · {tradeState(item.status)}</small></article>) : <div className="inspector-empty is-small"><Wallet size={17} /><strong>No open setups</strong></div>}</div>}
                </div>
              </>}
            </section>
          </div>
        </div>
        <div className="terminal-footer-bar"><span><span className={`inline-status-dot ${session.open ? '' : 'is-closed'}`} /> {session.label} · {session.reason}</span><span>{symbol}</span><span>{timeframe}</span><span className="terminal-footer-right">{tier} · ICT · Yahoo Finance</span></div>
      </div>
    </div>
  )
}

function ScannerPage(){const{user}=useAuth(),plan=user?.plan??'free';if(!hasScanner(plan))return <><PageTitle eyebrow="CHART SCANNER" title="Chart scanner" description="Upload a chart for market structure analysis."/><section className="panel generic-empty-panel"><EmptyState icon={LockKeyhole} title="Plus feature" description="Upgrade to Plus or Pro for unlimited scanner setups." action={<Button to="/subscription">View plans</Button>}/></section></>;return <><PageTitle eyebrow="CHART SCANNER" title="Chart scanner" description="Unlimited BUY/SELL image setups with real Entry, SL and TP levels." right={<span className="analyzer-badge"><ScanLine size={13}/> Plus & Pro</span>}/><ChartAnalyzer/></>}
function SettingsPage(){const{user}=useAuth(),plan=user?.plan??'free';return <><PageTitle eyebrow="WORKSPACE" title="Settings" description="Review live services and account options."/><div className="generic-page-grid"><div className="data-status-card"><h3>Live market data</h3><p>Yahoo Finance history and streaming quotes power the terminal.</p><StatusPill tone="green">Live</StatusPill></div><div className="data-status-card"><h3>{planName(plan)} Analysis</h3><p>Plan rules and quality checks apply to every closed-candle analysis.</p><StatusPill tone="green">Ready</StatusPill></div><div className="data-status-card"><h3>Telegram</h3><p>{user?.telegram?`Linked to @${user.telegram}`:'Ready to link from Integrations.'}</p><StatusPill tone={user?.telegram?'green':'blue'}>{user?.telegram?'Linked':'Available'}</StatusPill></div></div></>}

function WorkspaceApp(){return <AppShell><Routes><Route path="/dashboard" element={<DashboardPage/>}/><Route path="/terminal" element={<TerminalPage/>}/><Route path="/scanner" element={<ScannerPage/>}/><Route path="/signals" element={<SignalsPage/>}/><Route path="/history" element={<TradeHistoryPage/>}/><Route path="/pro" element={<ProDashboardPage/>}/><Route path="/telegram" element={<TelegramPage/>}/><Route path="/subscription" element={<SubscriptionPage/>}/><Route path="/settings" element={<SettingsPage/>}/><Route path="/admin" element={<AdminPage/>}/><Route path="*" element={<DashboardPage/>}/></Routes></AppShell>}
function RouteReveal(){const location=useLocation();useEffect(()=>{const els=[...document.querySelectorAll<HTMLElement>('.app-content .page-title-row,.app-content .overview-hero,.app-content .panel,.app-content .terminal-shell')];const obs=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('is-visible');obs.unobserve(e.target)}}),{threshold:.06});els.forEach((e,i)=>{e.classList.add('scroll-reveal');e.style.setProperty('--reveal-delay',`${Math.min(i,7)*50}ms`);obs.observe(e)});return()=>obs.disconnect()},[location.pathname]);return null}
function RequireAuth({children}:{children:ReactNode}){const{user,ready}=useAuth(),location=useLocation();if(!ready)return <div className="auth-loading"><Loader2 className="spin"/><span>Preparing workspace…</span></div>;return user?<>{children}</>:<Navigate to="/login" replace state={{from:`${location.pathname}${location.search}`}}/>}
function PublicOnly({children}:{children:ReactNode}){const{user,ready}=useAuth();if(!ready)return <div className="auth-loading"><Loader2 className="spin"/></div>;return user?<Navigate to={user.role==='admin'?'/admin':'/dashboard'} replace/>:<>{children}</>}

export default function App(){return <Routes><Route path="/" element={<LandingPage/>}/><Route path="/login" element={<PublicOnly><LoginPage/></PublicOnly>}/><Route path="/signup" element={<PublicOnly><SignupPage/></PublicOnly>}/><Route path="/checkout" element={<RequireAuth><CheckoutPage/></RequireAuth>}/><Route path="/*" element={<RequireAuth><RouteReveal/><WorkspaceApp/></RequireAuth>}/></Routes>}
