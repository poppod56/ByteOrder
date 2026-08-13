import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../lib/api', () => ({ default: { get: vi.fn() } }))

import api from '../lib/api'
import OrderHistory from './OrderHistory'

const TAKINGS = {
  date: '2026-08-13',
  bill_count: 3,
  order_count: 4,
  total: 48000,
  by_method: [
    { method: 'cash', bill_count: 2, order_count: 3, total: 36000 },
    { method: 'card', bill_count: 1, order_count: 1, total: 12000 },
  ],
  unpaid_order_count: 0,
  unpaid_total: null,
}

function mockDay({ takings = TAKINGS, orders = [] } = {}) {
  api.get.mockImplementation(url => {
    if (url === '/orders/history') return Promise.resolve({ data: orders })
    if (url === '/orders/takings') return Promise.resolve({ data: takings })
    if (url === '/settings/currency') return Promise.resolve({ data: { value: 'THB' } })
    return Promise.reject(new Error(`Unexpected GET ${url}`))
  })
}

beforeEach(() => vi.clearAllMocks())

describe('OrderHistory takings', () => {
  it('totals the day and splits it by how each bill was paid', async () => {
    mockDay()
    render(<OrderHistory />)

    expect(await screen.findByText("Day's takings")).toBeInTheDocument()
    expect(screen.getByText(/480\.00/)).toBeInTheDocument()
    expect(screen.getByText(/360\.00/)).toBeInTheDocument()
    expect(screen.getByText(/Cash/)).toBeInTheDocument()
    expect(screen.getByText(/Card/)).toBeInTheDocument()
  })

  it('counts the day in the till\'s own timezone, not UTC', async () => {
    mockDay()
    render(<OrderHistory />)

    await screen.findByText("Day's takings")
    const call = api.get.mock.calls.find(([url]) => url === '/orders/takings')
    expect(call[1].params.tz_offset).toBe(-new Date().getTimezoneOffset())
  })

  it('names bills whose method was never recorded rather than hiding them', async () => {
    mockDay({ takings: { ...TAKINGS, by_method: [{ method: null, bill_count: 1, order_count: 1, total: 5000 }] } })
    render(<OrderHistory />)

    expect(await screen.findByText(/Method not recorded/)).toBeInTheDocument()
  })

  it('flags money that has not been collected yet', async () => {
    mockDay({ takings: { ...TAKINGS, unpaid_order_count: 2, unpaid_total: 9000 } })
    render(<OrderHistory />)

    expect(await screen.findByText(/have not been paid for yet/)).toBeInTheDocument()
    expect(screen.getByText(/90\.00/)).toBeInTheDocument()
  })

  it('says nothing about uncollected money when there is none', async () => {
    mockDay()
    render(<OrderHistory />)

    await screen.findByText("Day's takings")
    expect(screen.queryByText(/have not been paid for yet/)).not.toBeInTheDocument()
  })

  it('shows a dash rather than a zero for an unpriced menu', async () => {
    mockDay({ takings: { ...TAKINGS, total: null, by_method: [] } })
    render(<OrderHistory />)

    await screen.findByText("Day's takings")
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('re-reads the takings when another day is picked', async () => {
    mockDay()
    const { container } = render(<OrderHistory />)
    await screen.findByText("Day's takings")

    fireEvent.change(container.querySelector('input[type=date]'), { target: { value: '2026-08-01' } })

    await waitFor(() => {
      const dates = api.get.mock.calls
        .filter(([url]) => url === '/orders/takings')
        .map(([, cfg]) => cfg.params.date)
      expect(dates).toContain('2026-08-01')
    })
  })
})
