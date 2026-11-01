import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from './auth'
import { fetchPublicMarkets, type PublicMarketQuote } from './services/api'
import {
  ArrowRight, ArrowUpRight, BadgeCheck, Check, ChevronRight, Gauge, Globe2, History,
  Layers3, Menu, MessageCircle, ScanLine, ShieldCheck, Sparkles, Target, TrendingUp, X, Zap,
} from 'lucide-react'

/* ------------------------------------------------------------------ coins --- */

type CoinKind = 'usd' | 'eur' | 'gbp' | 'jpy' | 'gold' | 'oil' | 'btc' | 'eth' | 'index'

const coinClip: Record<string, string> = { usd: 'lp-clip-usd', gbp: 'lp-clip-gbp', aud: 'lp-clip-aud' }

function Coin({ kind, size = 34 }: { kind: CoinKind; size?: number }) {
  const style = { width: size, height: size }
  const svg = (children: React.ReactNode) => (
    <svg viewBox="0 0 40 40" style={style} aria-hidden="true">{children}</svg>
  )

  if (kind === 'usd') return svg(<>
    <defs><clipPath id="lp-clip-usd"><circle cx="20" cy="20" r="20" /></clipPath></defs>
    <g clipPath="url(#lp-clip-usd)">
      <rect width="40" height="40" fill="#f7f7f7" />
      {[3, 9, 15, 21, 27, 33].map(y => <rect key={y} y={y} width="40" height="3.2" fill="#b22234" />)}
      <rect width="19" height="15" fill="#3c3b6e" />
      {[1, 4, 7, 10, 13, 16].map(x => [3, 6.5, 10, 13.5].map(y => <circle key={`${x}-${y}`} cx={x} cy={y} r=".7" fill="#fff" />))}
    </g>
  </>)

  if (kind === 'eur') return svg(<>
    <circle cx="20" cy="20" r="20" fill="#003399" />
    {Array.from({ length: 12 }).map((_, i) => {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2
      return <circle key={i} cx={20 + Math.cos(a) * 11.5} cy={20 + Math.sin(a) * 11.5} r="1.5" fill="#ffcc00" />
    })}
  </>)

  if (kind === 'gbp') return svg(<>
    <defs><clipPath id="lp-clip-gbp"><circle cx="20" cy="20" r="20" /></clipPath></defs>
    <circle cx="20" cy="20" r="20" fill="#16307a" />
    <g clipPath="url(#lp-clip-gbp)">
      <path d="M0 0 40 40M40 0 0 40" stroke="#fff" strokeWidth="8" />
      <path d="M0 0 40 40M40 0 0 40" stroke="#c8102e" strokeWidth="3.4" />
      <path d="M20 0v40M0 20h40" stroke="#fff" strokeWidth="13" />
      <path d="M20 0v40M0 20h40" stroke="#c8102e" strokeWidth="7" />
    </g>
  </>)

  if (kind === 'jpy') return svg(<>
    <circle cx="20" cy="20" r="20" fill="#f8f8f8" />
    <circle cx="20" cy="20" r="9.5" fill="#bc002d" />
  </>)

  if (kind === 'gold') return svg(<>
    <defs>
      <linearGradient id="lp-gold-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#f8e3a4" /><stop offset=".55" stopColor="#d9ab53" /><stop offset="1" stopColor="#a9761f" />
      </linearGradient>
    </defs>
    <circle cx="20" cy="20" r="20" fill="url(#lp-gold-grad)" />
    <path d="M10 25h20l-2.6-9.4H12.6Z" fill="#fff3cd" />
    <path d="M12.6 15.6h14.8l1.2 2.2H11.4Z" fill="#f4dc9c" />
    <path d="M10 25h20l-1.4 2.4H11.4Z" fill="#8f621a" opacity=".55" />
  </>)

  if (kind === 'oil') return svg(<>
    <defs><linearGradient id="lp-oil-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#83e7ff" /><stop offset="1" stopColor="#2676c9" /></linearGradient></defs>
    <circle cx="20" cy="20" r="20" fill="#091d31" />
    <path d="M20 6.5c5.8 8.2 10 13.3 10 19a10 10 0 1 1-20 0c0-5.7 4.2-10.8 10-19Z" fill="url(#lp-oil-grad)" />
    <path d="M15 26.5c1.1 2.8 3.1 4.1 6 4.1" stroke="#ddf8ff" strokeWidth="2" strokeLinecap="round" fill="none" />
  </>)

  if (kind === 'btc') return svg(<>
    <circle cx="20" cy="20" r="20" fill="#f7931a" />
    <path d="M16 9v3.4M22.2 9v3.4M14.6 13h8.6c3.4 0 4.7 4.6 1.3 6.2 4.6 1 3.7 7.2-.9 7.2h-9m2.6-13.4v14.2m4.8-14.2v14.2"
      stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </>)

  if (kind === 'eth') return svg(<>
    <circle cx="20" cy="20" r="20" fill="#4b5fe0" />
    <path d="M20 7.5 12.8 20.4 20 24.7l7.2-4.3Z" fill="#fff" />
    <path d="M20 26.4 12.8 22.1 20 33.5l7.2-11.4Z" fill="#fff" opacity=".72" />
  </>)

  return svg(<>
    <defs>
      <linearGradient id="lp-index-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#2fe3ad" /><stop offset="1" stopColor="#0e8f74" />
      </linearGradient>
    </defs>
    <circle cx="20" cy="20" r="20" fill="url(#lp-index-grad)" />
    <rect x="10" y="21" width="4.4" height="9" rx="1.2" fill="#06251d" opacity=".75" />
    <rect x="17.8" y="16" width="4.4" height="14" rx="1.2" fill="#06251d" opacity=".85" />
    <rect x="25.6" y="11" width="4.4" height="19" rx="1.2" fill="#06251d" />
    <path d="m10 17.5 7-5 6 2.4 7-6.2" stroke="#eafff8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </>)
}

function PairBadge({ base, quote, size = 34 }: { base: CoinKind; quote?: CoinKind; size?: number }) {
  const quoteSize = Math.round(size * 0.64)
  return (
    <span className="lp-pair" style={{ '--s': `${size}px` } as React.CSSProperties}>
      <span className="lp-coin"><Coin kind={base} size={size} /></span>
      {quote && <span className={`lp-pair-quote ${coinClip[quote] ? 'clipped' : ''}`} style={{ width: quoteSize, height: quoteSize }}><Coin kind={quote} size={quoteSize} /></span>}
    </span>
  )
}

/* ------------------------------------------------------------------ brand --- */

function LandingBrand() {
  return (
    <Link to="/" className="lp-brand" aria-label="SOVANNAPHUMTRADE home">
      <img src="/sovan-mark.png" alt="" />
      <span>SOVANNAPHUMTRADE</span>
    </Link>
  )
}

const navLinks = [
  { label: 'Markets', href: '#markets' },
  { label: 'Market analysis', href: '#analysis' },
  { label: 'Platform', href: '#platform' },
  { label: 'Founder', href: '#founder' },
  { label: 'Pricing', href: '#pricing' },
]

const TIKTOK_URL = 'https://www.tiktok.com/@chhengmengsithy0?_r=1&_t=ZS-9AydKLF3NPI'
const FACEBOOK_URL = 'https://www.facebook.com/share/1DEMiWh5wi/'
const TELEGRAM_URL = 'https://t.me/Chhengmengsithy'

function TikTokIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="currentColor">
      <path d="M16.6 2h-3.1v13.6a2.9 2.9 0 1 1-2.9-2.9c.3 0 .6 0 .9.1V9.6a6 6 0 0 0-.9-.1 6.1 6.1 0 1 0 6.1 6.1V8.2a7.7 7.7 0 0 0 4.4 1.4V6.5a4.4 4.4 0 0 1-4.5-4.5Z" />
    </svg>
  )
}

