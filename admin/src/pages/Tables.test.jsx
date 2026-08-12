import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Tables from './Tables'

vi.mock('../lib/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(() => Promise.resolve({ data: [] })),
    put: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({})),
  },
}))

// qrcode.react renders fine in jsdom but the SVG is noise for these assertions.
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }))

import api from '../lib/api'

const TABLE = { id: 1, kitchen_id: 'k', code: 'table-1', label: 'Table 1', active: true, created_at: '2026-01-01T00:00:00' }

function mockApi({ settings = [], slug = null, tables = [TABLE] } = {}) {
  api.get.mockImplementation(url => {
    if (url === '/orders/tables/') return Promise.resolve({ data: tables })
    if (url === '/settings/') return Promise.resolve({ data: settings })
    if (url === '/menu/kitchens/me') {
      return slug
        ? Promise.resolve({ data: { slug } })
        : Promise.reject({ response: { status: 404 } })
    }
    return Promise.reject(new Error(`Unexpected GET ${url}`))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Tables — QR target URL', () => {
  // Each URL is rendered twice: once in the on-screen list, once on the print sheet.
  it('builds the URL from the configured customer site, not the admin origin', async () => {
    mockApi({ settings: [{ key: 'frontend_url', value: 'https://order.example.com' }] })
    render(<Tables />)

    expect(await screen.findAllByText('https://order.example.com/order?t=table-1')).toHaveLength(2)
  })

  it('includes the kitchen slug when the deployment is multi-tenant', async () => {
    mockApi({
      settings: [{ key: 'frontend_url', value: 'https://byteorder.app' }],
      slug: 'matts-baps',
    })
    render(<Tables />)

    expect(await screen.findAllByText('https://byteorder.app/k/matts-baps/order?t=table-1')).toHaveLength(2)
  })

  it('strips a trailing slash from the configured URL', async () => {
    mockApi({ settings: [{ key: 'frontend_url', value: 'https://order.example.com/' }] })
    render(<Tables />)

    expect(await screen.findAllByText('https://order.example.com/order?t=table-1')).toHaveLength(2)
  })

  it('warns that the printed QR target is only a guess when unconfigured', async () => {
    mockApi({ settings: [] })
    render(<Tables />)

    expect(await screen.findByText('Customer site URL')).toBeInTheDocument()
  })

  it('hides the warning once a customer site URL is set', async () => {
    mockApi({ settings: [{ key: 'frontend_url', value: 'https://order.example.com' }] })
    render(<Tables />)

    await screen.findAllByText('https://order.example.com/order?t=table-1')
    expect(screen.queryByText('Customer site URL')).not.toBeInTheDocument()
  })
})

describe('Tables — listing', () => {
  it('prompts to add tables when there are none', async () => {
    mockApi({ tables: [] })
    render(<Tables />)

    expect(await screen.findByText(/No tables yet/i)).toBeInTheDocument()
  })

  it('offers the print sheet only once tables exist', async () => {
    mockApi({ tables: [] })
    const { unmount } = render(<Tables />)
    await screen.findByText(/No tables yet/i)
    expect(screen.queryByText('Print QR sheet')).not.toBeInTheDocument()
    unmount()

    mockApi({ tables: [TABLE] })
    render(<Tables />)
    expect(await screen.findByText('Print QR sheet')).toBeInTheDocument()
  })

  it('sends the entered name and count when adding', async () => {
    mockApi()
    api.post.mockResolvedValue({ data: [{ ...TABLE, id: 2, label: 'Patio 1', code: 'patio-1' }] })
    render(<Tables />)
    await screen.findAllByText('Table 1')

    await userEvent.type(screen.getByPlaceholderText('Table'), 'Patio')
    await userEvent.clear(screen.getByLabelText('How many'))
    await userEvent.type(screen.getByLabelText('How many'), '3')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/orders/tables/', { label: 'Patio', count: 3 })
    })
  })

  it('surfaces the API error message when adding fails', async () => {
    mockApi()
    api.post.mockRejectedValue({ response: { data: { detail: "Code 'table-1' is already in use" } } })
    render(<Tables />)
    await screen.findAllByText('Table 1')

    await userEvent.type(screen.getByPlaceholderText('Table'), 'Patio')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(screen.getByText("Code 'table-1' is already in use")).toBeInTheDocument()
    })
  })
})
