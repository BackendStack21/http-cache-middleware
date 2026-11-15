'use strict'

const { randomBytes } = require('node:crypto')
const CacheManager = require('cache-manager')
const iu = require('middleware-if-unless')()
const { parse: cacheControl } = require('@tusbar/cache-control')
const ms = require('ms')
const { get, deleteKeys } = require('./utils')

const X_CACHE_EXPIRE = 'x-cache-expire'
const X_CACHE_TIMEOUT = 'x-cache-timeout'
const X_CACHE_HIT = 'x-cache-hit'
const CACHE_ETAG = 'etag'
const CACHE_CONTROL = 'cache-control'
const CACHE_IF_NONE_MATCH = 'if-none-match'

// version of the cache entries format, entries using other formats are ignored
const ENTRY_VERSION = 2
// a whitespace can't be part of a request target, so it unambiguously separates the URL from the appended key
const KEY_SEPARATOR = ' '
// headers that describe a single connection or a single client, replaying them to other clients is unsafe
const NON_CACHEABLE_HEADERS = new Set([
  'set-cookie',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])
// headers that have to be sent on 304 responses if they would have been sent on the 200 response
const NOT_MODIFIED_HEADERS = [CACHE_ETAG, CACHE_CONTROL, 'content-location', 'expires', 'vary']

// [name, value, name, value, ...] => [[name, value], [name, value], ...]
const toPairs = (flat) => {
  const pairs = []
  for (let i = 0; i + 1 < flat.length; i += 2) {
    pairs.push([flat[i], flat[i + 1]])
  }

  return pairs
}

const getCacheKey = async (req) => {
  // Routers strip their mount path from req.url, so it has to be restored. Other than that, req.url
  // is the source of truth, as it reflects the URLs rewritten by upstream middlewares.
  let url = req.url
  if (req.baseUrl) {
    // Express
    url = req.baseUrl + url
  } else if (req.preRouterUrl !== undefined && typeof req.originalUrl === 'string' && req.originalUrl.endsWith(url)) {
    // restana (0http) nested routers
    url = req.originalUrl
  }
  // defensive: such URL could be confused with an appended key
  if (url.includes(KEY_SEPARATOR)) return null

  const append = req.cacheAppendKey ? await req.cacheAppendKey(req) : ''
  const suffix = append === undefined || append === null ? '' : String(append)

  return req.method + url + (suffix ? KEY_SEPARATOR + suffix : '')
}

const weakTag = (tag) => tag.startsWith('W/') ? tag.slice(2) : tag

// If-None-Match evaluation using weak comparison, see: https://www.rfc-editor.org/rfc/rfc9110#section-13.1.2
const isNotModified = (ifNoneMatch, etag) => {
  if (!ifNoneMatch || !etag) return false
  if (ifNoneMatch === etag || ifNoneMatch === '*') return true

  const expected = weakTag(String(etag))

  return String(ifNoneMatch).split(',').some(tag => weakTag(tag.trim()) === expected)
}

// retrieves the TTL in seconds, or 0 if the response is not cacheable
const getTtl = (headers) => {
  const timeout = headers[X_CACHE_TIMEOUT]
  let ttl = 0

  if (headers[CACHE_CONTROL]) {
    const directives = cacheControl(String(headers[CACHE_CONTROL]))
    // "no-store" is only overruled by an explicit x-cache-timeout header
    if (directives.noStore && timeout === undefined) return 0

    // we are a shared cache, so "s-maxage" takes precedence
    ttl = typeof directives.sharedMaxAge === 'number' ? directives.sharedMaxAge : directives.maxAge
  }
  if (!ttl) {
    if (timeout === undefined) return 0 // no TTL found, we don't cache

    ttl = ms(String(timeout)) / 1000
  }

  // TTL is rounded up (min value: 1 second), as some stores (i.e: Redis) only accept integers
  return Number.isFinite(ttl) && ttl > 0 ? Math.ceil(ttl) : 0
}

/**
 * Observes the response, so the callback is invoked once the response ends with: (status, headers, body, ttl)
 * The response body (string, Buffer or undefined) is ONLY buffered if the response is going to be cached,
 * which is decided using "resolveTtl" as soon as the response headers are known.
 */
