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
// ...

service.start(3000)
