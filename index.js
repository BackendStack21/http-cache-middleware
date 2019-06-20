const CacheManager = require('cache-manager')
const iu = require('middleware-if-unless')()
const ms = require('ms')
const onEnd = require('on-http-end')
const getKeys = require('./get-keys')

const X_CACHE_EXPIRE = 'x-cache-expire'
const X_CACHE_TIMEOUT = 'x-cache-timeout'
const X_CACHE_HIT = 'x-cache-hit'

const middleware = (opts) => async (req, res, next) => {
  opts = Object.assign({
    stores: [CacheManager.caching({ store: 'memory', max: 1000, ttl: 30 })]
  }, opts)

  // creating multi-cache instance
  const mcache = CacheManager.multiCaching(opts.stores)

  if (req.cacheDisabled) return next()

  let { url, cacheAppendKey = req => '' } = req
  cacheAppendKey = await cacheAppendKey(req)

  const key = req.method + url + cacheAppendKey
  // ref cache key on req object
  req.cacheKey = key

  // try to retrieve cached response
  const cached = await get(mcache, key)

  if (cached) {
    // respond from cache if there is a hit
    let { status, headers, data } = JSON.parse(cached)
    if (typeof data === 'object' && data.type === 'Buffer') {
      data = Buffer.from(data.data)
    }
    headers[X_CACHE_HIT] = '1'

    // set cached response headers
    Object.keys(headers).forEach(header => res.setHeader(header, headers[header]))

    // send cached payload
    req.cacheHit = true
    res.statusCode = status
    res.end(data)

    return
  }

  onEnd(res, (payload) => {
    if (payload.headers[X_CACHE_EXPIRE]) {
      // support service level expiration
      const keysPattern = payload.headers[X_CACHE_EXPIRE].replace(/\s/g, '')
      const patterns = keysPattern.split(',')
      // delete keys on all cache tiers
      patterns.forEach(pattern =>
        opts.stores.forEach(cache =>
          getKeys(cache, pattern).then(keys =>
            mcache.del(keys))))
    } else if (payload.headers[X_CACHE_TIMEOUT]) {
      // we need to cache response
      mcache.set(req.cacheKey, JSON.stringify(payload), {
        // @NOTE: cache-manager uses seconds as TTL unit
        // restrict to min value "1 second"
        ttl: Math.max(ms(payload.headers[X_CACHE_TIMEOUT]), 1000) / 1000
      })
    }
  })

  return next()
}

const get = (cache, key) => new Promise((resolve) => {
  cache.getAndPassUp(key, (_, res) => {
    resolve(res)
  })
})

module.exports = iu(middleware)
