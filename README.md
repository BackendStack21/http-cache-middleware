# http-cache-middleware
High performance connect-like HTTP cache middleware for Node.js. So your latency can decrease to single digit milliseconds 🚀 

> Uses `cache-manager` as caching layer, so multiple
storage engines are supported, i.e: Memory, Redis, ... https://www.npmjs.com/package/cache-manager

## Install
```js 
npm i http-cache-middleware
```

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
> Here we use the [`ms`](`https://www.npmjs.com/package/ms`) package to convert timeout to seconds. Please note that `millisecond` unit is not supported!  

Example on service using `restana`:
```js
service.get('/numbers', (req, res) => {
  res.setHeader('x-cache-timeout', '1 hour')

  res.send([
    1, 2, 3
  ])
})
```

### Caching on the browser side (304 status codes)
> From version `1.2.x` you can also use the HTTP compatible `Cache-Control` header: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control
When using the Cache-Control header, you can omit the custom `x-cache-timeout` header as the timeout can be passed using the `max-age` directive. 

#### Direct usage: 
```js 
res.setHeader('cache-control', 'private, no-cache, max-age=300')
res.setHeader('etag', 'cvbonrw6g00')

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
res.setHeader('etag', 'ao8onrw6gbt') // random ETag value 
```
This will enable browser clients to keep a copy of the cache on their side, but still being forced to validate 
the cache state on the server before using the cached response, therefore supporting gateway based cache invalidation. 

> NOTE: In order to fetch the generated `Cache-Control` and `ETag` headers, there have to be at least one cache hit.

### Invalidating caches 
Services can easily expire cache entries on demand, i.e: when the data state changes. Here we use the `x-cache-expire` header to indicate the cache entries to expire using a matching pattern:
```js
res.setHeader('x-cache-expire', '*/numbers')
```
> Here we use the [`matcher`](`https://www.npmjs.com/package/matcher`) package for matching patterns evaluation.

Example on service using `restana`:
```js
service.patch('/numbers', (req, res) => {
  // ...

  res.setHeader('x-cache-expire', '*/numbers')
  res.send(200)
})
```

#### Invalidating multiple patterns
Sometimes is required to expire cache entries using multiple patterns, that is also possible using the `,` separator:
```js
res.setHeader('x-cache-expire', '*/pattern1,*/pattern2')
```

#### Direclty invalidating caches from stores
```js
const stores = [redisCache]
const middleware = require('http-cache-middleware')({
  stores
})

const { deleteKeys } = require('http-cache-middleware/utils')
deleteKeys(stores, '*/pattern1,*/pattern2')
```

### Custom cache keys
Cache keys are generated using: `req.method + req.url`, however, for indexing/segmenting requirements it makes sense to allow cache keys extensions.  

To accomplish this, we simply recommend using middlewares to extend the keys before caching checks happen:
```js
service.use((req, res, next) => {
  req.cacheAppendKey = (req) => req.user.id // here cache key will be: req.method + req.url + req.user.id  
  return next()
})
```
> In this example we also distinguish cache entries by `user.id`, commonly used for authorization reasons.

In case full control of the `cache-key` value is preferred, just populate the `req.cacheKey` property with a `string` value. In this case, the req.method + req.url prefix is discarded:
```js
service.use((req, res, next) => {
  req.cacheKey = 'CUSTOM-CACHE-KEY'
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

## Want to contribute?
This is your repo ;)  

> Note: We aim to be 100% code coverage, please consider it on your pull requests.

## Related projects
- fast-gateway (https://www.npmjs.com/package/fast-gateway)

## Sponsors
- (INACTIVE) Kindly sponsored by [ShareNow](https://www.share-now.com/), a company that promotes innovation!  

## Support / Donate 💚
You can support the maintenance of this project: 
- Paypal: https://www.paypal.me/kyberneees
- [TRON](https://www.binance.com/en/buy-TRON) Wallet: `TJ5Bbf9v4kpptnRsePXYDvnYcYrS5Tyxus`