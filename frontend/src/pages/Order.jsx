import { useState, useEffect, useMemo, useRef } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { menuApi, orderApi } from '../lib/api'
import { useKitchen } from '../contexts/KitchenContext'
import { formatMoney, lineTotalOf, unitPriceOf, cartTotalOf } from '../lib/money'
import ItemSheet from '../components/order/ItemSheet'

const VIEWS = { MENU: 'menu', CART: 'cart', ORDERS: 'orders' }

// Takeaway orders have no table to look them up by, so their ids are remembered
// here. Session-scoped: a shared kiosk phone must not show the last customer's
// orders to the next one.
const TAKEAWAY_KEY = 'byteorder.myOrders'

function rememberTakeawayOrder(publicId) {
  try {
    const kept = JSON.parse(sessionStorage.getItem(TAKEAWAY_KEY) || '[]')
    sessionStorage.setItem(TAKEAWAY_KEY, JSON.stringify([publicId, ...kept].slice(0, 20)))
  } catch { /* private browsing — the list is a convenience, not the record */ }
}

function rememberedTakeawayOrders() {
  try {
    return JSON.parse(sessionStorage.getItem(TAKEAWAY_KEY) || '[]')
  } catch {
    return []
  }
}

/** Two lines merge only if the dish and every choice on it match. */
function lineKey(line) {
  const toppings = line.ingredients.filter(i => i.included).map(i => i.ingredient_id).sort().join(',')
  const options = line.options.map(o => o.option_id).sort().join(',')
  return `${line.menu_item_id}|${toppings}|${options}`
}

const STATUS_LABELS = {
  pending: 'In the queue',
  in_progress: 'Being prepared',
  ready: 'Ready',
  completed: 'Done',
}
const STATUS_STYLES = {
  pending: 'bg-yellow-100 text-yellow-800',
  in_progress: 'bg-blue-100 text-blue-800',
  ready: 'bg-green-100 text-green-800',
  completed: 'bg-gray-100 text-gray-600',
}

