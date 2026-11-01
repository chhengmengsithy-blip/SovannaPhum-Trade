import './env.ts'
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  db, findUserByEmail, findUserById, findUserByTelegram, getKhqrConfig, purgeExpiredSessions,
  initializeDatabase, transaction, updateKhqrConfig, ADMIN_EMAIL,
} from './db.ts'
import { createApiToken, listApiTokens, revokeApiToken, verifyApiToken, getApiTokenScopes,
  createBacktestJob, getBacktestJob, listBacktestJobs, recoverInterruptedBacktests, runBacktest,
  createAlertRule, listAlertRules, toggleAlertRule, deleteAlertRule,
  createTradeJournalEntry, updateTradeJournalEntry, listTradeJournal, getTradeJournalStats } from './proService.ts'
import type { KhqrRow, PaymentRow, Plan, UserRow } from './db.ts'
import { hashPassword, newToken, verifyPassword } from './security.ts'
import { billNumber, buildKhqr, isValidBakongId, khqrMd5 } from './khqr.ts'
import { HttpError } from './http.ts'
import { runV1Analysis } from './v1Service.ts'
import { runV2Analysis, runV2Scan } from './v2Service.ts'
import { runV3Analysis, runV3Scan } from './v3Service.ts'
import { history as getV1History } from './v1Store.ts'
import { history as getV2History } from './v2Store.ts'
import { history as getV3History } from './v3Store.ts'
import { fetchCandles, fetchLivePrice, isTimeframe, MARKET_SYMBOLS } from './marketData.ts'
import { runPythonResearch } from './researchService.ts'
import { STRATEGY_LABELS, type ProRiskProfile, type StrategyName } from '../src/v3/types.ts'

/* --------------------------------------------------------------------- config --- */

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '0.0.0.0'
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30)
const SESSION_COOKIE = 'svn_session'
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1'
// Demo payments and simulated social sign-in are local-testing escape hatches.
// Both are off by default so a production server cannot be tricked into
// activating a plan or signing in as somebody else.
const DEMO_PAYMENTS = process.env.ALLOW_DEMO_PAYMENTS === '1'
const SOCIAL_SIMULATION = process.env.ALLOW_SOCIAL_SIMULATION === '1'
const BAKONG_API_URL = (process.env.BAKONG_API_URL || 'https://api-bakong.nbc.gov.kh').replace(/\/+$/, '')
const DIST_DIR = resolve('dist')

const planAmount = (plan: Exclude<Plan, 'free'>) => (plan === 'plus' ? 5 : 15)
const planRank: Record<Plan, number> = { free: 0, plus: 1, pro: 2 }
const isPlan = (value: unknown): value is Plan => value === 'free' || value === 'plus' || value === 'pro'

/* --------------------------------------------------------------------- errors --- */

/* -------------------------------------------------------------------- helpers --- */

const now = () => new Date().toISOString()
const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

function publicUser(row: UserRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    plan: row.plan,
    role: row.role,
    provider: row.provider,
    telegram: row.telegram ?? undefined,
    lifetimePro: Boolean(row.lifetime_pro),
    createdAt: row.created_at,
  }
}

function publicPayment(row: PaymentRow, demo: boolean) {
  return {
    id: row.id,
    plan: row.plan,
    amount: row.amount,
    currency: row.currency,
    billNumber: row.bill_number,
    status: row.status,
    qrPayload: row.qr_payload,
    demo,
    createdAt: row.created_at,
    paidAt: row.paid_at ?? undefined,
  }
}

function khqrPublic(row: KhqrRow) {
  return {
    bakongId: row.bakong_id,
    merchantName: row.merchant_name,
    city: row.city,
    demo: demoActive(row),
    ready: isValidBakongId(row.bakong_id) && Boolean(process.env.BAKONG_TOKEN),
  }
}

/** Demo is only active when the server flag AND the stored row both allow it. */
function demoActive(row: KhqrRow) {
  return DEMO_PAYMENTS && Boolean(row.demo)
}

function str(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new HttpError(400, `${label} is required.`)
  const clean = value.trim()
  if (clean.length < min || clean.length > max) {
    throw new HttpError(400, `${label} must be between ${min} and ${max} characters.`)
  }
  return clean
}

function optionalHandle(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new HttpError(400, 'Enter a valid Telegram username.')
  const clean = value.trim().replace(/^@+/, '').toLowerCase()
  if (!/^[a-z0-9_]{3,32}$/.test(clean)) throw new HttpError(400, 'Enter a valid Telegram username (3–32 characters).')
  return clean
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) out[key] = decodeURIComponent(value)
  }
  return out
}

