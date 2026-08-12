import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../contexts/KitchenContext', () => ({
  KitchenProvider: ({ children }) => children,
  useKitchen: () => ({ kitchenId: 'test-kitchen', slug: null }),
}))

const menuApi = { get: vi.fn() }
const orderApi = { get: vi.fn(), post: vi.fn() }

vi.mock('../lib/api', () => ({
  menuApi: { get: (...args) => menuApi.get(...args) },
  orderApi: {
    get: (...args) => orderApi.get(...args),
    post: (...args) => orderApi.post(...args),
  },
  setKitchenId: vi.fn(),
}))

import Order from '../pages/Order'

const SIZE = {
  id: 1, name: 'Size', required: true, min_select: 0, max_select: 1,
  options: [{ id: 100, name: 'Regular', price_delta: 0 }, { id: 101, name: 'Large', price_delta: 1500 }],
}
const BACON = { ingredient: { id: 11, name: 'Bacon' }, is_default: false, price_delta: 2000 }
const LETTUCE = { ingredient: { id: 10, name: 'Lettuce' }, is_default: true, price_delta: 0 }

const BURGER = {
  id: 10, name: 'Cheeseburger', description: 'Beef patty', price: 12000, has_image: true,
  item_ingredients: [LETTUCE, BACON], option_groups: [SIZE],
}
const FRIES = {
  id: 11, name: 'Fries', description: '', price: 4000, has_image: false,
  item_ingredients: [], option_groups: [],
}
const WATER = {
  id: 12, name: 'Water', description: '', price: null, has_image: false,
  item_ingredients: [], option_groups: [],
}

const CATEGORIES = [
  { id: 1, name: 'Burgers', description: 'Handmade', items: [BURGER] },
  { id: 2, name: 'Sides', description: '', items: [FRIES, WATER] },
  { id: 3, name: 'Empty', description: '', items: [] },
]

function renderOrder(path = '/order') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Order />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  menuApi.get.mockImplementation(path => {
    if (path === '/categories/') return Promise.resolve({ data: CATEGORIES })
    if (path.includes('currency')) return Promise.resolve({ data: { value: 'THB' } })
    return Promise.resolve({ data: { value: null } })
  })
  orderApi.get.mockImplementation(path => {
    if (path.includes('/by-code/')) return Promise.resolve({ data: { code: 't3', label: 'Table 3' } })
    if (path.includes('/track/')) return Promise.reject({ response: { status: 404 } })
    return Promise.resolve({ data: [] })
  })
  orderApi.post.mockResolvedValue({ data: { public_id: 'abc-123' } })
})

async function openBurgerSheet() {
  await userEvent.click(await screen.findByText('Cheeseburger'))
  return screen.getByRole('dialog')
}

async function addBurgerToCart({ size = 'Large' } = {}) {
  const sheet = await openBurgerSheet()
  await userEvent.click(within(sheet).getByText(new RegExp(`^${size}`)))
  await userEvent.click(within(sheet).getByRole('button', { name: /Add \d+ to cart/ }))
}

// ── Menu ─────────────────────────────────────────────────────────────────────

