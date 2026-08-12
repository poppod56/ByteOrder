import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

vi.mock('../contexts/KitchenContext', () => ({
  KitchenProvider: ({ children }) => children,
  useKitchen: () => ({ kitchenId: 'test-kitchen', slug: null }),
}))

const orderApi = { get: vi.fn() }

vi.mock('../lib/api', () => ({
  menuApi: { get: vi.fn(() => Promise.resolve({ data: { value: null } })) },
  orderApi: { get: (...args) => orderApi.get(...args) },
  setKitchenId: vi.fn(),
}))

import TrackOrder from '../pages/TrackOrder'

const BASE_ORDER = {
  id: 1,
  public_id: 'abc-123',
  order_number: 'BO-20260812-001',
  customer_name: 'Alice',
  status: 'pending',
  table_id: null,
  table_label: null,
  queue_position: 2,
  items: [{ id: 1, menu_item_name: 'Burger', ingredients: [], options: [] }],
}

function renderTrack(path, order) {
  orderApi.get.mockResolvedValue({ data: order })
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/track/:publicId" element={<TrackOrder />} />
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TrackOrder — table order', () => {
  const tableOrder = { ...BASE_ORDER, table_id: 3, table_label: 'Table 5', customer_name: 'Table 5' }

  it('shows the table so the customer can check it was recorded', async () => {
    renderTrack('/track/abc-123?t=xyz', tableOrder)
    expect(await screen.findByText('Table 5')).toBeInTheDocument()
  })

  it('says the food is brought over rather than collected', async () => {
    renderTrack('/track/abc-123?t=xyz', tableOrder)

    expect(await screen.findByText(/We'll bring it to Table 5/i)).toBeInTheDocument()
    expect(screen.getByText('On its way!')).toBeInTheDocument()
    expect(screen.queryByText('Ready to collect!')).not.toBeInTheDocument()
  })

  it('offers another round bound to the same table', async () => {
    renderTrack('/track/abc-123?t=xyz', tableOrder)

    const link = await screen.findByText('Order more for Table 5')
    expect(link.closest('a')).toHaveAttribute('href', '/order?t=xyz')
  })
})

describe('TrackOrder — takeaway order', () => {
  it('keeps the collection wording', async () => {
    renderTrack('/track/abc-123', BASE_ORDER)

    expect(await screen.findByText(/Sit tight/i)).toBeInTheDocument()
    expect(screen.getByText('Ready to collect!')).toBeInTheDocument()
  })

  it('shows the customer name and no table', async () => {
    renderTrack('/track/abc-123', BASE_ORDER)

    expect(await screen.findByText('Alice')).toBeInTheDocument()
    expect(screen.queryByText(/Table/)).not.toBeInTheDocument()
  })

  it('links to a plain new order with no table code', async () => {
    renderTrack('/track/abc-123', BASE_ORDER)

    const link = await screen.findByText('Place another order')
    expect(link.closest('a')).toHaveAttribute('href', '/order')
  })
})
