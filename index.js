'use strict'

const CacheManager = require('cache-manager')
const iu = require('middleware-if-unless')()
const { parse: cacheControl } = require('@tusbar/cache-control')
const ms = require('ms')
const onEnd = require('on-http-end')
const { get, deleteKeys, DATA_POSTFIX } = require('./utils')

const X_CACHE_EXPIRE = 'x-cache-expire'
const X_CACHE_TIMEOUT = 'x-cache-timeout'
const X_CACHE_HIT = 'x-cache-hit'
const CACHE_ETAG = 'etag'
const CACHE_CONTROL = 'cache-control'
const CACHE_IF_NONE_MATCH = 'if-none-match'

const middleware = (opts) => {
  opts = Object.assign({
    stores: [CacheManager.caching({ store: 'memory', max: 1000, ttl: 30 })]
  }, opts)
  const mcache = CacheManager.multiCaching(opts.stores)

  return iu(async (req, res, next) => {
    try {
      if (req.cacheDisabled) return next()

      if (typeof req.cacheKey !== 'string') {
        let { url, cacheAppendKey = req => '' } = req
        cacheAppendKey = await cacheAppendKey(req)

        const key = req.method + url + cacheAppendKey
        // ref cache key on req object
        req.cacheKey = key
      }

      // try to retrieve cached response metadata
      const metadata = await get(mcache, req.cacheKey)

      if (metadata) {
      // respond from cache if there is a hit
        const { status, headers, encoding } = JSON.parse(metadata)

        // pre-checking If-None-Match header
        if (req.headers[CACHE_IF_NONE_MATCH] && req.headers[CACHE_IF_NONE_MATCH] === headers[CACHE_ETAG]) {
          res.setHeader('content-length', '0')
          res.statusCode = 304
          res.end()

          return
        } else {
          // try to retrieve cached response data
          const payload = await get(mcache, req.cacheKey + DATA_POSTFIX)
          if (payload) {
            let { data } = JSON.parse(payload)
            if (typeof data === 'object' && data.type === 'Buffer') {
              data = Buffer.from(data.data)
            }
            headers[X_CACHE_HIT] = '1'

            // set cached response headers
            Object.keys(headers).forEach(header => res.setHeader(header, headers[header]))

            // send cached payload
            req.cacheHit = true
            res.statusCode = status
            res.end(data, encoding)

            return
          }
        }
      }

      onEnd(res, async (payload) => {
        if (payload.status === 304) return

        if (payload.headers[X_CACHE_EXPIRE]) {
          // support service level expiration
          const keysPattern = payload.headers[X_CACHE_EXPIRE].replace(/\s/g, '')
          const patterns = keysPattern.split(',')
          // delete keys on all cache tiers
          deleteKeys(opts.stores, patterns)
        } else if (payload.headers[X_CACHE_TIMEOUT] || payload.headers[CACHE_CONTROL]) {
          // extract cache ttl
          let ttl = 0
          if (payload.headers[CACHE_CONTROL]) {
            ttl = cacheControl(payload.headers[CACHE_CONTROL]).maxAge
          }
          if (!ttl) {
            if (payload.headers[X_CACHE_TIMEOUT]) {
              ttl = Math.max(ms(payload.headers[X_CACHE_TIMEOUT]), 1000) / 1000 // min value: 1 second
            } else {
              return // no TTL found, we don't cache
            }
          }

          // setting cache-control header if absent
          if (!payload.headers[CACHE_CONTROL]) {
            payload.headers[CACHE_CONTROL] = `private, no-cache, max-age=${ttl}`
          }
          // setting ETag if absent
          if (!payload.headers[CACHE_ETAG]) {
            payload.headers[CACHE_ETAG] = Math.random().toString(36).substring(2, 16)
          }

          // cache response data
          await mcache.set(req.cacheKey + DATA_POSTFIX, JSON.stringify({ data: payload.data }), { ttl })
          delete payload.data
          // cache response metadata
          await mcache.set(req.cacheKey, JSON.stringify(payload), { ttl })
        }
      })

      return next()
    } catch (err) {
      return next(err)
    }
  })
}

module.exports = middleware
module.exports.deleteKeys = deleteKeys
