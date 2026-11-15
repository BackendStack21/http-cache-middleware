'use strict'

const { describe, it, expect, beforeAll, afterAll, spyOn } = require('bun:test')
const { memoryCache, serve } = require('./helpers')

describe('cache TTL', () => {
  const cache = memoryCache()
  const setSpy = spyOn(cache.store, 'set')
  let app

  // name: [response headers, expected TTL in seconds (0: the response is not stored)]
  const cases = {
    'x-cache-timeout': [{ 'x-cache-timeout': '1 minute' }, 60],
    'x-cache-timeout as a number of milliseconds': [{ 'x-cache-timeout': 120000 }, 120],
    'x-cache-timeout fractional seconds are rounded up': [{ 'x-cache-timeout': '1.5s' }, 2],
    'x-cache-timeout fractional milliseconds are rounded up': [{ 'x-cache-timeout': '2001ms' }, 3],
    'x-cache-timeout minimum is 1 second': [{ 'x-cache-timeout': '100ms' }, 1],
    // NOTE: "0" does not disable caching
    'x-cache-timeout 0 disables caching': [{ 'x-cache-timeout': '0' }, 0],
    'negative x-cache-timeout disables caching': [{ 'x-cache-timeout': '-1h' }, 0],
    'x-cache-timeout below 1 second is raised to the minimum': [{ 'x-cache-timeout': '5ms' }, 1],
    'x-cache-timeout unparseable': [{ 'x-cache-timeout': 'garbage' }, 0],
    'cache-control max-age': [{ 'cache-control': 'public, max-age=300' }, 300],
    'cache-control s-maxage beats max-age': [{ 'cache-control': 'max-age=300, s-maxage=10' }, 10],
    'cache-control max-age beats x-cache-timeout': [{ 'cache-control': 'max-age=300', 'x-cache-timeout': '1 minute' }, 300],
    'cache-control max-age=0 falls back to x-cache-timeout': [{ 'cache-control': 'max-age=0', 'x-cache-timeout': '5s' }, 5],
    'cache-control max-age=0 alone': [{ 'cache-control': 'max-age=0' }, 0],
    'cache-control no-cache falls back to x-cache-timeout': [{ 'cache-control': 'private, no-cache', 'x-cache-timeout': '1 minute' }, 60],
    'cache-control without TTL': [{ 'cache-control': 'no-cache' }, 0],
    'cache-control no-store': [{ 'cache-control': 'no-store, max-age=300' }, 0],
    'cache-control no-store overruled by x-cache-timeout': [{ 'cache-control': 'no-store', 'x-cache-timeout': '1 minute' }, 60],
    'cache-control no-store with max-age overruled by x-cache-timeout': [{ 'cache-control': 'no-store, max-age=300', 'x-cache-timeout': '1 minute' }, 300],
    'no caching headers': [{}, 0],
    // a shared cache must not reuse a response with s-maxage=0 without revalidation (RFC 9111 5.2.2.10),
    // and s-maxage overrides max-age: as for max-age=0, only x-cache-timeout should make it cacheable
    's-maxage=0 beats max-age': [{ 'cache-control': 's-maxage=0, max-age=300' }, 0]
  }
  // cases where the library is known to misbehave, see the it.failing below
  const knownBugs = new Set()

  const paths = {}
  const routes = {}
  Object.keys(cases).forEach((name, index) => {
    const path = `/ttl/${index}`
    paths[name] = path
    routes[path] = (req, res) => {
      for (const [header, value] of Object.entries(cases[name][0])) res.setHeader(header, value)
      res.end(name)
    }
  })

  beforeAll(async () => {
    app = await serve(require('./../index')({ stores: [cache] }), routes)
  })

  afterAll(() => app.close())

  const storedTtl = (key) => {
    const calls = setSpy.mock.calls.filter(call => call[0] === key)
    expect(calls.length).toBeLessThanOrEqual(1)

    return calls.length ? calls[0][2].ttl : 0
  }

  for (const [name, [headers, ttl]] of Object.entries(cases)) {
    const test = knownBugs.has(name) ? it.failing : it
    test(`${name}: ${JSON.stringify(headers)} => ${ttl ? `stored for ${ttl}s` : 'not stored'}`, async () => {
      const path = paths[name]
      const before = Date.now()
      const miss = await app.request(path)
      expect(miss.text).toBe(name)
      expect(storedTtl('GET' + path)).toBe(ttl)

      const second = await app.request(path)
      expect(second.headers.get('x-cache-hit')).toBe(ttl ? '1' : null)

      if (ttl) {
        // the entry itself expires with the TTL, so stale copies (i.e. on other cache tiers) are not served
        const entry = JSON.parse(await cache.get('GET' + path))
        expect(entry.expires).toBeGreaterThanOrEqual(before + ttl * 1000)
        expect(entry.expires).toBeLessThanOrEqual(Date.now() + ttl * 1000)
        // the generated cache-control header carries the TTL, unless the response had one
        expect(second.headers.get('cache-control')).toBe(headers['cache-control'] || `private, no-cache, max-age=${ttl}`)
      }
    })
  }
})
