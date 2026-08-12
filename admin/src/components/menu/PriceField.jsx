import { useEffect, useState } from 'react'
import { parseMoney, toMoneyInput } from '../../lib/money'

/**
 * Price entered in major units and stored in minor ones. Saving is explicit — a
 * price that autosaved while being typed would briefly persist "1" on the way to
 * "120".
 *
 * Blank is a real value: it means the item has no price and stays off the bill.
 */
export default function PriceField({ label = 'Price', value, currency, onSave, hint }) {
  const [text, setText] = useState(toMoneyInput(value))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { setText(toMoneyInput(value)) }, [value])

  const trimmed = text.trim()
  const parsed = parseMoney(trimmed)
  const invalid = trimmed !== '' && parsed === null
  const dirty = trimmed !== toMoneyInput(value).trim()

  async function save() {
    if (invalid) return
    setError('')
    setSaving(true)
    try {
      await onSave(parsed)
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not save that price.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 mb-1">
        {label} <span className="font-normal text-gray-400">({currency})</span>
      </label>
      <div className="flex items-center gap-2">
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && dirty && save()}
          inputMode="decimal"
          placeholder="—"
          aria-label={label}
          className={`w-24 border rounded px-2 py-1 text-sm text-right ${invalid ? 'border-red-400' : ''}`}
        />
        <button
          onClick={save}
          disabled={!dirty || invalid || saving}
          className="text-xs font-semibold text-brand-600 disabled:text-gray-300"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {invalid && <p className="text-xs text-red-600 mt-1">Enter an amount like 120 or 120.50</p>}
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      {hint && !invalid && !error && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  )
}
