import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../lib/api', () => ({
  default: { get: vi.fn(), put: vi.fn(() => Promise.resolve({ data: {} })) },
}))

class MockEventSource {
  constructor() { this.onmessage = null; this.onerror = null; this.close = vi.fn() }
}
global.EventSource = MockEventSource

import api from '../lib/api'
import OrderQueue from './OrderQueue'

function line(name, quantity = 1, { options = [], ingredients = [] } = {}) {
  return { id: Math.random(), menu_item_name: name, quantity, options, ingredients }
}

const T1_EARLY = {
  id: 1, order_number: 'BO-001', customer_name: 'Table 1', table_label: 'Table 1',
  status: 'pending', total: 12000, created_at: '2026-08-12T10:00:00',
  items: [line('Cheeseburger', 2)],
}
const TAKEAWAY_MID = {
  id: 2, order_number: 'BO-002', customer_name: 'Alice', table_label: null,
  status: 'pending', total: 4000, created_at: '2026-08-12T10:05:00',
  items: [line('Fries')],
}
const T10_LATE = {
  id: 3, order_number: 'BO-003', customer_name: 'Table 10', table_label: 'Table 10',
  status: 'in_progress', total: null, created_at: '2026-08-12T10:10:00',
  items: [line('Cheeseburger', 1), line('Fries', 3)],
}

// API returns oldest first.
const QUEUE = [T1_EARLY, TAKEAWAY_MID, T10_LATE]

function mockQueue(orders = QUEUE, currency = 'THB') {
  api.get.mockImplementation(url => {
    if (url === '/orders/queue') return Promise.resolve({ data: orders })
    if (url === '/settings/currency') return Promise.resolve({ data: { value: currency } })
    return Promise.reject(new Error(`Unexpected GET ${url}`))
  })
}

function orderNumbersInDomOrder() {
  return [...document.querySelectorAll('p')]
    .map(p => p.textContent)
    .filter(text => /^BO-\d+$/.test(text))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('OrderQueue — sorting', () => {
  it('keeps the longest wait at the top by default', async () => {
    mockQueue()
    render(<OrderQueue />)
    await screen.findByText('BO-001')

    expect(orderNumbersInDomOrder()).toEqual(['BO-001', 'BO-002', 'BO-003'])
  })

  it('can show the newest first', async () => {
    mockQueue()
    render(<OrderQueue />)
    await screen.findByText('BO-001')

    await userEvent.selectOptions(screen.getByLabelText('Show'), 'newest')

    expect(orderNumbersInDomOrder()).toEqual(['BO-003', 'BO-002', 'BO-001'])
  })

  it('groups by table for a serving run, numbering naturally and takeaway last', async () => {
    mockQueue()
    render(<OrderQueue />)
    await screen.findByText('BO-001')

    await userEvent.selectOptions(screen.getByLabelText('Show'), 'table')

    // Table 1 before Table 10 — not lexicographic — and takeaway at the end.
    expect(orderNumbersInDomOrder()).toEqual(['BO-001', 'BO-003', 'BO-002'])
  })
})

describe('OrderQueue — by dish', () => {
  it('combines the same dish across orders so one batch covers several tables', async () => {
    mockQueue()
    render(<OrderQueue />)
    await screen.findByText('BO-001')

    await userEvent.selectOptions(screen.getByLabelText('Show'), 'by-item')

    // 2 for Table 1 + 1 for Table 10.
    expect(screen.getByText('3×')).toBeInTheDocument()
    // 1 takeaway + 3 for Table 10.
    expect(screen.getByText('4×')).toBeInTheDocument()
  })

  it('says which orders each batch is for', async () => {
    mockQueue()
    render(<OrderQueue />)
    await screen.findByText('BO-001')
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'by-item')

    expect(screen.getByText('Table 1 · BO-001 ×2')).toBeInTheDocument()
    expect(screen.getByText('Takeaway · BO-002')).toBeInTheDocument()
  })

  it('keeps differently configured dishes apart', async () => {
    mockQueue([
      { ...T1_EARLY, items: [line('Cheeseburger', 1, { options: [{ group_name: 'Size', option_name: 'Large' }] })] },
      { ...TAKEAWAY_MID, items: [line('Cheeseburger', 1, { options: [{ group_name: 'Size', option_name: 'Regular' }] })] },
    ])
    render(<OrderQueue />)
    await screen.findByText('BO-001')
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'by-item')

    // Two batches of one, not one batch of two.
    expect(screen.getAllByText('1×')).toHaveLength(2)
    expect(screen.getByText('Size: Large')).toBeInTheDocument()
    expect(screen.getByText('Size: Regular')).toBeInTheDocument()
  })

  it('offers no status buttons, since a batch spans several orders', async () => {
    mockQueue()
    render(<OrderQueue />)
    await screen.findByText('BO-001')
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'by-item')

    expect(screen.queryByText('Start Cooking')).not.toBeInTheDocument()
    expect(screen.getByText(/Advance orders from any other view/)).toBeInTheDocument()
  })

  it('leads with whichever dish has been waiting longest', async () => {
    mockQueue()
    render(<OrderQueue />)
    await screen.findByText('BO-001')
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'by-item')

    const names = [...document.querySelectorAll('span')]
      .map(s => s.textContent)
      .filter(text => text === 'Cheeseburger' || text === 'Fries')
    expect(names[0]).toBe('Cheeseburger')   // first seen at 10:00, Fries at 10:05
  })
})

describe('OrderQueue — money and quantity', () => {
  it('shows the order total, and nothing for an unpriced order', async () => {
    mockQueue()
    render(<OrderQueue />)
    await screen.findByText('BO-001')

    expect(screen.getByText(/120\.00/)).toBeInTheDocument()
    const unpriced = screen.getByText('BO-003').closest('div.bg-brand-surface')
    expect(unpriced.textContent).not.toMatch(/\d+\.\d{2}/)
  })

  it('marks quantities above one and leaves singles plain', async () => {
    mockQueue()
    render(<OrderQueue />)
    const card = (await screen.findByText('BO-001')).closest('div.bg-brand-surface')

    expect(within(card).getByText('2×')).toBeInTheDocument()

    const fries = screen.getByText('BO-002').closest('div.bg-brand-surface')
    expect(within(fries).queryByText('1×')).not.toBeInTheDocument()
  })

  it("follows the kitchen's currency setting", async () => {
    mockQueue(QUEUE, 'GBP')
    render(<OrderQueue />)
    await screen.findByText('BO-001')

    await waitFor(() => {
      expect(screen.getByText(/120\.00/).textContent).toMatch(/GBP|£/)
    })
  })
})
