import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import * as QRCode from 'qrcode'
import { ArrowLeft, ArrowRight, Check, Loader2, LockKeyhole, QrCode, ShieldCheck, Sparkles, Zap } from 'lucide-react'
import { useAuth } from './auth'
import { planName, planPrice } from './plan'
import { api, type PaymentRecord } from './services/api'

const PLUS_FEATURES = ['Chart scanner', 'Validated trade setups', 'Telegram alerts']
const PRO_FEATURES = ['Everything in Plus', 'Multiple market playbooks', 'Advanced performance review', 'Priority support']

type PayState = 'creating' | 'pending' | 'verifying' | 'paid'

export default function CheckoutPage() {
  const [params] = useSearchParams()
  const { user, refreshUser } = useAuth()
  const plan = params.get('plan') === 'plus' ? 'plus' : params.get('plan') === 'pro' ? 'pro' : null

  const [payment, setPayment] = useState<PaymentRecord | null>(null)
  const [qr, setQr] = useState('')
  const [state, setState] = useState<PayState>('creating')
  const [error, setError] = useState('')

  const amount = plan ? planPrice(plan) : 0
  const lifetime = Boolean(user?.lifetimePro)
  const payload = useMemo(() => payment?.qrPayload ?? '', [payment])

  // Create the pending KHQR payment on the server (the merchant details never
  // leave the backend). Admin lifetime accounts skip checkout entirely.
  useEffect(() => {
    if (!plan || !user?.id || lifetime) return
    let active = true
    setState('creating')
    setError('')
    api<{ payment: PaymentRecord }>('/payments/checkout', { method: 'POST', body: { plan } })
      .then(result => {
        if (!active) return
        setPayment(result.payment)
        setState('pending')
      })
      .catch(err => {
        if (!active) return
        setError(err instanceof Error ? err.message : 'Could not start the payment.')
        setState('pending')
      })
    return () => { active = false }
  }, [plan, user?.id, lifetime])

  useEffect(() => {
    let active = true
    if (!payload) { setQr(''); return }
    QRCode.toDataURL(payload, {
      width: 420,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0c16', light: '#ffffff' },
    })
      .then(url => { if (active) setQr(url) })
      .catch(() => { if (active) setQr('') })
    return () => { active = false }
  }, [payload])

  // Poll while the QR is open so a transfer confirmed on the Bakong side
  // activates the plan without the user pressing anything.
  useEffect(() => {
    if (!payment || state === 'paid' || payment.status === 'paid') return
    const timer = window.setInterval(async () => {
      try {
        const result = await api<{ payment: PaymentRecord }>(`/payments/${payment.id}`)
        if (result.payment.status === 'paid') {
          setPayment(result.payment)
          await refreshUser()
          setState('paid')
        }
      } catch {
        /* keep waiting */
      }
    }, 6000)
    return () => window.clearInterval(timer)
  }, [payment?.id, payment?.status, state, refreshUser])

  if (!plan) return <Navigate to="/#pricing" replace />
  if (!user) return <Navigate to={`/login?plan=${plan}`} replace />

  const features = plan === 'plus' ? PLUS_FEATURES : PRO_FEATURES

  const confirm = async () => {
    if (!payment || state === 'verifying' || state === 'paid') return
    setState('verifying')
    setError('')
    try {
      const result = await api<{ payment: PaymentRecord }>(`/payments/${payment.id}/confirm`, { method: 'POST' })
      setPayment(result.payment)
      await refreshUser()
      setState('paid')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not verify the payment.')
      setState('pending')
    }
  }

  return (
    <div className="checkout-page">
      <header className="checkout-top">
        <Link to="/dashboard" className="checkout-brand"><img src="/sovan-mark.png" alt="" /><span>SOVANNAPHUMTRADE</span></Link>
        <Link to="/dashboard" className="checkout-back"><ArrowLeft size={15} /> Dashboard</Link>
      </header>

      <main className="checkout-shell">
        <div className="checkout-heading">
          <span className="checkout-kicker"><Sparkles size={13} /> SECURE CHECKOUT</span>
          <h1>Upgrade to <span>{planName(plan)}</span></h1>
          <p>Pay with KHQR from any Cambodian banking app. Your plan activates the moment the transfer is confirmed.</p>
        </div>

        <div className="checkout-grid">
          <section className="checkout-summary">
            <div className="checkout-plan">
              <div>
                <span className="checkout-label">SELECTED PLAN</span>
                <strong>{planName(plan)}</strong>
              </div>
              <span className="checkout-badge">{plan === 'pro' ? 'MOST POPULAR' : 'UPGRADE'}</span>
            </div>

            <ul className="checkout-features">
              {features.map(feature => <li key={feature}><Check size={14} />{feature}</li>)}
            </ul>

            <div className="checkout-rows">
              <div><span>{planName(plan)} monthly</span><strong>${amount}.00</strong></div>
              <div><span>Tax</span><strong>$0.00</strong></div>
              <div className="is-total"><span>Total due today</span><strong>${amount}.00</strong></div>
            </div>

            <div className="checkout-assurance">
              <ShieldCheck size={15} />
              <span>Secured by KHQR · Bakong network. Renews monthly. Cancel anytime.</span>
            </div>
          </section>

          <section className="checkout-pay">
            {lifetime ? (
              <div className="checkout-done">
                <span className="checkout-done-icon"><ShieldCheck size={26} /></span>
                <h2>Pro · Lifetime</h2>
                <p>Your admin account already has every Pro feature, forever. No payment needed.</p>
                <Link to="/dashboard" className="checkout-primary">Back to dashboard <ArrowRight size={15} /></Link>
              </div>
            ) : state === 'paid' ? (
              <div className="checkout-done">
                <span className="checkout-done-icon"><Check size={26} /></span>
                <h2>{planName(plan)} is active</h2>
                <p>Payment confirmed. Your workspace now unlocks {plan === 'plus' ? 'the chart scanner and Plus trade setups' : 'every Pro trading tool'}.</p>
                <Link to="/dashboard" className="checkout-primary">Go to dashboard <ArrowRight size={15} /></Link>
              </div>
            ) : !payment && error ? (
              <div className="checkout-done">
                <span className="checkout-done-icon is-pending"><LockKeyhole size={25} /></span>
                <h2>KHQR is not ready yet</h2>
                <p>{error}</p>
                <p className="checkout-help">Every KHQR payment is issued and verified by the production server before a plan is activated.</p>
                <Link to="/dashboard" className="checkout-primary">Back to dashboard <ArrowRight size={15} /></Link>
              </div>
            ) : (
              <>
                <div className="checkout-qr-head">
                  <div className="checkout-qr-title"><QrCode size={17} /><span>KHQR · Bakong</span></div>
                  <span className={`checkout-status ${state === 'verifying' ? 'verifying' : ''}`}>
                    {state === 'verifying' ? 'Checking…' : state === 'creating' ? 'Creating payment…' : 'Waiting for payment'}
                  </span>
                </div>

                <div className="checkout-qr-frame">
                  {qr
                    ? <img src={qr} alt={`KHQR code for ${planName(plan)}`} />
                    : <div className="checkout-qr-loading"><Loader2 size={22} className="spin" /> {state === 'creating' ? 'Creating payment…' : 'Generating QR…'}</div>}
                  <span className="checkout-qr-corner tl" /><span className="checkout-qr-corner tr" /><span className="checkout-qr-corner bl" /><span className="checkout-qr-corner br" />
                </div>

                <div className="checkout-amount"><strong>${amount}.00</strong><span>USD · {planName(plan)} monthly</span></div>

                <p className="checkout-scan">Open Bakong, ABA, Wing or any KHQR-enabled app and scan to pay.</p>

                {error && <p className="checkout-error">{error}</p>}

                <button className="checkout-primary" onClick={confirm} disabled={!payment || state === 'creating' || state === 'verifying'}>
                  {state === 'verifying'
                    ? <><Loader2 size={15} className="spin" /> Verifying payment…</>
                    : <>I have paid <ArrowRight size={15} /></>}
                </button>
                <p className="checkout-ref">{payment ? <>Reference {payment.billNumber} · Confirms automatically</> : 'Preparing a secure payment reference…'}</p>
              </>
            )}
          </section>
        </div>

        <div className="checkout-trust">
          <span><ShieldCheck size={14} /> 256-bit secure session</span>
          <span><Zap size={14} /> Instant activation</span>
          <span><Check size={14} /> Cancel anytime</span>
        </div>
      </main>
    </div>
  )
}
