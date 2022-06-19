'use strict'

const CacheManager = require('cache-manager')
const redisStore = require('cache-manager-ioredis')
const redisCache = CacheManager.caching({
  store: redisStore,
  db: 0,
  host: 'localhost',
  port: 6379,
  ttl: 30
})
const middleware = require('../index')({
  stores: [redisCache]
})

const service = require('restana')()
service.use(middleware)

service.get('/cache', (req, res) => {
  setTimeout(() => {
    res.setHeader('x-cache-timeout', '1 minute')
    res.send('this supposed to be a cacheable response')
  }, 50)
})

service.delete('/cache', (req, res) => {
  res.setHeader('x-cache-expire', '*/cache-*')
  res.end()
})

service.start(3000)
