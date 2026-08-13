import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { formatMoney } from '../lib/money'

const VIEWS = {
  OLDEST: 'oldest',
  NEWEST: 'newest',
  TABLE: 'table',
  BY_ITEM: 'by-item',
}

/** A line's choices, as the one string that decides whether two lines are the same dish to cook. */
function itemSignature(item) {
  const on = item.ingredients.filter(i => i.included).map(i => i.ingredient_name).sort()
  const off = item.ingredients.filter(i => !i.included).map(i => i.ingredient_name).sort()
  const options = item.options.map(o => `${o.group_name}:${o.option_name}`).sort()
  return [item.menu_item_name, ...options, ...on.map(n => `+${n}`), ...off.map(n => `-${n}`)].join('|')
}

/**
 * Every line across the queue, collapsed onto identical dishes so one batch can
 * be cooked for several tables at once. Ordered by the oldest order each dish
 * appears in, so the longest wait stays at the top.
 */
function groupByDish(orders) {
  const groups = new Map()
  orders.forEach(order => {
    order.items.forEach(item => {
      const key = itemSignature(item)
      if (!groups.has(key)) {
        groups.set(key, { key, item, quantity: 0, forOrders: [], firstSeen: order.created_at })
      }
      const group = groups.get(key)
      group.quantity += item.quantity
      group.forOrders.push({ order, quantity: item.quantity })
      if (order.created_at < group.firstSeen) group.firstSeen = order.created_at
    })
  })
  return [...groups.values()].sort((a, b) => a.firstSeen.localeCompare(b.firstSeen))
}

const STATUS_COLOURS = {
  pending: 'bg-yellow-100 text-yellow-800',
  in_progress: 'bg-blue-100 text-blue-800',
  ready: 'bg-green-100 text-green-800',
  completed: 'bg-gray-100 text-gray-600',
}
const NEXT_STATUS = { pending: 'in_progress', in_progress: 'ready', ready: 'completed' }