function FacebookIcon({ size = 18 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="currentColor"><path d="M13.7 22v-9h3l.5-3.5h-3.5V7.3c0-1 .3-1.8 1.8-1.8h1.9V2.4c-.3 0-1.5-.1-2.8-.1-2.8 0-4.7 1.7-4.7 4.8v2.6H6.8V13h3.1v9h3.8Z" /></svg>
}

function LandingNav() {
  const [open, setOpen] = useState(false)
  const { user } = useAuth()
  return (
    <header className="lp-nav">
      <div className="lp-wrap lp-nav-inner">
        <LandingBrand />
        <nav className="lp-links">
          {navLinks.map(link => <a key={link.href} href={link.href}>{link.label}</a>)}
        </nav>
        <div className="lp-nav-actions">
          <Link className="lp-signin" to={user ? '/dashboard' : '/login'}>{user ? 'Workspace' : 'Sign in'}</Link>
          <Link className="lp-btn lp-btn-primary lp-btn-sm" to={user ? '/dashboard' : '/signup'}>Open terminal <ArrowRight size={14} /></Link>
          <button className="lp-menu-btn" aria-label="Toggle menu" onClick={() => setOpen(v => !v)}>{open ? <X size={18} /> : <Menu size={18} />}</button>
        </div>
      </div>
      {open && <div className="lp-mobile-panel">{navLinks.map(link => <a key={link.href} href={link.href} onClick={() => setOpen(false)}>{link.label}<ChevronRight size={15} /></a>)}</div>}
    </header>
  )
}

/* ------------------------------------------------------------------- data --- */

const pairs: { apiSymbol: string; symbol: string; name: string; base: CoinKind; quote?: CoinKind }[] = [
  { apiSymbol: 'XAUUSD', symbol: 'XAU/USD', name: 'Gold', base: 'gold', quote: 'usd' },
  { apiSymbol: 'USOIL', symbol: 'USOIL', name: 'WTI Crude', base: 'oil', quote: 'usd' },
  { apiSymbol: 'EURUSD', symbol: 'EUR/USD', name: 'Euro', base: 'eur', quote: 'usd' },
  { apiSymbol: 'GBPUSD', symbol: 'GBP/USD', name: 'Sterling', base: 'gbp', quote: 'usd' },
  { apiSymbol: 'USDJPY', symbol: 'USD/JPY', name: 'Yen', base: 'usd', quote: 'jpy' },
  { apiSymbol: 'BTCUSD', symbol: 'BTC/USD', name: 'Bitcoin', base: 'btc', quote: 'usd' },
  { apiSymbol: 'ETHUSD', symbol: 'ETH/USD', name: 'Ethereum', base: 'eth', quote: 'usd' },
  { apiSymbol: 'US100', symbol: 'US100', name: 'Nasdaq 100', base: 'index' },
]

const markets = [
  { name: 'Gold', symbol: 'XAU/USD', base: 'gold' as CoinKind, quote: 'usd' as CoinKind, note: 'Safe-haven flows' },
  { name: 'Energy', symbol: 'USOIL', base: 'oil' as CoinKind, quote: 'usd' as CoinKind, note: 'WTI crude futures' },
  { name: 'Forex', symbol: 'EUR/USD', base: 'eur' as CoinKind, quote: 'usd' as CoinKind, note: 'Major currency pairs' },
  { name: 'Crypto', symbol: 'BTC/USD', base: 'btc' as CoinKind, quote: 'usd' as CoinKind, note: '24/7 digital assets' },
  { name: 'Indices', symbol: 'US100', base: 'index' as CoinKind, note: 'Global index momentum' },
]

const features = [
  { icon: Sparkles, title: 'Market structure analysis', text: 'Structure, momentum and key levels reviewed on closed candles.' },
  { icon: Zap, title: 'Rule-based signals', text: 'Every setup follows a defined, repeatable playbook.' },
  { icon: MessageCircle, title: 'Telegram alerts', text: 'Confirmed setups delivered straight to your phone.' },
  { icon: History, title: 'Trade journal', text: 'Every outcome logged, measured and reviewed.' },
  { icon: Layers3, title: 'Multi-market desk', text: 'Metals, energy, forex, crypto and indices in one view.' },
]

const engineFlow = [
  { icon: Globe2, label: '01 · DATA', title: 'Load live market data', text: 'Yahoo Finance price history and live quotes form one trusted candle stream.' },
  { icon: ScanLine, label: '02 · SCAN', title: 'Map market structure', text: 'Closed candles reveal swings, trend breaks, liquidity, key levels and price-action zones.' },
  { icon: Gauge, label: '03 · SCORE', title: 'Validate quality and risk', text: 'Trend, momentum, regime, structure and playbook fit pass through hard risk and cooldown gates.' },
  { icon: Target, label: '04 · RESULT', title: 'Build the trade plan', text: 'A validated BUY/SELL receives fixed Entry, SL and TP levels; otherwise the blocking reason stays clear.' },
]

const plans = [
  { id: 'free', tag: 'START', name: 'Free', price: '$0', per: 'forever', text: 'Explore the workspace.', items: ['Market overview', 'Saved signal history', 'Closed-candle analysis'], cta: 'Open workspace', featured: false },
  { id: 'plus', tag: 'UPGRADE', name: 'Plus', price: '$5', per: '/ month', text: 'For regular analysis.', items: ['Chart scanner', 'Validated trade setups', 'Telegram alerts'], cta: 'Start Plus', featured: false },
  { id: 'pro', tag: 'MOST POPULAR', name: 'Pro', price: '$15', per: '/ month', text: 'For full-time traders.', items: ['Everything in Plus', 'Multiple market playbooks', 'Advanced performance review'], cta: 'Start Pro', featured: true },
] as const

const steps = [
  { icon: Globe2, title: 'Pick your market', text: 'Gold, forex, crypto or indices. Choose a pair and timeframe.' },
  { icon: ScanLine, title: 'Analyze the market', text: 'Structure, momentum, liquidity and key levels are mapped on closed candles.' },
  { icon: Target, title: 'Trade the plan', text: 'Take the entry, stop and target — with risk already sized.' },
]

/* -------------------------------------------------------------------- ui --- */

function Tilt({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const px = (event.clientX - rect.left) / rect.width - 0.5
    const py = (event.clientY - rect.top) / rect.height - 0.5
    el.style.setProperty('--rx', `${(-py * 6).toFixed(2)}deg`)
    el.style.setProperty('--ry', `${(px * 6).toFixed(2)}deg`)
    el.style.setProperty('--mx', `${((px + 0.5) * 100).toFixed(1)}%`)
    el.style.setProperty('--my', `${((py + 0.5) * 100).toFixed(1)}%`)
  }
  const leave = () => {
    const el = ref.current
    if (!el) return
    el.style.setProperty('--rx', '0deg')
    el.style.setProperty('--ry', '0deg')
  }
  return <div ref={ref} className={`lp-tilt ${className}`} onPointerMove={move} onPointerLeave={leave}>{children}</div>
}

function WelcomeIntro({ onComplete }: { onComplete: () => void }) {
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const leaveTimer = window.setTimeout(() => setLeaving(true), 2350)
    const doneTimer = window.setTimeout(onComplete, 3000)
    return () => { window.clearTimeout(leaveTimer); window.clearTimeout(doneTimer) }
  }, [onComplete])

  const skip = () => {
    setLeaving(true)
    window.setTimeout(onComplete, 520)
  }

  return (
    <div className={`lp-welcome ${leaving ? 'is-leaving' : ''}`} role="dialog" aria-modal="true" aria-label="Welcome to SOVANNAPHUM TRADE">
      <div className="lp-welcome-grid" aria-hidden="true" />
      <div className="lp-welcome-orbit" aria-hidden="true">
        <span className="orbit orbit-a"><PairBadge base="gold" quote="usd" size={32} /></span>
        <span className="orbit orbit-b"><PairBadge base="btc" quote="usd" size={30} /></span>
        <span className="orbit orbit-c"><PairBadge base="eur" quote="usd" size={28} /></span>
      </div>
      <div className="lp-welcome-core">
        <span className="lp-welcome-mark"><img src="/sovan-mark.png" alt="" /></span>
        <span className="lp-welcome-kicker"><i /> LIVE MARKET WORKSPACE</span>
        <h1>WELCOME TO<br /><strong>SOVANNAPHUM TRADE</strong></h1>
        <p>Live charts · confirmed key levels · disciplined trade plans</p>
        <span className="lp-welcome-loader"><i /></span>
      </div>
      <button type="button" className="lp-welcome-skip" onClick={skip}>Enter now <ArrowRight size={14} /></button>
    </div>
  )
}

