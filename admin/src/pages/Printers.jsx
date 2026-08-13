import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'

export default function Printers() {
  const { t } = useTranslation()
  const [printers, setPrinters] = useState([])
  const [claimCode, setClaimCode] = useState('')
  const [claimName, setClaimName] = useState('')
  const [claiming, setClaiming] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => { loadPrinters() }, [])

  async function loadPrinters() {
    try {
      const { data } = await api.get('/orders/printers/')
      setPrinters(data)
    } catch {
      setPrinters([])
    }
  }

  async function handleClaim(e) {
    e.preventDefault()
    setError('')
    setSuccess('')
    setClaiming(true)
    try {
      await api.post('/orders/printers/claim', {
        claim_code: claimCode.toUpperCase().trim(),
        name: claimName.trim() || t('printers.printerNamePlaceholder'),
      })
      setSuccess(t('printers.claimSuccess'))
      setClaimCode('')
      setClaimName('')
      loadPrinters()
    } catch (err) {
      setError(err.response?.data?.detail || t('printers.claimFailed'))
    } finally {
      setClaiming(false)
    }
  }

  async function handleUnclaim(id) {
    if (!confirm(t('printers.confirmUnclaim'))) return
    try {
      await api.delete(`/orders/printers/${id}`)
      loadPrinters()
    } catch {
      setError(t('printers.unclaimFailed'))
    }
  }

  function formatLastSeen(ts) {
    if (!ts) return t('printers.never')
    const d = new Date(ts)
    const diff = (Date.now() - d) / 1000
    if (diff < 60) return t('printers.justNow')
    if (diff < 3600) return t('printers.minutesAgo', { count: Math.floor(diff / 60) })
    if (diff < 86400) return t('printers.hoursAgo', { count: Math.floor(diff / 3600) })
    return d.toLocaleDateString()
  }

  return (
    <div className="max-w-2xl space-y-8">
      <h1 className="text-2xl font-bold text-brand-text">{t('printers.title')}</h1>

      {success && <p className="text-green-600 text-sm">{success}</p>}
      {error && <p className="text-red-600 text-sm">{error}</p>}

      {/* Claimed printers */}
      <div className="bg-brand-surface rounded-xl shadow p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-800">{t('printers.yourPrinters')}</h2>
        {printers.length === 0 ? (
          <p className="text-gray-400 text-sm">{t('printers.noPrinters')}</p>
        ) : (
          <div className="space-y-3">
            {printers.map(p => (
              <div key={p.id} className="flex items-center justify-between border rounded-lg px-4 py-3">
                <div>
                  <p className="font-medium text-brand-text">{p.name || t('printers.unnamedPrinter')}</p>
                  <p className="text-xs text-gray-400 font-mono">{p.mac_address}{p.ip_address && ` · ${p.ip_address}`}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{t('printers.lastSeen', { time: formatLastSeen(p.last_seen_at) })}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
                    p.last_seen_at && (Date.now() - new Date(p.last_seen_at)) / 1000 < 120
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-100 text-gray-500'
                  }`}>
                    {p.last_seen_at && (Date.now() - new Date(p.last_seen_at)) / 1000 < 120 ? t('printers.online') : t('printers.offline')}
                  </span>
                  <button
                    onClick={() => handleUnclaim(p.id)}
                    className="text-xs text-red-500 hover:text-red-700"
                  >
                    {t('printers.remove')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Claim a new printer */}
      <form onSubmit={handleClaim} className="bg-brand-surface rounded-xl shadow p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-800">{t('printers.claimTitle')}</h2>
        <p className="text-sm text-gray-500" dangerouslySetInnerHTML={{ __html: t('printers.claimInstructions') }} />

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('printers.claimCode')}</label>
          <input
            value={claimCode}
            onChange={e => setClaimCode(e.target.value.toUpperCase().replace(/[^A-F0-9]/g, ''))}
            maxLength={6}
            placeholder="A1B2C3"
            className="w-full border rounded-lg px-3 py-2 font-mono text-lg tracking-widest uppercase"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('printers.printerName')}</label>
          <input
            value={claimName}
            onChange={e => setClaimName(e.target.value)}
            placeholder={t('printers.printerNamePlaceholder')}
            className="w-full border rounded-lg px-3 py-2"
          />
        </div>

        <button
          type="submit"
          disabled={claiming || claimCode.length !== 6}
          className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white font-medium rounded-lg px-6 py-2"
        >
          {claiming ? t('printers.claiming') : t('printers.claimPrinter')}
        </button>
      </form>
    </div>
  )
}
