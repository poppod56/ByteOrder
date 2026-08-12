import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
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
// Echo the props the sheet controls drive, so they can be asserted.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value, fgColor }) => <div data-testid="qr" data-colour={fgColor} data-value={value} />,
}))

import api from '../lib/api'

const TABLE = {
  id: 1, kitchen_id: 'k', code: 'table-1', label: 'Table 1', active: true,
  code_printed_at: '2026-01-01T00:00:00', created_at: '2026-01-01T00:00:00',
}
const UNPRINTED = { ...TABLE, code_printed_at: null }

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

    expect(await screen.findByText('Frontend URL')).toBeInTheDocument()
  })

  it('hides the warning once a customer site URL is set', async () => {
    mockApi({ settings: [{ key: 'frontend_url', value: 'https://order.example.com' }] })
    render(<Tables />)

    await screen.findAllByText('https://order.example.com/order?t=table-1')
    expect(screen.queryByText('Frontend URL')).not.toBeInTheDocument()
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

  it('warns about codes the server says are unprinted', async () => {
    mockApi({ tables: [UNPRINTED] })
    render(<Tables />)

    expect(await screen.findByText(/has a QR code that has not been printed yet/i)).toBeInTheDocument()
  })

  it('stays quiet once the server says the code was printed', async () => {
    mockApi({ tables: [TABLE] })
    render(<Tables />)

    await screen.findAllByText('Table 1')
    expect(screen.queryByText(/not been printed yet/i)).not.toBeInTheDocument()
  })

  it('rotates and reloads so the warning comes from the server, not this session', async () => {
    mockApi({ tables: [TABLE] })
    api.post.mockResolvedValue({ data: UNPRINTED })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<Tables />)
    await screen.findAllByText('Table 1')

    await userEvent.click(screen.getByRole('button', { name: 'New QR' }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/orders/tables/1/rotate'))
    // Re-fetched rather than tracked locally, so a refresh cannot lose the warning.
    expect(api.get).toHaveBeenCalledWith('/orders/tables/')
  })

  it('does not rotate when the confirmation is declined', async () => {
    mockApi()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<Tables />)
    await screen.findAllByText('Table 1')

    await userEvent.click(screen.getByRole('button', { name: 'New QR' }))

    expect(api.post).not.toHaveBeenCalled()
  })

  it('printing alone does not clear the warning', async () => {
    mockApi({ tables: [UNPRINTED] })
    vi.spyOn(window, 'print').mockImplementation(() => {})
    render(<Tables />)
    await screen.findByText(/not been printed yet/i)

    await userEvent.click(screen.getByRole('button', { name: 'Print QR sheet' }))

    // The dialog can be cancelled, and the paper still has to reach the table.
    expect(window.print).toHaveBeenCalled()
    expect(screen.getByText(/not been printed yet/i)).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('clears the warning only when the stickers are confirmed replaced', async () => {
    mockApi({ tables: [UNPRINTED] })
    api.post.mockResolvedValue({ data: [TABLE] })
    render(<Tables />)
    await screen.findByText(/not been printed yet/i)

    await userEvent.click(screen.getByRole('button', { name: /I've replaced the stickers/i }))

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/orders/tables/mark-printed', { ids: [1] })
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

describe('Tables — QR sheet controls', () => {
  it('previews the sheet on screen, not only on paper', async () => {
    mockApi({ settings: [{ key: 'frontend_url', value: 'https://order.example.com' }] })
    render(<Tables />)

    // One code per table, visible without opening the print dialog.
    expect(await screen.findAllByTestId('qr')).toHaveLength(1)
    expect(screen.getByText('QR sheet')).toBeInTheDocument()
  })

  it('sizes the code in millimetres so the preview matches the print', async () => {
    mockApi()
    render(<Tables />)
    await screen.findAllByText('Table 1')

    expect(document.getElementById('qr-1')).toHaveStyle({ width: '50mm' })

    fireEvent.change(screen.getByLabelText(/Code size/i), { target: { value: '80' } })

    expect(screen.getByLabelText(/Code size/i)).toHaveValue('80')
    expect(document.getElementById('qr-1')).toHaveStyle({ width: '80mm' })
  })

  it('lays the sheet out with the chosen number per row', async () => {
    mockApi()
    render(<Tables />)
    await screen.findAllByText('Table 1')

    await userEvent.selectOptions(screen.getByLabelText('Per row'), '2')

    expect(document.querySelector('.print-sheet')).toHaveStyle({
      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    })
  })

  it('follows the brand colour until one is picked', async () => {
    mockApi({ settings: [{ key: 'brand_primary', value: '#123456' }] })
    render(<Tables />)

    await waitFor(() => {
      expect(screen.getByTestId('qr')).toHaveAttribute('data-colour', '#123456')
    })

    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: '#00aa00' } })
    expect(screen.getByTestId('qr')).toHaveAttribute('data-colour', '#00aa00')

    await userEvent.click(screen.getByRole('button', { name: /Use brand colour/i }))
    expect(screen.getByTestId('qr')).toHaveAttribute('data-colour', '#123456')
  })

  it('can leave the URL off the printed sticker', async () => {
    mockApi({ settings: [{ key: 'frontend_url', value: 'https://order.example.com' }] })
    render(<Tables />)
    const url = 'https://order.example.com/order?t=table-1'
    expect(await screen.findAllByText(url)).toHaveLength(2)   // list + sheet

    await userEvent.click(screen.getByLabelText(/under each code/i))

    expect(screen.getAllByText(url)).toHaveLength(1)          // list only
  })
})
