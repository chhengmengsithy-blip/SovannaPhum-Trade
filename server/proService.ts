import { randomBytes, createHash } from 'node:crypto'
import { db } from './db.ts'
import type { UserRow } from './db.ts'
import type { Candle, Timeframe } from '../src/v3/types.ts'

/**
 * PRO Plan exclusive features
 * - Advanced backtesting
 * - Multi-timeframe analysis
 * - Custom strategy builder
 * - Portfolio analytics
 * - API access tokens
 */

export const PRO_FEATURES = {
  advancedBacktest: true,
  multiTimeframe: true,
  customStrategy: true,
  portfolioAnalytics: true,
  apiAccess: true,
  customAlerts: true,
  tradeJournal: true,
  riskAnalytics: true,
  marketScanner: true,
  customIndicators: true,
  apiTokens: true,
} as const

export type ProFeature = keyof typeof PRO_FEATURES

interface ApiTokenRow {
  id: string
  user_id: string
  name: string
  token_hash: string
  prefix: string
  scopes: string
  last_used_at: string | null
  expires_at: string | null
  created_at: string
  revoked_at: string | null
}

interface BacktestJobRow {
  id: string
  user_id: string
  name: string
  symbol: string
  timeframe: string
  strategy: string
  params: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  result: string | null
  progress: number
  created_at: string
  completed_at: string | null
}

interface AlertRuleRow {
  id: string
  user_id: string
  name: string
  symbol: string
  timeframe: string
  condition: string
  channels: string
  is_active: number
  created_at: string
  last_triggered: string | null
}

interface TradeJournalEntryRow {
  id: string
  user_id: string
  signal_id: string
  symbol: string
  timeframe: string
  direction: string
  entry_price: number
  exit_price: number | null
  stop_loss: number
  tp1: number
  tp2: number | null
  tp3: number | null
  position_size: number
  risk_amount: number
  pnl_r: number | null
  pnl_usd: number | null
  status: string
  notes: string
  tags: string
  entry_time: string
  exit_time: string | null
  created_at: string
  updated_at: string
}

const now = () => new Date().toISOString()

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function generateApiToken(): { token: string; prefix: string; hash: string } {
  const prefix = 'svn_pro_'
  const random = randomBytes(32).toString('hex')
  const token = prefix + random
  return { token, prefix: prefix.slice(0, -1), hash: hashToken(token) }
}

