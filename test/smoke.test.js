'use strict'

const { describe, it, expect, beforeAll, afterAll } = require('bun:test')

// NOTE: the tests below are sequential and stateful (they share one server
// and one in-memory cache), so their order matters.
describe('cache middleware', () => {
  const server = require('restana')()
  let baseUrl

  // unlike got, fetch does not throw on non-2xx responses: status codes are
  // asserted explicitly, and bodies are always consumed
  const request = async (path, init) => {
    const res = await fetch(baseUrl + path, init)
    const body = await res.text()

    return { res, body }
  }

  beforeAll(async () => {
    const middleware = require('./../index')()
    server.use((req, res, next) => {
      if (req.url === '/cache-disabled') {
        req.cacheDisabled = true
      }

      next()
    })
    server.use((req, res, next) => {
      if (req.url === '/custom-cache-key') {
        req.cacheKey = 'my-custom-cache-key'
      }

      next()
    })

    server.use(middleware)

    server.get('/health', (req, res) => {
      res.send()
    })

    server.get('/cache-disabled', (req, res) => {
      setTimeout(() => {
        res.setHeader('x-cache-timeout', '1 minute')
        res.send('hello')
      }, 50)
    })

    server.get('/custom-cache-key', (req, res) => {
      res.send(req.cacheKey)
    })

    server.get('/cache', (req, res) => {
      setTimeout(() => {
        res.setHeader('x-cache-timeout', '1 minute')
        res.send('hello')
      }, 50)
    })

    server.get('/cache-buffer', (req, res) => {
      setTimeout(() => {
        res.setHeader('x-cache-timeout', '1 minute')
        res.setHeader('etag', '1')
        res.setHeader('cache-control', 'no-cache')
        res.send(Buffer.from('world'))
      }, 50)
    })

    server.get('/cache-no-maxage', (req, res) => {
      res.setHeader('etag', '1')
      res.setHeader('cache-control', 'no-cache')
      res.send('!maxage')
    })

    server.get('/cache-control', (req, res) => {
      res.setHeader('cache-control', 'max-age=60')
      res.setHeader('etag', '1')
      res.send('cache')
    })

    server.delete('/cache', (req, res) => {
      res.setHeader('x-cache-expire', '*/cache')
      res.end()
    })

    server.delete('/cache2', (req, res) => {
      res.setHeader('x-cache-expire', '*/cache*')
      res.end()
    })

    // ephemeral port, so the suite never collides with anything else
    const httpServer = await server.start(0, '127.0.0.1')
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`
  })

  afterAll(async () => {
    // drop idle keep-alive sockets held by fetch, otherwise close() waits on them
    server.getServer().closeAllConnections()
    await server.close()
  })

  it('no-cache', async () => {
    const { res } = await request('/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-cache-hit')).toBeNull()
  })

  it('cache disabled', async () => {
    const first = await request('/cache-disabled')
    expect(first.res.status).toBe(200)
    const { res } = await request('/cache-disabled')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-cache-hit')).toBeNull()
  })

  it('custom cache key', async () => {
    const { res, body } = await request('/custom-cache-key')
    expect(res.status).toBe(200)
    expect(body).toBe('my-custom-cache-key')
  })

  it('create cache', async () => {
    const { res, body } = await request('/cache')
    expect(res.status).toBe(200)
    expect(body).toBe('hello')
    expect(res.headers.get('x-cache-hit')).toBeNull()
  })

  it('cache hit', async () => {
    const { res, body } = await request('/cache')
    expect(res.status).toBe(200)
    expect(body).toBe('hello')
    expect(res.headers.get('x-cache-hit')).toBe('1')
  })

  it('cache expire', async () => {
    const { res } = await request('/cache', { method: 'DELETE' })
    expect(res.status).toBe(200)
  })

  it('re-create cache', async () => {
    const { res, body } = await request('/cache')
    expect(res.status).toBe(200)
    expect(body).toBe('hello')
    expect(res.headers.get('x-cache-hit')).toBeNull()
  })

  it('cache expire using wildcard', async () => {
    const { res } = await request('/cache2', { method: 'DELETE' })
    expect(res.status).toBe(200)
  })

  it('re-create cache', async () => {
    const { res, body } = await request('/cache')
    expect(res.status).toBe(200)
    expect(body).toBe('hello')
    expect(res.headers.get('x-cache-hit')).toBeNull()
  })

  it('create cache (buffer)', async () => {
    const { res, body } = await request('/cache-buffer')
    expect(res.status).toBe(200)
    expect(body).toBe('world')
    expect(res.headers.get('x-cache-hit')).toBeNull()
  })

  it('no TTL detected', async () => {
    const first = await request('/cache-no-maxage')
    expect(first.res.status).toBe(200)
    const { res, body } = await request('/cache-no-maxage')
    expect(res.status).toBe(200)
    expect(body).toBe('!maxage')
    expect(res.headers.get('x-cache-hit')).toBeNull()
  })

  it('cache hit (buffer)', async () => {
    const { res, body } = await request('/cache-buffer')
    expect(res.status).toBe(200)
    expect(body).toBe('world')
    expect(res.headers.get('x-cache-hit')).toBe('1')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('etag')).toBe('1')
  })

  it('cache hit (buffer) - Etag', async () => {
    const { res, body } = await request('/cache-buffer')
    expect(res.status).toBe(200)
    expect(body).toBe('world')
    expect(res.headers.get('x-cache-hit')).toBe('1')
    expect(res.headers.get('etag')).toBe('1')
  })

  it('cache hit (buffer) - If-None-Match', async () => {
    const { res } = await request('/cache-buffer', {
      headers: {
        'If-None-Match': '1'
      }
    })
    expect(res.status).toBe(304)
  })

  it('cache create - cache-control', async () => {
    const { res, body } = await request('/cache-control')
    expect(res.status).toBe(200)
    expect(body).toBe('cache')
  })

  it('cache hit - cache-control', async () => {
    const { res, body } = await request('/cache-control')
    expect(res.status).toBe(200)
    expect(body).toBe('cache')
    expect(res.headers.get('x-cache-hit')).toBe('1')
  })
})
