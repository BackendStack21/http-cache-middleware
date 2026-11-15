'use strict'

/**
 * Framework integration scenarios: written once, run against restana and Express, using
 * both runtimes: Bun (test/frameworks.test.js) and Node.js (test/node-frameworks.js).
 * Scenarios only use node:assert/strict, so they run unchanged on both.
 *
 * Every scenario gets a fresh app, cache store and middleware instance. Each framework
 * adapter exposes the same routes, written using the framework's idiomatic API.
 *
 * NOTE: this file shows up in the coverage report and the coverage threshold applies
 * to it as well, so every line here must be used by `bun test`.
 */

const http = require('node:http')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const cacheMiddleware = require('./../index')
const { memoryCache, waitFor } = require('./helpers')

const TIMEOUT = '1 minute'
const GENERATED_CACHE_CONTROL = 'private, no-cache, max-age=60'
const GENERATED_ETAG = /^"[0-9a-f]{16}"$/
const JSON_BODY = { route: 'json', items: [1, 2, 3] }
// not valid UTF-8, so any text conversion on the way would show up
const BINARY = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a])
const CHUNKS = () => [Buffer.from([0xff, 0x00]), Buffer.from('é'), Buffer.from(' streamed')]
const FILE = __filename

// plays the role of the application middlewares running before the cache (i.e: authentication)
const upstream = (req, res, next) => {
  const user = req.headers['x-user']
  if (user) {
    req.user = { id: user }
    req.cacheAppendKey = (req) => req.user.id
  }
  if (req.headers['x-append-error']) {
    req.cacheAppendKey = () => { throw new Error('cacheAppendKey failed') }
  }
  if (req.headers['x-cache-disabled']) req.cacheDisabled = true

  next()
}

const listen = async (server) => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  return server
}

/**
 * Both adapters build the same app:
 * - `upstream`, then the cache middleware (unless `mount` is "routers"), then the routes
 * - two routers mounted on /v1 and /v2, exposing the same relative path (/items), that register
 *   the cache middleware themselves when `mount` is "routers"
 * - an error handler recording the errors it receives, then answering as the framework does by default
 */