describe('Order page — menu', () => {
  it('lays the whole menu out in sections instead of a step-by-step wizard', async () => {
    renderOrder()

    expect(await screen.findByRole('heading', { name: 'Burgers' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sides' })).toBeInTheDocument()
    expect(screen.getByText('Cheeseburger')).toBeInTheDocument()
    expect(screen.getByText('Fries')).toBeInTheDocument()
  })

  it('offers a tab per category, skipping ones with nothing in them', async () => {
    renderOrder()
    await screen.findByText('Cheeseburger')

    const tabs = screen.getByRole('navigation', { name: 'Menu categories' })
    expect(within(tabs).getByText('Burgers')).toBeInTheDocument()
    expect(within(tabs).queryByText('Empty')).not.toBeInTheDocument()
  })

  it('scrolls to a section when its tab is tapped', async () => {
    renderOrder()
    await screen.findByText('Cheeseburger')

    await userEvent.click(within(screen.getByRole('navigation', { name: 'Menu categories' })).getByText('Sides'))

    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('shows prices, and nothing where a price was never set', async () => {
    renderOrder()
    await screen.findByText('Cheeseburger')

    expect(screen.getByText(/120\.00/)).toBeInTheDocument()
    expect(screen.getByText(/40\.00/)).toBeInTheDocument()
    // Water is unpriced — its card must show no amount at all, not a free price.
    const waterCard = screen.getByText('Water').closest('button')
    expect(waterCard.textContent).not.toMatch(/\d+\.\d{2}/)
  })

  it('requests item images with the kitchen in the URL', async () => {
    // A plain <img> carries no X-Kitchen-ID header, so the kitchen has to travel
    // in the query string or cloud deployments reject every thumbnail.
    renderOrder()
    await screen.findByText('Cheeseburger')

    expect(document.querySelector('img'))
      .toHaveAttribute('src', '/api/items/10/image?kitchen_id=test-kitchen')
  })

  it('asks for no image when the item has none', async () => {
    renderOrder()
    await screen.findByText('Fries')

    expect(document.querySelectorAll('img')).toHaveLength(1)   // the burger only
  })
})

// ── Item sheet ───────────────────────────────────────────────────────────────

describe('Order page — item sheet', () => {
  it('opens a sheet with the item detail', async () => {
    renderOrder()
    const sheet = await openBurgerSheet()

    expect(within(sheet).getByText('Beef patty')).toBeInTheDocument()
    expect(within(sheet).getByText('Lettuce')).toBeInTheDocument()
  })

  it('steps the quantity between 1 and 99', async () => {
    renderOrder()
    const sheet = await openBurgerSheet()

    expect(within(sheet).getByTestId('quantity')).toHaveTextContent('1')
    expect(within(sheet).getByLabelText('Fewer')).toBeDisabled()

    await userEvent.click(within(sheet).getByLabelText('More'))
    await userEvent.click(within(sheet).getByLabelText('More'))
    expect(within(sheet).getByTestId('quantity')).toHaveTextContent('3')

    await userEvent.click(within(sheet).getByLabelText('Fewer'))
    expect(within(sheet).getByTestId('quantity')).toHaveTextContent('2')
  })

  it('prices the line as it is configured', async () => {
    renderOrder()
    const sheet = await openBurgerSheet()

    await userEvent.click(within(sheet).getByText(/^Large/))    // +15.00
    await userEvent.click(within(sheet).getByText(/^Bacon/))    // +20.00
    await userEvent.click(within(sheet).getByLabelText('More')) // ×2

    expect(within(sheet).getByRole('button', { name: /Add 2 to cart/ }))
      .toHaveTextContent('310.00')
  })

  it('will not add until a required choice is made', async () => {
    renderOrder()
    const sheet = await openBurgerSheet()

    expect(within(sheet).getByRole('button', { name: /Add 1 to cart/ })).toBeDisabled()
    expect(within(sheet).getByText(/Please choose: Size/)).toBeInTheDocument()

    await userEvent.click(within(sheet).getByText(/^Regular/))
    expect(within(sheet).getByRole('button', { name: /Add 1 to cart/ })).toBeEnabled()
  })

  it('adds straight away for an item with no choices', async () => {
    renderOrder()
    await userEvent.click(await screen.findByText('Fries'))

    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByRole('button', { name: /Add 1 to cart/ })).toBeEnabled()
  })

  it('closes on Escape without adding anything', async () => {
    renderOrder()
    await openBurgerSheet()

    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cart/ })).not.toHaveTextContent('1')
  })
})

// ── Cart ─────────────────────────────────────────────────────────────────────

describe('Order page — cart', () => {
  it('counts what is in the cart on the bottom bar', async () => {
    renderOrder()
    await addBurgerToCart()

    expect(screen.getByRole('button', { name: /Cart/ })).toHaveTextContent('1')
  })

  it('merges an identical configuration instead of listing it twice', async () => {
    renderOrder()
    await addBurgerToCart({ size: 'Large' })
    await addBurgerToCart({ size: 'Large' })

    await userEvent.click(screen.getByRole('button', { name: /Cart/ }))

    expect(screen.getAllByText('Cheeseburger')).toHaveLength(1)
    // Shown twice over: once on the line, once as the cart total.
    expect(screen.getAllByText(/270\.00/)).toHaveLength(2)   // (120+15) × 2
  })

  it('keeps differently configured lines apart', async () => {
    renderOrder()
    await addBurgerToCart({ size: 'Large' })
    await addBurgerToCart({ size: 'Regular' })

    await userEvent.click(screen.getByRole('button', { name: /Cart/ }))

    expect(screen.getAllByText('Cheeseburger')).toHaveLength(2)
  })

  it('adjusts a line, and removes it at zero', async () => {
    renderOrder()
    await addBurgerToCart()
    await userEvent.click(screen.getByRole('button', { name: /Cart/ }))

    await userEvent.click(screen.getByLabelText('More Cheeseburger'))
    expect(screen.getAllByText(/270\.00/)).toHaveLength(2)

    await userEvent.click(screen.getByLabelText('Fewer Cheeseburger'))
    await userEvent.click(screen.getByLabelText('Fewer Cheeseburger'))

    expect(screen.getByText(/Nothing in the cart yet/)).toBeInTheDocument()
  })

  it('totals the cart', async () => {
    renderOrder()
    await addBurgerToCart({ size: 'Regular' })
    await userEvent.click(await screen.findByText('Fries'))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Add 1 to cart/ }))

    await userEvent.click(screen.getByRole('button', { name: /Cart/ }))

    expect(screen.getByText('Total')).toBeInTheDocument()
    expect(screen.getByText(/160\.00/)).toBeInTheDocument()
  })
})