function sessionCookie(token: string, maxAgeSeconds = SESSION_DAYS * 86_400) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${COOKIE_SECURE ? '; Secure' : ''}`
}

async function readSessionUser(req: IncomingMessage): Promise<UserRow | null> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (!token) return null
  const row = await db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get<UserRow>(token, now())
  return row ?? null
}

async function requireUser(req: IncomingMessage): Promise<{ user: UserRow; token: string }> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (!token) throw new HttpError(401, 'Please sign in to continue.')
  const row = await db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get<UserRow>(token, now())
  if (!row) throw new HttpError(401, 'Your session has expired. Please sign in again.')
  return { user: row, token }
}

async function requireAdmin(req: IncomingMessage) {
  const session = await requireUser(req)
  if (session.user.role !== 'admin') throw new HttpError(403, 'Admin access is required.')
  return session
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers['content-type'] || ''
  if (!type.includes('application/json')) throw new HttpError(415, 'Expected a JSON request body.')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 200_000) throw new HttpError(413, 'Request body is too large.')
    chunks.push(chunk)
  }
  if (!size) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'Invalid JSON body.')
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-src 'self'",
].join('; ')

function applySecurityHeaders(res: ServerResponse) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')
  if (COOKIE_SECURE) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
}

async function createSession(userId: string): Promise<string> {
  const token = newToken()
  await db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token, userId, now(), daysFromNow(SESSION_DAYS),
  )
  return token
}

/* ------------------------------------------------------------------ rate limit --- */

const attempts = new Map<string, { count: number; reset: number }>()
let lastRateLimitSweep = 0

function sweepRateLimits(timestamp: number) {
  // Keep the map bounded: drop expired buckets at most once a minute.
  if (timestamp - lastRateLimitSweep < 60_000) return
  lastRateLimitSweep = timestamp
  for (const [key, entry] of attempts) {
    if (entry.reset < timestamp) attempts.delete(key)
  }
}

function rateLimit(req: IncomingMessage, bucket: string, max = 25, windowMs = 5 * 60_000) {
  const ip = req.socket.remoteAddress || 'unknown'
  const key = `${bucket}:${ip}`
  const timestamp = Date.now()
  sweepRateLimits(timestamp)
  const entry = attempts.get(key)
  if (!entry || entry.reset < timestamp) {
    attempts.set(key, { count: 1, reset: timestamp + windowMs })
    return
  }
  entry.count += 1
  if (entry.count > max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.')
}

/* --------------------------------------------------------------------- auth API --- */

async function startSession(res: ServerResponse, user: UserRow, status = 200): Promise<void> {
  const token = await createSession(user.id)
  res.setHeader('Set-Cookie', sessionCookie(token))
  sendJson(res, status, { user: publicUser(user) })
}

async function handleAuth(req: IncomingMessage, res: ServerResponse, path: string, method: string) {
  if (path === '/api/auth/me' && method === 'GET') {
    const user = await readSessionUser(req)
    sendJson(res, 200, { user: user ? publicUser(user) : null })
    return true
  }

  if (path === '/api/auth/signup' && method === 'POST') {
    rateLimit(req, 'signup', 15)
    const body = await readJson(req)
    const name = str(body.name, 'Name', 2, 80)
    const email = str(body.email, 'Email', 5, 160)
    const password = str(body.password, 'Password', 8, 200)
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.')
    if (await findUserByEmail(email)) throw new HttpError(409, 'An account with this email already exists.')

    const id = `u_${randomBytes(8).toString('hex')}`
    const timestamp = now()
    await db.prepare(
      `INSERT INTO users (id, name, email, password_hash, plan, role, provider, telegram, lifetime_pro, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'free', 'user', 'email', NULL, 0, ?, ?)`,
    ).run(id, name, email, hashPassword(password), timestamp, timestamp)
    await startSession(res, (await findUserById(id))!, 201)
    return true
  }

  if (path === '/api/auth/login' && method === 'POST') {
    rateLimit(req, 'login', 20)
    const body = await readJson(req)
    const email = str(body.email, 'Email', 3, 160)
    const password = str(body.password, 'Password', 1, 200)
    const user = await findUserByEmail(email)
    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'Incorrect email or password.')
    }
    await startSession(res, user)
    return true
  }

  if (path === '/api/auth/gmail' && method === 'POST') {
    if (!SOCIAL_SIMULATION) {
      throw new HttpError(403, 'Social sign-in is not available. Sign in with your email and password.')
    }
    rateLimit(req, 'gmail', 20)
    const body = await readJson(req)
    const email = str(body.email, 'Gmail address', 6, 160)
    if (!/^[^\s@]+@gmail\.com$/i.test(email)) throw new HttpError(400, 'Enter a valid @gmail.com address.')
    const existing = await findUserByEmail(email)
    if (existing) { await startSession(res, existing); return true }

    const id = `u_${randomBytes(8).toString('hex')}`
    const timestamp = now()
    const name = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
    await db.prepare(
      `INSERT INTO users (id, name, email, password_hash, plan, role, provider, telegram, lifetime_pro, created_at, updated_at)
       VALUES (?, ?, ?, '', 'free', 'user', 'gmail', NULL, 0, ?, ?)`,
    ).run(id, name, email, timestamp, timestamp)
    await startSession(res, (await findUserById(id))!, 201)
    return true
  }

  if (path === '/api/auth/telegram' && method === 'POST') {
    if (!SOCIAL_SIMULATION) {
      throw new HttpError(403, 'Telegram sign-in is not available. Sign in with your email and password.')
    }
    rateLimit(req, 'telegram-login', 20)
    const body = await readJson(req)
    const handle = optionalHandle(body.handle ?? body.username)
    if (!handle) throw new HttpError(400, 'Enter a valid Telegram username.')
    const existing = await findUserByTelegram(handle)
    if (existing) { await startSession(res, existing); return true }

    if (await findUserByEmail(`${handle}@telegram.local`)) {
      throw new HttpError(409, 'This Telegram username is already linked to another account.')
    }

    const id = `u_${randomBytes(8).toString('hex')}`
    const timestamp = now()
    await db.prepare(
      `INSERT INTO users (id, name, email, password_hash, plan, role, provider, telegram, lifetime_pro, created_at, updated_at)
       VALUES (?, ?, ?, '', 'free', 'user', 'telegram', ?, 0, ?, ?)`,
    ).run(id, `@${handle}`, `${handle}@telegram.local`, handle, timestamp, timestamp)
    await startSession(res, (await findUserById(id))!, 201)
    return true
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
    res.setHeader('Set-Cookie', sessionCookie('', 0))
    sendJson(res, 200, { ok: true })
    return true
  }

  if (path === '/api/auth/telegram' && method === 'PATCH') {
    const { user } = await requireUser(req)
    const body = await readJson(req)
    const handle = optionalHandle(body.handle)
    if (handle) {
      const owner = await findUserByTelegram(handle)
      if (owner && owner.id !== user.id) throw new HttpError(409, 'That Telegram username is linked to another account.')
    }
    await db.prepare('UPDATE users SET telegram = ?, updated_at = ? WHERE id = ?').run(handle, now(), user.id)
    sendJson(res, 200, { user: publicUser((await findUserById(user.id))!) })
    return true
  }

  return false
}

/* ------------------------------------------------------------------ payment API --- */

async function verifyBakong(payload: string, expectedAmount: number, expectedCurrency: string) {
  const token = process.env.BAKONG_TOKEN
  if (!token) {
    throw new HttpError(
      503,
      'Real KHQR verification is not configured. Add BAKONG_TOKEN on the server.',
    )
  }
  const md5 = khqrMd5(payload)
  let response: Response
  try {
    response = await fetch(`${BAKONG_API_URL}/v1/check_transaction_by_md5`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ md5 }),
    })
  } catch {
    throw new HttpError(502, 'Could not reach Bakong to verify the payment. Try again shortly.')
  }
  if (!response.ok) throw new HttpError(502, `Bakong verification failed (${response.status}).`)
  const data = (await response.json().catch(() => null)) as {
    responseCode?: number
    data?: { hash?: string; amount?: number | string; currency?: string }
  } | null
  const paidAmount = Number(data?.data?.amount)
  const currency = String(data?.data?.currency ?? '').toUpperCase()
  const amountOk = Number.isFinite(paidAmount) && paidAmount + 1e-6 >= expectedAmount
  const currencyOk = currency === expectedCurrency.toUpperCase()
  return {
    paid: data?.responseCode === 0 && Boolean(data?.data?.hash) && amountOk && currencyOk,
    ref: md5,
  }
}

async function handlePayments(req: IncomingMessage, res: ServerResponse, path: string, method: string) {
  if (path === '/api/payments/checkout' && method === 'POST') {
    const { user } = await requireUser(req)
    if (user.lifetime_pro) throw new HttpError(409, 'Your account already includes Pro forever. No payment is needed.')
    const body = await readJson(req)
    const plan = body.plan
    if (plan !== 'plus' && plan !== 'pro') throw new HttpError(400, 'Choose the Plus or Pro plan.')
    if (planRank[user.plan] >= planRank[plan]) {
      throw new HttpError(409, `You are already on ${user.plan === 'plus' ? 'Plus' : 'Pro'}. Choose a higher plan to upgrade.`)
    }
    const config = await getKhqrConfig()

    // Real payments only. A QR that cannot be verified (or that points at a
    // free email address) is never generated for a customer.
    if (!process.env.BAKONG_TOKEN) {
      throw new HttpError(
        503,
        'Real KHQR payments are not configured yet. Ask the admin to add BAKONG_TOKEN on the server.',
      )
    }
    if (!isValidBakongId(config.bakong_id)) {
      throw new HttpError(
        503,
        'Real KHQR payments are not configured yet. Ask the admin to set a valid Bakong account ID (for example name@aclb).',
      )
    }

    const pending = await db
      .prepare(
        `SELECT * FROM payments WHERE user_id = ? AND plan = ? AND status = 'pending' AND created_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get<PaymentRow>(user.id, plan, new Date(Date.now() - 30 * 60_000).toISOString())

    if (pending) {
      sendJson(res, 200, { payment: publicPayment(pending, demoActive(config)) })
      return true
    }

    const id = `pay_${randomBytes(8).toString('hex')}`
    const bill = billNumber()
    const amount = planAmount(plan)
    const qrPayload = buildKhqr(
      {
        bakongId: config.bakong_id,
        merchantName: config.merchant_name,
        city: config.city,
        demo: Boolean(config.demo),
      },
      { amount, billNumber: bill },
    )
    await db.prepare(
      `INSERT INTO payments (id, user_id, plan, amount, currency, bill_number, status, qr_payload, created_at)
       VALUES (?, ?, ?, ?, 'USD', ?, 'pending', ?, ?)`,
    ).run(id, user.id, plan, amount, bill, qrPayload, now())

    const created = await db.prepare('SELECT * FROM payments WHERE id = ?').get<PaymentRow>(id)
    if (!created) throw new Error('Created payment could not be read back.')
    sendJson(res, 201, { payment: publicPayment(created, demoActive(config)) })
    return true
  }

  if (path === '/api/payments' && method === 'GET') {
    const { user } = await requireUser(req)
    const config = await getKhqrConfig()
    const rows = await db
      .prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 25')
      .all<PaymentRow>(user.id)
    sendJson(res, 200, { payments: rows.map(row => publicPayment(row, demoActive(config))) })
    return true
  }

  const one = path.match(/^\/api\/payments\/([A-Za-z0-9_]+)$/)
  if (one && method === 'GET') {
    const { user } = await requireUser(req)
    const payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get<PaymentRow>(one[1])
    if (!payment || payment.user_id !== user.id) throw new HttpError(404, 'Payment not found.')
    sendJson(res, 200, { payment: publicPayment(payment, demoActive(await getKhqrConfig())) })
    return true
  }

  const confirm = path.match(/^\/api\/payments\/([A-Za-z0-9_]+)\/confirm$/)
  if (confirm && method === 'POST') {
    const { user } = await requireUser(req)
    let payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get<PaymentRow>(confirm[1])
    if (!payment || payment.user_id !== user.id) throw new HttpError(404, 'Payment not found.')
    if (payment.status === 'paid') {
      sendJson(res, 200, { payment: publicPayment(payment, demoActive(await getKhqrConfig())), user: publicUser(user) })
      return true
    }
    if (payment.status !== 'pending') throw new HttpError(409, 'This payment can no longer be confirmed.')

    const config = await getKhqrConfig()
    let ref: string | null = null

    if (demoActive(config)) {
      ref = 'demo'
    } else {
      const result = await verifyBakong(payment.qr_payload, payment.amount, payment.currency)
      if (!result.paid) throw new HttpError(402, 'No matching transfer found on Bakong yet. Pay the KHQR, then try again.')
      ref = result.ref
    }

    const paidAt = now()
    const updatedUser = await transaction(async () => {
      await db.prepare("UPDATE payments SET status = 'paid', paid_at = ?, provider_ref = ? WHERE id = ?").run(paidAt, ref, payment!.id)
      if (!user.lifetime_pro && planRank[payment!.plan] > planRank[user.plan]) {
        await db.prepare('UPDATE users SET plan = ?, updated_at = ? WHERE id = ?').run(payment!.plan, paidAt, user.id)
      }
      return (await findUserById(user.id))!
    })

    payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get<PaymentRow>(payment.id)
    if (!payment) throw new Error('Updated payment could not be read back.')
    sendJson(res, 200, {
      payment: publicPayment(payment, demoActive(config)),
      user: publicUser(updatedUser),
    })
    return true
  }

  return false
}