function quotePrice(symbol: string, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (symbol === 'USDJPY') return value.toFixed(3)
  if (['EURUSD', 'GBPUSD'].includes(symbol)) return value.toFixed(5)
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return value.toFixed(2)
}

function TickerRow({ quotes }: { quotes: Record<string, PublicMarketQuote> }) {
  return (
    <div className="lp-tick-row">
      {pairs.map(p => {
        const quote = quotes[p.apiSymbol]
        const change = quote?.change24h
        const up = typeof change === 'number' ? change >= 0 : true
        return <div className="lp-tick" key={p.symbol}>
          <PairBadge base={p.base} quote={p.quote} size={28} />
          <div className="lp-tick-name"><strong>{p.symbol}</strong><small>{p.name}</small></div>
          <div className="lp-tick-price"><strong>{quotePrice(p.apiSymbol, quote?.price)}</strong><small className={quote?.available ? (up ? 'up' : 'down') : ''}>{typeof change === 'number' ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : 'Loading'}</small></div>
        </div>
      })}
    </div>
  )
}

function HeroChart({ values, live }: { values: number[]; live: boolean }) {
  if (values.length < 2) {
    return <div className="lp-chart-loading"><span className="lp-chart-skeleton" /><small>Loading market history…</small></div>
  }
  const width = 560
  const height = 210
  const top = 18
  const bottom = 18
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width
    const y = top + (1 - (value - min) / range) * (height - top - bottom)
    return [x, y] as const
  })
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const area = `${line} L${width} ${height} L0 ${height} Z`
  const [lastX, lastY] = points[points.length - 1]
  const high = Math.max(...values)
  const low = Math.min(...values)
  const grid = [0.18, 0.42, 0.66, 0.9].map(ratio => top + ratio * (height - top - bottom))
  return (
    <svg viewBox={`0 0 ${width} ${height}`} aria-label="XAU/USD 15-minute closed prices" role="img">
      <defs>
        <linearGradient id="lp-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7c8cff" stopOpacity=".34" />
          <stop offset=".65" stopColor="#5b8cff" stopOpacity=".07" />
          <stop offset="1" stopColor="#5b8cff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="lp-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#7c8cff" /><stop offset=".62" stopColor="#6ea9ff" /><stop offset="1" stopColor="#3ce6b0" />
        </linearGradient>
      </defs>
      {grid.map(y => <line key={y} x1="0" y1={y} x2={width} y2={y} stroke="rgba(255,255,255,.055)" strokeDasharray="2 7" />)}
      <path d={area} fill="url(#lp-area)" className="lp-area" />
      <path d={line} fill="none" stroke="url(#lp-line)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" className="lp-chart-line" />
      <line x1="0" y1={lastY} x2={width} y2={lastY} stroke="rgba(90,210,190,.34)" strokeDasharray="4 6" />
      <text x={width - 4} y={top + 3} textAnchor="end" fill="#6f86a6" fontSize="10">{quotePrice('XAUUSD', high)}</text>
      <text x={width - 4} y={height - 3} textAnchor="end" fill="#6f86a6" fontSize="10">{quotePrice('XAUUSD', low)}</text>
      <circle cx={lastX} cy={lastY} r="3.2" fill="#3ce6b0" className="lp-dot" />
      <circle cx={lastX} cy={lastY} r="9" fill="none" stroke="#3ce6b0" strokeOpacity=".38" className="lp-dot-ring" />
      {live && <text x={lastX - 8} y={lastY - 9} textAnchor="end" fill="#8ef0cf" fontSize="10">live</text>}
    </svg>
  )
}