// ── Checkout ─────────────────────────────────────────────────────────────────

describe('Order page — takeaway checkout', () => {
  it('asks for a name at checkout rather than gating the menu', async () => {
    renderOrder()

    // The menu is browsable immediately — no name step in the way.
    await screen.findByText('Cheeseburger')
    expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument()

    await addBurgerToCart()
    await userEvent.click(screen.getByRole('button', { name: /Cart/ }))

    expect(screen.getByLabelText('Your name')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Place order' })).toBeDisabled()

    await userEvent.type(screen.getByLabelText('Your name'), 'Alice')
    expect(screen.getByRole('button', { name: 'Place order' })).toBeEnabled()
  })

  it('sends quantities and choices, then shows the order', async () => {
    renderOrder()
    await addBurgerToCart({ size: 'Large' })
    await userEvent.click(screen.getByRole('button', { name: /Cart/ }))
    await userEvent.click(screen.getByLabelText('More Cheeseburger'))
    await userEvent.type(screen.getByLabelText('Your name'), 'Alice')

    await userEvent.click(screen.getByRole('button', { name: 'Place order' }))

    await waitFor(() => expect(orderApi.post).toHaveBeenCalled())
    const body = orderApi.post.mock.calls[0][1]
    expect(body.customer_name).toBe('Alice')
    expect(body.table_code).toBeUndefined()
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ menu_item_id: 10, quantity: 2 })
    expect(body.items[0].options).toEqual([
      { option_id: 101, option_name: 'Large', group_name: 'Size', price_delta: 1500 },
    ])
    // Lands on the orders list.
    expect(await screen.findByText('Your orders')).toBeInTheDocument()
  })

  it('remembers takeaway orders for this session only', async () => {
    renderOrder()
    await addBurgerToCart()
    await userEvent.click(screen.getByRole('button', { name: /Cart/ }))
    await userEvent.type(screen.getByLabelText('Your name'), 'Alice')
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }))

    await waitFor(() => {
      expect(JSON.parse(sessionStorage.getItem('byteorder.myOrders'))).toEqual(['abc-123'])
    })
  })
})

