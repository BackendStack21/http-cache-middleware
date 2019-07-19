const CacheManager = require('cache-manager')
const middleware = require('./../index')({
  stores: [CacheManager.caching({ store: 'memory', max: 2000, ttl: 30 })]
})
const service = require('restana')()
service.use(middleware)
// ...

service.start(3000)
