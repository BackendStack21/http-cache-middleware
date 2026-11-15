'use strict'

const { describe, it, expect, beforeAll, afterAll } = require('bun:test')
const { memoryCache, serve } = require('./helpers')

describe('cache keys', () => {
  const cache = memoryCache()
  const calls = {}
  let app

  const handler = (req, res) => {
    calls[req.url] = (calls[req.url] || 0) + 1
    res.setHeader('x-cache-timeout', '1 minute')
    res.end(`${req.url} for ${req.headers['x-append'] || 'anonymous'} #${calls[req.url]}`)
  }
  const routes = {}
  for (const path of ['/profile', '/zero', '/me', '/me1', '/space', '/space x', '/rewritten', '/page', '/query', '/head', '/custom', '/custom-2', '/custom-head', '/disabled', '/error']) {
    routes[path] = handler
  }

  // plays the role of upstream middlewares
  const before = (req) => {
    const headers = req.headers
    if (headers['x-append'] !== undefined) {
      // asynchronous, the appended value is a JSON encoded header (i.e. 0, null, "" or 12)
      req.cacheAppendKey = async (req) => {
        await new Promise(resolve => setImmediate(resolve))

        return JSON.parse(req.headers['x-append'])
      }
    }
    if (headers['x-append-throws'] !== undefined) {
      req.cacheAppendKey = () => { throw new Error(headers['x-append-throws']) }
    }
    if (headers['x-decode'] !== undefined) {
      // i.e. a middleware normalizing URLs
      req.url = decodeURIComponent(req.url)
    }
    if (headers['x-rewrite'] !== undefined) {
      // i.e. a middleware rewriting URLs
      req.originalUrl = req.url
      req.url = headers['x-rewrite']
    }
    if (headers['x-mount'] !== undefined) {
      // i.e. a framework stripping the mount path (Express)
      req.baseUrl = headers['x-mount']
      req.url = req.url.slice(req.baseUrl.length)
    }
    if (headers['x-cache-key'] !== undefined) {
      req.cacheKey = headers['x-cache-key']
    }
    if (headers['x-cache-disabled'] !== undefined) {
      req.cacheDisabled = true
    }
  }

  beforeAll(async () => {
    app = await serve(require('./../index')({ stores: [cache] }), routes, before)
  })

  afterAll(() => app.close())

  const get = (path, headers = {}, method = 'GET') => app.request(path, { method, headers })
  const storedKeys = async (prefix) => (await cache.keys()).filter(key => key.startsWith(prefix)).sort()

  it('appends the (async) cacheAppendKey result to the key', async () => {
    expect((await get('/profile', { 'x-append': '12' })).text).toBe('/profile for 12 #1')
    expect((await get('/profile', { 'x-append': '7' })).text).toBe('/profile for 7 #2')

    const hit12 = await get('/profile', { 'x-append': '12' })
    expect(hit12.headers.get('x-cache-hit')).toBe('1')
    expect(hit12.text).toBe('/profile for 12 #1')
    const hit7 = await get('/profile', { 'x-append': '7' })
    expect(hit7.text).toBe('/profile for 7 #2')

    expect(await storedKeys('GET/profile')).toEqual(['GET/profile 12', 'GET/profile 7'])
  })

  it('appends non-string values, including 0, and skips null, undefined and empty values', async () => {
    expect((await get('/zero', { 'x-append': '0' })).text).toBe('/zero for 0 #1')
    expect((await get('/zero')).text).toBe('/zero for anonymous #2')
    expect((await get('/zero', { 'x-append': 'false' })).text).toBe('/zero for false #3')

    // user 0 must not get the anonymous response, and the other way around
    expect((await get('/zero', { 'x-append': '0' })).text).toBe('/zero for 0 #1')
    expect((await get('/zero')).text).toBe('/zero for anonymous #2')
    // null and "" are the same as no appended key
    expect((await get('/zero', { 'x-append': 'null' })).text).toBe('/zero for anonymous #2')
    expect((await get('/zero', { 'x-append': '""' })).text).toBe('/zero for anonymous #2')

    expect(await storedKeys('GET/zero')).toEqual(['GET/zero', 'GET/zero 0', 'GET/zero false'])
  })

  it('separates the URL from the appended key, so different requests never share a key', async () => {
    // both used to be stored as "GET/me12"
    expect((await get('/me', { 'x-append': '12' })).text).toBe('/me for 12 #1')
    expect((await get('/me1', { 'x-append': '2' })).text).toBe('/me1 for 2 #1')

    expect((await get('/me1', { 'x-append': '2' })).text).toBe('/me1 for 2 #1')
    expect((await get('/me', { 'x-append': '12' })).text).toBe('/me for 12 #1')
    expect(await storedKeys('GET/me')).toEqual(['GET/me 12', 'GET/me1 2'])
  })

  it('bypasses the cache for URLs containing a whitespace', async () => {
    // user "x" on /space is stored as "GET/space x"
    expect((await get('/space', { 'x-append': '"x"' })).text).toBe('/space for "x" #1')

    // "/space%20x" decoded by an upstream middleware would map to the same key
    const first = await get('/space%20x', { 'x-decode': '' })
    expect(first.text).toBe('/space x for anonymous #1')
    const second = await get('/space%20x', { 'x-decode': '' })
    expect(second.text).toBe('/space x for anonymous #2')
    expect(second.headers.get('x-cache-hit')).toBeNull()

    expect(await storedKeys('GET/space')).toEqual(['GET/space x'])
    expect((await get('/space', { 'x-append': '"x"' })).text).toBe('/space for "x" #1')
  })

  it('follows req.url rewrites, prefixed by the mount path (req.baseUrl)', async () => {
    // rewritten URLs are different resources (i.e. per language variants)
    expect((await get('/page', { 'x-rewrite': '/rewritten' })).text).toBe('/rewritten for anonymous #1')
    expect((await get('/page')).text).toBe('/page for anonymous #1')
    expect((await get('/page', { 'x-rewrite': '/rewritten' })).headers.get('x-cache-hit')).toBe('1')

    // the same relative URL on different mount paths is a different resource
    expect((await get('/v1/page', { 'x-mount': '/v1' })).text).toBe('/page for anonymous #2')
    expect((await get('/v2/page', { 'x-mount': '/v2' })).text).toBe('/page for anonymous #3')
    expect((await get('/v1/page', { 'x-mount': '/v1' })).text).toBe('/page for anonymous #2')

    expect(await storedKeys('GET/rewritten')).toEqual(['GET/rewritten'])
    expect(await storedKeys('GET/page')).toEqual(['GET/page'])
    expect(await storedKeys('GET/v')).toEqual(['GET/v1/page', 'GET/v2/page'])
  })

  it('includes the method and the query string', async () => {
    await get('/query?a=1')
    await get('/query?a=2')
    await get('/head', {}, 'HEAD')
    await get('/head')

    expect(await storedKeys('GET/query')).toEqual(['GET/query?a=1', 'GET/query?a=2'])
    expect(await storedKeys('HEAD/head')).toEqual(['HEAD/head'])
    // the HEAD entry has no body, it must not be replayed for GET requests
    const res = await get('/head')
    expect(res.headers.get('x-cache-hit')).toBe('1')
    expect(res.text).toBe('/head for anonymous #2')
  })

  it('uses custom cache keys as they are, ignoring cacheAppendKey', async () => {
    const miss = await get('/custom', { 'x-cache-key': 'custom-1', 'x-append': '12' })
    expect(miss.text).toBe('/custom for 12 #1')
    expect(await cache.get('custom-1')).toBeString()

    // other URL, same custom key
    const hit = await get('/custom-2', { 'x-cache-key': 'custom-1' })
    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(hit.text).toBe('/custom for 12 #1')
    expect(calls['/custom-2']).toBeUndefined()
  })

  it('serves HEAD requests using custom keys from the cache, but never stores their responses', async () => {
    const headMiss = await get('/custom-head', { 'x-cache-key': 'custom-head' }, 'HEAD')
    expect(headMiss.status).toBe(200)
    expect(headMiss.headers.get('x-cache-hit')).toBeNull()
    // a bodyless HEAD response would otherwise be replayed to GET requests
    expect(await cache.get('custom-head')).toBeUndefined()

    const getMiss = await get('/custom-head', { 'x-cache-key': 'custom-head' })
    expect(getMiss.headers.get('x-cache-hit')).toBeNull()
    expect(getMiss.text).toBe('/custom-head for anonymous #2')

    const headHit = await get('/custom-head', { 'x-cache-key': 'custom-head' }, 'HEAD')
    expect(headHit.headers.get('x-cache-hit')).toBe('1')
    expect(headHit.body.length).toBe(0)
    expect(calls['/custom-head']).toBe(2)
  })

  it('skips the cache when req.cacheDisabled is set', async () => {
    await get('/disabled', { 'x-cache-disabled': '' })
    const res = await get('/disabled', { 'x-cache-disabled': '' })
    expect(res.text).toBe('/disabled for anonymous #2')
    expect(await storedKeys('GET/disabled')).toEqual([])
  })

  it('passes errors thrown by cacheAppendKey to next(err)', async () => {
    const sync = await get('/error', { 'x-append-throws': 'sync failure' })
    expect(sync.status).toBe(500)
    expect(app.errors.pop().message).toBe('sync failure')

    // the async cacheAppendKey rejects with a SyntaxError
    const async = await get('/error', { 'x-append': 'not json' })
    expect(async.status).toBe(500)
    expect(app.errors.pop()).toBeInstanceOf(SyntaxError)

    expect(app.errors).toEqual([])
    expect(calls['/error']).toBeUndefined()
  })
})
