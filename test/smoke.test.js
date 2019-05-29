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
        res.send(Buffer.from('world'))
      }, 50)
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

  it('cache hit (buffer)', async () => {
    const res = await got('http://localhost:3000/cache-buffer')
    expect(res.body).to.equal('world')
    expect(res.headers['x-cache-hit']).to.equal('1')
  })

  it('close', async () => {
    return server.close()
  })
})
