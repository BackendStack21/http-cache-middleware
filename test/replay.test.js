'use strict'

const { describe, it, expect, beforeAll, afterAll } = require('bun:test')
const { memoryCache, serve } = require('./helpers')

describe('cached response replay', () => {
  const cache = memoryCache()
  const calls = {}
  let app

  const count = (req) => {
    calls[req.url] = (calls[req.url] || 0) + 1

    return calls[req.url]
  }

  const routes = {
    '/headers': (req, res) => {
      count(req)
      res.setHeader('x-cache-timeout', '1 minute')
      res.setHeader('content-type', 'text/plain')
      res.setHeader('x-custom', ['a', 'b'])
      res.setHeader('set-cookie', ['session=secret; HttpOnly', 'other=1'])
      res.setHeader('keep-alive', 'timeout=5')
      res.setHeader('connection', 'keep-alive')
      res.setHeader('proxy-authenticate', 'Basic')
      res.setHeader('proxy-authorization', 'Basic abc')
      res.setHeader('proxy-connection', 'keep-alive')
      res.setHeader('te', 'trailers')
      res.setHeader('trailer', 'x-checksum')
      res.setHeader('upgrade', 'h2c')
      res.end('headers')
    },
    '/partial': (req, res) => {
      res.statusCode = 206
      res.setHeader('x-cache-timeout', '1 minute')
      res.setHeader('content-range', 'bytes 0-3/10')
      res.end(`part ${count(req)}`)
    },
    '/not-modified': (req, res) => {
      count(req)
      res.statusCode = 304
      res.setHeader('cache-control', 'max-age=60')
      res.setHeader('etag', '"v1"')
      res.end()
    },
    '/generated': (req, res) => {
      res.setHeader('x-cache-timeout', '1 minute')
      res.end(`generated ${count(req)}`)
    },
    '/conditional': (req, res) => {
      res.setHeader('cache-control', 'public, max-age=60')
      res.setHeader('etag', '"v1"')
      res.setHeader('vary', 'accept-encoding')
      res.setHeader('expires', 'Thu, 01 Jan 2099 00:00:00 GMT')
      res.setHeader('content-location', '/conditional/v1')
      res.setHeader('content-type', 'text/plain')
      res.setHeader('x-custom', 'not on 304')
      res.end(`conditional ${count(req)}`)
    },
    '/weak': (req, res) => {
      res.setHeader('x-cache-timeout', '1 minute')
      res.setHeader('etag', 'W/"w1"')
      res.end(`weak ${count(req)}`)
    },
    '/missing': (req, res) => {
      res.statusCode = 404
      res.setHeader('x-cache-timeout', '1 minute')
      res.end(`missing ${count(req)}`)
    }
  }
  // each test primes its own path, so tests don't depend on each other
  for (const name of ['keep', 'not-modified', 'list']) routes[`/conditional/${name}`] = routes['/conditional']
  routes['/missing/conditional'] = routes['/missing']

  beforeAll(async () => {
    app = await serve(require('./../index')({ stores: [cache] }), routes)
  })

  afterAll(() => app.close())

  it('does not store nor replay set-cookie and hop-by-hop headers', async () => {
    const miss = await app.request('/headers')
    // the original response is untouched
    expect(miss.headers.getSetCookie()).toEqual(['session=secret; HttpOnly', 'other=1'])
    expect(miss.headers.get('upgrade')).toBe('h2c')

    const entry = JSON.parse(await cache.get('GET/headers'))
    expect(Object.keys(entry.headers).sort()).toEqual([
      'cache-control', 'content-type', 'etag', 'x-cache-timeout', 'x-custom'
    ])
    expect(entry.headers['x-custom']).toEqual(['a', 'b'])

    const hit = await app.request('/headers')
    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(hit.text).toBe('headers')
    expect(hit.headers.get('content-type')).toBe('text/plain')
    expect(hit.headers.get('x-custom')).toBe('a, b')
    expect(hit.headers.getSetCookie()).toEqual([])
    for (const name of ['proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'upgrade']) {
      expect(hit.headers.get(name)).toBeNull()
    }
    expect(calls['/headers']).toBe(1)
  })

  it('never stores 206 responses', async () => {
    const first = await app.request('/partial')
    expect(first.status).toBe(206)
    expect(first.text).toBe('part 1')
    const second = await app.request('/partial')
    expect(second.status).toBe(206)
    expect(second.text).toBe('part 2')
    expect(second.headers.get('x-cache-hit')).toBeNull()
    expect(await cache.get('GET/partial')).toBeUndefined()
  })

  it('never stores 304 responses', async () => {
    expect((await app.request('/not-modified')).status).toBe(304)
    const second = await app.request('/not-modified')
    expect(second.status).toBe(304)
    expect(second.headers.get('x-cache-hit')).toBeNull()
    expect(calls['/not-modified']).toBe(2)
    expect(await cache.get('GET/not-modified')).toBeUndefined()
  })

  it('generates a quoted ETag and a cache-control header for cached responses', async () => {
    const miss = await app.request('/generated')
    // generated headers are only part of the cached response
    expect(miss.headers.get('etag')).toBeNull()

    const hit = await app.request('/generated')
    expect(hit.text).toBe('generated 1')
    expect(hit.headers.get('etag')).toMatch(/^"[0-9a-f]{16}"$/)
    expect(hit.headers.get('cache-control')).toBe('private, no-cache, max-age=60')

    const revalidation = await app.request('/generated', { headers: { 'if-none-match': hit.headers.get('etag') } })
    expect(revalidation.status).toBe(304)
  })

  it('keeps the ETag and cache-control headers set by the service', async () => {
    await app.request('/conditional/keep')
    const hit = await app.request('/conditional/keep')
    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(hit.text).toBe('conditional 1')
    expect(hit.headers.get('etag')).toBe('"v1"')
    expect(hit.headers.get('cache-control')).toBe('public, max-age=60')
  })

  it('answers matching If-None-Match requests with a bodyless 304 carrying the validator headers', async () => {
    // on a miss the If-None-Match header is the service's business
    const miss = await app.request('/conditional/not-modified', { headers: { 'if-none-match': '"v1"' } })
    expect(miss.status).toBe(200)
    expect(miss.text).toBe('conditional 1')

    const res = await app.request('/conditional/not-modified', { headers: { 'if-none-match': '"v1"' } })
    expect(res.status).toBe(304)
    expect(res.body.length).toBe(0)
    expect(res.headers.get('etag')).toBe('"v1"')
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    expect(res.headers.get('vary')).toBe('accept-encoding')
    expect(res.headers.get('expires')).toBe('Thu, 01 Jan 2099 00:00:00 GMT')
    expect(res.headers.get('content-location')).toBe('/conditional/v1')
    expect(res.headers.get('x-custom')).toBeNull()
    expect(res.headers.get('x-cache-hit')).toBe('1')
    expect(calls['/conditional/not-modified']).toBe(1)
  })

  it('uses the weak comparison over a list of entity tags', async () => {
    const statusFor = async (path, ifNoneMatch) => (await app.request(path, { headers: { 'if-none-match': ifNoneMatch } })).status

    await app.request('/conditional/list')
    expect(await statusFor('/conditional/list', '"v0", "v1"')).toBe(304)
    expect(await statusFor('/conditional/list', '"v0","v1","v2"')).toBe(304)
    expect(await statusFor('/conditional/list', 'W/"v1"')).toBe(304)
    expect(await statusFor('/conditional/list', '"v0", W/"v1"')).toBe(304)
    expect(await statusFor('/conditional/list', '*')).toBe(304)
    expect(await statusFor('/conditional/list', '"v0"')).toBe(200)
    expect(await statusFor('/conditional/list', '"v0", "v2"')).toBe(200)
    expect(await statusFor('/conditional/list', 'v1')).toBe(200)
    expect(await statusFor('/conditional/list', '"V1"')).toBe(200)
    expect(calls['/conditional/list']).toBe(1)

    // stored weak ETag
    await app.request('/weak')
    expect(await statusFor('/weak', '"w1"')).toBe(304)
    expect(await statusFor('/weak', 'W/"w1"')).toBe(304)
    expect(await statusFor('/weak', '"w2", W/"w1"')).toBe(304)
    expect(await statusFor('/weak', 'W/"w2"')).toBe(200)
    expect(calls['/weak']).toBe(1)
  })

  it('replays cached error responses', async () => {
    const miss = await app.request('/missing')
    expect(miss.status).toBe(404)
    const hit = await app.request('/missing')
    expect(hit.status).toBe(404)
    expect(hit.text).toBe('missing 1')
    expect(hit.headers.get('x-cache-hit')).toBe('1')
  })

  // RFC 9110 13.2.1: preconditions must be ignored when the response would not be a 2xx,
  // however a cached 404 (with its generated ETag) is turned into a 304
  it('ignores If-None-Match for cached non-2xx responses', async () => {
    await app.request('/missing/conditional')
    const hit = await app.request('/missing/conditional')
    expect(hit.headers.get('x-cache-hit')).toBe('1')

    const res = await app.request('/missing/conditional', { headers: { 'if-none-match': hit.headers.get('etag') } })
    expect(res.status).toBe(404)
    const star = await app.request('/missing/conditional', { headers: { 'if-none-match': '*' } })
    expect(star.status).toBe(404)
  })
})
