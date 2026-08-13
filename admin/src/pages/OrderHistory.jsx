import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { formatMoney } from '../lib/money'

function todayStr() {
  const d = new Date()
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-')
}

export default function OrderHistory() {
  const { t } = useTranslation()
  const [orders, setOrders] = useState([])
  const [takings, setTakings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [currency, setCurrency] = useState('THB')
  const [date, setDate] = useState(todayStr())

  async function fetchHistory(d) {
    setLoading(true)
    try {
      const { data } = await api.get('/orders/history', { params: { date: d } })
      setOrders(data)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  async function fetchTakings(d) {
    try {
      // The till counts its day in its own timezone, not UTC — an evening's
      // takings must not be filed under two dates.
      const { data } = await api.get('/orders/takings', {
        params: { date: d, tz_offset: -new Date().getTimezoneOffset() },
      })
      setTakings(data)
    } catch (err) {
      console.error(err)
      setTakings(null)
    }
  }

  useEffect(() => {
    api.get('/settings/currency')
      .then(({ data }) => { if (data.value) setCurrency(data.value) })
      .catch(() => {})
  }, [])

  useEffect(() => { fetchHistory(date); fetchTakings(date) }, [date])

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-brand-text">{t('orderHistory.title')}</h1>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="border rounded px-3 py-1.5 text-sm"
        />
      </div>

      {takings && (
        <section className="bg-brand-surface rounded-xl shadow p-4 mb-6">
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <h2 className="font-semibold text-brand-text">{t('orderHistory.takings')}</h2>
            <p className="text-2xl font-extrabold text-brand-text">
              {takings.total === null ? '—' : formatMoney(takings.total, currency)}
            </p>
          </div>
          <p className="text-sm text-gray-500">
            {t('orderHistory.billCount', { count: takings.bill_count })}
          </p>

          {takings.by_method.length > 0 && (
            <dl className="mt-3 divide-y divide-gray-100 text-sm">
              {takings.by_method.map(row => (
                <div key={row.method || 'unrecorded'} className="flex justify-between py-1.5">
                  <dt className="text-gray-700">
                    {row.method ? t(`cashier.method.${row.method}`) : t('orderHistory.methodUnrecorded')}
                    <span className="text-gray-400"> · {t('orderHistory.billCount', { count: row.bill_count })}</span>
                  </dt>
                  <dd className="font-semibold text-brand-text">
                    {row.total === null ? '—' : formatMoney(row.total, currency)}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {takings.unpaid_order_count > 0 && (
            <p className="mt-3 text-sm text-yellow-800 bg-yellow-50 rounded-lg px-3 py-2">
              {t('orderHistory.stillUnpaid', {
                count: takings.unpaid_order_count,
                amount: takings.unpaid_total === null ? '—' : formatMoney(takings.unpaid_total, currency),
              })}
            </p>
          )}
        </section>
      )}

      {loading && <p className="text-gray-500">{t('orderHistory.loading')}</p>}

      {!loading && orders.length === 0 && (
        <div className="text-center py-16 text-gray-400">{t('orderHistory.empty')}</div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {orders.map(order => (
          <div key={order.id} className="bg-brand-surface rounded-xl shadow p-4 flex flex-col gap-3">
            <div className="flex items-start justify-between">
              <div>
                {order.table_label ? (
                  <p className="font-bold text-xl text-brand-text leading-tight">{order.table_label}</p>
                ) : (
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">{t('common.takeaway')}</p>
                )}
                <p className="font-bold text-lg text-brand-text">{order.order_number}</p>
                <p className="text-gray-600">{order.customer_name}</p>
              </div>
              <span className="text-xs text-gray-400">
                {new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>

            <div className="divide-y divide-gray-100 text-sm">
              {order.items.map(item => (
                <div key={item.id} className="py-2">
                  <p className="font-medium text-gray-800">{item.menu_item_name}</p>
                  {item.ingredients.filter(i => i.included).length > 0 && (
                    <p className="text-gray-500">
                      {t('common.withPrefix')}: {item.ingredients.filter(i => i.included).map(i => i.ingredient_name).join(', ')}
                    </p>
                  )}
                  {item.ingredients.filter(i => !i.included).length > 0 && (
                    <p className="text-red-500">
                      {t('common.noPrefix')}: {item.ingredients.filter(i => !i.included).map(i => i.ingredient_name).join(', ')}
                    </p>
                  )}
                  {item.options.length > 0 && (
                    <p className="text-gray-500">
                      {item.options.map(o => `${o.group_name}: ${o.option_name}`).join(' · ')}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