/* -------------------------------------------------------------------- admin API --- */

async function handleAdmin(req: IncomingMessage, res: ServerResponse, path: string, method: string) {
  if (path === '/api/admin/users' && method === 'GET') {
    await requireAdmin(req)
    const users = await db.prepare('SELECT * FROM users ORDER BY created_at ASC').all<UserRow>()
    sendJson(res, 200, { users: users.map(publicUser) })
    return true
  }

  if (path === '/api/admin/khqr' && method === 'GET') {
    await requireAdmin(req)
    sendJson(res, 200, { config: khqrPublic(await getKhqrConfig()) })
    return true
  }

  if (path === '/api/admin/khqr' && method === 'PUT') {
    await requireAdmin(req)
    const body = await readJson(req)
    const bakongId = typeof body.bakongId === 'string' ? body.bakongId.trim() : ''
    if (bakongId && !isValidBakongId(bakongId)) {
      throw new HttpError(
        400,
        'Enter a real Bakong account ID such as yourname@aclb. Free email addresses cannot receive KHQR payments.',
      )
    }
    const merchantName = str(body.merchantName, 'Merchant name', 1, 25)
    const city = str(body.city, 'City', 1, 15)
    const config = await updateKhqrConfig({
      bakong_id: bakongId,
      merchant_name: merchantName,
      city,
      // Demo mode is a server-operator escape hatch, never an admin toggle.
      demo: DEMO_PAYMENTS && body.demo === true ? 1 : 0,
    })
    sendJson(res, 200, { config: khqrPublic(config) })
    return true
  }

  if (path === '/api/admin/payments' && method === 'GET') {
    await requireAdmin(req)
    const rows = await db
      .prepare(
        `SELECT p.*, u.email FROM payments p JOIN users u ON u.id = p.user_id
         ORDER BY p.created_at DESC LIMIT 50`,
      )
      .all<PaymentRow & { email: string }>()
    const config = await getKhqrConfig()
    sendJson(res, 200, {
      payments: rows.map(row => ({
        ...publicPayment(row, demoActive(config)),
        email: row.email,
      })),
    })
    return true
  }

  const one = path.match(/^\/api\/admin\/users\/([A-Za-z0-9_]+)$/)
  if (one && method === 'PATCH') {
    const { user: admin } = await requireAdmin(req)
    const target = await findUserById(one[1])
    if (!target) throw new HttpError(404, 'Account not found.')
    if (target.lifetime_pro) throw new HttpError(400, 'Admin accounts stay on Pro forever.')
    const body = await readJson(req)
    if (!isPlan(body.plan)) throw new HttpError(400, 'Choose Free, Plus or Pro.')
    if (body.plan === 'pro' && target.id === admin.id) throw new HttpError(400, 'Admins already have Pro forever.')
    await db.prepare('UPDATE users SET plan = ?, updated_at = ? WHERE id = ?').run(body.plan, now(), target.id)
    sendJson(res, 200, { user: publicUser((await findUserById(target.id))!) })
    return true
  }

  if (one && method === 'DELETE') {
    const { user: admin } = await requireAdmin(req)
    const target = await findUserById(one[1])
    if (!target) throw new HttpError(404, 'Account not found.')
    if (target.id === admin.id) throw new HttpError(400, 'You cannot delete your own admin account.')
    if (target.lifetime_pro || target.role === 'admin') throw new HttpError(400, 'Admin accounts cannot be deleted.')
    await db.prepare('DELETE FROM users WHERE id = ?').run(target.id)
    sendJson(res, 200, { ok: true })
    return true
  }

  return false
}

