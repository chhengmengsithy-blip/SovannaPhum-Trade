import { useEffect, useRef, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, Camera, Check, ImagePlus, Loader2, Minus, RotateCcw, ScanLine, ShieldAlert, Target, Trash2, Zap } from 'lucide-react'
import { scanChartImage, type ChartScanResult } from './chartScanner'
import { fetchCandles } from '../../services/marketData'
import type { Candle as CandleData } from '../../v1/types'
import { buildScannerPlan, type ScannerTradePlan } from './scannerPlan'
import { g5 } from '../../v1/types'
import { markets, timeframes } from '../../config/markets'

type ScannerResult = ChartScanResult & { symbol: string; timeframe: string; plan: ScannerTradePlan | null }
interface ScanHistoryItem { id: string; at: number; result: ScannerResult }
type ScanStage = 'IDLE' | 'IMAGE' | 'MARKET' | 'LEVELS'
const HISTORY_KEY = 'sovan.scans.v1'
const scannerMarkets = markets.map(market => market.symbol)
const scannerTimeframes = [...timeframes]
const scanStages: Array<{ id: Exclude<ScanStage, 'IDLE'>; label: string }> = [
  { id: 'IMAGE', label: 'Read chart' },
  { id: 'MARKET', label: 'Load candles' },
  { id: 'LEVELS', label: 'Build levels' },
]
const stageCopy: Record<Exclude<ScanStage, 'IDLE'>, string> = {
  IMAGE: 'Reading the selected chart image…',
  MARKET: 'Loading real closed candles for the selected market…',
  LEVELS: 'Validating structure and calculating trade levels…',
}

function readHistory(): ScanHistoryItem[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ScanHistoryItem[]
    return Array.isArray(parsed) ? parsed.filter(item => item && item.result && typeof item.at === 'number').map(item => ({
      ...item,
      result: { ...item.result, symbol: item.result.symbol ?? 'XAUUSD', timeframe: item.result.timeframe ?? '15m', plan: item.result.plan ?? null },
    })).slice(0, 6) : []
  } catch {
    return []
  }
}