function HeroStage({ goldQuote, series }: { goldQuote?: PublicMarketQuote; series: number[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const px = (event.clientX - rect.left) / rect.width - 0.5
    const py = (event.clientY - rect.top) / rect.height - 0.5
    el.style.setProperty('--px', px.toFixed(3))
    el.style.setProperty('--py', py.toFixed(3))
    el.style.setProperty('--gx', `${((px + 0.5) * 100).toFixed(1)}%`)
    el.style.setProperty('--gy', `${((py + 0.5) * 100).toFixed(1)}%`)
  }
  const leave = () => {
    const el = ref.current
    if (!el) return
    el.style.setProperty('--px', '0')
    el.style.setProperty('--py', '0')
  }
  const goldChange = goldQuote?.change24h
  const goldUp = typeof goldChange === 'number' ? goldChange >= 0 : true

  return (
    <div className="lp-stage" ref={ref} onPointerMove={move} onPointerLeave={leave}>
      <div className="lp-stage-glow" />
      <a className="lp-founder-mini" href="#founder" aria-label="Meet founder Chheng Mengsithy">
        <span className="lp-founder-mini-photo"><img src="/sithy-founder.jpg" alt="" /></span>
        <span><small>FOUNDER · ADMIN</small><strong>Chheng Mengsithy</strong></span>
        <ArrowRight size={14} />
      </a>
      <div className="lp-terminal">
        <div className="lp-terminal-top">
          <div className="lp-symbol">
            <PairBadge base="gold" quote="usd" size={36} />
            <div><strong>XAU/USD</strong><small>Gold · Spot</small></div>
          </div>
          <span className="lp-live"><i /> {goldQuote?.available ? 'MARKET LIVE' : 'LOADING'}</span>
        </div>

        <div className="lp-terminal-price">
          <div><strong>{quotePrice('XAUUSD', goldQuote?.price)}</strong><span className={goldUp ? 'lp-up' : 'lp-down'}>{typeof goldChange === 'number' ? `${goldUp ? '▲' : '▼'} ${Math.abs(goldChange).toFixed(2)}%` : '—'}</span></div>
          <small>Yahoo Finance · real market feed</small>
        </div>

        <div className="lp-tabs"><span>5m</span><span className="on">15m</span><span>1H</span><span>4H</span><span className="lp-tabs-spacer" /><span className="lp-tabs-tool">Indicators</span></div>

        <div className="lp-chart">
          <HeroChart values={series} live={Boolean(goldQuote?.available)} />
          <span className="lp-scan" />
        </div>

        <div className="lp-insights">
          <div><span>Market structure</span><strong className="up">Mapped</strong></div>
          <div><span>Quality checks</span><strong>Rule verified</strong></div>
          <div><span>Data integrity</span><strong>Closed candles</strong></div>
        </div>

        <div className="lp-terminal-foot"><span><ShieldCheck size={13} /> Real market data</span><span className="lp-verdict"><Sparkles size={13} /> Decisions remain rule-validated</span></div>
        <span className="lp-glare" />
      </div>

      <div className="lp-float lp-float-a">
        <span className="lp-float-ring">
          <svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="16" fill="none" stroke="rgba(255,255,255,.1)" strokeWidth="3" /><circle cx="20" cy="20" r="16" fill="none" stroke="url(#lp-line)" strokeWidth="3" strokeLinecap="round" strokeDasharray="92 100" transform="rotate(-90 20 20)" /></svg>
        </span>
        <span><small>Market readiness</small><strong>Analysis ready</strong></span>
      </div>

      <div className="lp-float lp-float-b">
        <span className="lp-signal-dot" />
        <span><small>Decision flow</small><strong>Closed-candle verified</strong></span>
        <TrendingUp size={16} />
      </div>
    </div>
  )
}

function EngineFlowDemo() {
  const [active, setActive] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setActive(value => (value + 1) % engineFlow.length), 1900)
    return () => window.clearInterval(timer)
  }, [])
  const current = engineFlow[active]
  const ActiveIcon = current.icon

  return <div className="lp-engine-flow lp-reveal" style={{ '--d': '120ms' } as React.CSSProperties}>
    <div className="lp-engine-flow-top"><span className="lp-eyebrow">TRADING WORKFLOW</span><span className="lp-engine-connected"><i /> LIVE DATA</span></div>
    <div className="lp-engine-track">
      {engineFlow.map(({ icon: Icon, label, title }, index) => <button type="button" key={label} className={index === active ? 'is-active' : index < active ? 'is-done' : ''} onClick={() => setActive(index)}>
        <span><Icon size={15} /></span><small>{label}</small><strong>{title}</strong><i />
      </button>)}
    </div>
    <div className="lp-engine-screen">
      <div className="lp-engine-screen-icon"><ActiveIcon size={23} /></div>
      <div><small>{current.label}</small><strong>{current.title}</strong><p>{current.text}</p></div>
      <span className="lp-engine-loader"><i style={{ width: `${((active + 1) / engineFlow.length) * 100}%` }} /></span>
    </div>
    <div className="lp-engine-terminal" aria-hidden="true">
      <span className={active >= 0 ? 'is-on' : ''}>Live market context ready</span>
      <span className={active >= 1 ? 'is-on' : ''}>Structure and key levels mapped</span>
      <span className={active >= 2 ? 'is-on' : ''}>Quality and risk checks complete</span>
      <span className={active >= 3 ? 'is-on' : ''}>Trade plan ready for review</span>
    </div>
  </div>
}