const frameworks = [
  {
    name: 'restana',
    listen: async ({ middleware, mount, errors, called }) => {
      const restana = require('restana')
      const headers = { 'x-cache-timeout': TIMEOUT }
      const service = restana({
        errorHandler: (err, req, res) => {
          errors.push(err.message)
          res.send(err)
        }
      })
      service.use(upstream)
      if (mount === 'app') service.use(middleware)

      service.get('/text', (req, res) => {
        called('text')
        res.send('text body', 200, headers)
      })
      service.get('/json', (req, res) => {
        called('json')
        res.send(JSON_BODY, 201, headers)
      })
      service.get('/buffer', (req, res) => {
        called('buffer')
        res.send(BINARY, 200, headers)
      })
      service.get('/stream', (req, res) => {
        called('stream')
        res.send(Readable.from(CHUNKS()), 200, headers)
      })
      service.get('/file', (req, res) => {
        called('file')
        res.send(fs.createReadStream(FILE), 200, headers)
      })
      service.get('/max-age', (req, res) => {
        called('max-age')
        res.send('max-age body', 200, { 'cache-control': 'public, max-age=60' })
      })
      service.get('/me', (req, res) => {
        called('me')
        res.send(`profile of ${req.user.id}`, 200, headers)
      })
      service.get('/numbers', (req, res) => {
        called('numbers')
        res.send([1, 2], 200, headers)
      })
      service.get('/numbers/:id', (req, res) => {
        called(`numbers/${req.params.id}`)
        res.send({ id: req.params.id }, 200, headers)
      })
      service.patch('/numbers/:id', (req, res) => {
        res.setHeader('x-cache-expire', `GET/numbers/${req.params.id}`)
        res.send(204)
      })
      service.delete('/numbers', (req, res) => {
        res.setHeader('x-cache-expire', '*/numbers*')
        res.send(204)
      })
      service.get('/redirect', (req, res) => {
        called('redirect')
        res.send(undefined, 302, { location: '/text', ...headers })
      })
      service.get('/error', (req, res) => {
        called('error')
        throw new Error('handler failed')
      })
      service.get('/error-cacheable', (req, res) => {
        called('error-cacheable')
        res.setHeader('x-cache-timeout', TIMEOUT)
        throw new Error('handler failed')
      })

      for (const version of ['v1', 'v2']) {
        const router = service.newRouter()
        if (mount === 'routers') router.use(middleware)
        router.get('/items', (req, res) => {
          called(version)
          res.send(`${version} items`, 200, headers)
        })
        service.use(`/${version}`, router)
      }

      return service.start(0, '127.0.0.1')
    }
  },
  {
    name: 'express',
    listen: ({ middleware, mount, errors, called }) => {
      const express = require('express')
      const app = express()
      // the default error handler logs the errors it handles, except on the "test" environment
      app.set('env', 'test')
      app.use(upstream)
      if (mount === 'app') app.use(middleware)

      app.get('/text', (req, res) => {
        called('text')
        res.set('x-cache-timeout', TIMEOUT).send('text body')
      })
      app.get('/json', (req, res) => {
        called('json')
        res.set('x-cache-timeout', TIMEOUT).status(201).json(JSON_BODY)
      })
      app.get('/buffer', (req, res) => {
        called('buffer')
        res.set('x-cache-timeout', TIMEOUT).send(BINARY)
      })
      app.get('/stream', (req, res) => {
        called('stream')
        res.set('x-cache-timeout', TIMEOUT).type('bin')
        Readable.from(CHUNKS()).pipe(res)
      })
      app.get('/file', (req, res) => {
        called('file')
        res.sendFile(FILE, { headers: { 'x-cache-timeout': TIMEOUT } })
      })
      app.get('/max-age', (req, res) => {
        called('max-age')
        res.set('cache-control', 'public, max-age=60').status(200).send('max-age body')
      })
      app.get('/me', (req, res) => {
        called('me')
        res.set('x-cache-timeout', TIMEOUT).send(`profile of ${req.user.id}`)
      })
      app.get('/numbers', (req, res) => {
        called('numbers')
        res.set('x-cache-timeout', TIMEOUT).json([1, 2])
      })
      app.get('/numbers/:id', (req, res) => {
        called(`numbers/${req.params.id}`)
        res.set('x-cache-timeout', TIMEOUT).json({ id: req.params.id })
      })
      app.patch('/numbers/:id', (req, res) => {
        res.set('x-cache-expire', `GET/numbers/${req.params.id}`).sendStatus(204)
      })
      app.delete('/numbers', (req, res) => {
        res.set('x-cache-expire', '*/numbers*').sendStatus(204)
      })
      app.get('/redirect', (req, res) => {
        called('redirect')
        res.set('x-cache-timeout', TIMEOUT).redirect('/text')
      })
      app.get('/error', (req, res) => {
        called('error')
        throw new Error('handler failed')
      })
      app.get('/error-cacheable', (req, res) => {
        called('error-cacheable')
        res.set('x-cache-timeout', TIMEOUT)
        throw new Error('handler failed')
      })

      for (const version of ['v1', 'v2']) {
        const router = express.Router()
        if (mount === 'routers') router.use(middleware)
        router.get('/items', (req, res) => {
          called(version)
          res.set('x-cache-timeout', TIMEOUT).send(`${version} items`)
        })
        app.use(`/${version}`, router)
      }

      app.use((err, req, res, next) => {
        errors.push(err.message)
        next(err)
      })

      return listen(http.createServer(app))
    }
  }
]

/**
 * Raw node:http client. Unlike fetch, it adds no request headers (undici adds "cache-control: no-cache"
 * and "pragma: no-cache" to conditional requests, Bun's fetch does not) and it never follows redirects.
 */
const request = (port, path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const options = { host: '127.0.0.1', port, path, method, headers, agent: false, signal: AbortSignal.timeout(3000) }
  const req = http.request(options, (res) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => {
      const body = Buffer.concat(chunks)
      resolve({ status: res.statusCode, headers: res.headers, body, text: body.toString() })
    })
  })
  req.on('error', reject)
  req.end()
})

