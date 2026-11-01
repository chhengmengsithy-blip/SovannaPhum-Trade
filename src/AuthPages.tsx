import { useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, ArrowRight, Check, Eye, EyeOff, Fingerprint, LockKeyhole, Mail, ShieldCheck,
  Sparkles, User,
} from 'lucide-react'
import { useAuth } from './auth'
import type { Account } from './auth'

function useAuthTarget() {
  const location = useLocation()
  const [params] = useSearchParams()
  const plan = params.get('plan') === 'plus' ? 'plus' : params.get('plan') === 'pro' ? 'pro' : null
  const from = (location.state as { from?: string } | null)?.from
  return { plan, from }
}

function afterAuth(account: Account, plan: string | null, from?: string) {
  if (account.role === 'admin') return '/admin'
  if (plan) return `/checkout?plan=${plan}`
  return from && from.startsWith('/') ? from : '/dashboard'
}

function friendlyError(err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : ''
  if (!message) return fallback
  if (/cannot reach the server/i.test(message)) {
    return 'Live services are unavailable right now. Check your internet and try again.'
  }
  return message
}

function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-orb auth-orb-a" aria-hidden="true" />
      <div className="auth-orb auth-orb-b" aria-hidden="true" />
      <div className="auth-grid" aria-hidden="true" />
      <aside className="auth-visual">
        <Link to="/" className="auth-brand" aria-label="Back to SOVANNAPHUMTRADE">
          <img src="/sovan-mark.png" alt="" />
          <span>SOVANNAPHUMTRADE</span>
        </Link>
        <div className="auth-visual-copy">
          <span className="auth-kicker"><Sparkles size={13} /> MARKET ANALYSIS WORKSPACE</span>
          <h1>Read every move.<br /><span>Trade the plan.</span></h1>
          <p>One account for live charts, validated trade setups and alerts—on every device.</p>
          <ul>
            <li><Check size={14} /> Chart structure, momentum and liquidity</li>
            <li><Check size={14} /> Plus market scanner · Pro market playbooks</li>
            <li><Check size={14} /> Telegram alerts on your account</li>
          </ul>
        </div>
        <div className="auth-visual-foot">
          <ShieldCheck size={15} /> Encrypted session · your workspace stays signed in
        </div>
      </aside>
      <main className="auth-panel">
        <Link to="/" className="auth-mobile-brand" aria-label="SOVANNAPHUMTRADE home"><img src="/sovan-mark.png" alt="" /><span>SOVANNAPHUMTRADE</span></Link>
        <Link to="/" className="auth-back"><ArrowLeft size={15} /> Back to home</Link>
        {children}
        <p className="auth-legal">Trading involves risk. Analysis is not financial advice.</p>
      </main>
    </div>
  )
}

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const { plan, from } = useAuthTarget()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const finish = (account: Account) => navigate(afterAuth(account, plan, from), { replace: true })

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      finish(await login(email.trim(), password))
    } catch (err) {
      setError(friendlyError(err, 'Unable to sign in. Check your email and password.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <div className="auth-card">
        <div className="auth-heading">
          <span className="auth-badge"><Fingerprint size={12} /> WELCOME BACK</span>
          <h2>Sign in to your desk</h2>
          <p>Your charts, signals and plan are waiting.</p>
          {plan && (
            <span className="auth-plan-chip">
              {plan === 'plus' ? 'Plus' : 'Pro'} plan selected
            </span>
          )}
        </div>

        <form onSubmit={submit} className="auth-form">
          <label className="auth-field">
            <span>Email</span>
            <div className="auth-input"><Mail size={15} /><input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" autoFocus required /></div>
          </label>
          <label className="auth-field">
            <span>Password</span>
            <div className="auth-input">
              <LockKeyhole size={15} />
              <input type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} placeholder="Your password" autoComplete="current-password" required />
              <button type="button" className="auth-eye" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={15} /> : <Eye size={15} />}</button>
            </div>
          </label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button type="submit" className="auth-submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'} {!busy && <ArrowRight size={15} />}</button>
        </form>

        <div className="auth-note">
          <ShieldCheck size={15} />
          <span>Email and password only. Sessions are encrypted and never shared with third parties.</span>
        </div>

        <p className="auth-switch">New here? <Link to={plan ? `/signup?plan=${plan}` : '/signup'}>Create an account</Link></p>
      </div>
    </AuthLayout>
  )
}

export function SignupPage() {
  const { signup } = useAuth()
  const navigate = useNavigate()
  const { plan, from } = useAuthTarget()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const finish = (account: Account) => navigate(afterAuth(account, plan, from), { replace: true })

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    if (password !== confirm) { setError('Passwords do not match.'); return }
    setBusy(true)
    try {
      finish(await signup({ name: name.trim(), email: email.trim(), password }))
    } catch (err) {
      setError(friendlyError(err, 'Unable to create the account.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <div className="auth-card">
        <div className="auth-heading">
          <span className="auth-badge"><Sparkles size={12} /> CREATE ACCOUNT</span>
          <h2>Start your workspace</h2>
          <p>Free to start. Upgrade to Plus or Pro anytime.</p>
          {plan && <span className="auth-plan-chip">{plan === 'plus' ? 'Plus' : 'Pro'} plan selected · {plan === 'plus' ? '$5' : '$15'}/month</span>}
        </div>

        <form onSubmit={submit} className="auth-form">
          <label className="auth-field">
            <span>Full name</span>
            <div className="auth-input"><User size={15} /><input value={name} onChange={event => setName(event.target.value)} placeholder="Your name" autoComplete="name" minLength={2} required /></div>
          </label>
          <label className="auth-field">
            <span>Email</span>
            <div className="auth-input"><Mail size={15} /><input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" required /></div>
          </label>
          <label className="auth-field">
            <span>Password</span>
            <div className="auth-input">
              <LockKeyhole size={15} />
              <input type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 8 characters" autoComplete="new-password" minLength={8} required />
              <button type="button" className="auth-eye" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={15} /> : <Eye size={15} />}</button>
            </div>
          </label>
          <label className="auth-field">
            <span>Confirm password</span>
            <div className="auth-input"><LockKeyhole size={15} /><input type={showPassword ? 'text' : 'password'} value={confirm} onChange={event => setConfirm(event.target.value)} placeholder="Repeat the password" autoComplete="new-password" required /></div>
          </label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button type="submit" className="auth-submit" disabled={busy}>{busy ? 'Creating account…' : 'Create account'} {!busy && <ArrowRight size={15} />}</button>
        </form>

        <div className="auth-note">
          <ShieldCheck size={15} />
          <span>Your account starts with Free Analysis. Upgrade to Plus or Pro whenever you are ready.</span>
        </div>

        <p className="auth-switch">Already have an account? <Link to={plan ? `/login?plan=${plan}` : '/login'}>Sign in</Link></p>
      </div>
    </AuthLayout>
  )
}