/* ------------------------------------------------------------------- page --- */

export default function LandingPage() {
  const { user } = useAuth()
  const [showWelcome, setShowWelcome] = useState(() => {
    try { return window.sessionStorage.getItem('spt-welcome-seen') !== '1' } catch { return true }
  })
  const [quotes, setQuotes] = useState<Record<string, PublicMarketQuote>>({})
  const [goldSeries, setGoldSeries] = useState<number[]>([])
  const [marketConnected, setMarketConnected] = useState(false)
  const planTarget = (id: 'free' | 'plus' | 'pro') => {
    if (id === 'free') return user ? '/dashboard' : '/signup'
    return user ? `/checkout?plan=${id}` : `/signup?plan=${id}`
  }
  const pageRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLSpanElement>(null)

  const completeWelcome = useCallback(() => {
    try { window.sessionStorage.setItem('spt-welcome-seen', '1') } catch { /* storage can be blocked */ }
    setShowWelcome(false)
  }, [])

  useEffect(() => {
    if (!showWelcome) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [showWelcome])

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const response = await fetchPublicMarkets()
        if (!active) return
        setMarketConnected(response.connected)
        setQuotes(Object.fromEntries(response.markets.map(quote => [quote.symbol, quote])))
        if (response.series?.candles.length) setGoldSeries(response.series.candles.map(candle => candle.close))
      } catch {
        if (active) setMarketConnected(false)
      }
    }
    void load()
    const timer = window.setInterval(load, 30_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    const page = pageRef.current
    const bar = barRef.current
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        const max = document.documentElement.scrollHeight - window.innerHeight
        const progress = max > 0 ? Math.min(document.documentElement.scrollTop / max, 1) : 0
        if (bar) bar.style.transform = `scaleX(${progress})`
        if (page) page.style.setProperty('--scroll', `${Math.min(document.documentElement.scrollTop, 1600)}`)
      })
    }

    const targets = Array.from(document.querySelectorAll<HTMLElement>('.lp-reveal'))
    let observer: IntersectionObserver | undefined
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) { entry.target.classList.add('is-in'); observer?.unobserve(entry.target) }
        })
      }, { threshold: 0.14, rootMargin: '0px 0px -40px 0px' })
      targets.forEach(el => observer?.observe(el))
    } else {
      targets.forEach(el => el.classList.add('is-in'))
    }

    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', onScroll)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [])

  useEffect(() => {
    const hash = window.location.hash.slice(1)
    if (!hash) return
    const target = document.getElementById(hash)
    if (!target) return
    const timer = window.setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <div className="lp" ref={pageRef}>
      {showWelcome && <WelcomeIntro onComplete={completeWelcome} />}
      <span className="lp-progress" ref={barRef} aria-hidden="true" />
      <span className="lp-orb lp-orb-one" aria-hidden="true" />
      <span className="lp-orb lp-orb-two" aria-hidden="true" />
      <LandingNav />

      <main>
        <section className="lp-hero">
          <div className="lp-hero-grid" aria-hidden="true" />
          <div className="lp-wrap lp-hero-inner">
            <div className="lp-hero-copy">
              <span className="lp-badge"><i /> LIVE MARKET ANALYSIS</span>
              <h1>Read every move.<br /><span>Trade the plan.</span></h1>
              <p>Live market charts, rule-based trade setups and disciplined risk levels—one clean workspace for metals, energy, forex, crypto and indices.</p>
              <div className="lp-hero-cta">
                <Link className="lp-btn lp-btn-primary" to="/dashboard">Open the terminal <ArrowRight size={16} /></Link>
                <a className="lp-btn lp-btn-ghost" href="#analysis">See how it works <ChevronRight size={15} /></a>
              </div>
              <div className="lp-stats">
                <div><strong>12</strong><span>markets</span></div>
                <div><strong>3</strong><span>analysis plans</span></div>
                <div><strong>1</strong><span>verified data path</span></div>
              </div>
            </div>
            <HeroStage goldQuote={quotes.XAUUSD} series={goldSeries} />
          </div>
        </section>

        <section className="lp-ticker" aria-label="Market snapshot">
          <div className="lp-ticker-track">
            <TickerRow quotes={quotes} />
            <TickerRow quotes={quotes} />
          </div>
        </section>
        <p className="lp-ticker-note"><span className={marketConnected ? 'is-connected' : ''} /> {marketConnected ? 'Yahoo Finance live quotes · refreshed every 30 seconds' : 'Loading Yahoo Finance market quotes…'}</p>

        <section className="lp-section lp-ai" id="analysis">
          <div className="lp-wrap lp-ai-inner">
            <div className="lp-ai-copy lp-reveal">
              <span className="lp-eyebrow">MARKET ANALYSIS</span>
              <h2>Every level mapped.<br /><span>Every risk visible.</span></h2>
              <p>It reads price structure, momentum and liquidity on every timeframe, then returns either a validated setup with levels or a clear blocking reason.</p>
              <div className="lp-ai-steps">
                <div><span><ScanLine size={17} /></span><div><strong>Scan the structure</strong><small>Swing highs, lows and trend breaks.</small></div></div>
                <div><span><Gauge size={17} /></span><div><strong>Score the momentum</strong><small>Volume, volatility and candle pressure.</small></div></div>
                <div><span><Target size={17} /></span><div><strong>Build the trade</strong><small>Entry, stop and target with risk sized.</small></div></div>
              </div>
            </div>

            <EngineFlowDemo />
          </div>
        </section>

        <section className="lp-section lp-markets" id="markets">
          <div className="lp-wrap">
            <div className="lp-head lp-reveal">
              <div><span className="lp-eyebrow">COVERAGE</span><h2>Five markets.<br /><span>One desk.</span></h2></div>
              <p>Every market, one workflow. Pick a pair, read the setup, manage the risk.</p>
            </div>
            <div className="lp-market-grid">
              {markets.map((market, i) => (
                <Tilt className="lp-market-card lp-reveal" key={market.name}>
                  <div className="lp-market-top">
                    <PairBadge base={market.base} quote={market.quote} size={46} />
                    <ArrowUpRight size={16} />
                  </div>
                  <strong>{market.name}</strong>
                  <span className="lp-market-symbol">{market.symbol}</span>
                  <small>{market.note}</small>
                  <span className="lp-market-index">0{i + 1}</span>
                </Tilt>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-section lp-platform" id="platform">
          <div className="lp-wrap">
            <div className="lp-head lp-reveal">
              <div><span className="lp-eyebrow">PLATFORM</span><h2>Everything you need<br /><span>to trade the plan.</span></h2></div>
              <p>Analysis, signals, risk and review — built into a single focused workspace.</p>
            </div>
            <div className="lp-feature-grid">
              {features.map(({ icon: Icon, title, text }, i) => (
                <Tilt className="lp-feature lp-reveal" key={title}>
                  <span className="lp-feature-icon"><Icon size={19} /></span>
                  <span className="lp-feature-num">0{i + 1}</span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </Tilt>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-section lp-founder" id="founder">
          <div className="lp-wrap">
            <div className="lp-founder-card lp-reveal">
              <div className="lp-founder-glow" aria-hidden="true" />
              <div className="lp-founder-copy">
                <span className="lp-eyebrow"><BadgeCheck size={13} /> FOUNDER · PLATFORM ADMIN</span>
                <h2>My name is<br /><span>Chheng Mengsithy.</span></h2>
                <p>
                  I am <strong>Chheng Mengsithy</strong>, founder and admin of SOVANNAPHUMTRADE. I lead the
                  platform vision, product development and community—building a cleaner workspace for
                  market analysis, disciplined trade plans and trader education.
                </p>
                <div className="lp-founder-tags">
                  <span>Founder</span><span>Platform admin</span><span>Product builder</span>
                </div>
                <div className="lp-founder-socials" aria-label="Founder contact links">
                  <a className="is-facebook" href={FACEBOOK_URL} target="_blank" rel="noopener noreferrer"><FacebookIcon /><span><small>Facebook</small><strong>Chheng Mengsithy</strong></span><ArrowUpRight size={14} /></a>
                  <a className="is-tiktok" href={TIKTOK_URL} target="_blank" rel="noopener noreferrer"><TikTokIcon /><span><small>TikTok</small><strong>@chhengmengsithy0</strong></span><ArrowUpRight size={14} /></a>
                  <a className="is-telegram" href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer"><MessageCircle size={18} /><span><small>Telegram</small><strong>@Chhengmengsithy</strong></span><ArrowUpRight size={14} /></a>
                </div>
              </div>
              <div className="lp-founder-visual">
                <div className="lp-founder-photo">
                  <img src="/sithy-founder.jpg" alt="Chheng Mengsithy, founder and admin of SOVANNAPHUMTRADE" loading="lazy" />
                  <span className="lp-founder-ring" aria-hidden="true" />
                  <span className="lp-founder-photo-label"><small>SOVANNAPHUMTRADE</small><strong>Founder &amp; Admin</strong></span>
                </div>
                <span className="lp-founder-orbit orbit-one" aria-hidden="true" />
                <span className="lp-founder-orbit orbit-two" aria-hidden="true" />
              </div>
            </div>
          </div>
        </section>

        <section className="lp-section lp-how" id="how-it-works">
          <div className="lp-wrap">
            <div className="lp-head lp-reveal">
              <div><span className="lp-eyebrow">HOW IT WORKS</span><h2>Chart to plan<br /><span>in three steps.</span></h2></div>
            </div>
            <div className="lp-steps">
              {steps.map(({ icon: Icon, title, text }, i) => (
                <div className="lp-step lp-reveal" key={title} style={{ '--d': `${i * 90}ms` } as React.CSSProperties}>
                  <span className="lp-step-num">0{i + 1}</span>
                  <span className="lp-step-icon"><Icon size={20} /></span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-section lp-pricing" id="pricing">
          <div className="lp-wrap">
            <div className="lp-head lp-reveal">
              <div><span className="lp-eyebrow">PLANS</span><h2>Simple pricing.<br /><span>No surprises.</span></h2></div>
              <p>Start free. Upgrade when your workflow needs more.</p>
            </div>
            <div className="lp-plan-grid">
              {plans.map(plan => (
                <div className={`lp-plan ${plan.featured ? 'is-featured' : ''} lp-reveal`} key={plan.name}>
                  <span className="lp-plan-tag">{plan.tag}</span>
                  <div className="lp-plan-title">
                    <h3>{plan.name}</h3>
                  </div>
                  <div className="lp-price"><strong>{plan.price}</strong><span>{plan.per}</span></div>
                  <p>{plan.text}</p>
                  <ul>{plan.items.map(item => <li key={item}><Check size={14} />{item}</li>)}</ul>
                  <Link className={`lp-btn ${plan.featured ? 'lp-btn-primary' : 'lp-btn-ghost'} lp-btn-full`} to={planTarget(plan.id)}>{plan.cta} <ArrowRight size={14} /></Link>
                </div>
              ))}
            </div>
            <p className="lp-plan-note">Cancel anytime · Trading involves risk · Analysis is not financial advice</p>
          </div>
        </section>

        <section className="lp-cta-wrap lp-reveal">
          <div className="lp-cta">
            <div className="lp-cta-glow" aria-hidden="true" />
            <div>
              <span className="lp-eyebrow">START NOW</span>
              <h2>Your next setup<br /><span>is already forming.</span></h2>
              <p>Open the terminal and review the market through the same disciplined analysis process.</p>
            </div>
            <Link className="lp-btn lp-btn-primary" to="/dashboard">Open the terminal <ArrowRight size={16} /></Link>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-wrap lp-footer-inner">
          <LandingBrand />
          <nav>
            <a href="#markets">Markets</a><a href="#analysis">Market analysis</a><a href="#platform">Platform</a><a href="#founder">Founder</a><a href="#pricing">Pricing</a>
            <a href={TIKTOK_URL} target="_blank" rel="noopener noreferrer">TikTok</a>
            <Link to="/dashboard">Terminal</Link>
          </nav>
          <span>© 2026 SOVANNAPHUMTRADE · Trading involves risk.</span>
        </div>
      </footer>
    </div>
  )
}