/* ---------------------------------------------------------------------- static --- */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (!existsSync(DIST_DIR)) {
    sendJson(res, 404, { error: 'Live services are ready. Build the web app before serving this address.' })
    return
  }
  let relative: string
  try {
    relative = decodeURIComponent(pathname)
  } catch {
    relative = '/'
  }
  const requested = normalize(join(DIST_DIR, relative)).replace(/\\/g, '/')
  const root = DIST_DIR.replace(/\\/g, '/')
  let file = requested === root || requested === `${root}/` ? join(DIST_DIR, 'index.html') : requested
  if (!file.startsWith(`${root}/`)) file = join(DIST_DIR, 'index.html')
  if (!existsSync(file) || !statSync(file).isFile()) file = join(DIST_DIR, 'index.html')
  if (!existsSync(file)) {
    sendJson(res, 404, { error: 'Not found' })
    return
  }
  const ext = extname(file).toLowerCase()
  const body = readFileSync(file)
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  if (req.method === 'HEAD') res.end()
  else res.end(body)
}

/* ---------------------------------------------------------------------- server --- */

function applyCors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin
  if (!origin) return
  const configured = (process.env.APP_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean)
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  if (local || configured.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Vary', 'Origin')
  }
}

await initializeDatabase()
await purgeExpiredSessions()
await recoverInterruptedBacktests()

const cleanup = setInterval(() => {
  void purgeExpiredSessions().catch(error => console.error('[postgres] session cleanup failed', error))
}, 6 * 60 * 60_000)
cleanup.unref()

