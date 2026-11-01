import { useEffect, useState } from 'react'
import { Beaker, BrainCircuit, Loader2, RefreshCw, ShieldAlert, Sparkles } from 'lucide-react'
import { runProResearch, type ProResearchReport } from '../../services/api'
import type { ProRiskProfile, StrategyName } from '../../v3/types'
import { g5 } from '../../v1/types'

export default function ProResearchPanel({
  symbol,
  timeframe,
  playbook,
  riskProfile,
}: {
  symbol: string
  timeframe: string
  playbook: 'AUTO' | StrategyName
  riskProfile: ProRiskProfile
}) {
  const [report, setReport] = useState<ProResearchReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { setReport(null); setError('') }, [symbol, timeframe, playbook, riskProfile])

  const run = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      setReport(await runProResearch({ symbol, timeframe, playbook, riskProfile }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Playbook context could not be loaded.')
    } finally {
      setBusy(false)
    }
  }

  return <section className="pro-research-panel">
    <header className="pro-research-head">
      <div>
        <span className="signal-kicker is-v3"><BrainCircuit size={12} /> PLAYBOOK CONTEXT</span>
        <h3>Analysis context <span>· {symbol} {timeframe}</span></h3>
        <small>Additional volatility, Fibonacci, key-level and risk context for the selected Pro playbook.</small>
      </div>
      <button type="button" className="btn btn-secondary" onClick={run} disabled={busy}>{busy ? <Loader2 size={14} className="spin" /> : report ? <RefreshCw size={14} /> : <Beaker size={14} />}{busy ? ' Loading context…' : report ? ' Refresh context' : ' Load context'}</button>
    </header>
    {error && <div className="pro-research-error"><ShieldAlert size={14} /><span>{error}</span></div>}
    {!report && !error && <div className="pro-research-empty"><Sparkles size={18} /><span>Load supporting context for the selected playbook, including volatility, Fibonacci and risk-quality diagnostics.</span></div>}
    {report && <>
      <div className="pro-research-metrics">
        <div><span>RESEARCH BIAS</span><strong>{report.market.researchDirection}</strong><small>{report.market.trend} trend</small></div>
        <div><span>VOLATILITY</span><strong>{report.market.volatilityPercent.toFixed(2)}%</strong><small>ATR {g5(report.market.atr14)}</small></div>
        <div><span>SUGGESTED RISK</span><strong>{report.risk.suggestedRiskPercent}%</strong><small>{report.risk.profile} · floor {report.risk.qualityFloor}</small></div>
        <div><span>RANGE POSITION</span><strong>{Math.round(report.market.rangePosition * 100)}%</strong><small>S {g5(report.market.support)} · R {g5(report.market.resistance)}</small></div>
      </div>
      <div className="pro-playbook-rankings">
        {report.playbooks.slice(0, 6).map((item, index) => <article key={item.id} className={index === 0 ? 'is-best' : ''}>
          <span className="playbook-rank">0{index + 1}</span>
          <div><strong>{item.label}</strong><small>{item.detail}</small></div>
          <span className="playbook-fit">{item.score}<small>/100</small></span>
          <div className="playbook-fit-bar"><i style={{ width: `${item.score}%` }} /></div>
        </article>)}
      </div>
      <p className="pro-research-note">{report.disclaimer} · {report.candles} closed candles reviewed.</p>
    </>}
  </section>
}
