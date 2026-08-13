import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { formatMoney } from '../lib/money'

/** "19:04", in the browser's own timezone. Timestamps come back naive UTC. */
function clockTime(iso) {
  const date = new Date(`${iso}${iso.endsWith('Z') ? '' : 'Z'}`)
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

// Must stay in step with PAYMENT_METHODS in order-service: the till is counted
// by method, so anything the server will not store must not be offered here.
const PAYMENT_METHODS = ['cash', 'transfer', 'card', 'other']

/** Identifies one open bill: a table has an id, a takeaway bill is its order. */
function billKey(bill) {
  return bill.kind === 'takeaway' ? `takeaway-${bill.orders[0].id}` : `table-${bill.table_id}`
}

function lineDescription(item, noPrefix) {
  const bits = [
    ...item.options.map(o => `${o.group_name}: ${o.option_name}`),
    ...item.ingredients.filter(i => !i.included).map(i => `${noPrefix} ${i.ingredient_name}`),
    ...item.ingredients.filter(i => i.included).map(i => i.ingredient_name),
  ]
  return bits.join(' · ')
}

export default function Cashier() {
  const { t } = useTranslation()
  const [tables, setTables] = useState([])
  const [loading, setLoading] = useState(true)
  const [currency, setCurrency] = useState('THB')
  const [expanded, setExpanded] = useState(null)
  // The table being paid for, frozen at the moment the cashier pressed the
  // button: the confirmation has to be about the orders they actually read out.
  const [confirming, setConfirming] = useState(null)
  const [settling, setSettling] = useState(false)
  const [notice, setNotice] = useState(null)
  // Cash is what most tables pay with, so it is preselected — but it is a real
  // answer that gets recorded, not a silent default: the till is counted by it.
  const [method, setMethod] = useState('cash')

  const fetchOpen = useCallback(async () => {
    try {
      const { data } = await api.get('/orders/cashier/open')
      setTables(data)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    api.get('/settings/currency')
      .then(({ data }) => { if (data.value) setCurrency(data.value) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetchOpen()
    const interval = setInterval(fetchOpen, 10000)

    // Same channel the kitchen queue listens on, so a dish ordered at the table
    // appears on the till before the cashier has finished reading the bill out.
    const token = localStorage.getItem('token')
    const es = token
      ? new EventSource(`/api/orders/queue/stream?token=${encodeURIComponent(token)}`)
      : null
    if (es) {
      es.onmessage = () => fetchOpen()
      es.onerror = () => {}   // polling handles reconnection
    }

    return () => { clearInterval(interval); es?.close() }
  }, [fetchOpen])

  async function confirmPayment() {
    setSettling(true)
    setNotice(null)
    try {
      // Only the orders on the confirmation screen. One placed since then comes
      // back as outstanding rather than being marked paid for free.
      const { data } = await api.post('/orders/cashier/settle', {
        order_ids: confirming.orders.map(o => o.id),
        payment_method: method,
      })
      setConfirming(null)
      setNotice(data.outstanding.length > 0
        ? {
            tone: 'warn',
            text: t('cashier.settledWithOutstanding', { table: confirming.label, count: data.outstanding.length }),
          }
        : { tone: 'ok', text: t('cashier.settledOk', { table: confirming.label }) })
    } catch (err) {
      setConfirming(null)
      setNotice(err.response?.data?.detail?.code === 'already_settled'
        ? { tone: 'warn', text: t('cashier.alreadySettled') }
        : { tone: 'warn', text: t('cashier.settleFailed') })
    } finally {
      setSettling(false)
      fetchOpen()
    }
  }

  if (loading) return <p className="text-gray-500">{t('cashier.loading')}</p>

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-brand-text">{t('cashier.title')}</h1>
        <button onClick={fetchOpen} className="text-sm text-brand-600 hover:underline">{t('cashier.refresh')}</button>
      </div>

      {notice && (
        <div
          role="status"
          className={`mb-4 rounded-lg px-4 py-3 text-sm ${
            notice.tone === 'ok' ? 'bg-green-50 text-green-800' : 'bg-yellow-50 text-yellow-800'
          }`}
        >
          {notice.text}
        </div>
      )}

      {tables.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          {t('cashier.noUnpaidTables')}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tables.map(table => (
          <div key={`${table.kind}-${table.table_id ?? table.orders[0].id}`} className="bg-brand-surface rounded-xl shadow p-4 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                {table.kind === 'takeaway' && (
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                    {t('common.takeaway')}
                  </p>
                )}
                <p className="font-bold text-2xl text-brand-text leading-tight">{table.label}</p>
                <p className="text-sm text-gray-500">
                  {t('cashier.orderCount', { count: table.order_count })} · {t('cashier.fromTime', { time: clockTime(table.opened_at) })}
                </p>
              </div>
              <p className="font-bold text-xl text-brand-text shrink-0">
                {table.total === null ? '—' : formatMoney(table.total, currency)}
              </p>
            </div>

            {table.unserved_count > 0 && (
              <p className="text-sm text-yellow-700 bg-yellow-50 rounded-lg px-3 py-2">
                {t('cashier.unservedNote', { count: table.unserved_count })}
              </p>
            )}
            {table.stale && (
              <p className="text-sm text-gray-600 bg-gray-100 rounded-lg px-3 py-2">
                {t('cashier.staleNote')}
              </p>
            )}
            {table.kind === 'table' && !table.active && (
              <p className="text-sm text-gray-600 bg-gray-100 rounded-lg px-3 py-2">
                {t('cashier.removedNote')}
              </p>
            )}

            <button
              onClick={() => setExpanded(expanded === billKey(table) ? null : billKey(table))}
              className="text-sm text-brand-600 hover:underline text-left"
            >
              {expanded === billKey(table) ? t('cashier.hideItems') : t('cashier.checkItems')}
            </button>

            {expanded === billKey(table) && (
              <div className="divide-y divide-gray-100 text-sm">
                {table.orders.map(order => (
                  <div key={order.id} className="py-2">
                    <div className="flex justify-between text-xs text-gray-500 mb-1">
                      <span>{order.order_number} · {clockTime(order.created_at)}</span>
                      <span>{t(`orderQueue.status.${order.status}`)}</span>
                    </div>
                    {order.items.map(item => (
                      <div key={item.id} className="flex justify-between gap-2">
                        <span className="text-brand-text">
                          {item.quantity}× {item.menu_item_name}
                          {lineDescription(item, t('cashier.noInline')) && (
                            <span className="block text-xs text-gray-500">{lineDescription(item, t('cashier.noInline'))}</span>
                          )}
                        </span>
                        {item.unit_price !== null && item.unit_price !== undefined && (
                          <span className="text-gray-600 shrink-0">
                            {formatMoney(item.unit_price * item.quantity, currency)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={() => { setMethod('cash'); setConfirming(table) }}
              className="mt-auto w-full bg-brand-600 text-white font-semibold rounded-lg py-2.5 hover:opacity-90"
            >
              {t('cashier.confirmPayment')}
            </button>
          </div>
        ))}
      </div>

      {confirming && (
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5" role="dialog" aria-modal="true">
            <h2 className="text-xl font-bold text-brand-text">
              {t('cashier.takePaymentFor', { table: confirming.label })}
            </h2>
            <p className="text-3xl font-extrabold text-brand-text my-3">
              {confirming.total === null ? '—' : formatMoney(confirming.total, currency)}
            </p>
            <p className="text-sm text-gray-600">
              {t('cashier.settleNote', { count: confirming.order_count })}
            </p>
            {confirming.unserved_count > 0 && (
              <p className="text-sm text-yellow-800 bg-yellow-50 rounded-lg px-3 py-2 mt-3">
                {t('cashier.unservedWarning', { count: confirming.unserved_count })}
              </p>
            )}

            <fieldset className="mt-4">
              <legend className="text-sm font-semibold text-brand-text mb-2">
                {t('cashier.paidBy')}
              </legend>
              <div className="grid grid-cols-2 gap-2">
                {PAYMENT_METHODS.map(value => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={method === value}
                    onClick={() => setMethod(value)}
                    className={`rounded-lg py-2 text-sm font-semibold border ${
                      method === value
                        ? 'border-brand-600 bg-brand-600 text-white'
                        : 'border-gray-300 text-gray-700'
                    }`}
                  >
                    {t(`cashier.method.${value}`)}
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="flex gap-3 mt-5">
              <button
                onClick={() => setConfirming(null)}
                className="flex-1 border rounded-lg py-2.5 font-semibold text-gray-700"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={confirmPayment}
                disabled={settling}
                className="flex-1 bg-brand-600 text-white rounded-lg py-2.5 font-semibold disabled:opacity-60"
              >
                {settling ? t('cashier.settling') : t('cashier.confirmPaid')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