const onResponse = (res, resolveTtl, withBody, callback) => {
  const { write, end, writeHead } = res
  let inlineHeaders
  let headers
  let ttl = 0
  let ended = false
  let body

  const init = () => {
    if (headers) return

    headers = res.getHeaders()
    if (inlineHeaders !== null && typeof inlineHeaders === 'object') {
      // headers passed to writeHead(...) are not always reflected by getHeaders()
      const pairs = Array.isArray(inlineHeaders)
        ? (Array.isArray(inlineHeaders[0]) ? inlineHeaders : toPairs(inlineHeaders))
        : Object.entries(inlineHeaders)
      for (const [name, value] of pairs) {
        headers[String(name).toLowerCase()] = value
      }
    }
    if (!headers[X_CACHE_EXPIRE]) ttl = resolveTtl(headers)
  }

  const push = (chunk) => {
    if (body === undefined) {
      body = [chunk]
    } else if (typeof body === 'string') {
      body = [Buffer.from(body), chunk]
    } else {
      body.push(chunk)
    }
  }

  const accumulate = (chunk, encoding, copy) => {
    if (typeof chunk === 'string') {
      if (chunk.length === 0) return

      if (typeof encoding === 'string' && !/^utf-?8$/i.test(encoding)) {
        push(Buffer.from(chunk, encoding))
      } else if (body === undefined) {
        body = chunk
      } else if (typeof body === 'string') {
        body += chunk
      } else {
        body.push(Buffer.from(chunk))
      }
    } else if (chunk instanceof Uint8Array && chunk.byteLength > 0) {
      // written chunks are copied, as the caller is free to reuse them before the response ends
      push(copy
        ? Buffer.from(chunk)
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      )
    }
  }

  // a failed attempt to send the response is followed by another response (i.e: an error page)
  const reset = () => {
    if (res.headersSent) return

    headers = undefined
    inlineHeaders = undefined
    ttl = 0
    body = undefined
  }

  res.writeHead = function (status, reason, inline) {
    if (!headers && !ended) {
      inlineHeaders = typeof reason === 'string' ? inline : (inline ?? reason)
      // headers are captured before other writeHead(...) hooks (i.e: compression) alter them
      init()
    }

    try {
      return writeHead.apply(this, arguments)
    } catch (err) {
      reset()
      throw err
    }
  }

  res.write = function (chunk, encoding) {
    if (!ended) {
      init()
      if (ttl > 0 && withBody) accumulate(chunk, encoding, true)
    }

    return write.apply(this, arguments)
  }

  res.end = function (chunk, encoding) {
    if (ended) return end.apply(this, arguments)

    ended = true
    init()
    const status = res.statusCode
    let result
    try {
      result = end.apply(this, arguments)
    } catch (err) {
      ended = false
      reset()
      throw err
    }

    if (ttl > 0 && withBody) {
      accumulate(chunk, encoding, false)
      if (Array.isArray(body)) {
        body = body.length === 1 ? body[0] : Buffer.concat(body)
      }
    }
    // NOTE: the body has to be consumed synchronously, as the last chunk is not copied
    callback(status, headers, body, ttl)
    body = undefined

    return result
  }
}

// truncated responses (i.e: an upstream failing half way) announce more bytes than they deliver
const isComplete = (req, headers, body) => {
  const length = headers['content-length']
  if (length === undefined || req.method === 'HEAD') return true

  const bytes = typeof body === 'string' ? Buffer.byteLength(body) : (body ? body.length : 0)

  return Number(length) === bytes
}

const serialize = (status, headers, body, ttl) => {
  const entry = {
    v: ENTRY_VERSION,
    status,
    headers: {},
    expires: Date.now() + ttl * 1000
  }
  for (const name in headers) {
    // HTTP/2 pseudo-headers (i.e: ":status") can't be replayed either
    if (!NON_CACHEABLE_HEADERS.has(name) && name[0] !== ':') entry.headers[name] = headers[name]
  }

  // setting cache-control header if absent
  if (!entry.headers[CACHE_CONTROL]) {
    entry.headers[CACHE_CONTROL] = `private, no-cache, max-age=${ttl}`
  }
  // setting ETag if absent
  if (!entry.headers[CACHE_ETAG]) {
    entry.headers[CACHE_ETAG] = `"${randomBytes(8).toString('hex')}"`
  }

  if (typeof body === 'string') {
    entry.data = body
  } else if (body) {
    // binary payloads are stored using base64, which is way cheaper than JSON encoded Buffers
    entry.data = body.toString('base64')
    entry.base64 = true
  }

  return JSON.stringify(entry)
}

