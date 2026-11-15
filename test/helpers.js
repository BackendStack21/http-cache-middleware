'use strict'

// Shared test helpers. NOTE: this file shows up in the coverage report and the
// coverage threshold applies to it as well, so every line here must be used.

const http = require('node:http')
const CacheManager = require('cache-manager')

const memoryCache = () => CacheManager.caching({ store: 'memory', max: 1000, ttl: 30 })

/**
 * Minimal connect-like app on top of a raw node:http server, listening on an ephemeral port.
 * Every request runs `before` (optional), then the middleware; `next()` dispatches to
 * `routes[pathname]`, while `next(err)` is recorded in `errors` and answered with a 500.
 */
const serve = async (middleware, routes, before = () => {}) => {
  const errors = []
  const server = http.createServer((req, res) => {
    before(req, res)
    middleware(req, res, (err) => {
      if (err) {
        errors.push(err)
        res.statusCode = 500
        return res.end()
      }

      routes[req.url.split('?')[0]](req, res)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  return {
    errors,
    // the body is always consumed as raw bytes, so binary payloads can be compared exactly
    request: async (path, init) => {
      const res = await fetch(base + path, init)
      const body = Buffer.from(await res.arrayBuffer())

      return { status: res.status, headers: res.headers, body, text: body.toString() }
    },
    close: () => {
      // drop idle keep-alive sockets held by fetch, otherwise close() waits on them
      server.closeAllConnections()

      return new Promise(resolve => server.close(resolve))
    }
  }
}

/**
 * Polls until `predicate` returns (or resolves to) true or `timeout` ms elapse, resolving to the last predicate result.
 * Used for side effects that happen after the response was flushed (cache writes, expirations, onError).
 */
const waitFor = async (predicate, timeout = 1000) => {
  const deadline = Date.now() + timeout
  while (!(await predicate()) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }

  return predicate()
}

module.exports = {
  memoryCache,
  serve,
  waitFor
}
