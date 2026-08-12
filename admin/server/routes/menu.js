const express = require('express')
const axios = require('axios')

const router = express.Router()
const MENU_SERVICE = process.env.MENU_SERVICE_URL || 'http://menu-service:8000'
const AUTH_MODE = process.env.AUTH_MODE || 'cloud'

function getKitchenId(req) {
  if (AUTH_MODE === 'self-hosted') return process.env.DEFAULT_KITCHEN_ID || 'default'
  // @clerk/express v2: req.auth is a function, not an object — must call it.
  // Fall back to userId so personal-account (no-org) users each get their own kitchen.
  const auth = req.auth?.()
  return auth?.orgId || auth?.userId
}

router.all('/{*path}', async (req, res) => {
  const kitchenId = getKitchenId(req)
  if (!kitchenId) {
    return res.status(403).json({ error: 'No organization selected' })
  }

  // Item photos come back as image bytes. Forcing every response through
  // res.json() turns them into a JSON string of the buffer, so the request has to
  // be told to expect binary and the body passed straight through.
  const wantsBinary = /\/items\/\d+\/image\/?$/.test(req.path) && req.method === 'GET'

  try {
    const response = await axios({
      method: req.method,
      url: `${MENU_SERVICE}${req.path}`,
      params: req.query,
      data: req.body,
      headers: { 'Content-Type': 'application/json', 'X-Kitchen-ID': kitchenId },
      responseType: wantsBinary ? 'arraybuffer' : 'json',
    })

    if (wantsBinary) {
      const contentType = response.headers['content-type']
      if (contentType) res.setHeader('Content-Type', contentType)
      const cacheControl = response.headers['cache-control']
      if (cacheControl) res.setHeader('Cache-Control', cacheControl)
      return res.status(response.status).send(Buffer.from(response.data))
    }

    res.status(response.status).json(response.data)
  } catch (err) {
    const status = err.response?.status || 500
    // An arraybuffer error body is a Buffer, not an object — decode it before
    // trying to pass it on, or the client gets an unreadable blob of bytes.
    let body = err.response?.data
    if (body && Buffer.isBuffer(body)) {
      try {
        body = JSON.parse(body.toString('utf8'))
      } catch {
        body = { error: 'Menu service error' }
      }
    }
    res.status(status).json(body || { error: 'Menu service error' })
  }
})

module.exports = router