const deserialize = (value) => {
  if (typeof value !== 'string') return null

  const entry = JSON.parse(value)
  if (
    entry === null || typeof entry !== 'object' || entry.v !== ENTRY_VERSION ||
    entry.headers === null || typeof entry.headers !== 'object' ||
    !Number.isInteger(entry.status) || entry.status < 100 || entry.status > 599 ||
    (entry.data !== undefined && typeof entry.data !== 'string') ||
    // multi-tier caches can retain entries for longer than expected
    !(entry.expires > Date.now())
  ) {
    return null
  }

  return entry
}

const middleware = (opts) => {
  opts = Object.assign({
    stores: [CacheManager.caching({ store: 'memory', max: 1000, ttl: 30 })]
  }, opts)
  const { stores } = opts
  // error reporting is not allowed to break the request/response flow either
  const onError = (err) => {
    try {
      if (typeof opts.onError === 'function') {
        const result = opts.onError(err)
        if (result && typeof result.then === 'function') result.then(undefined, () => {})
      }
    } catch (_) {}
  }
  const mcache = CacheManager.multiCaching(stores)

  // caching is an optimization: cache failures are reported, but never break the request/response flow
  const lookup = async (key) => {
    try {
      return deserialize(await get(mcache, key))
    } catch (err) {
      onError(err)

      return null
    }
  }

  const resolveTtl = (headers) => {
    try {
      return getTtl(headers)
    } catch (err) {
      onError(err)

      return 0
    }
  }

  const onResponseEnd = async (req, status, headers, body, ttl) => {
    try {
      if (headers[X_CACHE_EXPIRE]) {
        // support service level expiration, delete keys on all cache tiers
        await deleteKeys(stores, String(headers[X_CACHE_EXPIRE]))
      } else if (ttl > 0 && status !== 304 && status !== 206 && isComplete(req, headers, body)) {
        await mcache.set(req.cacheKey, serialize(status, headers, body, ttl), { ttl })
      }
    } catch (err) {
      onError(err)
    }
  }

  return iu(async (req, res, next) => {
    try {
      if (req.cacheDisabled) return next()

      const customKey = typeof req.cacheKey === 'string'
      if (!customKey) {
        const key = await getCacheKey(req)
        if (key === null) return next()

        // ref cache key on req object
        req.cacheKey = key
      }

      // try to retrieve the cached response
      const entry = await lookup(req.cacheKey)

      if (entry) {
        // respond from cache if there is a hit
        const { status, headers, data } = entry

        req.cacheHit = true

        // pre-checking If-None-Match header (only applies to successful responses of safe methods)
        if (
          status >= 200 && status < 300 && (req.method === 'GET' || req.method === 'HEAD') &&
          isNotModified(req.headers[CACHE_IF_NONE_MATCH], headers[CACHE_ETAG])
        ) {
          for (const name of NOT_MODIFIED_HEADERS) {
            if (headers[name] !== undefined) res.setHeader(name, headers[name])
          }
          res.setHeader(X_CACHE_HIT, '1')
          res.statusCode = 304
          res.end()

          return
        }

        // set cached response headers
        for (const name in headers) {
          res.setHeader(name, headers[name])
        }
        res.setHeader(X_CACHE_HIT, '1')

        // send cached payload
        res.statusCode = status
        res.end(entry.base64 ? Buffer.from(data, 'base64') : data)

        return
      }

      // HEAD responses have no body, so they can't be stored using custom cache keys (shared with other methods)
      const storable = !(customKey && req.method === 'HEAD')
      onResponse(
        res,
        (headers) => storable ? resolveTtl(headers) : 0,
        // HEAD responses have no body, even if the handler provides one
        req.method !== 'HEAD',
        (status, headers, body, ttl) => onResponseEnd(req, status, headers, body, ttl)
      )

      return next()
    } catch (err) {
      return next(err)
    }
  })
}

module.exports = middleware
module.exports.deleteKeys = deleteKeys
