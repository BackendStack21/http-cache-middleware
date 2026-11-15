'use strict'

const CacheManager = require('cache-manager')
const middleware = require('./../index')({
  stores: [CacheManager.caching({
    store: 'memory',
    max: 2000, // max number of entries
    // optional: also bound the memory usage, entries are strings so their length is used as size
    // (entries bigger than maxSize are not cached)
    maxSize: 64 * 1024 * 1024,
    sizeCalculation: (entry) => entry.length,
    ttl: 30
  })]
})
const service = require('restana')()
service.use(middleware)

service.get('/numbers', (req, res) => {
  // keep response in cache for 1 minute if not expired before
  res.setHeader('x-cache-timeout', '1 minute')
  res.send([1, 2, 3])
})

service.patch('/numbers', (req, res) => {
  // ... the logic here changes the numbers

  // expire the cached GET /numbers response
  res.setHeader('x-cache-expire', '*/numbers')
  res.end()
})

service.start(3000)
