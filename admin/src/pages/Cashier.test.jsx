import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}))

class MockEventSource {
  constructor() { this.onmessage = null; this.onerror = null; this.close = vi.fn() }
}
global.EventSource = MockEventSource

import api from '../lib/api'
import Cashier from './Cashier'

function order(id, { status = 'pending', total = 12000, items } = {}) {
  return {
    id,
    order_number: `BO-00${id}`,
    customer_name: 'Table 1',
    status,
    total,
    created_at: '2026-08-12T10:00:00',
    items: items || [{
      id: id * 10, menu_item_name: 'Cheeseburger', quantity: 2,
      unit_price: 6000, options: [], ingredients: [],
    }],
  }
}

function openTable(overrides = {}) {
  return {
    table_id: 1,
    code: 'abc',
    label: 'Table 1',
    active: true,
    order_count: 1,
    total: 12000,
    opened_at: '2026-08-12T10:00:00',
    last_order_at: '2026-08-12T10:00:00',
    unserved_count: 0,
    stale: false,
    orders: [order(1)],
    ...overrides,
  }
}

function mockOpen(tables) {
  api.get.mockImplementation(url => {
    if (url === '/orders/tables/open') return Promise.resolve({ data: tables })
    if (url === '/settings/currency') return Promise.resolve({ data: { value: 'THB' } })
    return Promise.reject(new Error(`Unexpected GET ${url}`))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('Cashier', () => {
  it('lists each unpaid table with what it owes', async () => {
    mockOpen([openTable(), openTable({ table_id: 2, label: 'Table 2', total: 4000 })])
    render(<Cashier />)

    expect(await screen.findByText('Table 1')).toBeInTheDocument()
    expect(screen.getByText('Table 2')).toBeInTheDocument()
    expect(screen.getByText(/120\.00/)).toBeInTheDocument()
  })

  it('says so plainly when nobody owes anything', async () => {
    mockOpen([])
    render(<Cashier />)

    expect(await screen.findByText(/No unpaid tables/)).toBeInTheDocument()
  })

  it('shows a dash rather than a zero total when the menu has no prices', async () => {
    mockOpen([openTable({ total: null, orders: [order(1, { total: null })] })])
    render(<Cashier />)

    await screen.findByText('Table 1')
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText(/0\.00/)).not.toBeInTheDocument()
  })

  it('settles exactly the orders that were on screen', async () => {
    mockOpen([openTable({ order_count: 2, orders: [order(1), order(2)] })])
    api.post.mockResolvedValue({ data: { bill_id: 'b1', settled: [], outstanding: [] } })
    render(<Cashier />)

    await userEvent.click(await screen.findByRole('button', { name: 'Confirm payment' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirm paid' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/orders/tables/1/settle', { order_ids: [1, 2], payment_method: 'cash' },
    ))
  })

  it('records how the table paid', async () => {
    mockOpen([openTable()])
    api.post.mockResolvedValue({ data: { bill_id: 'b1', settled: [], outstanding: [] } })
    render(<Cashier />)

    await userEvent.click(await screen.findByRole('button', { name: 'Confirm payment' }))
    await userEvent.click(screen.getByRole('button', { name: 'Transfer' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirm paid' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/orders/tables/1/settle', { order_ids: [1], payment_method: 'transfer' },
    ))
  })

  it('starts each table back at cash rather than inheriting the last one', async () => {
    mockOpen([openTable(), openTable({ table_id: 2, label: 'Table 2', orders: [order(9)] })])
    api.post.mockResolvedValue({ data: { bill_id: 'b1', settled: [], outstanding: [] } })
    render(<Cashier />)

    const [firstPay, secondPay] = await screen.findAllByRole('button', { name: 'Confirm payment' })
    await userEvent.click(firstPay)
    await userEvent.click(screen.getByRole('button', { name: 'Card' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await userEvent.click(secondPay)
    expect(screen.getByRole('button', { name: 'Cash' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('asks for confirmation before taking any money', async () => {
    mockOpen([openTable()])
    render(<Cashier />)

    await userEvent.click(await screen.findByRole('button', { name: 'Confirm payment' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(api.post).not.toHaveBeenCalled()
  })

  it('warns that unserved food is still coming before payment is taken', async () => {
    mockOpen([openTable({ unserved_count: 2 })])
    render(<Cashier />)

    await userEvent.click(await screen.findByRole('button', { name: 'Confirm payment' }))

    expect(screen.getByRole('dialog')).toHaveTextContent(/still in the kitchen queue|still be cooked/)
  })

  it('flags an order that arrived while the cashier was confirming', async () => {
    mockOpen([openTable()])
    api.post.mockResolvedValue({ data: { bill_id: 'b1', settled: [order(1)], outstanding: [order(2)] } })
    render(<Cashier />)

    await userEvent.click(await screen.findByRole('button', { name: 'Confirm payment' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirm paid' }))

    expect(await screen.findByRole('status')).toHaveTextContent(/still unpaid/)
  })

  it('recovers when another till already closed the bill', async () => {
    mockOpen([openTable()])
    api.post.mockRejectedValue({ response: { status: 409, data: { detail: { code: 'already_settled' } } } })
    render(<Cashier />)

    await userEvent.click(await screen.findByRole('button', { name: 'Confirm payment' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirm paid' }))

    expect(await screen.findByRole('status')).toHaveTextContent(/already settled/)
  })

  it('shows the items so the bill can be checked against the table', async () => {
    mockOpen([openTable()])
    render(<Cashier />)

    await userEvent.click(await screen.findByRole('button', { name: 'Check items' }))

    expect(screen.getByText(/Cheeseburger/)).toBeInTheDocument()
    // Clock time is rendered in the browser's own zone, so only the shape is asserted.
    expect(screen.getByText(/BO-001 · \d{1,2}:\d{2}/)).toBeInTheDocument()
  })

  it('marks a bill nobody closed so it can be cleared', async () => {
    mockOpen([openTable({ stale: true })])
    render(<Cashier />)

    expect(await screen.findByText(/Untouched for hours/)).toBeInTheDocument()
  })
})
