import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Check, Crown, Loader2, QrCode, Save, Send, ShieldCheck, Trash2, Users, Wallet } from 'lucide-react'
import { useAuth } from './auth'
import { planName, planPrice, type Plan } from './plan'
import { api, type KhqrConfig } from './services/api'

const planOptions: Plan[] = ['free', 'plus', 'pro']

export default function AdminPage() {
  const { user, accounts, updateAccount, deleteAccount, refreshAccounts } = useAuth()
  const [config, setConfig] = useState<KhqrConfig | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void refreshAccounts()
    api<{ config: KhqrConfig }>('/admin/khqr')
      .then(result => setConfig(result.config))
      .catch(err => setError(err instanceof Error ? err.message : 'Could not load the gateway settings.'))
  }, [refreshAccounts])

  if (!user || user.role !== 'admin') return <Navigate to="/dashboard" replace />

  const paid = accounts.filter(account => account.plan !== 'free')
  const mrr = accounts.reduce((total, account) => total + (account.lifetimePro ? 0 : planPrice(account.plan)), 0)
  const telegram = accounts.filter(account => account.telegram).length

  const stats = [
    { icon: Users, label: 'Accounts', value: String(accounts.length), note: `${accounts.filter(a => a.role === 'admin').length} admin` },
    { icon: Crown, label: 'Paid plans', value: String(paid.length), note: `${accounts.filter(a => a.plan === 'free').length} on Free` },
    { icon: Wallet, label: 'Monthly revenue', value: `$${mrr}`, note: 'Plus $5 · Pro $15' },
    { icon: Send, label: 'Telegram linked', value: String(telegram), note: 'Alert-ready accounts' },
  ]

  const changePlan = (id: string, plan: Plan) => {
    setError('')
    void updateAccount(id, { plan }).catch(err => setError(err instanceof Error ? err.message : 'Could not update the plan.'))
  }

  const removeAccount = async (id: string, email: string) => {
    if (!window.confirm(`Delete ${email}? This removes their sessions and payment history.`)) return
    setError('')
    try {
      await deleteAccount(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the account.')
    }
  }

  const saveConfig = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!config) return
    setSaving(true)
    setError('')
    try {
      const result = await api<{ config: KhqrConfig }>('/admin/khqr', { method: 'PUT', body: config })
      setConfig(result.config)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2200)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the gateway.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="admin-page">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">OWNER CONSOLE</div>
          <h1>Admin dashboard</h1>
          <p>Accounts, plans and the KHQR payment gateway for SOVANNAPHUMTRADE.</p>
        </div>
        <div className="page-title-actions"><span className="admin-lifetime"><Crown size={14} /> PRO FOREVER</span></div>
      </div>

      {error && <p className="admin-error">{error}</p>}

      <div className="admin-stats">
        {stats.map(({ icon: Icon, label, value, note }) => (
          <div className="admin-stat" key={label}>
            <span className="admin-stat-icon"><Icon size={18} /></span>
            <span className="admin-stat-label">{label}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </div>
        ))}
      </div>

      <section className="panel admin-panel">
        <div className="panel-header"><div><h2>Accounts</h2><p>Change a plan or remove an account. Admin stays on Pro forever.</p></div><span className="admin-count">{accounts.length} total</span></div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>Account</th><th>Sign-in</th><th>Plan</th><th>Telegram</th><th>Joined</th><th /></tr></thead>
            <tbody>
              {accounts.map(account => {
                const isSelf = account.id === user.id
                return (
                  <tr key={account.id}>
                    <td>
                      <div className="admin-user">
                        <span className={`admin-avatar ${account.role === 'admin' ? 'is-admin' : ''}`}>{account.name.slice(0, 1).toUpperCase()}</span>
                        <div><strong>{account.name}{isSelf && <em>you</em>}{account.role === 'admin' && <span className="admin-role">ADMIN</span>}</strong><small>{account.email}</small></div>
                      </div>
                    </td>
                    <td><span className="admin-provider">{account.provider}</span></td>
                    <td>
                      {account.lifetimePro ? (
                        <span className="admin-plan-fixed"><Crown size={12} /> PRO FOREVER</span>
                      ) : (
                        <div className="admin-plan-switch">
                          {planOptions.map(option => (
                            <button key={option} className={account.plan === option ? 'is-active' : ''} onClick={() => changePlan(account.id, option)}>{planName(option)}</button>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>{account.telegram ? <span className="admin-tg">@{account.telegram}</span> : <span className="admin-muted">Not linked</span>}</td>
                    <td className="admin-muted">{new Date(account.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                    <td>
                      {!isSelf && account.role !== 'admin' && (
                        <button className="admin-delete" aria-label={`Delete ${account.email}`} onClick={() => { void removeAccount(account.id, account.email) }}><Trash2 size={14} /></button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel admin-panel">
        <div className="panel-header"><div><h2>KHQR payment gateway</h2><p>Production Bakong merchant details used to issue verifiable checkout QR payments.</p></div><span className="admin-count"><QrCode size={13} /> KHQR</span></div>
        {config ? (
          <form className="admin-form" onSubmit={saveConfig}>
            <label>
              <span>Bakong account ID <span className="required">*</span></span>
              <input value={config.bakongId} onChange={event => setConfig({ ...config, bakongId: event.target.value })} placeholder="yourname@aclb" required />
              <small>Must be a real Bakong ID like <code>sithy@aclb</code>. Free email addresses cannot receive KHQR payments.</small>
            </label>
            <label>
              <span>Merchant name</span>
              <input value={config.merchantName} onChange={event => setConfig({ ...config, merchantName: event.target.value })} maxLength={25} required />
            </label>
            <label>
              <span>City</span>
              <input value={config.city} onChange={event => setConfig({ ...config, city: event.target.value })} maxLength={15} required />
            </label>
            <div className="admin-form-foot">
              <p>
                <ShieldCheck size={14} />
                {config.ready
                  ? 'KHQR is ready. Checkout QR codes will be generated and verified through Bakong.'
                  : !config.bakongId
                    ? 'Enter a verified Bakong account ID to enable production KHQR payments.'
                    : !isValidBakongId(config.bakongId)
                      ? 'The Bakong ID is not valid. Use a bank/biller code like <code>yourname@aclb</code>, not a free email address.'
                      : 'Add a valid BAKONG_TOKEN to enable real payment verification.'}
              </p>
              <button type="submit" className="btn btn-primary" disabled={saving || !config.ready}>
                {saving ? <><Loader2 size={15} className="spin" /> Saving…</> : saved ? <><Check size={15} /> Saved</> : <><Save size={15} /> Save gateway</>}
              </button>
            </div>
          </form>
        ) : (
          <div className="admin-config-loading"><Loader2 size={16} className="spin" /> Loading gateway settings…</div>
        )}
      </section>
    </div>
  )
}

function isValidBakongId(value: string): boolean {
  const id = value.trim()
  if (!id || id.length > 64) return false
  const match = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}@([A-Za-z]{2,12})$/.exec(id)
  if (!match) return false
  const freemail = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'proton.me', 'protonmail.com', 'telegram.local', 'example.com'])
  return !freemail.has(match[1].toLowerCase())
}