const server = createServer(async (req, res) => {
  const method = req.method || 'GET'
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname

  applyCors(req, res)
  applySecurityHeaders(res)
  if (method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  try {
    if (path === '/api/health' && method === 'GET') {
      const [users, payments, config] = await Promise.all([
        db.prepare('SELECT COUNT(*) AS count FROM users').get<{ count: number }>(),
        db.prepare("SELECT COUNT(*) AS count FROM payments WHERE status = 'paid'").get<{ count: number }>(),
        getKhqrConfig(),
      ])
      sendJson(res, 200, {
        ok: true,
        users: users?.count ?? 0,
        paidPayments: payments?.count ?? 0,
        demoPayments: demoActive(config),
        bakongConfigured: Boolean(process.env.BAKONG_TOKEN),
        khqrReady: isValidBakongId(config.bakong_id) && Boolean(process.env.BAKONG_TOKEN),
        socialSimulation: SOCIAL_SIMULATION,
        time: now(),
      })
      return
    }

    if (path === '/api/market/public' && method === 'GET') {
      rateLimit(req, 'public-market', 30, 60_000)
      const symbols = ['XAUUSD', 'XAGUSD', 'USOIL', 'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'US100']
      const results = await Promise.all(symbols.map(async symbol => {
        try {
          const quote = await fetchLivePrice(symbol)
          return { ...quote, available: true as const }
        } catch {
          return { symbol, price: null, time: null, change24h: null, available: false as const }
        }
      }))
      let series: { time: number; close: number }[] = []
      try {
        const history = await fetchCandles('XAUUSD', '15m')
        series = history.candles.slice(-72).map(candle => ({ time: candle.time, close: candle.close }))
      } catch {
        series = []
      }
      sendJson(res, 200, {
        connected: results.some(result => result.available),
        provider: 'Yahoo Finance',
        updatedAt: Date.now(),
        markets: results,
        series: { symbol: 'XAUUSD', timeframe: '15m', candles: series },
      })
      return
    }

    if (path.startsWith('/api/auth')) {
      if (await handleAuth(req, res, path, method)) return
    } else if (path.startsWith('/api/payments')) {
      if (await handlePayments(req, res, path, method)) return
    } else if (path.startsWith('/api/admin')) {
      if (await handleAdmin(req, res, path, method)) return
    }

    if (path === '/api/analyze' && method === 'POST') {
      const { user } = await requireUser(req)
      rateLimit(req, 'analyze', 40, 60_000)
      const body = await readJson(req)
      const analysis = await runV1Analysis(user, body)
      sendJson(res, 200, analysis)
      return
    }

    if (path === '/api/analyze/v2' && method === 'POST') {
      const { user } = await requireUser(req)
      rateLimit(req, 'analyze-v2', 40, 60_000)
      const body = await readJson(req)
      const analysis = await runV2Analysis(user, body)
      sendJson(res, 200, analysis)
      return
    }

    if (path === '/api/scan/v2' && method === 'POST') {
      const { user } = await requireUser(req)
      rateLimit(req, 'scan-v2', 12, 60_000)
      const body = await readJson(req)
      const result = await runV2Scan(user, body)
      sendJson(res, 200, result)
      return
    }

    if (path === '/api/analyze/v3' && method === 'POST') {
      const { user } = await requireUser(req)
      rateLimit(req, 'analyze-v3', 60, 60_000)
      const body = await readJson(req)
      const analysis = await runV3Analysis(user, body)
      sendJson(res, 200, analysis)
      return
    }

    if (path === '/api/scan/v3' && method === 'POST') {
      const { user } = await requireUser(req)
      rateLimit(req, 'scan-v3', 20, 60_000)
      const body = await readJson(req)
      const result = await runV3Scan(user, body)
      sendJson(res, 200, result)
      return
    }

    // Signals history endpoint
    if (path === '/api/signals' && method === 'GET') {
      const { user } = await requireUser(req)
      rateLimit(req, 'signals-history', 30, 60_000)

      // Chart markers cover whichever engine created the persisted setup. This
      // is display-only: no strategy state, cooldown or limit is modified.
      const symbolFilter = url.searchParams.get('symbol')?.trim().toUpperCase() || null
      const timeframeFilter = url.searchParams.get('timeframe')?.trim() || null
      const requestedSignalLimit = Number(url.searchParams.get('limit') ?? (symbolFilter || timeframeFilter ? 5000 : 500))
      const signalLimit = Number.isFinite(requestedSignalLimit) ? Math.min(Math.max(Math.floor(requestedSignalLimit), 1), 5000) : 500
      const timestamp = Date.now()
      const [v1History, v2History, v3History] = await Promise.all([
        getV1History(user.id, 5000),
        getV2History(user.id, timestamp, 5000),
        getV3History(user.id, timestamp, 5000),
      ])
      const signals = [
        ...v1History.map(signal => ({ signal, engine: 'V1' as const })),
        ...v2History.map(signal => ({ signal, engine: 'V2' as const })),
        ...v3History.map(signal => ({ signal, engine: 'V3' as const })),
      ].filter(item => (!symbolFilter || item.signal.symbol === symbolFilter)
        && (!timeframeFilter || item.signal.timeframe === timeframeFilter))
      const unique = [...new Map(signals.map(item => [item.signal.signalId, item])).values()]
        .sort((left, right) => right.signal.barTime - left.signal.barTime)
        .slice(0, signalLimit)
        .map(({ signal, engine }) => ({
          signalId: signal.signalId,
          engine,
          symbol: signal.symbol,
          timeframe: signal.timeframe,
          direction: signal.direction,
          status: signal.status,
          strategyName: 'strategyName' in signal ? signal.strategyName : null,
          riskProfile: 'riskProfile' in signal ? signal.riskProfile ?? null : null,
          score: signal.score.total,
          entry: signal.levels.entry,
          stopLoss: signal.currentStopLoss ?? signal.levels.stopLoss,
          tp1: signal.levels.tp1,
          tp2: signal.levels.tp2,
          tp3: signal.levels.tp3,
          barTime: signal.barTime,
          createdAt: signal.createdAt,
        }))
      const terminal = new Set(['TP3_HIT', 'STOP_LOSS_HIT', 'CLOSED', 'CANCELLED'])

      sendJson(res, 200, {
        open: unique.filter(signal => !terminal.has(signal.status)),
        history: unique.filter(signal => terminal.has(signal.status)),
      })
      return
    }

    // ============================ MARKET DATA API ============================

    // Get historical candles for a symbol/timeframe
    if (path === '/api/market/candles' && method === 'GET') {
      await requireUser(req)
      rateLimit(req, 'market-candles', 60, 60_000)
      const url = new URL(req.url || '/', `http://${req.headers.host}`)
      const symbol = url.searchParams.get('symbol')?.toUpperCase()
      const timeframe = url.searchParams.get('timeframe')
      const requestedLimit = Number(url.searchParams.get('limit') ?? 600)
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(Math.floor(requestedLimit), 1), 10_000)
        : 600

      if (!symbol || !timeframe) {
        throw new HttpError(400, 'symbol and timeframe are required')
      }
      if (!MARKET_SYMBOLS[symbol]) {
        throw new HttpError(400, `Unsupported market: ${symbol}`)
      }
      if (!isTimeframe(timeframe)) {
        throw new HttpError(400, `Unsupported timeframe: ${timeframe}`)
      }

      try {
        const data = await fetchCandles(symbol, timeframe)
        const limited = data.candles.slice(-limit)
        sendJson(res, 200, {
          symbol: data.symbol,
          timeframe: data.timeframe,
          candles: limited,
          provider: data.provider,
        })
      } catch (error) {
        if (error instanceof HttpError) throw error
        throw new HttpError(502, 'Failed to fetch market data')
      }
      return
    }

    // Get the latest live price for a symbol (newest closed 5m candle)
    if (path === '/api/market/price' && method === 'GET') {
      await requireUser(req)
      rateLimit(req, 'market-price', 120, 60_000)
      const url = new URL(req.url || '/', `http://${req.headers.host}`)
      const symbol = url.searchParams.get('symbol')?.toUpperCase()

      if (!symbol || !MARKET_SYMBOLS[symbol]) {
        throw new HttpError(400, 'Invalid or unsupported symbol')
      }

      try {
        const live = await fetchLivePrice(symbol)
        sendJson(res, 200, live)
      } catch (error) {
        if (error instanceof HttpError) throw error
        throw new HttpError(502, 'Failed to fetch price')
      }
      return
    }

    // ============================ PRO PLAN EXCLUSIVE API ROUTES ============================

    if (path === '/api/pro/research' && method === 'POST') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      rateLimit(req, 'pro-python-research', 10, 60_000)
      const body = await readJson(req)
      const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : ''
      const timeframe = typeof body.timeframe === 'string' ? body.timeframe.trim() : ''
      if (!MARKET_SYMBOLS[symbol] || !isTimeframe(timeframe)) throw new HttpError(400, 'Choose a valid market and timeframe.')
      const riskProfile: ProRiskProfile = body.riskProfile === 'LOW' || body.riskProfile === 'HIGH' ? body.riskProfile : 'MEDIUM'
      let playbook: StrategyName | undefined
      if (typeof body.playbook === 'string' && body.playbook !== 'AUTO') {
        if (!Object.prototype.hasOwnProperty.call(STRATEGY_LABELS, body.playbook)) throw new HttpError(400, 'Choose a valid Pro playbook.')
        playbook = body.playbook as StrategyName
      }
      const data = await fetchCandles(symbol, timeframe)
      const report = await runPythonResearch({ symbol, timeframe, candles: data.candles, playbook, riskProfile })
      sendJson(res, 200, report)
      return
    }

    // --- API Tokens ---
    if (path === '/api/pro/tokens' && method === 'GET') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      rateLimit(req, 'pro-tokens-list', 30, 60_000)
      const tokens = await listApiTokens(user.id)
      sendJson(res, 200, { tokens })
      return
    }

    if (path === '/api/pro/tokens' && method === 'POST') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      rateLimit(req, 'pro-tokens-create', 10, 60_000)
      const body = await readJson(req)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) throw new HttpError(400, 'Token name is required.')
      const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s: unknown) => typeof s === 'string') : []
      const expiresDays = typeof body.expiresDays === 'number' && body.expiresDays > 0 ? body.expiresDays : undefined
      const { token, prefix } = await createApiToken(user.id, name, scopes, expiresDays)
      sendJson(res, 201, { token, prefix, name, scopes, expiresDays })
      return
    }

    if (path === '/api/pro/tokens' && method === 'DELETE') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      rateLimit(req, 'pro-tokens-revoke', 20, 60_000)
      const body = await readJson(req)
      const tokenId = typeof body.tokenId === 'string' ? body.tokenId.trim() : ''
      if (!tokenId) throw new HttpError(400, 'Token ID is required.')
      await revokeApiToken(user.id, tokenId)
      sendJson(res, 200, { ok: true })
      return
    }

    // --- Backtesting ---
    if (path === '/api/pro/backtest' && method === 'POST') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      rateLimit(req, 'pro-backtest-create', 5, 60_000)
      const body = await readJson(req)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const symbol = typeof body.symbol === 'string' ? body.symbol.toUpperCase() : ''
      const timeframe = typeof body.timeframe === 'string' ? body.timeframe : ''
      const strategy = typeof body.strategy === 'string' ? body.strategy : 'V3_PRO'
      const params: Record<string, unknown> = body.params && typeof body.params === 'object' && !Array.isArray(body.params)
        ? body.params as Record<string, unknown>
        : {}
      if (!name || !symbol || !timeframe) throw new HttpError(400, 'Name, symbol and timeframe are required.')
      if (!MARKET_SYMBOLS[symbol] || !isTimeframe(timeframe)) throw new HttpError(400, 'Choose a valid market and timeframe.')
      const jobId = await createBacktestJob(user.id, { name, symbol, timeframe, strategy, params })
      sendJson(res, 201, { jobId, status: 'pending' })
      return
    }

    if (path === '/api/pro/backtest' && method === 'GET') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      rateLimit(req, 'pro-backtest-list', 30, 60_000)
      const jobs = await listBacktestJobs(user.id)
      sendJson(res, 200, { jobs })
      return
    }

    if (path.match(/^\/api\/pro\/backtest\/([a-f0-9]+)$/) && method === 'GET') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      const jobId = path.split('/').pop()!
      const job = await getBacktestJob(user.id, jobId)
      if (!job) throw new HttpError(404, 'Backtest job not found.')
      sendJson(res, 200, { job })
      return
    }

    if (path.match(/^\/api\/pro\/backtest\/([a-f0-9]+)$/) && method === 'POST') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      rateLimit(req, 'pro-backtest-run', 10, 60_000)
      const jobId = path.split('/').pop()!
      const job = await getBacktestJob(user.id, jobId)
      if (!job) throw new HttpError(404, 'Backtest job not found.')
      if (job.status !== 'pending') throw new HttpError(409, `Backtest is already ${job.status}.`)

      void runBacktest(jobId, async (symbol, timeframe) => {
        if (!MARKET_SYMBOLS[symbol] || !isTimeframe(timeframe)) throw new Error('The saved market or timeframe is no longer supported.')
        return fetchCandles(symbol, timeframe)
      }).catch(error => console.error('[pro-backtest]', error))

      sendJson(res, 202, { jobId, status: 'running' })
      return
    }

    // --- Alert Rules ---
    if (path === '/api/pro/alerts' && method === 'GET') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      rateLimit(req, 'pro-alerts-list', 30, 60_000)
      const alerts = await listAlertRules(user.id)
      sendJson(res, 200, { alerts })
      return
    }

    if (path === '/api/pro/alerts' && method === 'POST') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      rateLimit(req, 'pro-alerts-create', 10, 60_000)
      const body = await readJson(req)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const symbol = typeof body.symbol === 'string' ? body.symbol.toUpperCase() : ''
      const timeframe = typeof body.timeframe === 'string' ? body.timeframe : ''
      const condition = typeof body.condition === 'string' ? body.condition.trim() : ''
      const channels = Array.isArray(body.channels) ? body.channels.filter((c: unknown) => typeof c === 'string') : []
      if (!name || !symbol || !timeframe || !condition) throw new HttpError(400, 'Name, symbol, timeframe and condition are required.')
      const id = await createAlertRule(user.id, { name, symbol, timeframe, condition, channels })
      sendJson(res, 201, { id, name, symbol, timeframe, condition, channels, isActive: true })
      return
    }

    if (path.match(/^\/api\/pro\/alerts\/([a-f0-9]+)$/) && method === 'PATCH') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      const ruleId = path.split('/').pop()!
      const body = await readJson(req)
      if (typeof body.isActive !== 'number' || (body.isActive !== 0 && body.isActive !== 1)) {
        throw new HttpError(400, 'isActive must be 0 or 1.')
      }
      await toggleAlertRule(user.id, ruleId, body.isActive)
      sendJson(res, 200, { ok: true })
      return
    }

    if (path.match(/^\/api\/pro\/alerts\/([a-f0-9]+)$/) && method === 'DELETE') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      const ruleId = path.split('/').pop()!
      await deleteAlertRule(user.id, ruleId)
      sendJson(res, 200, { ok: true })
      return
    }

    // --- Trade Journal ---
    if (path === '/api/pro/journal' && method === 'GET') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      rateLimit(req, 'pro-journal-list', 30, 60_000)
      const url = new URL(req.url || '/', `http://${req.headers.host}`)
      const filters = {
        symbol: url.searchParams.get('symbol') || undefined,
        status: url.searchParams.get('status') || undefined,
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
      }
      const entries = await listTradeJournal(user.id, filters)
      sendJson(res, 200, { entries })
      return
    }

    if (path === '/api/pro/journal/stats' && method === 'GET') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      const stats = await getTradeJournalStats(user.id)
      sendJson(res, 200, { stats })
      return
    }

    if (path === '/api/pro/journal' && method === 'POST') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      rateLimit(req, 'pro-journal-create', 20, 60_000)
      const body = await readJson(req)
      const required = ['signalId', 'symbol', 'timeframe', 'direction', 'entryPrice', 'stopLoss', 'tp1', 'positionSize', 'riskAmount', 'entryTime']
      for (const field of required) {
        if (body[field] === undefined || body[field] === '') throw new HttpError(400, `${field} is required.`)
      }
      const signalId = typeof body.signalId === 'string' ? body.signalId.trim() : ''
      const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : ''
      const timeframe = typeof body.timeframe === 'string' ? body.timeframe.trim() : ''
      const direction = typeof body.direction === 'string' ? body.direction.trim().toUpperCase() : ''
      const entryTime = typeof body.entryTime === 'string' ? body.entryTime.trim() : ''
      if (!signalId || !symbol || !timeframe || !['BUY', 'SELL'].includes(direction) || !entryTime) {
        throw new HttpError(400, 'Signal, market, timeframe, BUY/SELL direction and entry time are required.')
      }
      const entryPrice = Number(body.entryPrice)
      const stopLoss = Number(body.stopLoss)
      const tp1 = Number(body.tp1)
      const positionSize = Number(body.positionSize)
      const riskAmount = Number(body.riskAmount)
      if (![entryPrice, stopLoss, tp1, positionSize, riskAmount].every(Number.isFinite)) {
        throw new HttpError(400, 'Trade prices, position size and risk amount must be valid numbers.')
      }
      const id = await createTradeJournalEntry(user.id, {
        signalId,
        symbol,
        timeframe,
        direction,
        entryPrice,
        stopLoss,
        tp1,
        tp2: body.tp2 !== undefined ? Number(body.tp2) : null,
        tp3: body.tp3 !== undefined ? Number(body.tp3) : null,
        positionSize,
        riskAmount,
        notes: typeof body.notes === 'string' ? body.notes : '',
        tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        entryTime,
      })
      sendJson(res, 201, { id })
      return
    }

    if (path.match(/^\/api\/pro\/journal\/([a-f0-9]+)$/) && method === 'PATCH') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      const entryId = path.split('/').pop()!
      const body = await readJson(req)
      const allowed = ['exitPrice', 'status', 'pnlR', 'pnlUsd', 'notes', 'tags', 'exitTime']
      const updates: Record<string, unknown> = {}
      for (const key of allowed) {
        if (body[key] !== undefined) updates[key] = body[key]
      }
      if (Object.keys(updates).length === 0) throw new HttpError(400, 'No valid fields to update.')
      await updateTradeJournalEntry(user.id, entryId, updates)
      sendJson(res, 200, { ok: true })
      return
    }

    // --- Journal Stats ---
    if (path === '/api/pro/journal/stats' && method === 'GET') {
      const { user } = await requireUser(req)
      if (user.plan !== 'pro') throw new HttpError(403, 'PRO plan required.')
      const stats = await getTradeJournalStats(user.id)
      sendJson(res, 200, { stats })
      return
    }

    if (path.startsWith('/api')) {
      sendJson(res, 404, { error: 'Requested service was not found.' })
      return
    }

    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed.' })
      return
    }
    serveStatic(req, res, path)
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message })
      return
    }
    console.error('[server]', error)
    sendJson(res, 500, { error: 'Something went wrong. Please try again.' })
  }
})

