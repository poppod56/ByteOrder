import { vi } from 'vitest'
import '@testing-library/jest-dom'

// EventSource is not available in jsdom — provide a minimal stub.
// Must be a class (or regular function), not an arrow function, because
// Home.jsx calls `new EventSource(...)` and arrow functions cannot be constructors.
class MockEventSource {
  constructor() {
    this.onmessage = null
    this.onerror = null
    this.close = vi.fn()
  }
}
global.EventSource = vi.fn().mockImplementation(function (url) {
  const instance = new MockEventSource()
  return instance
})

// jsdom has no IntersectionObserver; the ordering page uses one to keep the
// category tab in step with the scroll position.
global.IntersectionObserver = class {
  constructor(callback) { this.callback = callback }
  observe() {}
  unobserve() {}
  disconnect() {}
}

// jsdom does not implement scrollIntoView.
Element.prototype.scrollIntoView = vi.fn()