export async function createApiToken(userId: string, name: string, scopes: string[], expiresDays?: number): Promise<{ token: string; prefix: string }> {
  const { token, prefix, hash } = generateApiToken()
  const expiresAt = expiresDays ? new Date(Date.now() + expiresDays * 86400000).toISOString() : null

  await db.prepare(`
    INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scopes, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomBytes(16).toString('hex'), userId, name, hash, prefix, JSON.stringify(scopes), expiresAt, now())

  return { token, prefix }
}

export async function listApiTokens(userId: string) {
  return db.prepare(`
    SELECT id, name, prefix, scopes, last_used_at, expires_at, created_at, revoked_at
    FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC
  `).all<Omit<ApiTokenRow, 'token_hash'>>(userId)
}

export async function revokeApiToken(userId: string, tokenId: string): Promise<void> {
  await db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?').run(now(), tokenId, userId)
}

export async function verifyApiToken(token: string): Promise<UserRow | null> {
  const hash = hashToken(token)
  const row = await db.prepare(`
    SELECT u.* FROM api_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL
    AND (t.expires_at IS NULL OR t.expires_at > ?)
  `).get<UserRow>(hash, now())

  if (row) {
    await db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?').run(now(), hash)
    return row
  }
  return null
}

export async function getApiTokenScopes(token: string): Promise<string[]> {
  const hash = hashToken(token)
  const row = await db.prepare('SELECT scopes FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL').get<{ scopes: string }>(hash)
  return row ? JSON.parse(row.scopes) : []
}

export async function createBacktestJob(userId: string, params: {
  name: string
  symbol: string
  timeframe: string
  strategy: string
  params: Record<string, unknown>
}): Promise<string> {
  const id = randomBytes(16).toString('hex')
  await db.prepare(`
    INSERT INTO backtest_jobs (id, user_id, name, symbol, timeframe, strategy, params, status, progress, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
  `).run(id, userId, params.name, params.symbol, params.timeframe, params.strategy, JSON.stringify(params.params), now())
  return id
}

export async function getBacktestJob(userId: string, jobId: string) {
  return db.prepare('SELECT * FROM backtest_jobs WHERE id = ? AND user_id = ?').get<BacktestJobRow>(jobId, userId)
}

export async function listBacktestJobs(userId: string) {
  return db.prepare('SELECT * FROM backtest_jobs WHERE user_id = ? ORDER BY created_at DESC').all<BacktestJobRow>(userId)
}

export async function updateBacktestJob(jobId: string, updates: Partial<BacktestJobRow>): Promise<void> {
  const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ')
  const values = [...Object.values(updates), jobId]
  await db.prepare(`UPDATE backtest_jobs SET ${fields} WHERE id = ?`).run(...values)
}

/** A process restart interrupts in-memory runners; make those jobs playable again. */
export async function recoverInterruptedBacktests(): Promise<void> {
  await db.prepare("UPDATE backtest_jobs SET status = 'pending', progress = 0 WHERE status = 'running'").run()
}

export async function runBacktest(jobId: string, fetchCandlesFn: (symbol: string, timeframe: string) => Promise<{ candles: Candle[] }>) {
  const job = await db.prepare('SELECT * FROM backtest_jobs WHERE id = ?').get<BacktestJobRow>(jobId)
  if (!job || job.status !== 'pending') return

  await db.prepare('UPDATE backtest_jobs SET status = ?, progress = ? WHERE id = ?').run('running', 10, jobId)

  try {
    const data = await fetchCandlesFn(job.symbol, job.timeframe)
    // Keep the interactive runner bounded and deterministic. The standalone
    // backtest harness remains available for deep multi-year research.
    const candles = data.candles.slice(-900)
    const warmupBars = 260
    if (candles.length <= warmupBars + 1) throw new Error('Not enough closed candles for this backtest.')
    const totalSteps = candles.length - warmupBars - 1

    const { evaluateV3 } = await import('../src/v3/engine.ts')

    let totalTrades = 0
    let wins = 0
    let totalPnl = 0
    let maxDrawdown = 0
    let peak = 0
    let equity = 10000

    for (let i = warmupBars; i < candles.length - 1; i++) {
      // A rolling context avoids repeatedly evaluating the entire one-year
      // series while retaining enough history for every Pro indicator.
      const slice = candles.slice(Math.max(0, i - 359), i + 1)
      const result = evaluateV3({ symbol: job.symbol, timeframe: job.timeframe as Timeframe, candles: slice, now: candles[i].time })

      if (result.action === 'BUY' || result.action === 'SELL') {
        const levels = result.levels!
        const entry = levels.entry
        const sl = levels.stopLoss
        const tp1 = levels.tp1
        const tp2 = levels.tp2
        const tp3 = levels.tp3

        let outcome = 'open'
        let pnlR = 0

        for (let j = i + 1; j < candles.length; j++) {
          const c = candles[j]
          if (result.action === 'BUY') {
            if (c.low <= sl) { outcome = 'SL'; pnlR = -1; break }
            if (tp3 !== null && c.high >= tp3) { outcome = 'TP3'; pnlR = levels.rrTp3 ?? 3; break }
            if (tp2 !== null && c.high >= tp2) { outcome = 'TP2'; pnlR = levels.rrTp2 ?? 2; break }
            if (c.high >= tp1) { outcome = 'TP1'; pnlR = levels.rrTp1; break }
          } else {
            if (c.high >= sl) { outcome = 'SL'; pnlR = -1; break }
            if (tp3 !== null && c.low <= tp3) { outcome = 'TP3'; pnlR = levels.rrTp3 ?? 3; break }
            if (tp2 !== null && c.low <= tp2) { outcome = 'TP2'; pnlR = levels.rrTp2 ?? 2; break }
            if (c.low <= tp1) { outcome = 'TP1'; pnlR = levels.rrTp1; break }
          }
        }

        if (outcome !== 'open') {
          totalTrades++
          const riskUsd = equity * 0.01
          const pnlUsd = pnlR * riskUsd
          equity += pnlUsd
          peak = Math.max(peak, equity)
          const dd = (peak - equity) / peak
          maxDrawdown = Math.max(maxDrawdown, dd)

          if (pnlR > 0) wins++
          totalPnl += pnlR

        }
      }

      // Progress reflects actual evaluated bars. Yield frequently so quote,
      // health and polling requests remain responsive during the run.
      if ((i - warmupBars) % 8 === 0) {
        const completedSteps = i - warmupBars + 1
        const progress = Math.min(95, 10 + Math.round((completedSteps / totalSteps) * 85))
        await db.prepare('UPDATE backtest_jobs SET progress = ? WHERE id = ?').run(progress, jobId)
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    }

    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0
    const profitFactor = totalTrades > 0 ? totalPnl / Math.max(1, totalTrades - wins) : 0

    const result = {
      totalTrades,
      wins,
      losses: totalTrades - wins,
      winRate: Math.round(winRate * 100) / 100,
      totalPnlR: Math.round(totalPnl * 100) / 100,
      profitFactor: Math.round(profitFactor * 100) / 100,
      maxDrawdown: Math.round(maxDrawdown * 10000) / 100,
      finalEquity: Math.round(equity),
      candlesReviewed: candles.length,
    }

    await db.prepare('UPDATE backtest_jobs SET status = ?, progress = 100, result = ?, completed_at = ? WHERE id = ?')
      .run('completed', JSON.stringify(result), now(), jobId)

  } catch (error) {
    await db.prepare('UPDATE backtest_jobs SET status = ?, result = ?, completed_at = ? WHERE id = ?')
      .run('failed', JSON.stringify({ error: String(error) }), now(), jobId)
  }
}

export async function createAlertRule(userId: string, params: {
  name: string
  symbol: string
  timeframe: string
  condition: string
  channels: string[]
}): Promise<string> {
  const id = randomBytes(16).toString('hex')
  await db.prepare(`
    INSERT INTO alert_rules (id, user_id, name, symbol, timeframe, condition, channels, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, userId, params.name, params.symbol, params.timeframe, params.condition, JSON.stringify(params.channels), now())
  return id
}

export async function listAlertRules(userId: string) {
  return db.prepare('SELECT * FROM alert_rules WHERE user_id = ? ORDER BY created_at DESC').all<AlertRuleRow>(userId)
}

export async function toggleAlertRule(userId: string, ruleId: string, isActive: number): Promise<void> {
  await db.prepare('UPDATE alert_rules SET is_active = ? WHERE id = ? AND user_id = ?').run(isActive, ruleId, userId)
}

export async function deleteAlertRule(userId: string, ruleId: string): Promise<void> {
  await db.prepare('DELETE FROM alert_rules WHERE id = ? AND user_id = ?').run(ruleId, userId)
}

export async function createTradeJournalEntry(userId: string, params: {
  signalId: string
  symbol: string
  timeframe: string
  direction: string
  entryPrice: number
  stopLoss: number
  tp1: number
  tp2: number | null
  tp3: number | null
  positionSize: number
  riskAmount: number
  notes: string
  tags: string[]
  entryTime: string
}): Promise<string> {
  const id = randomBytes(16).toString('hex')
  await db.prepare(`
    INSERT INTO trade_journal (id, user_id, signal_id, symbol, timeframe, direction, entry_price, exit_price, stop_loss, tp1, tp2, tp3, position_size, risk_amount, pnl_r, pnl_usd, status, notes, tags, entry_time, exit_time, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, 'open', ?, ?, ?, NULL, ?, ?)
  `).run(id, userId, params.signalId, params.symbol, params.timeframe, params.direction, params.entryPrice, params.stopLoss, params.tp1, params.tp2, params.tp3, params.positionSize, params.riskAmount, params.notes, JSON.stringify(params.tags), params.entryTime, now(), now())
  return id
}

export async function updateTradeJournalEntry(userId: string, entryId: string, updates: Record<string, unknown>): Promise<void> {
  const columns: Record<string, string> = {
    exitPrice: 'exit_price',
    status: 'status',
    pnlR: 'pnl_r',
    pnlUsd: 'pnl_usd',
    notes: 'notes',
    tags: 'tags',
    exitTime: 'exit_time',
  }
  const entries = Object.entries(updates)
    .filter(([key]) => columns[key])
    .map(([key, value]) => [columns[key], key === 'tags' ? JSON.stringify(value) : value] as const)
  if (!entries.length) return
  const fields = entries.map(([column]) => `${column} = ?`).join(', ')
  const values = entries.map(([, value]) => value)
  await db.prepare(`UPDATE trade_journal SET ${fields}, updated_at = ? WHERE id = ? AND user_id = ?`)
    .run(...values, now(), entryId, userId)
}

export async function listTradeJournal(userId: string, filters?: { symbol?: string; status?: string; from?: string; to?: string }) {
  let sql = 'SELECT * FROM trade_journal WHERE user_id = ?'
  const params: (string | number)[] = [userId]

  if (filters?.symbol) {
    sql += ' AND symbol = ?'
    params.push(filters.symbol)
  }
  if (filters?.status) {
    sql += ' AND status = ?'
    params.push(filters.status)
  }
  if (filters?.from) {
    sql += ' AND entry_time >= ?'
    params.push(filters.from)
  }
  if (filters?.to) {
    sql += ' AND entry_time <= ?'
    params.push(filters.to)
  }
  sql += ' ORDER BY entry_time DESC LIMIT 500'

  return db.prepare(sql).all<TradeJournalEntryRow>(...params)
}

export async function getTradeJournalStats(userId: string) {
  const all = await db.prepare('SELECT * FROM trade_journal WHERE user_id = ?').all<TradeJournalEntryRow>(userId)
  const closed = all.filter(t => t.status !== 'open')
  const total = closed.length
  const wins = closed.filter(t => (t.pnl_r ?? 0) > 0).length
  const losses = closed.filter(t => (t.pnl_r ?? 0) < 0).length
  const totalPnlR = closed.reduce((sum, t) => sum + (t.pnl_r ?? 0), 0)
  const totalPnlUsd = closed.reduce((sum, t) => sum + (t.pnl_usd ?? 0), 0)
  const avgR = total > 0 ? totalPnlR / total : 0
  const winRate = total > 0 ? (closed.filter(t => (t.pnl_r ?? 0) > 0).length / total) * 100 : 0

  return { total, wins, losses, winRate: Math.round(winRate * 10) / 10, totalPnlR: Math.round(totalPnlR * 100) / 100, totalPnlUsd: Math.round(totalPnlUsd * 100) / 100, avgR: Math.round(avgR * 100) / 100 }
}