/**
 * Starts the framework app on an ephemeral port.
 * - `mount`: "app" registers the cache middleware app-wide, "routers" inside the mounted routers only
 * - `wrap`: applied to the middleware before registering it, i.e: `(middleware) => middleware.unless([...])`
 */
const start = async (framework, { mount = 'app', wrap = (middleware) => middleware } = {}) => {
  const cache = memoryCache()
  const calls = {}
  const errors = []
  const server = await framework.listen({
    middleware: wrap(cacheMiddleware({ stores: [cache] })),
    mount,
    errors,
    called: (route) => { calls[route] = (calls[route] || 0) + 1 }
  })
  const keys = async () => (await cache.keys()).sort()

  return {
    name: framework.name,
    calls,
    errors,
    keys,
    request: (path, options) => request(server.address().port, path, options),
    entry: async (key) => JSON.parse(await cache.get(key)),
    // cache writes and expirations happen once the response was sent
    stored: async (key) => assert.ok(await waitFor(async () => (await keys()).includes(key)), `${key} not stored`),
    expired: async (key) => assert.ok(await waitFor(async () => !(await keys()).includes(key)), `${key} not expired`),
    close: () => {
      server.closeAllConnections()

      return new Promise(resolve => server.close(resolve))
    }
  }
}

const assertMiss = (res) => assert.equal(res.headers['x-cache-hit'], undefined)

// a hit replays the status, content-type and bytes of the response it was stored from
const assertReplay = (hit, miss) => {
  assertMiss(miss)
  assert.equal(hit.headers['x-cache-hit'], '1')
  assert.equal(hit.status, miss.status)
  assert.equal(hit.headers['content-type'], miss.headers['content-type'])
  assert.deepEqual(hit.body, miss.body)
}

