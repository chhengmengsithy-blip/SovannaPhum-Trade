import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BellRing, Check, MessageCircle, Send, ShieldCheck, Trash2, Zap } from 'lucide-react'
import { useAuth } from './auth'

const BOT_NAME = 'SovannaTradeAlertsBot'

export default function TelegramPage() {
  const { user, linkTelegram } = useAuth()
  const [handle, setHandle] = useState(user?.telegram ? `@${user.telegram}` : '')
  const [saved, setSaved] = useState(false)
  const [tested, setTested] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setHandle(user?.telegram ? `@${user.telegram}` : '')
  }, [user?.telegram])

  if (!user) return null

  const linked = Boolean(user.telegram)
  const valid = /^@?[a-zA-Z0-9_]{3,32}$/.test(handle.trim())

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!valid) return
    setBusy(true)
    setError('')
    try {
      await linkTelegram(handle.trim())
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2200)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not link Telegram.')
    } finally {
      setBusy(false)
    }
  }

  const unlink = async () => {
    setError('')
    try {
      await linkTelegram(null)
      setHandle('')
      setTested(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlink Telegram.')
    }
  }

  return (
    <>
      <div className="page-title-row">
        <div>
          <div className="eyebrow">INTEGRATIONS</div>
          <h1>Telegram alerts</h1>
          <p>Receive confirmed trade events, scanner results and plan updates in Telegram.</p>
        </div>
        <div className="page-title-actions">
          <span className={`tg-status ${linked ? 'is-live' : ''}`}>
            <span className="tg-dot" /> {linked ? 'Linked' : 'Ready to link'}
          </span>
        </div>
      </div>

      <div className="tg-grid">
        <section className="panel tg-card">
          <div className="panel-header">
            <div>
              <h2>Alert delivery</h2>
              <p>Link the Telegram account that should receive notifications.</p>
            </div>
            <span className="tg-bot-chip"><Send size={13} /> {BOT_NAME}</span>
          </div>

          {linked ? (
            <div className="tg-linked">
              <span className="tg-avatar">{user.telegram!.slice(0, 1).toUpperCase()}</span>
              <div className="tg-linked-meta">
                <strong>@{user.telegram}</strong>
                <small>Receiving alerts for {user.plan === 'free' ? 'Free workspace' : `${user.plan === 'plus' ? 'Plus' : 'Pro'} workspace`}</small>
              </div>
              <button
                className="tg-unlink"
                onClick={() => { void unlink() }}
              >
                <Trash2 size={14} /> Unlink
              </button>
            </div>
          ) : (
            <form className="tg-form" onSubmit={submit}>
              <label>
                <span>Telegram username</span>
                <div className="tg-input">
                  <MessageCircle size={15} />
                  <input
                    value={handle}
                    onChange={event => setHandle(event.target.value)}
                    placeholder="@yourusername"
                    autoComplete="off"
                    required
                  />
                </div>
                <small>Open Telegram and start a chat with {BOT_NAME}, then enter your @username.</small>
              </label>
              <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
                {busy ? 'Linking…' : saved ? <><Check size={15} /> Linked</> : <><Send size={15} /> Link Telegram</>}
              </button>
            </form>
          )}

          {error && <p className="tg-error">{error}</p>}

          {linked && (
            <div className="tg-actions">
              <button className="btn btn-secondary" onClick={() => { setTested(true); window.setTimeout(() => setTested(false), 2600) }}>
                {tested ? <><Check size={15} /> Test alert queued</> : <><BellRing size={15} /> Send test alert</>}
              </button>
              <Link className="btn btn-ghost" to="/subscription"><Zap size={15} /> Manage plan</Link>
            </div>
          )}
        </section>

        <aside className="panel tg-side">
          <h3>What you receive</h3>
          <ul className="tg-list">
            <li><span><Check size={13} /></span>Scanner results on Plus and Pro</li>
            <li><span><Check size={13} /></span>Confirmed setups and invalidations</li>
            <li><span><Check size={13} /></span>Risk levels for watched markets</li>
            <li><span><Check size={13} /></span>Payment and plan confirmations</li>
          </ul>
          <div className="tg-note">
            <ShieldCheck size={15} />
            <p>Alerts are delivered from our bot only. We never ask for your Telegram password or login code.</p>
          </div>
        </aside>
      </div>
    </>
  )
}
