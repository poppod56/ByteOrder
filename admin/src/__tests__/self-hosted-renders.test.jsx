/**
 * Self-hosted deployments never mount a ClerkProvider (see main.jsx), and Clerk
 * hooks throw when called without one. Every other admin test mocks
 * @clerk/clerk-react, which is exactly why a broken self-hosted admin panel went
 * unnoticed: the mock stood in for a provider that isn't there at runtime.
 *
 * These tests deliberately use the real Clerk package and no provider, so they
 * fail the way the browser does.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../lib/api', () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: [] })),
    put: vi.fn(() => Promise.resolve({ data: {} })),
    post: vi.fn(() => Promise.resolve({ data: [] })),
    delete: vi.fn(() => Promise.resolve({})),
  },
  setupApiInterceptors: vi.fn(),
  setupSelfHostedInterceptors: vi.fn(),
}))

// jsdom has no EventSource; the order queue opens one on mount.
class MockEventSource {
  constructor() {
    this.onmessage = null
    this.onerror = null
    this.close = vi.fn()
  }
}
// Assigned as the class itself — an arrow function cannot be called with `new`.
global.EventSource = MockEventSource

import Layout from '../components/Layout'
import Settings from '../pages/Settings'
import App from '../App'

describe('self-hosted admin — no ClerkProvider in the tree', () => {
  it('renders the shared layout', () => {
    expect(() =>
      render(<MemoryRouter><Layout onSignOut={() => {}} /></MemoryRouter>)
    ).not.toThrow()
  })

  it('renders Settings', () => {
    expect(() =>
      render(<MemoryRouter><Settings authMode="self-hosted" /></MemoryRouter>)
    ).not.toThrow()
  })

  it('reaches the order queue after login, rather than a blank screen', () => {
    localStorage.setItem('token', 'a-self-hosted-jwt')
    try {
      render(
        <MemoryRouter initialEntries={['/orders']}>
          <App authMode="self-hosted" />
        </MemoryRouter>
      )
      expect(screen.getByText('Order Queue')).toBeInTheDocument()
      expect(screen.getByText('Tables')).toBeInTheDocument()
    } finally {
      localStorage.removeItem('token')
    }
  })

  it('redirects to login without a token', () => {
    render(
      <MemoryRouter initialEntries={['/orders']}>
        <App authMode="self-hosted" />
      </MemoryRouter>
    )
    expect(screen.queryByText('Order Queue')).not.toBeInTheDocument()
  })

  it('signs out by clearing the local token', async () => {
    localStorage.setItem('token', 'a-self-hosted-jwt')
    const { unmount } = render(
      <MemoryRouter initialEntries={['/orders']}>
        <App authMode="self-hosted" />
      </MemoryRouter>
    )
    // jsdom refuses real navigation, so only the token clearing is asserted.
    try {
      screen.getByText('Log out').click()
    } catch {
      // navigation attempt — ignore
    }
    expect(localStorage.getItem('token')).toBeNull()
    unmount()
  })
})