describe('Order page — table checkout', () => {
  it('needs no name and shows the table', async () => {
    renderOrder('/order?t=t3')

    expect(await screen.findByText('Table 3')).toBeInTheDocument()
    await addBurgerToCart()
    await userEvent.click(screen.getByRole('button', { name: /Cart/ }))

    expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Place order' })).toBeEnabled()
  })

  it('binds the order to the table', async () => {
    renderOrder('/order?t=t3')
    await addBurgerToCart()
    await userEvent.click(screen.getByRole('button', { name: /Cart/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }))

    await waitFor(() => expect(orderApi.post).toHaveBeenCalled())
    expect(orderApi.post.mock.calls[0][1].table_code).toBe('t3')
    // A table's orders come from the server, not this browser.
    expect(sessionStorage.getItem('byteorder.myOrders')).toBeNull()
  })

  it('explains a rotated QR and keeps the cart', async () => {
    orderApi.post.mockRejectedValue({
      response: { status: 400, data: { detail: { code: 'unknown_table', message: 'Unknown table code' } } },
    })
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

    renderOrder('/order?t=t3')
    await addBurgerToCart()
    await userEvent.click(screen.getByRole('button', { name: /Cart/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }))

    expect(await screen.findByText(/This table has a new QR code/)).toBeInTheDocument()
    expect(alertSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Cart/ })).toHaveTextContent('1')

    await userEvent.click(screen.getByRole('button', { name: /Keep my order as a takeaway/ }))
    expect(screen.getByLabelText('Your name')).toBeInTheDocument()
  })

  it('degrades to takeaway when the code is not recognised at all', async () => {
    orderApi.get.mockImplementation(path =>
      path.includes('/by-code/')
        ? Promise.reject({ response: { status: 404 } })
        : Promise.resolve({ data: [] })
    )
    renderOrder('/order?t=bogus')

    expect(await screen.findByText(/couldn't recognise that table code/i)).toBeInTheDocument()
    expect(screen.getByText('Cheeseburger')).toBeInTheDocument()
  })
})

// ── Orders already placed ────────────────────────────────────────────────────

describe('Order page — orders list', () => {
  const PLACED = {
    id: 1, public_id: 'abc-123', order_number: 'BO-001', status: 'pending',
    total: 27000, queue_position: 2, table_label: 'Table 3',
    items: [{ id: 1, menu_item_name: 'Cheeseburger', quantity: 2, ingredients: [], options: [] }],
  }

  it('lists everything ordered at the table, from the server', async () => {
    orderApi.get.mockImplementation(path => {
      if (path.includes('/by-code/')) return Promise.resolve({ data: { code: 't3', label: 'Table 3' } })
      if (path.includes('/by-table/t3')) return Promise.resolve({ data: [PLACED] })
      return Promise.resolve({ data: [] })
    })

    renderOrder('/order?t=t3')
    await userEvent.click(await screen.findByRole('button', { name: /Orders/ }))

    expect(screen.getByText('Orders for Table 3')).toBeInTheDocument()
    expect(screen.getByText('BO-001')).toBeInTheDocument()
    expect(screen.getByText('2x Cheeseburger')).toBeInTheDocument()
    expect(screen.getByText(new RegExp('270\\.00'))).toBeInTheDocument()
    expect(screen.getByText('#2 in the queue')).toBeInTheDocument()
  })

  it('looks up remembered takeaway orders instead', async () => {
    sessionStorage.setItem('byteorder.myOrders', JSON.stringify(['abc-123']))
    orderApi.get.mockImplementation(path =>
      path.includes('/track/abc-123')
        ? Promise.resolve({ data: { ...PLACED, table_label: null } })
        : Promise.resolve({ data: [] })
    )

    renderOrder()
    await userEvent.click(await screen.findByRole('button', { name: /Orders/ }))

    expect(await screen.findByText('BO-001')).toBeInTheDocument()
    expect(screen.getByText('Your orders')).toBeInTheDocument()
  })

  it('links each order through to its tracking page', async () => {
    orderApi.get.mockImplementation(path => {
      if (path.includes('/by-code/')) return Promise.resolve({ data: { code: 't3', label: 'Table 3' } })
      if (path.includes('/by-table/t3')) return Promise.resolve({ data: [PLACED] })
      return Promise.resolve({ data: [] })
    })

    renderOrder('/order?t=t3')
    await userEvent.click(await screen.findByRole('button', { name: /Orders/ }))

    expect(screen.getByText('BO-001').closest('a')).toHaveAttribute('href', '/track/abc-123?t=t3')
  })

  it('says so when nothing has been ordered', async () => {
    renderOrder('/order?t=t3')
    await userEvent.click(await screen.findByRole('button', { name: /Orders/ }))

    expect(screen.getByText(/Nothing ordered yet/)).toBeInTheDocument()
  })
})
