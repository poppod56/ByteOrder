import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

const navigateSpy = vi.fn()
vi.mock('react-router-dom', async importOriginal => ({
  ...(await importOriginal()),
  useNavigate: () => navigateSpy,
}))

vi.mock('../contexts/KitchenContext', () => ({
  KitchenProvider: ({ children }) => children,
  useKitchen: () => ({ kitchenId: 'test-kitchen', slug: null }),
}))

const CATEGORIES = [{
  id: 1,
  name: 'Burgers',
  description: '',
  items: [{ id: 10, name: 'Cheeseburger', description: '', item_ingredients: [], option_groups: [] }],
}]

function withOptionGroups(groups) {
  return [{ ...CATEGORIES[0], items: [{ ...CATEGORIES[0].items[0], option_groups: groups }] }]
}

const SIZE_REQUIRED = {
  id: 1, name: 'Size', required: true, min_select: 0, max_select: 1,
  options: [{ id: 100, name: 'Regular' }, { id: 101, name: 'Large' }],
}
const EXTRAS_UP_TO_TWO = {
  id: 2, name: 'Extras', required: false, min_select: 0, max_select: 2,
  options: [{ id: 200, name: 'Egg' }, { id: 201, name: 'Bacon' }, { id: 202, name: 'Avocado' }],
}

async function reachCustomise() {
  await screen.findByText(/What are you having\?/i)
  await userEvent.click(screen.getByText('Burgers'))
  await userEvent.click(screen.getByText('Cheeseburger'))
}

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

function renderOrder(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Order />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  menuApi.get.mockImplementation(path =>
    path === '/categories/'
      ? Promise.resolve({ data: CATEGORIES })
      : Promise.resolve({ data: { value: null } })
  )
  orderApi.get.mockResolvedValue({ data: { code: 't3', label: 'Table 3' } })
  orderApi.post.mockResolvedValue({ data: { public_id: 'abc-123' } })
})