export default function Order() {
  const { kitchenId, slug } = useKitchen()
  const [searchParams] = useSearchParams()
  const tableCode = searchParams.get('t')

  const [table, setTable] = useState(null)
  const [tableError, setTableError] = useState(false)
  const [tableRotated, setTableRotated] = useState(false)
  const [resolvingTable, setResolvingTable] = useState(Boolean(tableCode))

  const [categories, setCategories] = useState([])
  const [kitchenName, setKitchenName] = useState('ByteOrder')
  const [currency, setCurrency] = useState('THB')

  const [view, setView] = useState(VIEWS.MENU)
  const [sheetItem, setSheetItem] = useState(null)
  const [cart, setCart] = useState([])
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const [myOrders, setMyOrders] = useState([])
  const [activeCategory, setActiveCategory] = useState(null)
  const sectionRefs = useRef({})
  const esRef = useRef(null)

  const basePath = slug ? `/k/${slug}` : ''

  // ── Load menu, branding, currency ──────────────────────────────────────────
  useEffect(() => {
    menuApi.get('/categories/').then(({ data }) => setCategories(data)).catch(() => setCategories([]))
    menuApi.get('/settings/kitchen_name').then(({ data }) => {
      if (data.value) setKitchenName(data.value)
    }).catch(() => {})
    menuApi.get('/settings/currency').then(({ data }) => {
      if (data.value) setCurrency(data.value)
    }).catch(() => {})
  }, [])

  // ── Resolve ?t= to a table ─────────────────────────────────────────────────
  // An unrecognised code degrades to a takeaway order rather than dead-ending the
  // customer; the API would reject an order carrying it anyway.
  useEffect(() => {
    if (!tableCode) return
    let cancelled = false
    orderApi.get(`/orders/tables/by-code/${encodeURIComponent(tableCode)}`)
      .then(({ data }) => {
        if (cancelled) return
        setTable(data)
        setResolvingTable(false)
      })
      .catch(() => {
        if (cancelled) return
        setTableError(true)
        setResolvingTable(false)
      })
    return () => { cancelled = true }
  }, [tableCode])

  // ── "Already ordered" list ────────────────────────────────────────────────
  async function loadMyOrders() {
    if (table) {
      try {
        const { data } = await orderApi.get(`/orders/by-table/${encodeURIComponent(table.code)}`)
        setMyOrders(data)
      } catch {
        setMyOrders([])
      }
      return
    }
    const ids = rememberedTakeawayOrders()
    const found = await Promise.all(ids.map(id =>
      orderApi.get(`/orders/track/${id}`).then(r => r.data).catch(() => null)
    ))
    // Guard the shape as well as the failure: one unexpected response should not
    // blank the whole page while someone is mid-meal.
    setMyOrders(found.filter(o => o && o.public_id && Array.isArray(o.items)))
  }

  useEffect(() => {
    if (!kitchenId) return
    loadMyOrders()
    // The kitchen's queue channel fires on every status change, so the list can
    // follow along without polling.
    const es = new EventSource(
      `/orders-api/orders/queue/stream?kitchen_id=${encodeURIComponent(kitchenId)}`
    )
    esRef.current = es
    es.onmessage = () => loadMyOrders()
    return () => es.close()
  }, [kitchenId, table])

  // ── Category tabs follow the scroll ───────────────────────────────────────
  useEffect(() => {
    if (view !== VIEWS.MENU || categories.length === 0) return
    if (typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      entries => {
        const visible = entries.filter(e => e.isIntersecting)
        if (visible.length > 0) setActiveCategory(Number(visible[0].target.dataset.categoryId))
      },
      // Band just under the sticky tabs, so the highlighted tab is the section
      // actually being read rather than one scrolled past.
      { rootMargin: '-96px 0px -70% 0px' },
    )
    Object.values(sectionRefs.current).forEach(el => el && observer.observe(el))
    return () => observer.disconnect()
  }, [view, categories])

  const visibleCategories = useMemo(
    () => categories.filter(c => (c.items || []).length > 0),
    [categories],
  )

  const cartCount = cart.reduce((sum, line) => sum + line.quantity, 0)
  const cartTotal = cartTotalOf(cart)
  const activeOrderCount = myOrders.filter(o => o.status !== 'completed').length

  const imageUrl = item => item.has_image
    ? `/api/items/${item.id}/image?kitchen_id=${encodeURIComponent(kitchenId)}`
    : null

  function addToCart(line) {
    setCart(prev => {
      const key = lineKey(line)
      const existing = prev.findIndex(l => lineKey(l) === key)
      if (existing === -1) return [...prev, line]
      const merged = [...prev]
      // Capped to match the server's own bound on quantity.
      merged[existing] = {
        ...merged[existing],
        quantity: Math.min(99, merged[existing].quantity + line.quantity),
      }
      return merged
    })
    setSheetItem(null)
  }

  function setLineQuantity(index, quantity) {
    setCart(prev => quantity <= 0
      ? prev.filter((_, i) => i !== index)
      : prev.map((line, i) => (i === index ? { ...line, quantity: Math.min(99, quantity) } : line)))
  }

  function scrollToCategory(categoryId) {
    setActiveCategory(categoryId)
    sectionRefs.current[categoryId]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  async function placeOrder() {
    if (cart.length === 0) return
    setSubmitting(true)
    try {
      const { data } = await orderApi.post('/orders/', {
        customer_name: name,
        items: cart.map(line => ({
          menu_item_id: line.menu_item_id,
          menu_item_name: line.menu_item_name,
          quantity: line.quantity,
          ingredients: line.ingredients,
          options: line.options,
        })),
        ...(table ? { table_code: table.code } : {}),
      })
      if (!table) rememberTakeawayOrder(data.public_id)
      setCart([])
      setView(VIEWS.ORDERS)
      loadMyOrders()
    } catch (err) {
      // The table's QR was rotated while this cart was being built. Retrying can
      // never succeed, so say so and offer a way out that keeps the cart.
      if (err.response?.data?.detail?.code === 'unknown_table') {
        setTableRotated(true)
      } else {
        alert('Failed to place order. Please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  function continueAsTakeaway() {
    setTable(null)
    setTableRotated(false)
  }

  if (resolvingTable) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-bg">
        <div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const needsName = !table && !name.trim()

  return (
    <div className="min-h-screen bg-brand-bg pb-24">
      <header className="sticky top-0 z-30 bg-brand-600 text-white px-4 py-3 flex items-center gap-3">
        <h1 className="text-lg font-bold truncate">{kitchenName}</h1>
        {table && (
          <span className="bg-white/20 text-sm font-semibold px-2.5 py-1 rounded-lg whitespace-nowrap">
            {table.label}
          </span>
        )}
      </header>

      {view === VIEWS.MENU && visibleCategories.length > 0 && (
        <nav aria-label="Menu categories" className="sticky top-13 z-20 bg-brand-surface border-b border-gray-100 overflow-x-auto">
          <div className="flex gap-1 px-2">
            {visibleCategories.map(category => (
              <button
                key={category.id}
                onClick={() => scrollToCategory(category.id)}
                className={`px-4 py-3 text-sm font-semibold whitespace-nowrap border-b-2 ${
                  activeCategory === category.id
                    ? 'border-brand-600 text-brand-600'
                    : 'border-transparent text-gray-500'
                }`}
              >
                {category.name}
              </button>
            ))}
          </div>
        </nav>
      )}

      <div className="max-w-lg mx-auto px-4 py-4">
        {tableError && (
          <p className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm rounded-xl px-4 py-3 mb-4">
            We couldn't recognise that table code — please order as a takeaway, or ask a member of staff.
          </p>
        )}

        {tableRotated && (
          <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-xl px-4 py-3 mb-4">
            <p className="font-semibold mb-1">This table has a new QR code</p>
            <p className="mb-3">
              Scan the sticker on your table again to order for {table?.label || 'your table'}. Or keep
              this order and collect it yourself.
            </p>
            <button
              onClick={continueAsTakeaway}
              className="bg-red-600 hover:bg-red-700 text-white font-semibold px-4 py-2 rounded-lg"
            >
              Keep my order as a takeaway
            </button>
          </div>
        )}

        {/* ── Menu ─────────────────────────────────────────────────────────── */}
        {view === VIEWS.MENU && (
          visibleCategories.length === 0 ? (
            <p className="text-gray-400 text-center py-16">The menu is empty right now.</p>
          ) : (
            visibleCategories.map(category => (
              <section
                key={category.id}
                data-category-id={category.id}
                ref={el => { sectionRefs.current[category.id] = el }}
                className="mb-8 scroll-mt-28"
              >
                <h2 className="text-xl font-bold text-brand-text mb-1">{category.name}</h2>
                {category.description && (
                  <p className="text-sm text-gray-500 mb-3">{category.description}</p>
                )}
                <div className="space-y-3">
                  {category.items.map(item => (
                    <button
                      key={item.id}
                      onClick={() => setSheetItem(item)}
                      className="w-full bg-brand-surface rounded-2xl shadow-sm px-4 py-3 flex items-center gap-3 text-left"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-bold text-brand-text">{item.name}</p>
                        {item.description && (
                          <p className="text-sm text-gray-500 line-clamp-2">{item.description}</p>
                        )}
                        {item.price !== null && item.price !== undefined && (
                          <p className="text-brand-600 font-semibold mt-1">
                            {formatMoney(item.price, currency)}
                          </p>
                        )}
                      </div>
                      {imageUrl(item) && (
                        <img
                          src={imageUrl(item)}
                          alt=""
                          className="w-20 h-20 rounded-xl object-cover shrink-0"
                        />
                      )}
                    </button>
                  ))}
                </div>
              </section>
            ))
          )
        )}

        {/* ── Cart ─────────────────────────────────────────────────────────── */}
        {view === VIEWS.CART && (
          <div>
            <h2 className="text-xl font-bold text-brand-text mb-4">Your cart</h2>
            {cart.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-gray-400 mb-4">Nothing in the cart yet.</p>
                <button onClick={() => setView(VIEWS.MENU)} className="text-brand-600 font-semibold underline">
                  Browse the menu
                </button>
              </div>
            ) : (
              <>
                <div className="space-y-3 mb-6">
                  {cart.map((line, index) => (
                    <div key={lineKey(line) + index} className="bg-brand-surface rounded-2xl shadow-sm px-4 py-3">
                      <div className="flex justify-between gap-3">
                        <p className="font-bold text-brand-text">{line.menu_item_name}</p>
                        {lineTotalOf(line) !== null && (
                          <p className="font-semibold text-brand-text whitespace-nowrap">
                            {formatMoney(lineTotalOf(line), currency)}
                          </p>
                        )}
                      </div>
                      {line.options.length > 0 && (
                        <p className="text-sm text-brand-600">
                          {line.options.map(o => `${o.group_name}: ${o.option_name}`).join(' · ')}
                        </p>
                      )}
                      {line.ingredients.filter(i => i.included).length > 0 && (
                        <p className="text-sm text-gray-500">
                          {line.ingredients.filter(i => i.included).map(i => i.ingredient_name).join(', ')}
                        </p>
                      )}
                      {line.ingredients.filter(i => !i.included).length > 0 && (
                        <p className="text-sm text-red-400">
                          No {line.ingredients.filter(i => !i.included).map(i => i.ingredient_name).join(', ')}
                        </p>
                      )}

                      <div className="flex items-center justify-between mt-2">
                        <div className="flex items-center gap-3">
                          <button
                            aria-label={`Fewer ${line.menu_item_name}`}
                            onClick={() => setLineQuantity(index, line.quantity - 1)}
                            className="w-9 h-9 rounded-full border-2 border-gray-200 font-bold text-gray-600"
                          >
                            −
                          </button>
                          <span className="font-bold w-6 text-center">{line.quantity}</span>
                          <button
                            aria-label={`More ${line.menu_item_name}`}
                            onClick={() => setLineQuantity(index, line.quantity + 1)}
                            className="w-9 h-9 rounded-full border-2 border-brand-600 font-bold text-brand-600"
                          >
                            +
                          </button>
                        </div>
                        {unitPriceOf(line) !== null && line.quantity > 1 && (
                          <p className="text-xs text-gray-400">
                            {formatMoney(unitPriceOf(line), currency)} each
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {cartTotal !== null && (
                  <div className="flex justify-between items-baseline mb-6 px-1">
                    <span className="text-lg font-bold text-brand-text">Total</span>
                    <span className="text-2xl font-extrabold text-brand-text">
                      {formatMoney(cartTotal, currency)}
                    </span>
                  </div>
                )}

                {/* Asked at checkout rather than as a gate on the menu — and only
                    when there is no table, since the table is the identity. */}
                {!table && (
                  <div className="mb-4">
                    <label htmlFor="customer-name" className="block text-sm font-medium text-gray-700 mb-1">
                      Your name
                    </label>
                    <input
                      id="customer-name"
                      value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder="So we can call you when it's ready"
                      className="w-full border-2 border-gray-200 focus:border-brand-500 rounded-xl px-4 py-3 outline-none"
                    />
                  </div>
                )}

                <button
                  onClick={placeOrder}
                  disabled={submitting || needsName}
                  className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white font-bold py-3.5 rounded-xl text-lg"
                >
                  {submitting ? 'Placing…' : 'Place order'}
                </button>
              </>
            )}
          </div>
        )}

        {/* ── Orders placed ────────────────────────────────────────────────── */}
        {view === VIEWS.ORDERS && (
          <div>
            <h2 className="text-xl font-bold text-brand-text mb-1">
              {table ? `Orders for ${table.label}` : 'Your orders'}
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              {table
                ? 'Everything ordered at this table today.'
                : 'Orders placed on this device.'}
            </p>

            {myOrders.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-gray-400 mb-4">Nothing ordered yet.</p>
                <button onClick={() => setView(VIEWS.MENU)} className="text-brand-600 font-semibold underline">
                  Browse the menu
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {myOrders.map(order => (
                  <Link
                    key={order.public_id}
                    to={`${basePath}/track/${order.public_id}${tableCode ? `?t=${encodeURIComponent(tableCode)}` : ''}`}
                    className="block bg-brand-surface rounded-2xl shadow-sm px-4 py-3"
                  >
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <span className="font-bold text-brand-text">{order.order_number}</span>
                      <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${STATUS_STYLES[order.status] || ''}`}>
                        {STATUS_LABELS[order.status] || order.status}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500">
                      {order.items.map(i => `${i.quantity}x ${i.menu_item_name}`).join(', ')}
                    </p>
                    {order.total !== null && order.total !== undefined && (
                      <p className="text-sm font-semibold text-brand-text mt-1">
                        {formatMoney(order.total, currency)}
                      </p>
                    )}
                    {order.queue_position && order.status === 'pending' && (
                      <p className="text-xs text-brand-600 font-semibold mt-1">
                        #{order.queue_position} in the queue
                      </p>
                    )}
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Bottom navigation ─────────────────────────────────────────────── */}
      <nav aria-label="Sections" className="fixed bottom-0 inset-x-0 z-30 bg-brand-surface border-t border-gray-200 flex">
        {[
          { key: VIEWS.MENU, label: 'Menu', icon: '🍽', badge: 0 },
          { key: VIEWS.CART, label: 'Cart', icon: '🛒', badge: cartCount },
          { key: VIEWS.ORDERS, label: 'Orders', icon: '📋', badge: activeOrderCount },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setView(tab.key)}
            aria-current={view === tab.key ? 'page' : undefined}
            className={`flex-1 py-3 flex flex-col items-center gap-0.5 text-xs font-semibold ${
              view === tab.key ? 'text-brand-600' : 'text-gray-400'
            }`}
          >
            <span className="relative text-xl leading-none">
              {tab.icon}
              {tab.badge > 0 && (
                <span className="absolute -top-1.5 -right-3 bg-brand-600 text-white rounded-full text-[10px] font-bold px-1.5 py-0.5 leading-none">
                  {tab.badge}
                </span>
              )}
            </span>
            {tab.label}
          </button>
        ))}
      </nav>

      <ItemSheet
        item={sheetItem}
        currency={currency}
        imageUrl={sheetItem ? imageUrl(sheetItem) : null}
        onClose={() => setSheetItem(null)}
        onAdd={addToCart}
      />
    </div>
  )
}
