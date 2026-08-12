import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import Settings from './Settings'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../lib/api', () => ({
  default: {
    get: vi.fn(),
    put: vi.fn(() => Promise.resolve({ data: {} })),
  },
}))

vi.mock('@clerk/clerk-react', () => ({
  useOrganization: vi.fn(),
}))

import api from '../lib/api'
import { useOrganization } from '@clerk/clerk-react'

// Helpers to set up API responses for each test
function mockEmptySettings() {
  api.get.mockImplementation((url) => {
    if (url === '/settings/') return Promise.resolve({ data: [] })
    if (url === '/menu/kitchens/me') return Promise.reject({ response: { status: 404 } })
    return Promise.reject(new Error(`Unexpected GET ${url}`))
  })
}

function mockSettingsWithKitchenName(name) {
  api.get.mockImplementation((url) => {
    if (url === '/settings/') return Promise.resolve({
      data: [{ key: 'kitchen_name', value: name }],
    })
    if (url === '/menu/kitchens/me') return Promise.reject({ response: { status: 404 } })
    return Promise.reject(new Error(`Unexpected GET ${url}`))
  })
}

function mockSettings(settings, slug) {
  api.get.mockImplementation((url) => {
    if (url === '/settings/') return Promise.resolve({ data: settings })
    if (url === '/menu/kitchens/me') {
      return slug
        ? Promise.resolve({ data: { slug } })
        : Promise.reject({ response: { status: 404 } })
    }
    return Promise.reject(new Error(`Unexpected GET ${url}`))
  })
}

// ── Customer URL preview ──────────────────────────────────────────────────────

describe('Settings — customer URL preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useOrganization.mockReturnValue({ organization: null })
  })

  it('builds the preview from Frontend URL so it matches what QR codes encode', async () => {
    mockSettings([{ key: 'frontend_url', value: 'https://order.example.com' }], 'matts-baps')

    render(<Settings authMode="cloud" />)

    await waitFor(() => {
      expect(screen.getByText('https://order.example.com/k/matts-baps')).toBeInTheDocument()
    })
  })

  it('falls back to the admin origin with the admin. prefix stripped', async () => {
    mockSettings([], 'matts-baps')

    render(<Settings authMode="cloud" />)

    await waitFor(() => {
      expect(screen.getByText(`${window.location.origin}/k/matts-baps`)).toBeInTheDocument()
    })
  })
})

// ── kitchen_name pre-fill from Clerk ──────────────────────────────────────────

describe('Settings — kitchen name pre-fill from Clerk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pre-fills kitchen name from Clerk org name when settings return empty', async () => {
    useOrganization.mockReturnValue({ organization: { name: "Matt's Baps", slug: 'matts-baps' } })
    mockEmptySettings()

    render(<Settings authMode="cloud" />)

    await waitFor(() => {
      const input = screen.getByPlaceholderText('e.g. The Garden Kitchen')
      expect(input.value).toBe("Matt's Baps")
    })
  })

  it('shows a banner when kitchen name is pre-filled from Clerk', async () => {
    useOrganization.mockReturnValue({ organization: { name: "Matt's Baps", slug: 'matts-baps' } })
    mockEmptySettings()

    render(<Settings authMode="cloud" />)

    await waitFor(() => {
      expect(screen.getByText(/Kitchen name pre-filled from your Clerk organization/i)).toBeInTheDocument()
    })
  })

  it('does not pre-fill kitchen name when settings already has a value', async () => {
    useOrganization.mockReturnValue({ organization: { name: "Matt's Baps", slug: 'matts-baps' } })
    mockSettingsWithKitchenName('My Custom Kitchen')

    render(<Settings authMode="cloud" />)

    await waitFor(() => {
      const input = screen.getByPlaceholderText('e.g. The Garden Kitchen')
      expect(input.value).toBe('My Custom Kitchen')
    })
    expect(screen.queryByText(/Kitchen name pre-filled from your Clerk organization/i)).not.toBeInTheDocument()
  })

  it('does not pre-fill kitchen name when Clerk org name is unavailable', async () => {
    useOrganization.mockReturnValue({ organization: null })
    mockEmptySettings()

    render(<Settings authMode="cloud" />)

    await waitFor(() => {
      // API call completes — input stays empty
      expect(api.get).toHaveBeenCalledWith('/settings/')
    })
    const input = screen.getByPlaceholderText('e.g. The Garden Kitchen')
    expect(input.value).toBe('')
    expect(screen.queryByText(/Kitchen name pre-filled from your Clerk organization/i)).not.toBeInTheDocument()
  })
})
