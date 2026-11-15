'use strict'

const { describe, it, expect, afterEach } = require('bun:test')
const CacheManager = require('cache-manager')
const { memoryCache, serve, waitFor } = require('./helpers')

// A cache-manager v4 store backed by a memory store, where any method can be replaced to inject failures
const fakeCache = (overrides) => {
  const memory = memoryCache().store

  return CacheManager.caching({
    store: Object.assign({
      name: 'fake',
      get: (key, options, cb) => memory.get(key, options, cb),
      set: (key, value, options, cb) => memory.set(key, value, options, cb),
      del: (keys) => memory.del(keys),
      keys: (cb) => memory.keys(cb)
    }, overrides)
  })
}

describe('cache failures', () => {
  let app
  const calls = {}

  const routes = {
    '/items': (req, res) => {
      calls[req.url] = (calls[req.url] || 0) + 1
      if (req.method === 'DELETE') {
        res.setHeader('x-cache-expire', req.headers['x-pattern'])
        return res.end('deleted')
      }
      res.setHeader('x-cache-timeout', '1 minute')
      res.end(`items #${calls[req.url]}`)
    }
  }

  const start = async (opts) => {
    app = await serve(require('./../index')(opts), routes)
  }

  afterEach(async () => {
    await app.close()
    delete calls['/items']
  })

  it('serves the request as a miss when the store fails reading', async () => {
    const errors = []
    let fail = 'callback'
    const cache = fakeCache({
      get: (key, options, cb) => {
        if (fail === 'callback') return cb(new Error('get failed'))
        throw new Error('get threw')
      }
    })
    await start({ stores: [cache], onError: (err) => errors.push(err) })

    const first = await app.request('/items')
    expect(first.status).toBe(200)
    expect(first.text).toBe('items #1')
    expect(errors.map(err => err.message)).toEqual(['get failed'])

    // the response was stored, but the store keeps failing
    expect(await cache.store.keys()).toEqual(['GET/items'])
    fail = 'throw'
    const second = await app.request('/items')
    expect(second.text).toBe('items #2')
    expect(second.headers.get('x-cache-hit')).toBeNull()
    expect(errors.map(err => err.message)).toEqual(['get failed', 'get threw'])
  })

  it('reports store write failures without affecting the response', async () => {
    const errors = []
    const failure = new Error('set failed')
    await start({
      stores: [fakeCache({ set: (key, value, options, cb) => setImmediate(() => cb(failure)) })],
      onError: (err) => errors.push(err)
    })

    const res = await app.request('/items')
    expect(res.status).toBe(200)
    expect(res.text).toBe('items #1')
    expect(await waitFor(() => errors.length > 0)).toBe(true)
    expect(errors).toEqual([failure])

    expect((await app.request('/items')).text).toBe('items #2')
  })

  it('reports failures listing keys while expiring', async () => {
    const errors = []
    const failure = new Error('keys failed')
    await start({
      stores: [fakeCache({ keys: (cb) => setImmediate(() => cb(failure)) })],
      onError: (err) => errors.push(err)
    })

    const res = await app.request('/items', { method: 'DELETE', headers: { 'x-pattern': '*/items' } })
    expect(res.status).toBe(200)
    expect(res.text).toBe('deleted')
    expect(await waitFor(() => errors.length > 0)).toBe(true)
    expect(errors).toEqual([failure])
  })

  it('reports failures deleting keys while expiring', async () => {
    const errors = []
    const failure = new Error('del failed')
    await start({
      stores: [fakeCache({ del: () => Promise.reject(failure) })],
      onError: (err) => errors.push(err)
    })

    const res = await app.request('/items', { method: 'DELETE', headers: { 'x-pattern': 'GET/items' } })
    expect(res.status).toBe(200)
    expect(await waitFor(() => errors.length > 0)).toBe(true)
    expect(errors).toEqual([failure])
  })

  it('reports wildcard expirations on stores that can not list keys', async () => {
    const errors = []
    await start({
      stores: [fakeCache({ keys: undefined })],
      onError: (err) => errors.push(err)
    })

    const res = await app.request('/items', { method: 'DELETE', headers: { 'x-pattern': '*/items' } })
    expect(res.status).toBe(200)
    expect(await waitFor(() => errors.length > 0)).toBe(true)
    expect(errors[0].message).toBe('Cache store does not support listing keys, wildcard patterns can not be expired!')
  })

  it('ignores cache failures by default', async () => {
    // any unhandled rejection or uncaught exception would fail this test
    let sets = 0
    const cache = fakeCache({
      get: (key, options, cb) => cb(new Error('get failed')),
      set: (key, value, options, cb) => {
        sets++
        cb(new Error('set failed'))
      },
      keys: (cb) => cb(new Error('keys failed'))
    })
    await start({ stores: [cache] })

    expect((await app.request('/items')).text).toBe('items #1')
    expect((await app.request('/items')).text).toBe('items #2')
    expect((await app.request('/items', { method: 'DELETE', headers: { 'x-pattern': '*' } })).status).toBe(200)
    expect(await waitFor(() => sets === 2)).toBe(true)
  })

  // i.e. `{ onError: config.onError }`
  it('tolerates an onError callback that throws', async () => {
    let reported = 0
    const cache = fakeCache({
      get: (key, options, cb) => cb(new Error('get failed')),
      set: (key, value, options, cb) => cb(new Error('set failed'))
    })
    await start({
      stores: [cache],
      onError: () => {
        reported++
        throw new Error('onError failed')
      }
    })

    const res = await app.request('/items')
    expect(res.status).toBe(200)
    expect(res.text).toBe('items #1')
    // both the failed lookup and the failed write were reported
    expect(await waitFor(() => reported === 2)).toBe(true)
    expect(app.errors).toEqual([])
  })

  it('tolerates an explicit undefined onError option', async () => {
    const cache = memoryCache()
    await cache.set('GET/items', 'not { json')
    await start({ stores: [cache], onError: undefined })

    const res = await app.request('/items')
    expect(res.status).toBe(200)
    expect(res.text).toBe('items #1')
  })
})