export default function OrderQueue() {
  const { t } = useTranslation()
  const VIEW_LABELS = {
    [VIEWS.OLDEST]: t('orderQueue.views.oldest'),
    [VIEWS.NEWEST]: t('orderQueue.views.newest'),
    [VIEWS.TABLE]: t('orderQueue.views.table'),
    [VIEWS.BY_ITEM]: t('orderQueue.views.byItem'),
  }
  const STATUS_LABELS = {
    pending: t('orderQueue.status.pending'),
    in_progress: t('orderQueue.status.in_progress'),
    ready: t('orderQueue.status.ready'),
    completed: t('orderQueue.status.completed'),
  }
  const NEXT_LABEL = {
    pending: t('orderQueue.nextLabel.pending'),
    in_progress: t('orderQueue.nextLabel.in_progress'),
    ready: t('orderQueue.nextLabel.ready'),
  }
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState(VIEWS.OLDEST)
  const [currency, setCurrency] = useState('THB')

  const fetchQueue = useCallback(async () => {
    try {
      const { data } = await api.get('/orders/queue')
      setOrders(data)
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
    fetchQueue()
    const interval = setInterval(fetchQueue, 10000)

    const token = localStorage.getItem('token')
    const es = token
      ? new EventSource(`/api/orders/queue/stream?token=${encodeURIComponent(token)}`)
      : null
    if (es) {
      es.onmessage = () => fetchQueue()
      es.onerror = () => {}   // polling handles reconnection
    }

    return () => { clearInterval(interval); es?.close() }
  }, [fetchQueue])

  async function advance(order) {
    const next = NEXT_STATUS[order.status]
    if (!next) return
    await api.put(`/orders/${order.id}/status`, { status: next })
    fetchQueue()
  }

  // The API already returns oldest first; the rest are re-orderings of that.
  const sorted = useMemo(() => {
    if (view === VIEWS.NEWEST) return [...orders].reverse()
    if (view === VIEWS.TABLE) {
      // Takeaway last, so a serving run reads down the tables in order.
      return [...orders].sort((a, b) =>
        (a.table_label || '￿').localeCompare(b.table_label || '￿', undefined, { numeric: true })
        || a.created_at.localeCompare(b.created_at))
    }
    return orders
  }, [orders, view])

  const dishes = useMemo(
    () => (view === VIEWS.BY_ITEM ? groupByDish(orders) : []),
    [orders, view],
  )

  if (loading) return <p className="text-gray-500">{t('orderQueue.loading')}</p>

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-brand-text">{t('orderQueue.title')}</h1>
        <div className="flex items-center gap-3">
          <label htmlFor="queue-view" className="text-sm text-gray-500">{t('orderQueue.show')}</label>
          <select
            id="queue-view"
            value={view}
            onChange={e => setView(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm"
          >
            {Object.entries(VIEW_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <button onClick={fetchQueue} className="text-sm text-brand-600 hover:underline">{t('orderQueue.refresh')}</button>
        </div>
      </div>

      {orders.length === 0 && (
        <div className="text-center py-16 text-gray-400">{t('orderQueue.noActiveOrders')}</div>
      )}

      {/* By dish: a cooking checklist across every open order. Statuses are not
          changed here — one row spans several orders, so advancing from it would
          be ambiguous. That stays on the order cards. */}
      {view === VIEWS.BY_ITEM && orders.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">
            {t('orderQueue.byItemNote')}
          </p>
          {dishes.map(dish => (
            <div key={dish.key} className="bg-brand-surface rounded-xl shadow p-4">
              <div className="flex items-baseline gap-3">
                <span className="text-2xl font-extrabold text-brand-600">{dish.quantity}×</span>
                <span className="text-lg font-bold text-brand-text">{dish.item.menu_item_name}</span>
              </div>

              {dish.item.options.length > 0 && (
                <p className="text-sm text-gray-600 mt-1">
                  {dish.item.options.map(o => `${o.group_name}: ${o.option_name}`).join(' · ')}
                </p>
              )}
              {dish.item.ingredients.filter(i => i.included).length > 0 && (
                <p className="text-sm text-gray-500">
                  {t('common.withPrefix')}: {dish.item.ingredients.filter(i => i.included).map(i => i.ingredient_name).join(', ')}
                </p>
              )}
              {dish.item.ingredients.filter(i => !i.included).length > 0 && (
                <p className="text-sm text-red-500">
                  {t('common.noPrefix')}: {dish.item.ingredients.filter(i => !i.included).map(i => i.ingredient_name).join(', ')}
                </p>
              )}

              <div className="flex flex-wrap gap-2 mt-3">
                {dish.forOrders.map(({ order, quantity }) => (
                  <span
                    key={order.id}
                    className="text-xs font-semibold bg-gray-100 text-gray-700 rounded-full px-2.5 py-1"
                  >
                    {order.table_label || t('common.takeaway')} · {order.order_number}
                    {quantity > 1 && ` ×${quantity}`}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {view !== VIEWS.BY_ITEM && (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map(order => (
          <div key={order.id} className="bg-brand-surface rounded-xl shadow p-4 flex flex-col gap-3">
            <div className="flex items-start justify-between">
              <div>
                {order.table_label ? (
                  <p className="font-bold text-2xl text-brand-text leading-tight">{order.table_label}</p>
                ) : (
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">{t('common.takeaway')}</p>
                )}
                <p className="font-bold text-lg text-brand-text">{order.order_number}</p>
                <p className="text-gray-600">{order.customer_name}</p>
              </div>
              <div className="text-right shrink-0">
                <span className={`text-xs font-semibold px-2 py-1 rounded-full ${STATUS_COLOURS[order.status]}`}>
                  {STATUS_LABELS[order.status]}
                </span>
                {order.total !== null && order.total !== undefined && (
                  <p className="font-semibold text-brand-text mt-1">{formatMoney(order.total, currency)}</p>
                )}
              </div>
            </div>

            <div className="divide-y divide-gray-100 text-sm">
              {order.items.map(item => (
                <div key={item.id} className="py-2">
                  <p className="font-medium text-gray-800">
                    {item.quantity > 1 && <span className="text-brand-600 font-bold">{item.quantity}× </span>}
                    {item.menu_item_name}
                  </p>
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

            {NEXT_STATUS[order.status] && (
              <button
                onClick={() => advance(order)}
                className="mt-auto w-full bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold py-2 rounded-lg transition-colors"
              >
                {NEXT_LABEL[order.status]}
              </button>
            )}
          </div>
        ))}
      </div>
      )}
    </div>
  )
}