export default function ChartAnalyzer() {
  const galleryInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const urlRef = useRef<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState('')
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<ScanStage>('IDLE')
  const [result, setResult] = useState<ScannerResult | null>(null)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<ScanHistoryItem[]>(readHistory)
  const [symbol, setSymbol] = useState('XAUUSD')
  const [timeframe, setTimeframe] = useState('15m')

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current) }, [])

  const setImage = (next: File | null) => {
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null }
    setFile(next)
    setResult(null)
    setError('')
    setStage('IDLE')
    if (next) {
      const url = URL.createObjectURL(next)
      urlRef.current = url
      setPreview(url)
    } else {
      setPreview('')
      if (galleryInput.current) galleryInput.current.value = ''
      if (cameraInput.current) cameraInput.current.value = ''
    }
  }

  const acceptFile = (next?: File | null) => {
    if (!next) return
    if (!next.type.startsWith('image/')) { setError('Please choose an image file (PNG, JPG or WebP).'); return }
    if (next.size > 15 * 1024 * 1024) { setError('That image is larger than 15 MB. Please use a smaller file.'); return }
    setImage(next)
  }

  const analyze = async () => {
    if (!file || busy) return
    setBusy(true)
    setResult(null)
    setError('')
    setStage('IMAGE')
    try {
      const scan = await scanChartImage(file)
      let plan: ScannerTradePlan | null = null
      if (scan.bias !== 'WAIT') {
        setStage('MARKET')
        const market = await fetchCandles(symbol, timeframe, 1500) as { candles?: CandleData[] }
        setStage('LEVELS')
        plan = buildScannerPlan(scan.bias, Array.isArray(market.candles) ? market.candles : [])
        if (!plan) throw new Error(`A real ${symbol} ${timeframe} trade plan could not be built from the available closed candles.`)
      } else {
        setStage('LEVELS')
      }
      const completed: ScannerResult = { ...scan, symbol, timeframe, plan }
      setResult(completed)
      const entry: ScanHistoryItem = { id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`, at: Date.now(), result: completed }
      setHistory(current => {
        const next = [entry, ...current].slice(0, 6)
        try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
        return next
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The chart could not be analyzed.')
    } finally {
      setStage('IDLE')
      setBusy(false)
    }
  }

  const BiasIcon = result ? (result.bias === 'LONG' ? ArrowUpRight : result.bias === 'SHORT' ? ArrowDownRight : Minus) : Minus

  return <section className="panel chart-analyzer" id="chart-analyzer">
    <div className="analyzer-grid">
      <div className="analyzer-input">
        <div className="scanner-market-controls">
          <label><span>MARKET</span><select value={symbol} onChange={event => { setSymbol(event.target.value); setResult(null) }}>{scannerMarkets.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
          <label><span>TIMEFRAME</span><select value={timeframe} onChange={event => { setTimeframe(event.target.value); setResult(null) }}>{scannerTimeframes.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
          <span className="scanner-unlimited"><Zap size={11} /> Unlimited scanner setups</span>
        </div>
        <div
          className={`analyzer-drop ${dragging ? 'is-dragging' : ''} ${preview ? 'has-preview' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="Choose a chart image"
          onClick={() => galleryInput.current?.click()}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); galleryInput.current?.click() } }}
          onDragOver={event => { event.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={event => { event.preventDefault(); setDragging(false); acceptFile(event.dataTransfer.files?.[0]) }}
        >
          {preview
            ? <img src={preview} alt="Selected chart image" />
            : <div className="drop-empty">
                <span className="drop-empty-icon"><ImagePlus size={24} /></span>
                <strong>Drop a chart image here</strong>
                <span>PNG, JPG or WebP up to 15 MB. Screenshots and straight-on photos both work.</span>
              </div>}
          {busy && <div className="analyzer-scan"><span className="scan-beam" /><span className="scan-label">{stage === 'IMAGE' ? 'READING CHART' : stage === 'MARKET' ? 'LOADING REAL CANDLES' : 'BUILDING LEVELS'}</span></div>}
        </div>
        <div className="analyzer-actions">
          <button type="button" className="btn btn-secondary" onClick={() => galleryInput.current?.click()}><ImagePlus size={15} /> Choose photo</button>
          <button type="button" className="btn btn-secondary" onClick={() => cameraInput.current?.click()}><Camera size={15} /> Take photo</button>
          <button type="button" className="btn btn-primary" onClick={analyze} disabled={!file || busy}>{busy ? <Loader2 size={15} className="spin" /> : <ScanLine size={15} />} {busy ? 'Analyzing…' : 'Analyze chart'}</button>
          {(file || result) && <button type="button" className="icon-button analyzer-reset" onClick={() => setImage(null)} aria-label="Reset scanner"><RotateCcw size={15} /></button>}
        </div>
        {error && <p className="analyzer-error">{error}</p>}
        <p className="analyzer-hint">Best results: select the matching market/timeframe, then upload a clean screenshot. Image analysis runs locally; exact levels use real closed market candles.</p>
        <input ref={galleryInput} className="visually-hidden" type="file" accept="image/*" onChange={event => acceptFile(event.target.files?.[0])} />
        <input ref={cameraInput} className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={event => acceptFile(event.target.files?.[0])} />
      </div>
      <div className="analyzer-output">
        {result ? <div className={`scan-result bias-${result.bias.toLowerCase()}`}>
          <div className="scan-bias-row">
            <span className="scan-bias-icon"><BiasIcon size={23} /></span>
            <div><span className="scan-bias-label">{result.symbol} · {result.timeframe} · SCANNER SIGNAL</span><strong>{result.bias === 'LONG' ? 'BUY' : result.bias === 'SHORT' ? 'SELL' : 'NO TRADE'}</strong></div>
            <span className="scan-confidence">{result.strength}%</span>
          </div>
          <div className="scan-confidence-bar"><span style={{ width: `${result.strength}%` }} /></div>
          <p className="scan-summary">{result.summary}</p>
          {result.plan && <div className={`scanner-trade-plan is-${result.plan.action.toLowerCase()}`}>
            <div className="scanner-plan-head"><span><Target size={13} /> {result.plan.action} SETUP</span><small>Unlimited · image analysis</small></div>
            <div className="scanner-plan-levels">
              <div><span>ENTRY ZONE</span><strong>{g5(result.plan.entryZoneLow)} – {g5(result.plan.entryZoneHigh)}</strong><small>Entry {g5(result.plan.entry)}</small></div>
              <div><span>STOP LOSS</span><strong>{g5(result.plan.stopLoss)}</strong><small>Risk {g5(result.plan.risk)}</small></div>
              <div><span>TP1</span><strong>{g5(result.plan.tp1)}</strong><small>1R+</small></div>
              <div><span>TP2</span><strong>{g5(result.plan.tp2)}</strong><small>2R+</small></div>
              <div><span>TP3</span><strong>{g5(result.plan.tp3)}</strong><small>3R+</small></div>
            </div>
            <p>{result.plan.references.join(' · ')}</p>
          </div>}
          {result.bias === 'WAIT' && <div className="scanner-no-trade"><Minus size={13} /><span>No BUY/SELL setup—image conditions are mixed.</span></div>}
          <div className="scan-metrics">
            {result.metrics.map(metric => <div className={`scan-metric tone-${metric.tone}`} key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}
          </div>
          <div className="scan-reasons">
            <span className="scan-reasons-label">WHY</span>
            <ul>{result.reasons.map(reason => <li key={reason}><Check size={12} />{reason}</li>)}</ul>
          </div>
          <p className="scan-disclaimer"><ShieldAlert size={13} /> Image bias plus real closed Yahoo candles. Scanner plans are unlimited and remain separate from official Free, Plus and Pro signal limits.</p>
        </div> : busy ? <div className="analyzer-placeholder is-busy">
          <span className="placeholder-icon"><Loader2 size={22} className="spin" /></span>
          <strong>Analyzing the chart…</strong>
          <p>{stage === 'IDLE' ? 'Preparing the chart…' : stageCopy[stage]}</p>
          <div className="scan-stage-track">{scanStages.map((item, index) => {
            const activeIndex = Math.max(0, scanStages.findIndex(candidate => candidate.id === stage))
            return <span key={item.id} className={index === activeIndex ? 'is-active' : index < activeIndex ? 'is-complete' : ''}><i>{index < activeIndex ? <Check size={10} /> : index + 1}</i>{item.label}</span>
          })}</div>
          <span className="scan-progress-label">Stages advance only when each real operation completes.</span>
        </div> : <div className="analyzer-placeholder">
          <span className="placeholder-icon"><ScanLine size={22} /></span>
          <strong>No chart scanned yet</strong>
          <p>Add a chart image and run the analyzer. The result shows a structured read of the visible market.</p>
          <div className="placeholder-steps"><span>01 Upload</span><span>02 Analyze</span><span>03 Review</span></div>
        </div>}
      </div>
    </div>
    {history.length > 0 && <div className="scan-history">
      <div className="scan-history-head">
        <div><span className="scan-history-label">RECENT SCANS</span><small>Saved on this device only</small></div>
        <button type="button" className="scan-history-clear" onClick={() => { setHistory([]); try { window.localStorage.removeItem(HISTORY_KEY) } catch { /* storage unavailable */ } }}><Trash2 size={13} /> Clear</button>
      </div>
      <div className="scan-history-list">
        {history.map(item => <button type="button" key={item.id} className={`scan-history-item bias-${item.result.bias.toLowerCase()}`} onClick={() => setResult(item.result)}>
          <span className="history-bias">{item.result.bias === 'LONG' ? 'BUY' : item.result.bias === 'SHORT' ? 'SELL' : 'WAIT'}</span>
          <span className="history-copy"><strong>{item.result.symbol} {item.result.timeframe} · {item.result.strength}%</strong><small>{item.result.plan ? `Entry ${g5(item.result.plan.entry)} · SL ${g5(item.result.plan.stopLoss)} · TP1 ${g5(item.result.plan.tp1)}` : item.result.summary}</small></span>
          <span className="history-time">{new Date(item.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        </button>)}
      </div>
    </div>}
  </section>
}
