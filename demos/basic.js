const middleware = require('./../index')()
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