const scenarios = [
  {
    name: 'miss then hit: string, JSON and Buffer bodies',
    run: async (t) => {
      const cases = [
        ['text', 200, t.name === 'express' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', Buffer.from('text body')],
        ['json', 201, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(JSON_BODY))],
        ['buffer', 200, 'application/octet-stream', BINARY]
      ]
      for (const [route, status, type, body] of cases) {
        const miss = await t.request(`/${route}`)
        assert.equal(miss.status, status)
        assert.equal(miss.headers['content-type'], type)
        assert.deepEqual(miss.body, body)
        await t.stored(`GET/${route}`)

        const hit = await t.request(`/${route}`)
        assertReplay(hit, miss)
        assert.equal(hit.headers['content-length'], String(body.length))
        assert.equal(t.calls[route], 1)
      }
    }
  },
  {
    name: 'streamed responses (Readable piped into res, files) are cached and replayed byte-exact',
    run: async (t) => {
      const miss = await t.request('/stream')
      assert.deepEqual(miss.body, Buffer.concat(CHUNKS()))
      assert.equal(miss.headers['content-length'], undefined)
      await t.stored('GET/stream')

      const hit = await t.request('/stream')
      assertReplay(hit, miss)
      // replays are sent at once
      assert.equal(hit.headers['content-length'], String(miss.body.length))
      assert.equal(t.calls.stream, 1)

      const fileMiss = await t.request('/file')
      assert.deepEqual(fileMiss.body, fs.readFileSync(FILE))
      await t.stored('GET/file')

      const fileHit = await t.request('/file')
      assertReplay(fileHit, fileMiss)
      assert.equal(t.calls.file, 1)
      if (t.name === 'express') {
        // res.sendFile() sets its own validators and "cache-control: public, max-age=0", they are replayed as is
        // (max-age=0 means no TTL, so x-cache-timeout drives the caching)
        assert.equal(fileHit.headers['cache-control'], 'public, max-age=0')
        assert.match(fileMiss.headers.etag, /^W\//)
        assert.equal(fileHit.headers.etag, fileMiss.headers.etag)
        assert.equal(fileHit.headers['last-modified'], fileMiss.headers['last-modified'])
      } else {
        assert.equal(fileHit.headers['cache-control'], GENERATED_CACHE_CONTROL)
        assert.match(fileHit.headers.etag, GENERATED_ETAG)
      }
    }
  },
  {
    name: 'cache-control max-age drives the TTL, the header is replayed as is',
    run: async (t) => {
      const before = Date.now()
      const miss = await t.request('/max-age')
      await t.stored('GET/max-age')
      const { expires } = await t.entry('GET/max-age')
      assert.ok(expires >= before + 60000 && expires <= Date.now() + 60000, `expires: ${expires - before}ms`)

      const hit = await t.request('/max-age')
      assertReplay(hit, miss)
      assert.equal(hit.headers['cache-control'], 'public, max-age=60')
      assert.equal(t.calls['max-age'], 1)
      if (t.name === 'express') {
        // Express sets a weak ETag on res.send(), which is kept
        assert.match(miss.headers.etag, /^W\/"/)
        assert.equal(hit.headers.etag, miss.headers.etag)
      } else {
        assert.equal(miss.headers.etag, undefined)
        assert.match(hit.headers.etag, GENERATED_ETAG)
      }
    }
  },
  {
    name: 'x-cache-timeout: generated cache-control and quoted etag',
    run: async (t) => {
      // neither framework sets an ETag on piped streams
      const miss = await t.request('/stream')
      // the generated headers are part of the cached entry only
      assert.equal(miss.headers['cache-control'], undefined)
      assert.equal(miss.headers.etag, undefined)
      await t.stored('GET/stream')

      const hit = await t.request('/stream')
      assert.equal(hit.headers['x-cache-hit'], '1')
      assert.equal(hit.headers['cache-control'], GENERATED_CACHE_CONTROL)
      assert.match(hit.headers.etag, GENERATED_ETAG)
      assert.equal((await t.request('/stream')).headers.etag, hit.headers.etag)

      const notModified = await t.request('/stream', { headers: { 'if-none-match': hit.headers.etag } })
      assert.equal(notModified.status, 304)
      assert.equal(notModified.body.length, 0)
      assert.equal(notModified.headers.etag, hit.headers.etag)
      assert.equal(notModified.headers['cache-control'], GENERATED_CACHE_CONTROL)
      assert.equal(t.calls.stream, 1)

      // res.send() responses: Express already set a (weak) ETag, which is kept
      const text = await t.request('/text')
      await t.stored('GET/text')
      const textHit = await t.request('/text')
      assert.equal(textHit.headers['cache-control'], GENERATED_CACHE_CONTROL)
      if (t.name === 'express') {
        assert.match(text.headers.etag, /^W\/"/)
        assert.equal(textHit.headers.etag, text.headers.etag)
      } else {
        assert.equal(text.headers.etag, undefined)
        assert.match(textHit.headers.etag, GENERATED_ETAG)
      }
    }
  },
  {
    name: 'framework ETag and If-None-Match (304 from the framework vs 304 from the cache)',
    run: async (t) => {
      // the framework response, bypassing the cache
      const direct = await t.request('/text', { headers: { 'x-cache-disabled': '1' } })
      assert.equal(t.calls.text, 1)
      if (t.name === 'express') {
        assert.match(direct.headers.etag, /^W\/"/)

        // nothing cached yet: Express itself answers the conditional request with a 304 (req.fresh)...
        const fresh = await t.request('/text', { headers: { 'if-none-match': direct.headers.etag } })
        assert.equal(fresh.status, 304)
        assertMiss(fresh)
        assert.equal(t.calls.text, 2)
        // ...which is not stored, so a later plain GET gets the full response
        assert.deepEqual(await t.keys(), [])
        const full = await t.request('/text')
        assert.equal(full.status, 200)
        assertMiss(full)
        assert.equal(full.text, 'text body')
        assert.equal(t.calls.text, 3)
      } else {
        // restana does not handle conditional requests: the first one is a full 200, which is stored
        assert.equal(direct.headers.etag, undefined)
        const first = await t.request('/text', { headers: { 'if-none-match': '"unknown"' } })
        assert.equal(first.status, 200)
        assertMiss(first)
        assert.equal(t.calls.text, 2)
      }
      await t.stored('GET/text')
      const calls = t.calls.text

      const hit = await t.request('/text')
      assert.equal(hit.headers['x-cache-hit'], '1')
      const { etag } = hit.headers
      if (t.name === 'express') {
        // the cached entry keeps the framework's ETag
        assert.equal(etag, direct.headers.etag)
      } else {
        assert.match(etag, GENERATED_ETAG)
      }

      // from now on, the cache answers the conditional requests (weak comparison, lists)
      for (const ifNoneMatch of [etag, `"other", W/${etag.replace(/^W\//, '')}`]) {
        const notModified = await t.request('/text', { headers: { 'if-none-match': ifNoneMatch } })
        assert.equal(notModified.status, 304)
        assert.equal(notModified.headers.etag, etag)
        assert.equal(notModified.headers['cache-control'], GENERATED_CACHE_CONTROL)
      }
      // the request "cache-control: no-cache" directive is not honoured (Express' req.fresh honours it)
      const noCache = await t.request('/text', { headers: { 'if-none-match': etag, 'cache-control': 'no-cache' } })
      assert.equal(noCache.status, 304)

      const other = await t.request('/text', { headers: { 'if-none-match': '"other"' } })
      assert.equal(other.status, 200)
      assert.equal(other.headers['x-cache-hit'], '1')
      assert.equal(other.text, 'text body')
      assert.equal(t.calls.text, calls)
    }
  },
  {
    name: 'x-cache-expire: exact (PATCH) and wildcard (DELETE) patterns, followed by a miss',
    run: async (t) => {
      const paths = ['/numbers', '/numbers/1', '/numbers/2']
      for (const path of paths) {
        await t.request(path)
        await t.stored(`GET${path}`)
        assert.equal((await t.request(path)).headers['x-cache-hit'], '1')
      }

      const patch = await t.request('/numbers/1', { method: 'PATCH' })
      assert.equal(patch.status, 204)
      await t.expired('GET/numbers/1')
      assert.deepEqual(await t.keys(), ['GET/numbers', 'GET/numbers/2'])
      const miss = await t.request('/numbers/1')
      assertMiss(miss)
      assert.equal(miss.text, '{"id":"1"}')
      assert.equal(t.calls['numbers/1'], 2)
      assert.equal((await t.request('/numbers/2')).headers['x-cache-hit'], '1')

      const del = await t.request('/numbers', { method: 'DELETE' })
      assert.equal(del.status, 204)
      await t.expired('GET/numbers')
      assert.deepEqual(await t.keys(), [])
      for (const path of paths) assertMiss(await t.request(path))
      assert.deepEqual(t.calls, { numbers: 2, 'numbers/1': 3, 'numbers/2': 2 })
    }
  },
  {
    name: 'req.cacheAppendKey set by an upstream middleware segments the cache per user',
    run: async (t) => {
      const as = (user) => t.request('/me', { headers: { 'x-user': user } })

      const alice = await as('alice')
      assert.equal(alice.text, 'profile of alice')
      await t.stored('GET/me alice')
      const bob = await as('bob')
      assertMiss(bob)
      assert.equal(bob.text, 'profile of bob')
      await t.stored('GET/me bob')

      assertReplay(await as('alice'), alice)
      assertReplay(await as('bob'), bob)
      assert.equal(t.calls.me, 2)
      assert.deepEqual(await t.keys(), ['GET/me alice', 'GET/me bob'])
    }
  },
  {
    name: 'req.cacheDisabled set by an upstream middleware bypasses the cache',
    run: async (t) => {
      const disabled = () => t.request('/text', { headers: { 'x-cache-disabled': '1' } })

      assertMiss(await disabled())
      assertMiss(await disabled())
      assert.equal(t.calls.text, 2)
      assert.deepEqual(await t.keys(), [])

      await t.request('/text')
      await t.stored('GET/text')
      assert.equal((await t.request('/text')).headers['x-cache-hit'], '1')
      // also when the response is cached
      const bypass = await disabled()
      assertMiss(bypass)
      assert.equal(bypass.text, 'text body')
      assert.equal(t.calls.text, 4)
    }
  },
  ...['app', 'routers'].map(mount => ({
    name: mount === 'app'
      ? 'mounted routers: same relative path on /v1 and /v2, cache middleware registered app-wide'
      : 'mounted routers: same relative path on /v1 and /v2, cache middleware registered inside the routers',
    app: { mount },
    run: async (t) => {
      const v1 = await t.request('/v1/items')
      assert.equal(v1.text, 'v1 items')
      assert.ok(await waitFor(async () => (await t.keys()).length === 1))

      const v2 = await t.request('/v2/items')
      assert.equal(v2.text, 'v2 items', `GET /v2/items was served the /v1/items response, stored keys: ${await t.keys()}`)
      assertMiss(v2)
      await t.stored('GET/v2/items')
      assert.deepEqual(await t.keys(), ['GET/v1/items', 'GET/v2/items'])

      assertReplay(await t.request('/v1/items'), v1)
      assertReplay(await t.request('/v2/items'), v2)
      assert.deepEqual(t.calls, { v1: 1, v2: 1 })
    }
  })),
  {
    name: 'middleware.unless([...]) as documented',
    app: { wrap: (middleware) => middleware.unless(['/me']) },
    run: async (t) => {
      const me = () => t.request('/me', { headers: { 'x-user': 'alice' } })
      assertMiss(await me())
      assertMiss(await me())
      assert.equal(t.calls.me, 2)

      // string endpoints only match GET requests: HEAD /me still goes through the cache
      await t.request('/me', { method: 'HEAD', headers: { 'x-user': 'alice' } })
      await t.stored('HEAD/me alice')

      const text = await t.request('/text')
      await t.stored('GET/text')
      assertReplay(await t.request('/text'), text)
      assert.deepEqual(await t.keys(), ['GET/text', 'HEAD/me alice'])
    }
  },
  {
    name: 'middleware.iff([...]) as documented',
    app: { wrap: (middleware) => middleware.iff([{ methods: ['GET', 'PATCH'], url: '/numbers/:id' }]) },
    run: async (t) => {
      assertMiss(await t.request('/text'))
      assertMiss(await t.request('/text'))
      assert.equal(t.calls.text, 2)

      const miss = await t.request('/numbers/1')
      await t.stored('GET/numbers/1')
      assertReplay(await t.request('/numbers/1'), miss)

      // DELETE /numbers is skipped by iff(...), so its x-cache-expire header is not processed either
      assert.equal((await t.request('/numbers', { method: 'DELETE' })).status, 204)
      assert.equal((await t.request('/numbers/1')).headers['x-cache-hit'], '1')

      assert.equal((await t.request('/numbers/1', { method: 'PATCH' })).status, 204)
      await t.expired('GET/numbers/1')
      assertMiss(await t.request('/numbers/1'))
      assert.equal(t.calls['numbers/1'], 2)
    }
  },
  {
    name: 'HEAD requests on a GET route, before and after the GET is cached',
    run: async (t) => {
      const head = (path) => t.request(path, { method: 'HEAD' })

      // HEAD first: stored under its own key, so the GET is still a miss
      const headMiss = await head('/text')
      assert.equal(headMiss.status, 200)
      assert.equal(headMiss.body.length, 0)
      assertMiss(headMiss)
      await t.stored('HEAD/text')
      const headHit = await head('/text')
      assertReplay(headHit, headMiss)
      assert.equal(t.calls.text, 1)

      const get = await t.request('/text')
      assertMiss(get)
      assert.equal(get.text, 'text body')
      assert.equal(headMiss.headers['content-type'], get.headers['content-type'])
      assert.equal(t.calls.text, 2)
      await t.stored('GET/text')

      // GET first: the HEAD request is a miss as well
      const json = await t.request('/json')
      await t.stored('GET/json')
      assert.equal((await t.request('/json')).headers['x-cache-hit'], '1')
      const jsonHead = await head('/json')
      assertMiss(jsonHead)
      assert.equal(jsonHead.status, 201)
      assert.equal(t.calls.json, 2)
      await t.stored('HEAD/json')
      assertReplay(await head('/json'), jsonHead)
      assert.deepEqual(await t.keys(), ['GET/json', 'GET/text', 'HEAD/json', 'HEAD/text'])

      if (t.name === 'express') {
        // Express announces the length of the GET body on HEAD responses, so do the replays
        assert.equal(headMiss.headers['content-length'], get.headers['content-length'])
        assert.equal(headHit.headers['content-length'], get.headers['content-length'])
      } else {
        assert.equal(headMiss.headers['content-length'], undefined)
        assert.equal(headHit.headers['content-length'], undefined)
      }
      assert.equal(jsonHead.headers['content-length'], t.name === 'express' ? json.headers['content-length'] : undefined)
    }
  },
  {
    name: 'framework 404 (no route) is not cached',
    run: async (t) => {
      for (let i = 0; i < 2; i++) {
        const res = await t.request('/missing')
        assert.equal(res.status, 404)
        assertMiss(res)
        assert.equal(res.headers['content-type'], t.name === 'express' ? 'text/html; charset=utf-8' : undefined)
      }
      assert.deepEqual(await t.keys(), [])
    }
  },
  {
    name: 'error thrown in a handler (500) is not cached',
    run: async (t) => {
      for (let i = 0; i < 2; i++) {
        const res = await t.request('/error')
        assert.equal(res.status, 500)
        assertMiss(res)
      }
      assert.equal(t.calls.error, 2)
      assert.deepEqual(t.errors, ['handler failed', 'handler failed'])
      assert.deepEqual(await t.keys(), [])
    }
  },
  {
    name: 'error thrown in a handler after setting x-cache-timeout: the 500 is cached (documented)',
    run: async (t) => {
      const miss = await t.request('/error-cacheable')
      assert.equal(miss.status, 500)
      await t.stored('GET/error-cacheable')

      const hit = await t.request('/error-cacheable')
      assertReplay(hit, miss)
      assert.equal(t.calls['error-cacheable'], 1)
      assert.deepEqual(t.errors, ['handler failed'])
    }
  },
  {
    name: 'redirect (302) with x-cache-timeout is cached and replayed with its location',
    run: async (t) => {
      const miss = await t.request('/redirect')
      assert.equal(miss.status, 302)
      assert.equal(miss.headers.location, '/text')
      await t.stored('GET/redirect')

      const hit = await t.request('/redirect')
      assertReplay(hit, miss)
      assert.equal(hit.headers.location, '/text')
      assert.deepEqual(t.calls, { redirect: 1 })

      if (t.name === 'express') {
        // res.redirect() negotiates the body (Vary: Accept), the cache ignores Vary:
        // an HTML client is served the text/plain variant
        assert.equal(miss.headers.vary, 'Accept')
        assert.equal(miss.headers['content-type'], 'text/plain; charset=utf-8')
        const html = await t.request('/redirect', { headers: { accept: 'text/html' } })
        assertReplay(html, miss)
      } else {
        assert.equal(miss.body.length, 0)
      }
    }
  },
  {
    name: 'error thrown by req.cacheAppendKey reaches the framework error handler (500)',
    run: async (t) => {
      const res = await t.request('/text', { headers: { 'x-append-error': '1' } })
      assert.equal(res.status, 500)
      assertMiss(res)
      assert.deepEqual(t.errors, ['cacheAppendKey failed'])
      assert.deepEqual(t.calls, {})
      assert.deepEqual(await t.keys(), [])
      if (t.name === 'express') {
        assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
      } else {
        assert.deepEqual(JSON.parse(res.text), { code: 500, message: 'Internal Server Error' })
      }
    }
  }
]

/**
 * Scenarios the library is known to fail, as "<framework>: <scenario>" => reason.
 * They keep asserting the expected behavior, and run as expected failures (bun: it.failing, node: XFAIL).
 */
const knownIssues = {}

const knownIssue = (framework, scenario) => knownIssues[`${framework.name}: ${scenario.name}`]

const run = async (framework, scenario) => {
  const t = await start(framework, scenario.app)
  try {
    await scenario.run(t)
  } finally {
    await t.close()
  }
}

module.exports = {
  frameworks,
  scenarios,
  knownIssue,
  run
}
