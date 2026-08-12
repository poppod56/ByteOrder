import { useState, useEffect, useCallback, useMemo } from 'react'
import api from '../lib/api'
import { formatMoney } from '../lib/money'

const VIEWS = {
  OLDEST: 'oldest',
  NEWEST: 'newest',
  TABLE: 'table',
  BY_ITEM: 'by-item',
}

const VIEW_LABELS = {
  [VIEWS.OLDEST]: 'Oldest first',
  [VIEWS.NEWEST]: 'Newest first',
  [VIEWS.TABLE]: 'By table',
  [VIEWS.BY_ITEM]: 'By dish',
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

const STATUS_LABELS = { pending: 'Pending', in_progress: 'Cooking', ready: 'Ready', completed: 'Done' }
const STATUS_COLOURS = {
  pending: 'bg-yellow-100 text-yellow-800',
  in_progress: 'bg-blue-100 text-blue-800',
  ready: 'bg-green-100 text-green-800',
  completed: 'bg-gray-100 text-gray-600',
}
const NEXT_STATUS = { pending: 'in_progress', in_progress: 'ready', ready: 'completed' }
const NEXT_LABEL = { pending: 'Start Cooking', in_progress: 'Mark Ready', ready: 'Complete' }

export default function OrderQueue() {
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

  if (loading) return <p className="text-gray-500">Loading queue…</p>

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-brand-text">Order Queue</h1>
        <div className="flex items-center gap-3">
          <label htmlFor="queue-view" className="text-sm text-gray-500">Show</label>
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
          <button onClick={fetchQueue} className="text-sm text-brand-600 hover:underline">Refresh</button>
        </div>
      </div>

      {orders.length === 0 && (
        <div className="text-center py-16 text-gray-400">No active orders</div>
      )}

      {/* By dish: a cooking checklist across every open order. Statuses are not
          changed here — one row spans several orders, so advancing from it would
          be ambiguous. That stays on the order cards. */}
      {view === VIEWS.BY_ITEM && orders.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">
            Every open order combined, so one batch covers several tables. Advance
            orders from any other view.
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
                  With: {dish.item.ingredients.filter(i => i.included).map(i => i.ingredient_name).join(', ')}
                </p>
              )}
              {dish.item.ingredients.filter(i => !i.included).length > 0 && (
                <p className="text-sm text-red-500">
                  NO: {dish.item.ingredients.filter(i => !i.included).map(i => i.ingredient_name).join(', ')}
                </p>
              )}

              <div className="flex flex-wrap gap-2 mt-3">
                {dish.forOrders.map(({ order, quantity }) => (
                  <span
                    key={order.id}
                    className="text-xs font-semibold bg-gray-100 text-gray-700 rounded-full px-2.5 py-1"
                  >
                    {order.table_label || 'Takeaway'} · {order.order_number}
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
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Takeaway</p>
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
                      With: {item.ingredients.filter(i => i.included).map(i => i.ingredient_name).join(', ')}
                    </p>
                  )}
                  {item.ingredients.filter(i => !i.included).length > 0 && (
                    <p className="text-red-500">
                      NO: {item.ingredients.filter(i => !i.included).map(i => i.ingredient_name).join(', ')}
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
