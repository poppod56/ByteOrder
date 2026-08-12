import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../contexts/KitchenContext', () => ({
  KitchenProvider: ({ children }) => children,
  useKitchen: () => ({ kitchenId: 'test-kitchen', slug: null }),
}))

let frontendUrlSetting = null

vi.mock('../lib/api', () => ({
  menuApi: {
    get: vi.fn((path) => {
      if (path.includes('kitchen_name')) return Promise.resolve({ data: { value: 'Test Kitchen' } })
      if (path.includes('logo')) return Promise.resolve({ data: { value: null } })
      if (path.includes('brand_primary')) return Promise.resolve({ data: { value: '#ea580c' } })
      if (path.includes('frontend_url')) return Promise.resolve({ data: { value: frontendUrlSetting } })
      return Promise.resolve({ data: {} })
    }),
  },
  orderApi: {
    get: vi.fn(() => Promise.resolve({ data: [] })),
  },
  setKitchenId: vi.fn(),
}))

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }) => <div data-testid="qr-code">{value}</div>,
}))

import Home from '../pages/Home'

beforeEach(() => {
  frontendUrlSetting = null
})

describe('Home — kiosk QR target', () => {
  it('encodes the configured Frontend URL, not the address the kiosk is loaded on', async () => {
    frontendUrlSetting = 'https://order.example.com'
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    )
    expect(await screen.findByText('https://order.example.com/order')).toBeInTheDocument()
  })

  it('strips a trailing slash', async () => {
    frontendUrlSetting = 'https://order.example.com/'
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    )
    expect(await screen.findByText('https://order.example.com/order')).toBeInTheDocument()
  })

  it('falls back to the current origin when unset', async () => {
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    )
    expect(await screen.findByText(`${window.location.origin}/order`)).toBeInTheDocument()
  })
})

describe('Home', () => {
  it('renders without crashing', () => {
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    )
    expect(document.body).toBeDefined()
  })

  it('shows Place Order link', () => {
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    )
    expect(screen.getByText('Place Order')).toBeDefined()
  })

  it('shows Track Order link', () => {
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    )
    expect(screen.getByText('Track Order')).toBeDefined()
  })

  it('shows empty queue message when no orders', () => {
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    )
    expect(screen.getByText(/No active orders/i)).toBeDefined()
  })
})
