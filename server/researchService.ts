import type { Candle, ProRiskProfile, StrategyName, Timeframe } from '../src/v3/types.ts'
import { HttpError } from './http.ts'

const RESEARCH_URL = (process.env.PYTHON_RESEARCH_URL || 'http://127.0.0.1:8790').replace(/\/+$/, '')

export type PythonResearchReport = {
  engine: string
  generatedAt: string
  symbol: string
  timeframe: string
  candles: number
  market: {
    trend: string
    researchDirection: string
    close: number
    atr14: number
    volatilityPercent: number
    volumeRatio: number
    support: number
    resistance: number
    rangePosition: number
  }
  fibonacci: Record<string, number>
  risk: { profile: ProRiskProfile; suggestedRiskPercent: number; qualityFloor: number; minimumR: number }
  playbooks: Array<{ id: StrategyName; label: string; score: number; detail: string }>
  disclaimer: string
}

export async function runPythonResearch(input: {
  symbol: string
  timeframe: Timeframe
  candles: Candle[]
  playbook?: StrategyName
  riskProfile: ProRiskProfile
}): Promise<PythonResearchReport> {
  let response: Response
  try {
    response = await fetch(`${RESEARCH_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, candles: input.candles.slice(-1500) }),
      signal: AbortSignal.timeout(12_000),
    })
  } catch {
    throw new HttpError(503, 'Playbook context is temporarily unavailable. Start the research service with npm run python:research.')
  }
  const payload = await response.json().catch(() => null) as PythonResearchReport | { error?: unknown } | null
  if (!response.ok) {
    const message = payload && 'error' in payload && typeof payload.error === 'string' ? payload.error : 'Python research failed.'
    throw new HttpError(response.status >= 500 ? 502 : 400, message)
  }
  return payload as PythonResearchReport
}