describe('Order page — no table QR', () => {
  it('asks for a name first', async () => {
    renderOrder('/order')
    expect(await screen.findByText(/What's your name\?/i)).toBeDefined()
  })

  it('does not look up a table', async () => {
    renderOrder('/order')
    await screen.findByText(/What's your name\?/i)
    expect(orderApi.get).not.toHaveBeenCalled()
  })
})

describe('Order page — scanned from a table QR', () => {
  it('resolves the code and skips straight to the menu', async () => {
    renderOrder('/order?t=t3')

    expect(await screen.findByText(/What are you having\?/i)).toBeDefined()
    expect(orderApi.get).toHaveBeenCalledWith('/orders/tables/by-code/t3')
    expect(screen.queryByText(/What's your name\?/i)).toBeNull()
  })

  it('shows the table label so a mis-stuck QR is noticed', async () => {
    renderOrder('/order?t=t3')
    expect(await screen.findByText('Table 3')).toBeDefined()
  })

  it('falls back to the name step when the code is unknown', async () => {
    orderApi.get.mockRejectedValue({ response: { status: 404 } })
    renderOrder('/order?t=bogus')

    expect(await screen.findByText(/What's your name\?/i)).toBeDefined()
    expect(await screen.findByText(/couldn't recognise that table code/i)).toBeDefined()
  })

  it('binds the placed order to the table and keeps it for the next round', async () => {
    renderOrder('/order?t=t3')
    await screen.findByText(/What are you having\?/i)

    await userEvent.click(screen.getByText('Burgers'))
    await userEvent.click(screen.getByText('Cheeseburger'))
    await userEvent.click(screen.getByText('Add to order'))
    await userEvent.click(screen.getByText('Place Order'))

    await waitFor(() => expect(orderApi.post).toHaveBeenCalled())
    expect(orderApi.post.mock.calls[0][1]).toMatchObject({ table_code: 't3' })
    // ?t= must survive into the tracking URL, or ordering again loses the table.
    expect(navigateSpy).toHaveBeenCalledWith('/track/abc-123?t=t3')
  })

  it('explains a rotated QR instead of telling the customer to retry', async () => {
    orderApi.post.mockRejectedValue({
      response: { status: 400, data: { detail: { code: 'unknown_table', message: 'Unknown table code' } } },
    })
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

    renderOrder('/order?t=t3')
    await screen.findByText(/What are you having\?/i)
    await userEvent.click(screen.getByText('Burgers'))
    await userEvent.click(screen.getByText('Cheeseburger'))
    await userEvent.click(screen.getByText('Add to order'))
    await userEvent.click(screen.getByText('Place Order'))

    expect(await screen.findByText(/This table has a new QR code/i)).toBeInTheDocument()
    // The old generic "please try again" could never succeed here.
    expect(alertSpy).not.toHaveBeenCalled()
  })

  it('lets the customer keep the basket as a takeaway order', async () => {
    orderApi.post.mockRejectedValue({
      response: { status: 400, data: { detail: { code: 'unknown_table', message: 'Unknown table code' } } },
    })
    vi.spyOn(window, 'alert').mockImplementation(() => {})

    renderOrder('/order?t=t3')
    await screen.findByText(/What are you having\?/i)
    await userEvent.click(screen.getByText('Burgers'))
    await userEvent.click(screen.getByText('Cheeseburger'))
    await userEvent.click(screen.getByText('Add to order'))
    await userEvent.click(screen.getByText('Place Order'))
    await screen.findByText(/This table has a new QR code/i)

    await userEvent.click(screen.getByText('Keep my order as a takeaway'))

    // Dropped back to the name step, with the basket still in hand.
    expect(await screen.findByText(/What's your name\?/i)).toBeInTheDocument()
    expect(screen.getByText('Basket (1)')).toBeInTheDocument()
  })

  it('still surfaces other failures as before', async () => {
    orderApi.post.mockRejectedValue({ response: { status: 500, data: {} } })
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

    renderOrder('/order?t=t3')
    await screen.findByText(/What are you having\?/i)
    await userEvent.click(screen.getByText('Burgers'))
    await userEvent.click(screen.getByText('Cheeseburger'))
    await userEvent.click(screen.getByText('Add to order'))
    await userEvent.click(screen.getByText('Place Order'))

    await waitFor(() => expect(alertSpy).toHaveBeenCalled())
    expect(screen.queryByText(/This table has a new QR code/i)).not.toBeInTheDocument()
  })

  it('does not send a table_code once the lookup has failed', async () => {
    orderApi.get.mockRejectedValue({ response: { status: 404 } })
    renderOrder('/order?t=bogus')
    await screen.findByText(/What's your name\?/i)

    // Nothing submitted yet, but the failed code must not be retained for later.
    await waitFor(() => expect(orderApi.post).not.toHaveBeenCalled())
    expect(screen.queryByText('Table 3')).toBeNull()
  })
})

describe('Order page — option groups', () => {
  it('asks for the choices the kitchen configured', async () => {
    menuApi.get.mockImplementation(path =>
      path === '/categories/'
        ? Promise.resolve({ data: withOptionGroups([SIZE_REQUIRED]) })
        : Promise.resolve({ data: { value: null } })
    )
    renderOrder('/order?t=t3')
    await reachCustomise()

    expect(screen.getByText('Size')).toBeInTheDocument()
    expect(screen.getByText('Regular')).toBeInTheDocument()
    expect(screen.getByText('Large')).toBeInTheDocument()
    expect(screen.getByText('Choose one')).toBeInTheDocument()
  })

  it('blocks adding to the order until a required choice is made', async () => {
    menuApi.get.mockImplementation(path =>
      path === '/categories/'
        ? Promise.resolve({ data: withOptionGroups([SIZE_REQUIRED]) })
        : Promise.resolve({ data: { value: null } })
    )
    renderOrder('/order?t=t3')
    await reachCustomise()

    expect(screen.getByText('Add to order')).toBeDisabled()
    expect(screen.getByText(/Please choose: Size/i)).toBeInTheDocument()

    await userEvent.click(screen.getByText('Large'))

    expect(screen.getByText('Add to order')).toBeEnabled()
  })

  it('replaces the pick in a choose-one group', async () => {
    menuApi.get.mockImplementation(path =>
      path === '/categories/'
        ? Promise.resolve({ data: withOptionGroups([SIZE_REQUIRED]) })
        : Promise.resolve({ data: { value: null } })
    )
    renderOrder('/order?t=t3')
    await reachCustomise()

    await userEvent.click(screen.getByText('Regular'))
    await userEvent.click(screen.getByText('Large'))
    await userEvent.click(screen.getByText('Add to order'))

    // Only the last pick survives, not both.
    expect(screen.getByText('Size: Large')).toBeInTheDocument()
  })

  it('accumulates up to the cap then locks the rest', async () => {
    menuApi.get.mockImplementation(path =>
      path === '/categories/'
        ? Promise.resolve({ data: withOptionGroups([EXTRAS_UP_TO_TWO]) })
        : Promise.resolve({ data: { value: null } })
    )
    renderOrder('/order?t=t3')
    await reachCustomise()

    expect(screen.getByText('Choose up to 2')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Egg'))
    await userEvent.click(screen.getByText('Bacon'))

    expect(screen.getByText('Avocado')).toBeDisabled()

    // Deselecting frees the slot again.
    await userEvent.click(screen.getByText('Egg'))
    expect(screen.getByText('Avocado')).toBeEnabled()
  })

  it('sends the chosen options with the order', async () => {
    menuApi.get.mockImplementation(path =>
      path === '/categories/'
        ? Promise.resolve({ data: withOptionGroups([SIZE_REQUIRED, EXTRAS_UP_TO_TWO]) })
        : Promise.resolve({ data: { value: null } })
    )
    renderOrder('/order?t=t3')
    await reachCustomise()

    await userEvent.click(screen.getByText('Large'))
    await userEvent.click(screen.getByText('Bacon'))
    await userEvent.click(screen.getByText('Add to order'))
    await userEvent.click(screen.getByText('Place Order'))

    await waitFor(() => expect(orderApi.post).toHaveBeenCalled())
    expect(orderApi.post.mock.calls[0][1].items[0].options).toEqual([
      { option_id: 101, option_name: 'Large', group_name: 'Size' },
      { option_id: 201, option_name: 'Bacon', group_name: 'Extras' },
    ])
  })

  it('does not get in the way of items with no option groups', async () => {
    renderOrder('/order?t=t3')
    await reachCustomise()

    expect(screen.getByText(/Tap toppings to add them/i)).toBeInTheDocument()
    expect(screen.getByText('Add to order')).toBeEnabled()
  })
})
