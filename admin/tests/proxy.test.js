const request = require('supertest')
const jwt = require('jsonwebtoken')

process.env.AUTH_MODE = 'self-hosted'
process.env.ADMIN_USERNAME = 'admin'
process.env.ADMIN_PASSWORD = 'testpass'

// JWT_SECRET must match what the middleware uses
const JWT_SECRET = process.env.JWT_SECRET || 'byteorder-dev-secret-change-in-production'

// Mock axios before requiring app so all route handlers use the mock
jest.mock('axios')
const axios = require('axios')

const app = require('../server/app')

function makeToken(username = 'admin') {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256' })
}

beforeEach(() => {
  jest.clearAllMocks()
})

// ── Unauthenticated requests ──────────────────────────────────────────────────

describe('Unauthenticated requests are rejected', () => {
  it('rejects GET /api/menu/ without token', async () => {
    const res = await request(app).get('/api/menu/')
    expect(res.status).toBe(401)
  })

  it('rejects GET /api/orders/ without token', async () => {
    const res = await request(app).get('/api/orders/')
    expect(res.status).toBe(401)
  })

  it('rejects GET /api/settings/ without token', async () => {
    const res = await request(app).get('/api/settings/')
    expect(res.status).toBe(401)
  })
})

// ── Menu proxy ────────────────────────────────────────────────────────────────

describe('GET /api/menu/* proxies to menu-service', () => {
  it('forwards authenticated request and returns proxied data', async () => {
    const mockCategories = [{ id: 1, name: 'Burgers' }]
    axios.mockResolvedValueOnce({ status: 200, data: mockCategories })

    const token = makeToken()
    const res = await request(app)
      .get('/api/menu/categories/')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual(mockCategories)
    expect(axios).toHaveBeenCalledTimes(1)
    const callArg = axios.mock.calls[0][0]
    expect(callArg.url).toContain('/categories/')
    expect(callArg.headers['X-Kitchen-ID']).toBeDefined()
  })

  it('propagates upstream error status', async () => {
    const err = new Error('Not found')
    err.response = { status: 404, data: { detail: 'Not found' } }
    axios.mockRejectedValueOnce(err)

    const token = makeToken()
    const res = await request(app)
      .get('/api/menu/categories/9999')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(404)
  })
})

// ── Orders proxy ──────────────────────────────────────────────────────────────

describe('GET /api/orders/* proxies to order-service', () => {
  it('forwards authenticated request and returns proxied data', async () => {
    const mockOrders = [{ id: 1, customer_name: 'Alice', status: 'pending' }]
    axios.mockResolvedValueOnce({ status: 200, data: mockOrders })

    const token = makeToken()
    const res = await request(app)
      .get('/api/orders/queue')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual(mockOrders)
    const callArg = axios.mock.calls[0][0]
    expect(callArg.url).toContain('/orders/queue')
  })
})

// ── Settings proxy ────────────────────────────────────────────────────────────

describe('GET /api/settings/* proxies to menu-service settings', () => {
  it('forwards authenticated request and returns proxied data', async () => {
    const mockSetting = { key: 'kitchen_name', value: 'My Kitchen' }
    axios.mockResolvedValueOnce({ status: 200, data: mockSetting })

    const token = makeToken()
    const res = await request(app)
      .get('/api/settings/kitchen_name')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual(mockSetting)
    const callArg = axios.mock.calls[0][0]
    expect(callArg.url).toContain('/settings/kitchen_name')
  })
})

// ── Item images are binary, not JSON ─────────────────────────────────────────
// res.json() would turn image bytes into a JSON string of the buffer, so the
// image route has to ask axios for binary and pass the body straight through.

describe('GET /api/menu/items/:id/image passes bytes through', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAABzenr0AAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
    'base64',
  )

  it('returns the bytes with the upstream content type', async () => {
    axios.mockResolvedValueOnce({
      status: 200,
      data: PNG,
      headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=300' },
    })

    const res = await request(app)
      .get('/api/menu/items/5/image')
      .set('Authorization', `Bearer ${makeToken()}`)

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['cache-control']).toBe('public, max-age=300')
    expect(Buffer.from(res.body)).toEqual(PNG)
    expect(axios.mock.calls[0][0].responseType).toBe('arraybuffer')
  })

  it('keeps an error body readable even though the request wanted binary', async () => {
    // axios hands back a Buffer for the error body too, which would reach the
    // client as an unreadable blob if passed on as-is.
    axios.mockRejectedValueOnce({
      response: { status: 404, data: Buffer.from(JSON.stringify({ detail: 'No image for this item' })) },
    })

    const res = await request(app)
      .get('/api/menu/items/5/image')
      .set('Authorization', `Bearer ${makeToken()}`)

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ detail: 'No image for this item' })
  })

  it('still asks for JSON on every other menu route', async () => {
    axios.mockResolvedValueOnce({ status: 200, data: [{ id: 1 }] })

    await request(app)
      .get('/api/menu/items/')
      .set('Authorization', `Bearer ${makeToken()}`)

    expect(axios.mock.calls[0][0].responseType).toBe('json')
  })

  it('uploads an image as JSON, not binary', async () => {
    axios.mockResolvedValueOnce({ status: 200, data: { id: 5, has_image: true } })

    const res = await request(app)
      .put('/api/menu/items/5/image')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ data_url: 'data:image/png;base64,AAAA' })

    expect(res.status).toBe(200)
    expect(axios.mock.calls[0][0].responseType).toBe('json')
  })
})
