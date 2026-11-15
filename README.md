# http-cache-middleware
[![NPM version](https://badgen.net/npm/v/http-cache-middleware)](https://www.npmjs.com/package/http-cache-middleware)
[![NPM Total Downloads](https://badgen.net/npm/dt/http-cache-middleware)](https://www.npmjs.com/package/http-cache-middleware)
[![License](https://badgen.net/npm/license/http-cache-middleware)](https://www.npmjs.com/package/http-cache-middleware)
[![Github stars](https://badgen.net/github/stars/jkyberneees/http-cache-middleware?icon=github)](https://github.com/jkyberneees/http-cache-middleware)

<img src="logo.svg" width="400">  

High performance connect-like HTTP cache middleware for Node.js. So your latency can decrease to single digit milliseconds 🚀 

> Uses `cache-manager` (v4) as caching layer, so multiple
storage engines are supported, i.e: Memory, Redis, ... https://www.npmjs.com/package/cache-manager

## Install
```bash
npm i http-cache-middleware
```
> Requires Node.js >= 22.

## Usage
```js
const middleware = require('http-cache-middleware')()
const service = require('restana')()
service.use(middleware)

service.get('/cache-on-get', (req, res) => {
  setTimeout(() => {
    // keep response in cache for 1 minute if not expired before
    res.setHeader('x-cache-timeout', '1 minute')
    res.send('this supposed to be a cacheable response')
  }, 50)
})

service.delete('/cache', (req, res) => {
  // ... the logic here changes the cache state

  // expire the cache keys using pattern
  res.setHeader('x-cache-expire', '*/cache-on-get')
  res.end()
})

service.start(3000)
```

### Express
```js
const express = require('express')
const middleware = require('http-cache-middleware')()

const app = express()
// after the middlewares setting req.cacheAppendKey / req.cacheDisabled, before the routes
app.use(middleware)

app.get('/numbers', (req, res) => {
  res.set('x-cache-timeout', '1 hour').json([1, 2, 3])
})

// keys of mounted routers include the mount path (req.baseUrl), i.e: GET/v1/numbers/1
const router = express.Router()
router.get('/numbers/:id', (req, res) => {
  res.set('x-cache-timeout', '1 hour').json({ id: req.params.id })
})
router.patch('/numbers/:id', (req, res) => {
  res.set('x-cache-expire', `GET${req.baseUrl}/numbers/${req.params.id}`).sendStatus(204)
})
app.use('/v1', router)

app.listen(3000)
```
> Express sets a weak `ETag` on `res.send()` / `res.json()` responses: the cache keeps it (no ETag is generated) and uses it to answer `If-None-Match` requests. The `304` responses sent by Express itself are not cached.

## Redis cache
```js
// redis setup
const CacheManager = require('cache-manager')
const redisStore = require('cache-manager-ioredis')
const redisCache = CacheManager.caching({
  store: redisStore,
  db: 0,
  host: 'localhost',
  port: 6379,
  ttl: 30
})

// middleware instance
const middleware = require('http-cache-middleware')({
  stores: [redisCache]
})
```
> Stores have to be created with `cache-manager` 4.x (i.e: `cache-manager-ioredis` 2.x), stores from `cache-manager` 5+ are not supported.

## Options
- `stores`: Array of `cache-manager` caches, used as multi-tier cache (first store has the highest priority). Default: `[CacheManager.caching({ store: 'memory', max: 1000, ttl: 30 })]`
- `onError`: Function called with the error when a cache store operation fails. Default: no-op.  
  Cache failures never fail the request: a failed read is handled as a cache miss, and the failures reported by the stores are passed to `onError`. Errors thrown (or rejected) by `onError` itself are ignored.

```js
const middleware = require('http-cache-middleware')({
  onError: (err) => console.error('cache store failure', err)
})
```

## Why cache? 
> Because caching is the last mile for low latency distributed systems!

Enabling proper caching strategies will drastically reduce the latency of your system, as it reduces network round-trips, database calls and CPU processing.  
For our services, we are talking here about improvements in response times from `X ms` to `~2ms`, as an example.

### Enabling cache for service endpoints
Enabling a response to be cached just requires the 
`x-cache-timeout` header to be set:
```js
res.setHeader('x-cache-timeout', '1 hour')
```
> Here we use the [`ms`](https://www.npmjs.com/package/ms) package to convert the timeout, i.e: `'30s'`, `'5 minutes'`, `'1 hour'` (values without unit are milliseconds). TTLs are rounded up to whole seconds, with a minimum of 1 second. Unparseable, zero and negative values are not cached.

Example on service using `restana`:
```js
service.get('/numbers', (req, res) => {
  res.setHeader('x-cache-timeout', '1 hour')

  res.send([
    1, 2, 3
  ])
})
```

#### What gets cached
- The TTL is taken from the `Cache-Control` `s-maxage` directive, or from its `max-age` directive if `s-maxage` is absent. If that value is missing or `0`, the `x-cache-timeout` header is used. Without TTL, nothing is cached.
- `Cache-Control: no-store` responses are not cached, unless the `x-cache-timeout` header is also set.
- `304` and `206` responses, and responses carrying the `x-cache-expire` header, are never cached.
- The `set-cookie` header and hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`, ...) are never stored, so they are never replayed.
- Responses announcing a `content-length` that differs from the bytes actually sent (i.e: an upstream failing half way) are not cached.
- Response bodies are only buffered when the response is going to be cached, which is decided once the response headers are known.

Cached responses are served with the `x-cache-hit: 1` header.

### Caching on the browser side (304 status codes)
> From version `1.2.x` you can also use the HTTP compatible `Cache-Control` header: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control
When using the Cache-Control header, you can omit the custom `x-cache-timeout` header as the timeout can be passed using the `s-maxage` or `max-age` directives. 

#### Direct usage: 
```js 
res.setHeader('cache-control', 'private, no-cache, max-age=300')
res.setHeader('etag', '"cvbonrw6g00"')

res.end('5 minutes cacheable content here....')
```

#### Indirect usage:
When using:
```js
res.setHeader('x-cache-timeout', '5 minutes')
```
The middleware will now transparently generate default `Cache-Control` and `ETag` headers as described below:
```js 
res.setHeader('cache-control', 'private, no-cache, max-age=300')
res.setHeader('etag', '"8c3bd1a9f6e2a07d"') // random ETag value 
```
This will enable browser clients to keep a copy of the cache on their side, but still being forced to validate 
the cache state on the server before using the cached response, therefore supporting gateway based cache invalidation. 

> NOTE: In order to fetch the generated `Cache-Control` and `ETag` headers, there have to be at least one cache hit.

When the `If-None-Match` header of a `GET` or `HEAD` request matches the `ETag` of the cached response (lists, weak `W/` validators and `*` are supported), the middleware responds with `304 Not Modified`, including the `ETag`, `Cache-Control`, `Content-Location`, `Expires` and `Vary` headers of the cached response.

### Invalidating caches 
Services can easily expire cache entries on demand, i.e: when the data state changes. Here we use the `x-cache-expire` header to indicate the cache entries to expire using a matching pattern:
```js
res.setHeader('x-cache-expire', '*/numbers')
```
> Patterns are matched against the [cache keys](#custom-cache-keys), i.e: `GET/numbers`. `*` is the only wildcard (matches any sequence of characters), any other character is matched literally and matching is case-sensitive. Expiration happens once the response has been sent.

Example on service using `restana`:
```js
service.patch('/numbers', (req, res) => {
  // ...

  res.setHeader('x-cache-expire', '*/numbers')
  res.send(200)
})
```

#### Invalidating multiple patterns
Sometimes is required to expire cache entries using multiple patterns, that is also possible using the `,` separator (surrounding whitespaces are ignored):
```js
res.setHeader('x-cache-expire', '*/pattern1,*/pattern2')
```

#### Directly invalidating caches from stores
```js
const stores = [redisCache]
const middleware = require('http-cache-middleware')({
  stores
})

const { deleteKeys } = require('http-cache-middleware/utils') // or: require('http-cache-middleware').deleteKeys
deleteKeys(stores, '*/pattern1,*/pattern2') // or: ['*/pattern1', '*/pattern2']
  .catch(err => console.error('cache expiration failed', err))
```
> `deleteKeys` returns a promise. Expiring wildcard patterns requires stores supporting `keys()`, otherwise the promise is rejected.

### Custom cache keys
Cache keys are generated using: `req.method + req.url`, i.e: `GET/numbers?page=1`. When the middleware is registered inside a mounted router (Express routers, restana nested routers), the mount path is kept in the key, i.e: `GET/v1/numbers`. Requests whose URL contains a whitespace are not cached.  
However, for indexing/segmenting requirements it makes sense to allow cache keys extensions.  

To accomplish this, we simply recommend using middlewares to extend the keys before caching checks happen:
```js
service.use((req, res, next) => {
  req.cacheAppendKey = (req) => req.user.id // here cache key will be: req.method + url + ' ' + req.user.id
  return next()
})
```
> In this example we also distinguish cache entries by `user.id`, commonly used for authorization reasons.

`cacheAppendKey` can also return a promise. The returned value is appended after a single whitespace, i.e: `GET/numbers 42`, while `undefined`, `null` and `''` append nothing. Consider it on your expiration patterns: `*/numbers` won't match `GET/numbers 42`, but `*/numbers *` or `*/numbers*` will (the latter also matches i.e: `GET/numbers?page=1`).

In case full control of the `cache-key` value is preferred, just populate the `req.cacheKey` property with a `string` value. In this case, the key is used as it is: the request method is not part of it, so any request using the same key is served the cached response. `HEAD` requests using custom keys are served from cache, but never stored.
```js
service.use((req, res, next) => {
  if (req.method === 'GET') {
    // i.e: ignoring the query string
    req.cacheKey = 'GET' + req.url.split('?')[0]
  }
  return next()
})
```

### Disable cache for custom endpoints
You can also disable cache checks for certain requests programmatically:
```js
service.use((req, res, next) => {
  req.cacheDisabled = true
  return next()
})
```
The middleware also supports [`middleware-if-unless`](https://www.npmjs.com/package/middleware-if-unless) routing criteria (by default, routes match `GET` requests only):
```js
// cache everything, except GET /me and GET /health
service.use(middleware.unless(['/me', '/health']))

// or, only run the middleware on the given routes
service.use(middleware.iff([{ methods: ['GET', 'PATCH'], url: '/numbers/:id' }]))
```
> Requests skipped by `req.cacheDisabled`, `iff` or `unless` don't process the `x-cache-expire` header either.

## Security considerations
- The middleware does not look at the `Vary`, `Authorization` or `Cache-Control: private` headers (the generated `private, no-cache, max-age=N` header targets browsers). Responses that differ per user must be segmented using `cacheAppendKey`, or excluded using `req.cacheDisabled` / `iff` / `unless`.
- Any request method and response status (except `304` and `206`) is cached when the handler sets the caching headers, i.e: `POST` or `500` responses.
- The default memory store is bounded by number of entries (1000), not by size. To also bound memory usage, see `maxSize` and `sizeCalculation` in [demos/memory-store.js](demos/memory-store.js).
- Expiring wildcard patterns on Redis uses the `KEYS` command, which blocks Redis while scanning all keys. Consider a dedicated Redis database for caching.
- Don't build `x-cache-expire` patterns from untrusted input: `*` expires everything.

## Development
Dev tooling uses [Bun](https://bun.sh), the library itself targets Node.js:
```bash
bun install
bun run lint
bun run test # runs bun test with coverage
bun run test:node # smoke and framework (restana, Express) tests using the Node.js runtime
```

## Want to contribute?
This is your repo ;)  

> Note: We aim to be 100% code coverage, please consider it on your pull requests.

## Related projects
- fast-gateway (https://www.npmjs.com/package/fast-gateway)
