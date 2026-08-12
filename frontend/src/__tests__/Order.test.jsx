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
  items: [{ id: 10, name: 'Cheeseburger', description: '', item_ingredients: [] }],
}]

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

  it('does not send a table_code once the lookup has failed', async () => {
    orderApi.get.mockRejectedValue({ response: { status: 404 } })
    renderOrder('/order?t=bogus')
    await screen.findByText(/What's your name\?/i)

    // Nothing submitted yet, but the failed code must not be retained for later.
    await waitFor(() => expect(orderApi.post).not.toHaveBeenCalled())
    expect(screen.queryByText('Table 3')).toBeNull()
  })
})
