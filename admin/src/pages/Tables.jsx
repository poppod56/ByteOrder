import { useState, useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import api from '../lib/api'

export default function Tables() {
  const [tables, setTables] = useState([])
  const [label, setLabel] = useState('')
  const [count, setCount] = useState(1)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [frontendUrl, setFrontendUrl] = useState('')
  const [slug, setSlug] = useState(null)
  const [brandColour, setBrandColour] = useState('#ea580c')
  // Sheet layout. Size is in millimetres so what you see is what gets printed;
  // the QR itself is rendered as SVG and scaled by CSS, so it stays crisp.
  const [qrSizeMm, setQrSizeMm] = useState(50)
  const [perRow, setPerRow] = useState(3)
  const [qrColour, setQrColour] = useState(null)   // null = follow the brand colour
  const [showUrl, setShowUrl] = useState(true)

  useEffect(() => {
    loadTables()

    api.get('/settings/').then(({ data }) => {
      const map = Object.fromEntries(data.map(s => [s.key, s.value || '']))
      setFrontendUrl(map.frontend_url || '')
      if (map.brand_primary) setBrandColour(map.brand_primary)
    }).catch(() => {})

    // 404 in self-hosted mode — there is no slug, customers use /order directly.
    api.get('/menu/kitchens/me')
      .then(({ data }) => setSlug(data.slug))
      .catch(() => setSlug(null))
  }, [])

  async function loadTables() {
    try {
      const { data } = await api.get('/orders/tables/')
      setTables(data)
    } catch {
      setTables([])
    }
  }

  async function handleCreate(e) {
    e.preventDefault()
    setError('')
    setSuccess('')
    setCreating(true)
    try {
      const { data } = await api.post('/orders/tables/', { label: label.trim(), count: Number(count) })
      setSuccess(data.length === 1 ? `Added ${data[0].label}.` : `Added ${data.length} tables.`)
      setLabel('')
      setCount(1)
      loadTables()
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to add tables.')
    } finally {
      setCreating(false)
    }
  }

  async function handleRename(table) {
    const next = prompt('Rename table', table.label)
    if (next === null) return
    if (!next.trim()) return
    try {
      await api.put(`/orders/tables/${table.id}`, { label: next.trim() })
      loadTables()
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to rename table.')
    }
  }

  async function handleRotate(table) {
    const ok = confirm(
      `Generate a new QR code for ${table.label}?\n\n` +
      'The sticker currently on the table stops working straight away — you will need to print and replace it.'
    )
    if (!ok) return
    setError('')
    setSuccess('')
    try {
      await api.post(`/orders/tables/${table.id}/rotate`)
      loadTables()
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to generate a new QR code.')
    }
  }

  // Only printing, deliberately: the dialog can be cancelled and the paper still
  // has to get onto the table, so clearing the reminder is a separate, explicit act.
  function handlePrint() {
    window.print()
  }

  async function handleMarkPrinted() {
    setError('')
    try {
      await api.post('/orders/tables/mark-printed', { ids: unprinted.map(t => t.id) })
      setSuccess('Marked as replaced.')
      loadTables()
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to update those tables.')
    }
  }

  async function handleRemove(table) {
    if (!confirm(`Remove ${table.label}? Its QR code will stop working, but past orders keep their table name.`)) return
    try {
      await api.delete(`/orders/tables/${table.id}`)
      loadTables()
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to remove table.')
    }
  }

  // Customers never load the admin origin, so the QR must point at the public
  // customer site. Guessing from window.location is a fallback only — a wrong
  // base URL silently prints QR codes that lead nowhere useful.
  // The kiosk QR is built the same way in the customer app's Home page.
  const baseUrl = frontendUrl.trim().replace(/\/+$/, '')
    || window.location.origin.replace(/(^https?:\/\/)admin\./, '$1')
  const orderPath = slug ? `/k/${slug}/order` : '/order'
  const tableUrl = code => `${baseUrl}${orderPath}?t=${encodeURIComponent(code)}`

  // Server-side, so the reminder survives a refresh and reaches whoever is
  // actually holding the printer — not just the browser that rotated the code.
  const unprinted = tables.filter(t => !t.code_printed_at)

  const sheetColour = qrColour ?? brandColour

  function downloadQr(table) {
    const svg = document.getElementById(`qr-${table.id}`)?.closest('div')?.querySelector('svg')
    if (!svg) return
    const blob = new Blob(
      ['<?xml version="1.0" encoding="UTF-8"?>\n', new XMLSerializer().serializeToString(svg)],
      { type: 'image/svg+xml' },
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    // Slugified label so a replacement sticker is easy to find on disk later.
    a.download = `qr-${table.label.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}.svg`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-8">
      {/* Print styles: hide the app shell and keep each QR card whole. */}
      <style>{`
        @media print {
          body { background: #fff; }
          .no-print, nav, header, aside { display: none !important; }
          .print-sheet { gap: 10mm; }
          .print-card { break-inside: avoid; page-break-inside: avoid; }
        }
      `}</style>

      <div className="no-print space-y-8 max-w-3xl">
        <h1 className="text-2xl font-bold text-brand-text">Tables</h1>

        {success && <p className="text-green-600 text-sm">{success}</p>}
        {error && <p className="text-red-600 text-sm">{error}</p>}

        {unprinted.length > 0 && (
          <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-4 py-3">
            <p className="mb-2">
              {unprinted.length === 1 ? 'This table has' : `These ${unprinted.length} tables have`} a QR
              code that has not been printed yet:{' '}
              <strong>{unprinted.map(t => t.label).join(', ')}</strong>. Any older sticker no longer works.
            </p>
            <button
              onClick={handleMarkPrinted}
              className="bg-red-600 hover:bg-red-700 text-white font-semibold px-4 py-2 rounded-lg"
            >
              I've replaced the stickers
            </button>
          </div>
        )}

        {!frontendUrl && (
          <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm rounded-lg px-4 py-3">
            No <strong>Frontend URL</strong> set in Settings — QR codes below are guessed from this
            admin address (<span className="font-mono">{baseUrl}</span>). Set it before printing.
          </div>
        )}

        <div className="bg-brand-surface rounded-xl shadow p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-800">Your Tables</h2>
          {tables.length === 0 ? (
            <p className="text-gray-400 text-sm">No tables yet. Add some below, then print the QR sheet and stick one on each table.</p>
          ) : (
            <div className="space-y-3">
              {tables.map(t => (
                <div key={t.id} className="flex items-center justify-between border rounded-lg px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-medium text-brand-text">{t.label}</p>
                    <p className="text-xs text-gray-400 font-mono break-all">{tableUrl(t.code)}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    <button onClick={() => handleRename(t)} className="text-xs text-gray-500 hover:text-gray-800">Rename</button>
                    <button onClick={() => handleRotate(t)} className="text-xs text-gray-500 hover:text-gray-800">New QR</button>
                    <button onClick={() => handleRemove(t)} className="text-xs text-red-500 hover:text-red-700">Remove</button>
                  </div>
                </div>
              ))}
            </div>
          )}

        </div>

        {tables.length > 0 && (
          <div className="bg-brand-surface rounded-xl shadow p-6 space-y-4">
            <h2 className="text-lg font-semibold text-gray-800">QR sheet</h2>
            <p className="text-sm text-gray-500">
              This is exactly what prints. Sizes are in millimetres, so measure one against a table
              before running off the whole set.
            </p>

            <div className="flex flex-wrap gap-6">
              <div>
                <label htmlFor="qr-size" className="block text-sm font-medium text-gray-700 mb-1">
                  Code size — {qrSizeMm} mm
                </label>
                <input
                  id="qr-size"
                  type="range"
                  min={20}
                  max={120}
                  step={5}
                  value={qrSizeMm}
                  onChange={e => setQrSizeMm(Number(e.target.value))}
                  className="w-48"
                />
              </div>

              <div>
                <label htmlFor="qr-per-row" className="block text-sm font-medium text-gray-700 mb-1">Per row</label>
                <select
                  id="qr-per-row"
                  value={perRow}
                  onChange={e => setPerRow(Number(e.target.value))}
                  className="border rounded-lg px-3 py-2"
                >
                  {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>

              <div>
                <label htmlFor="qr-colour" className="block text-sm font-medium text-gray-700 mb-1">Colour</label>
                <div className="flex items-center gap-2">
                  <input
                    id="qr-colour"
                    type="color"
                    value={sheetColour}
                    onChange={e => setQrColour(e.target.value)}
                    className="h-10 w-14 rounded border cursor-pointer p-0.5"
                  />
                  {qrColour && (
                    <button onClick={() => setQrColour(null)} className="text-xs text-gray-400 hover:text-gray-700 underline">
                      Use brand colour
                    </button>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-1">Dark colours scan more reliably</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Show URL</label>
                <label className="inline-flex items-center gap-2 text-sm text-gray-600">
                  <input type="checkbox" checked={showUrl} onChange={e => setShowUrl(e.target.checked)} />
                  under each code
                </label>
              </div>
            </div>

            <button
              onClick={handlePrint}
              className="bg-brand-600 hover:bg-brand-700 text-white font-medium rounded-lg px-6 py-2"
            >
              Print QR sheet
            </button>
          </div>
        )}

        <form onSubmit={handleCreate} className="bg-brand-surface rounded-xl shadow p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-800">Add Tables</h2>
          <p className="text-sm text-gray-500">
            Adding more than one numbers them from the name — “Table” × 4 becomes Table 1 to Table 4.
          </p>

          <div>
            <label htmlFor="table-label" className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              id="table-label"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="Table"
              className="w-full border rounded-lg px-3 py-2"
              required
            />
          </div>

          <div>
            <label htmlFor="table-count" className="block text-sm font-medium text-gray-700 mb-1">How many</label>
            <input
              id="table-count"
              type="number"
              min={1}
              max={200}
              value={count}
              onChange={e => setCount(e.target.value)}
              className="w-32 border rounded-lg px-3 py-2"
            />
          </div>

          <button
            type="submit"
            disabled={creating || !label.trim()}
            className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white font-medium rounded-lg px-6 py-2"
          >
            {creating ? 'Adding…' : 'Add'}
          </button>
        </form>
      </div>

      {/* The sheet itself — on screen it is the preview, on paper it is the output. */}
      {tables.length > 0 && (
        <div
          className="print-sheet grid gap-6 justify-items-center"
          style={{ gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))` }}
        >
          {tables.map(t => (
            <div
              key={t.id}
              className="print-card flex flex-col items-center justify-start p-4 text-center border border-gray-200 rounded-lg bg-white w-full"
            >
              {/* Rendered large and scaled by CSS so millimetre sizing stays sharp. */}
              <div id={`qr-${t.id}`} style={{ width: `${qrSizeMm}mm`, maxWidth: '100%' }}>
                <QRCodeSVG
                  value={tableUrl(t.code)}
                  size={512}
                  fgColor={sheetColour}
                  style={{ width: '100%', height: 'auto', display: 'block' }}
                />
              </div>
              <p className="mt-3 text-lg font-bold">{t.label}</p>
              {showUrl && (
                <p className="text-[10px] text-gray-400 font-mono break-all">{tableUrl(t.code)}</p>
              )}
              <button
                onClick={() => downloadQr(t)}
                className="no-print mt-2 text-xs text-gray-400 hover:text-gray-700 underline"
              >
                Download SVG
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
