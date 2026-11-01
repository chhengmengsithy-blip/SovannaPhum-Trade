import { Link } from 'react-router-dom'
import { ArrowRight, Check, CreditCard, Crown, ShieldCheck, Sparkles, Zap } from 'lucide-react'
import { useAuth } from './auth'
import { planName, planPrice, type Plan } from './plan'

const FEATURES: Record<Plan, string[]> = {
  free: ['Market overview', 'Saved signal history', 'Closed-candle analysis'],
  plus: ['Chart scanner', 'Validated trade setups', 'Telegram alerts'],
  pro: ['Everything in Plus', 'Multiple market playbooks', 'Advanced performance review', 'Priority support'],
}

const ORDER: Plan[] = ['free', 'plus', 'pro']

export default function SubscriptionPage() {
  const { user } = useAuth()
  if (!user) return null

  const current = user.plan
  const lifetime = Boolean(user.lifetimePro)

  return (
    <>
      <div className="page-title-row">
        <div>
          <div className="eyebrow">ACCOUNT</div>
          <h1>Subscription</h1>
          <p>Review your plan, unlock the chart scanner and manage billing.</p>
        </div>
        <div className="page-title-actions">
          <span className={`sub-current-chip ${lifetime ? 'is-lifetime' : ''}`}>
            {lifetime ? <Crown size={14} /> : <CreditCard size={14} />}
            {lifetime ? 'Pro · Lifetime' : `${planName(current)} plan`}
          </span>
        </div>
      </div>

      <section className="panel sub-summary">
        <div className="sub-summary-main">
          <span className="sub-summary-icon">{lifetime ? <Crown size={22} /> : <Sparkles size={22} />}</span>
          <div>
            <span className="sub-label">CURRENT PLAN</span>
            <strong>{planName(current)}{lifetime ? ' · forever' : ''}</strong>
            <p>
              {lifetime
                ? 'Your admin account includes every Pro feature for life. No billing required.'
                : current === 'free'
                  ? 'You are on the Free plan. Upgrade to unlock the chart scanner and alerts.'
                  : `${planName(current)} renews monthly at $${planPrice(current)}.00. Cancel anytime.`}
            </p>
          </div>
        </div>
        <div className="sub-summary-side">
          <span className="sub-price">{lifetime ? '$0' : `$${planPrice(current)}`}<small>{lifetime ? 'lifetime' : current === 'free' ? 'forever' : '/ month'}</small></span>
          {!lifetime && current !== 'pro' && <Link className="btn btn-primary" to={`/checkout?plan=${current === 'free' ? 'plus' : 'pro'}`}>Upgrade <ArrowRight size={15} /></Link>}
          {current === 'pro' && !lifetime && <span className="sub-badge"><ShieldCheck size={14} /> Highest tier</span>}
        </div>
      </section>

      <div className="sub-plans">
        {ORDER.map(plan => {
          const active = plan === current
          const featured = plan === 'pro'
          return (
            <section key={plan} className={`panel sub-plan ${featured ? 'is-featured' : ''} ${active ? 'is-active' : ''}`}>
              <div className="sub-plan-head">
                <span className="sub-plan-tag">{plan === 'free' ? 'START' : plan === 'plus' ? 'UPGRADE' : 'MOST POPULAR'}</span>
                {active && <span className="sub-plan-active"><Check size={12} /> Current</span>}
              </div>
              <h2>{planName(plan)}</h2>
              <div className="sub-plan-price">${planPrice(plan)}<small>{plan === 'free' ? 'forever' : '/ month'}</small></div>
              <ul>
                {FEATURES[plan].map(feature => <li key={feature}><Check size={14} />{feature}</li>)}
              </ul>
              {active ? (
                <span className="sub-plan-btn is-disabled">{lifetime ? <><Crown size={14} /> Pro forever</> : 'Your current plan'}</span>
              ) : plan === 'free' ? (
                <span className="sub-plan-btn is-disabled">Included in every plan</span>
              ) : lifetime ? (
                <span className="sub-plan-btn is-disabled"><Crown size={14} /> Included</span>
              ) : (
                <Link className={`sub-plan-btn ${featured ? 'is-primary' : ''}`} to={`/checkout?plan=${plan}`}>
                  {plan === 'plus' ? 'Start Plus' : 'Start Pro'} <ArrowRight size={14} />
                </Link>
              )}
            </section>
          )
        })}
      </div>

      <section className="panel sub-billing">
        <div className="panel-header">
          <div><h2>Billing</h2><p>Payments are collected with KHQR through the Bakong network.</p></div>
          <span className="admin-count"><Zap size={13} /> KHQR</span>
        </div>
        <div className="sub-billing-rows">
          <div><span>Payment method</span><strong>{lifetime ? 'Admin exemption' : 'KHQR · Bakong'}</strong></div>
          <div><span>Billing cycle</span><strong>{lifetime ? 'Lifetime' : current === 'free' ? '—' : 'Monthly'}</strong></div>
          <div><span>Next charge</span><strong>{lifetime || current === 'free' ? '—' : 'In 30 days'}</strong></div>
        </div>
      </section>
    </>
  )
}
