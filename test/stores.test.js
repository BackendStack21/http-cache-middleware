'use strict'

const { describe, it, expect, afterEach } = require('bun:test')
const CacheManager = require('cache-manager')
const redisStore = require('cache-manager-ioredis')
const middleware = require('./../index')
const { memoryCache, serve, waitFor } = require('./helpers')

const calls = {}
const routes = {
  '/items': (req, res) => {
    calls[req.url] = (calls[req.url] || 0) + 1
    res.setHeader('x-cache-timeout', '1.5s')
    res.end(`items #${calls[req.url]}`)
  },
  '/search': (req, res) => {
    calls[req.url] = (calls[req.url] || 0) + 1
    res.setHeader('x-cache-timeout', '1 minute')
    res.end(`search ${req.url} #${calls[req.url]}`)
  },
  '/expire': (req, res) => {
    res.setHeader('x-cache-expire', JSON.parse(req.headers['x-patterns']))
    // never stored, even when cacheable
    res.setHeader('x-cache-timeout', '1 minute')
    res.end('expired')
  }
}
const expire = (app, patterns) => app.request('/expire', { method: 'POST', headers: { 'x-patterns': JSON.stringify(patterns) } })

describe('cache stores', () => {
  let app

  afterEach(async () => {
    await app.close()
    for (const key in calls) delete calls[key]
  })

  it('exports deleteKeys, to expire entries from outside of the request flow', async () => {
    expect(middleware.deleteKeys).toBe(require('./../utils').deleteKeys)

    const stores = [memoryCache()]
    app = await serve(middleware({ stores }), routes)
    await app.request('/items')
    expect((await app.request('/items')).headers.get('x-cache-hit')).toBe('1')

    await middleware.deleteKeys(stores, '*/items')
    const res = await app.request('/items')
    expect(res.headers.get('x-cache-hit')).toBeNull()
    expect(res.text).toBe('items #2')
  })

  it('expires entries using x-cache-expire headers, without storing those responses', async () => {
    const cache = memoryCache()
    app = await serve(middleware({ stores: [cache] }), routes)
    await app.request('/items')
    await app.request('/search?q=a')
    await app.request('/search?q=b')
    expect((await cache.keys()).sort()).toEqual(['GET/items', 'GET/search?q=a', 'GET/search?q=b'])

    // array header values are joined as a comma separated list
    expect((await expire(app, ['GET/items', '*/search?q=a'])).text).toBe('expired')
    expect(await waitFor(() => cache.store.keyCount() === 1)).toBe(true)
    expect(await cache.keys()).toEqual(['GET/search?q=b'])

    expect((await expire(app, ' */search* , GET/nothing')).status).toBe(200)
    expect(await waitFor(() => cache.store.keyCount() === 0)).toBe(true)
  })

  it('supports multiple cache tiers', async () => {
    const tier1 = memoryCache()
    const tier2 = memoryCache()
    app = await serve(middleware({ stores: [tier1, tier2] }), routes)

    await app.request('/items')
    const entry = await tier1.get('GET/items')
    expect(entry).toBeString()
    expect(await tier2.get('GET/items')).toBe(entry)

    // entries missing on the first tier are served from the second one, and passed up
    await tier1.del('GET/items')
    const hit = await app.request('/items')
    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(hit.text).toBe('items #1')
    expect(await tier1.get('GET/items')).toBe(entry)

    // expired entries on lower tiers are not served, even if passed up
    const expired = JSON.parse(entry)
    expired.expires = Date.now() - 1
    await tier1.del('GET/items')
    await tier2.set('GET/items', JSON.stringify(expired))
    const miss = await app.request('/items')
    expect(miss.headers.get('x-cache-hit')).toBeNull()
    expect(miss.text).toBe('items #2')

    // expirations apply to all the tiers
    await expire(app, '*/items')
    expect(await waitFor(() => tier1.store.keyCount() + tier2.store.keyCount() === 0)).toBe(true)
    expect((await app.request('/items')).text).toBe('items #3')
  })

  describe('cache-manager-ioredis', () => {
    // an in-memory stand-in for an ioredis client, as used by cache-manager-ioredis
    const fakeRedis = () => {
      const data = new Map()
      const commands = []

      return {
        data,
        commands,
        options: {},
        get: (key, cb) => setImmediate(() => cb(null, data.has(key) ? data.get(key) : null)),
        setex: (key, ttl, value, cb) => {
          commands.push(['setex', key, ttl])
          data.set(key, value)
          setImmediate(() => cb(null, 'OK'))
        },
        keys: (pattern, cb) => {
          commands.push(['keys', pattern])
          setImmediate(() => cb(null, [...data.keys()]))
        },
        del: (keys, cb) => {
          commands.push(['del', keys])
          // deletions take a while, as they would on a real server
          setTimeout(() => {
            keys.forEach(key => data.delete(key))
            cb(null, keys.length)
          }, 20)
        }
      }
    }
    const redisCache = (redis) => CacheManager.caching({ store: redisStore, redisInstance: redis })

    it('stores entries with an integer TTL, and replays them', async () => {
      const redis = fakeRedis()
      app = await serve(middleware({ stores: [redisCache(redis)] }), routes)

      await app.request('/items')
      // "1.5s" is rounded up, as SETEX only accepts integers
      expect(redis.commands).toEqual([['setex', 'GET/items', 2]])

      const hit = await app.request('/items')
      expect(hit.headers.get('x-cache-hit')).toBe('1')
      expect(hit.text).toBe('items #1')
    })

    it('sends escaped patterns to redis, and filters the keys locally', async () => {
      const redis = fakeRedis()
      app = await serve(middleware({ stores: [redisCache(redis)] }), routes)
      await app.request('/search?q=[a]')
      await app.request('/search?q=b')
      await app.request('/items')

      await expire(app, '*/search?q=[a]*')
      expect(await waitFor(() => redis.data.size === 2)).toBe(true)
      expect(redis.commands.filter(([command]) => command !== 'setex')).toEqual([
        ['keys', '*/search\\?q=\\[a\\]*'],
        ['del', ['GET/search?q=[a]']]
      ])
    })

    // cache-manager-ioredis' del() returns undefined, and drops errors, when called without a callback
    it('deleteKeys settles once redis deleted the keys', async () => {
      const redis = fakeRedis()
      redis.data.set('GET/a', '"entry"')
      const stores = [redisCache(redis)]
      app = await serve(middleware({ stores }), routes)

      await middleware.deleteKeys(stores, '*/a')
      expect(redis.data.has('GET/a')).toBe(false)
    })

    it('deleteKeys rejects when redis fails deleting the keys', async () => {
      const redis = fakeRedis()
      const failure = new Error('READONLY You can\'t write against a read only replica.')
      redis.del = (keys, cb) => setImmediate(() => cb(failure))
      const stores = [redisCache(redis)]
      app = await serve(middleware({ stores }), routes)

      await expect(middleware.deleteKeys(stores, 'GET/a')).rejects.toBe(failure)
    })
  })
})