// ============================ WEBSOCKET SERVER FOR LIVE MARKET DATA ============================
const wss = new WebSocketServer({ server, path: '/ws/market' })

interface MarketClient extends WebSocket {
  subscriptions?: Set<string>
  authenticated?: boolean
  userId?: string
}

wss.on('connection', (ws: MarketClient, req: IncomingMessage) => {
  void setupMarketClient(ws, req)
})

async function setupMarketClient(ws: MarketClient, req: IncomingMessage): Promise<void> {
  let user: UserRow | null
  try {
    user = await readSessionUser(req)
  } catch (error) {
    console.error('[WS] Authentication failed:', error)
    ws.close(1011, 'Authentication unavailable')
    return
  }
  if (!user) {
    ws.close(1008, 'Authentication required')
    return
  }

  ws.authenticated = true
  ws.userId = user.id
  ws.subscriptions = new Set()

  ws.on('message', data => {
    try {
      const msg = JSON.parse(data.toString()) as { type?: unknown; symbols?: unknown }
      if (msg.type === 'subscribe' && Array.isArray(msg.symbols)) {
        const symbols = [...new Set(msg.symbols
          .filter((value): value is string => typeof value === 'string')
          .map(value => value.trim().toUpperCase())
          .filter(symbol => Boolean(MARKET_SYMBOLS[symbol])))]
          .slice(0, Object.keys(MARKET_SYMBOLS).length)
        for (const symbol of symbols) ws.subscriptions?.add(symbol)
        ws.send(JSON.stringify({ type: 'subscribed', symbols }))
        void sendCurrentPrices(ws, symbols)
      } else if (msg.type === 'unsubscribe' && Array.isArray(msg.symbols)) {
        const symbols = msg.symbols
          .filter((value): value is string => typeof value === 'string')
          .map(value => value.trim().toUpperCase())
        symbols.forEach(symbol => ws.subscriptions?.delete(symbol))
        ws.send(JSON.stringify({ type: 'unsubscribed', symbols }))
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }))
    }
  })

  ws.on('error', (err) => {
    console.error('[WS] Error:', err)
  })

  // Send welcome message
  ws.send(JSON.stringify({ type: 'welcome', message: 'SOVANNAPHUMTRADE live market data is ready' }))
}

