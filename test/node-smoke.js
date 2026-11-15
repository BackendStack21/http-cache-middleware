'use strict'

// Smoke test for the Node.js runtime: the test suite runs on Bun, while the library targets Node.js.
// Usage: node test/node-smoke.js

const http = require('node:http')
const assert = require('node:assert/strict')

const errors = []
const middleware = require('./../index')({ onError: (err) => errors.push(err) })
let calls = 0

const routes = {
  '/write-head': (req, res) => {
    res.writeHead(200, { 'x-cache-timeout': '1 minute' })
    res.end(`call ${++calls}`)
  },
  '/write-head-raw': (req, res) => {
    res.writeHead(200, 'OK', ['X-Cache-Timeout', '1 minute'])
    res.end(`call ${++calls}`)
  },
  '/binary': (req, res) => {
    res.setHeader('cache-control', 'max-age=60')
    res.setHeader('set-cookie', 'session=1')
    res.write(Buffer.from([0xff, 0xfe]))
    res.write('é')
    res.end(new Uint8Array([1, 2]))
  },
  '/not-cacheable': (req, res) => res.end(`call ${++calls}`),
  '/not-found': (req, res) => {
    res.statusCode = 404
    res.setHeader('x-cache-timeout', '1 minute')
    res.end('not found')
  },
  '/expire': (req, res) => {
    res.setHeader('x-cache-expire', '*/write-head')
    res.end()
  }
}

const server = http.createServer((req, res) => middleware(req, res, (err) => {
  if (err) {
    res.statusCode = 500
    return res.end(String(err))
  }

  const handler = Object.hasOwn(routes, req.url) ? routes[req.url] : undefined
  if (typeof handler !== 'function') {
    res.statusCode = 404
    return res.end()
  }

  handler(req, res)
}))

const main = async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const get = async (path, headers) => {
    const res = await fetch(base + path, { headers })

    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) }
  }

  // headers passed to writeHead(...)
  for (const path of ['/write-head', '/write-head-raw']) {
    const miss = await get(path)
    const hit = await get(path)
    assert.equal(miss.headers.get('x-cache-hit'), null, path)
    assert.equal(hit.headers.get('x-cache-hit'), '1', path)
    assert.equal(hit.body.toString(), miss.body.toString(), path)
  }

  // mixed chunks are replayed byte by byte, per-client headers are not replayed
  const miss = await get('/binary')
  const hit = await get('/binary')
  assert.equal(miss.body.toString('hex'), 'fffec3a90102')
  assert.equal(hit.headers.get('x-cache-hit'), '1')
  assert.equal(hit.body.toString('hex'), miss.body.toString('hex'))
  assert.equal(hit.headers.get('set-cookie'), null)
  assert.match(hit.headers.get('etag'), /^"[0-9a-f]{16}"$/)

  // conditional requests
  const etag = hit.headers.get('etag')
  assert.equal((await get('/binary', { 'if-none-match': `"other", W/${etag}` })).status, 304)
  assert.equal((await get('/binary', { 'if-none-match': '"other"' })).status, 200)

  // responses without caching headers
  await get('/not-cacheable')
  assert.equal((await get('/not-cacheable')).headers.get('x-cache-hit'), null)

  // cached error responses ignore preconditions
  await get('/not-found')
  assert.equal((await get('/not-found')).headers.get('x-cache-hit'), '1')
  assert.equal((await get('/not-found', { 'if-none-match': '*' })).status, 404)

  // expiration
  await get('/expire')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal((await get('/write-head')).headers.get('x-cache-hit'), null)
  assert.equal((await get('/write-head-raw')).headers.get('x-cache-hit'), '1')

  assert.deepEqual(errors, [])
  console.log(`Node.js ${process.version}: OK`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    server.closeAllConnections()
    server.close()
  })
