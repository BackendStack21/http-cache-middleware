/* global describe, it */
const got = require('got')
const expect = require('chai').expect

describe('cache middleware', () => {
  const server = require('restana')()

  it('init', async () => {
    const middleware = require('./../index')()
    server.use((req, res, next) => {
      if (req.url === '/cache-disabled') {
        req.cacheDisabled = true
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
  })

  it('start', async () => {
    return server.start(3000)
  })

  it('no-cache', async () => {
    const res = await got('http://localhost:3000/health')
    expect(res.headers['x-cache-hit']).to.equal(undefined)
  })

  it('cache disabled', async () => {
    await got('http://localhost:3000/cache-disabled')
    const res = await got('http://localhost:3000/cache-disabled')
    expect(res.headers['x-cache-hit']).to.equal(undefined)
  })

  it('create cache', async () => {
    const res = await got('http://localhost:3000/cache')
    expect(res.body).to.equal('hello')
    expect(res.headers['x-cache-hit']).to.equal(undefined)
  })

  it('cache hit', async () => {
    const res = await got('http://localhost:3000/cache')
    expect(res.body).to.equal('hello')
    expect(res.headers['x-cache-hit']).to.equal('1')
  })

  it('cache expire', async () => {
    await got.delete('http://localhost:3000/cache')
  })

  it('create cache 2', async () => {
    const res = await got('http://localhost:3000/cache')
    expect(res.body).to.equal('hello')
    expect(res.headers['x-cache-hit']).to.equal(undefined)
  })

  it('create cache (buffer)', async () => {
    const res = await got('http://localhost:3000/cache-buffer')
    expect(res.body).to.equal('world')
    expect(res.headers['x-cache-hit']).to.equal(undefined)
  })

  it('no TTL detected', async () => {
    await got('http://localhost:3000/cache-no-maxage')
    const res = await got('http://localhost:3000/cache-no-maxage')
    expect(res.body).to.equal('!maxage')
    expect(res.headers['x-cache-hit']).to.equal(undefined)
  })

  it('cache hit (buffer)', async () => {
    const res = await got('http://localhost:3000/cache-buffer')
    expect(res.body).to.equal('world')
    expect(res.headers['x-cache-hit']).to.equal('1')
    expect(res.headers['cache-control']).to.equal('no-cache')
    expect(res.headers['etag']).to.equal('1')
  })

  it('cache hit (buffer) - Etag', async () => {
    const res = await got('http://localhost:3000/cache-buffer')
    expect(res.body).to.equal('world')
    expect(res.headers['x-cache-hit']).to.equal('1')
    expect(res.headers['etag']).to.equal('1')
  })

  it('cache hit (buffer) - If-None-Match', async () => {
    const res = await got('http://localhost:3000/cache-buffer', {
      headers: {
        'If-None-Match': '1'
      }
    })
    expect(res.statusCode).to.equal(304)
  })

  it('cache create - cache-control', async () => {
    const res = await got('http://localhost:3000/cache-control')
    expect(res.body).to.equal('cache')
  })

  it('cache hit - cache-control', async () => {
    const res = await got('http://localhost:3000/cache-control')
    expect(res.body).to.equal('cache')
    expect(res.headers['x-cache-hit']).to.equal('1')
  })

  it('close', async () => {
    return server.close()
  })
})