async function sendCurrentPrices(client: MarketClient, symbols: string[]) {
  await Promise.all(symbols.map(async symbol => {
    if (client.readyState !== WebSocket.OPEN || !client.subscriptions?.has(symbol)) return
    try {
      const live = await fetchLivePrice(symbol)
      if (client.readyState === WebSocket.OPEN && client.subscriptions?.has(symbol)) {
        client.send(JSON.stringify({ type: 'price', ...live }))
      }
    } catch (error) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'market-error',
          symbol,
          message: error instanceof Error ? error.message : 'Live quote unavailable.',
        }))
      }
    }
  }))
}

// Broadcast live price updates to subscribed clients only.
let broadcastRunning = false
const lastPriceErrorAt = new Map<string, number>()
async function broadcastPriceUpdates() {
  if (broadcastRunning) return
  broadcastRunning = true
  const symbols = new Set<string>()
  wss.clients.forEach((client: MarketClient) => {
    if (client.readyState === WebSocket.OPEN) {
      client.subscriptions?.forEach(symbol => symbols.add(symbol))
    }
  })
  if (!symbols.size) {
    broadcastRunning = false
    return
  }

  try {
    await Promise.all([...symbols].map(async symbol => {
      if (!MARKET_SYMBOLS[symbol]) return
      try {
        const live = await fetchLivePrice(symbol)
        wss.clients.forEach((client: MarketClient) => {
          if (client.readyState === WebSocket.OPEN && client.subscriptions?.has(symbol)) {
            client.send(JSON.stringify({ type: 'price', ...live }))
          }
        })
      } catch (error) {
        const now = Date.now()
        if (now - (lastPriceErrorAt.get(symbol) ?? 0) >= 60_000) {
          lastPriceErrorAt.set(symbol, now)
          console.error(`[WS] Live quote unavailable for ${symbol}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }))
  } finally {
    broadcastRunning = false
  }
}

// Broadcast every 5 seconds
const marketBroadcast = setInterval(broadcastPriceUpdates, 5000)
marketBroadcast.unref()

server.listen(PORT, HOST, () => {
  console.log(`SOVANNAPHUMTRADE API listening on http://localhost:${PORT}`)
  console.log('PostgreSQL database: Neon')
  console.log(`Admin: ${ADMIN_EMAIL} · demo KHQR payments: ${DEMO_PAYMENTS ? 'on' : 'off'} · social simulation: ${SOCIAL_SIMULATION ? 'on' : 'off'}`)
})
