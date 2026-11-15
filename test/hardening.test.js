'use strict'

const { describe, it, expect, beforeAll, afterAll } = require('bun:test')
const { memoryCache, serve, waitFor } = require('./helpers')

describe('hardening', () => {
  const cache = memoryCache()
  const errors = []
  const calls = {}
  let app

  const count = (req) => {
    calls[req.url] = (calls[req.url] || 0) + 1

    return calls[req.url]
  }

  const routes = {
    // a response announcing more bytes than it delivers (i.e. an upstream failing half way)
    '/truncated': (req, res) => {
      count(req)
      res.setHeader('x-cache-timeout', '1 minute')
      res.setHeader('x-declared-length', '10')
      res.end('12345')
    },
    '/complete': (req, res) => {
      res.setHeader('x-cache-timeout', '1 minute')
      res.setHeader('content-length', '6')
      res.end(`héllo${count(req)}`.slice(0, 5))
    },
    '/complete-binary': (req, res) => {
      count(req)
      res.setHeader('x-cache-timeout', '1 minute')
      res.setHeader('content-length', '2')
      res.end(Buffer.from([0xff, 0xfe]))
    },
    '/head': (req, res) => {
      count(req)
      res.setHeader('x-cache-timeout', '1 minute')
      res.setHeader('content-length', '5')
      res.end()
    },
    '/empty-timeout': (req, res) => {
      res.setHeader('x-cache-timeout', '')
      res.end(`call ${count(req)}`)
    },
    '/end-throws': (req, res) => {
      count(req)
      res.setHeader('x-cache-timeout', '1 minute')
      try {
        res.end('first attempt')
      } catch (err) {
        res.end('second attempt')
      }
    },
    '/write-head-undefined-reason': (req, res) => {
      count(req)
      res.writeHead(200, undefined, { 'x-cache-timeout': '1 minute' })
      res.end('inline headers after an undefined reason')
    },
    '/write-head-status-only': (req, res) => {
      res.setHeader('x-cache-timeout', '1 minute')
      res.writeHead(201)
      res.end(`created ${count(req)}`)
    },
    // a first attempt to send the response fails, an error page follows
    '/write-head-throws': (req, res) => {
      res.setHeader('cache-control', 'max-age=60')
      try {
        res.writeHead(200, { 'x-invalid': 'a\nb' })
      } catch (err) {
        res.removeHeader('cache-control')
        res.statusCode = 500
      }
      res.end(`failed ${count(req)}`)
    },
    '/unsafe': (req, res) => {
      res.setHeader('x-cache-timeout', '1 minute')
      res.setHeader('etag', '"v1"')
      res.end(`${req.method} ${count(req)}`)
    },
    '/head-with-body': (req, res) => {
      res.setHeader('x-cache-timeout', '1 minute')
      res.write('a body that is ')
      res.end('never sent')
    },
    '/seeded': (req, res) => {
      res.end(`handler ${count(req)}`)
    }
  }

  // plays the role of upstream middlewares
  const before = (req, res) => {
    if (req.url === '/end-throws') {
      const { end } = res
      res.end = function (chunk) {
        if (chunk === 'first attempt') throw new Error('end failed')

        return end.apply(this, arguments)
      }
    }
    if (req.url === '/truncated') {
      // the content-length header is only visible to the cache, so the HTTP exchange itself stays valid
      const { getHeaders } = res
      res.getHeaders = function () {
        const headers = getHeaders.call(this)
        headers['content-length'] = headers['x-declared-length']

        return headers
      }
    }
  }

  beforeAll(async () => {
    app = await serve(require('./../index')({
      stores: [cache],
      // an asynchronous error handler that fails
      onError: async (err) => {
        errors.push(err)
        throw new Error('onError rejected')
      }
    }), routes, before)
  })

  afterAll(() => app.close())

  const stored = async (key) => (await cache.keys()).includes(key)

  it('does not cache responses delivering less bytes than announced', async () => {
    expect((await app.request('/truncated')).text).toBe('12345')
    const second = await app.request('/truncated')
    expect(second.headers.get('x-cache-hit')).toBeNull()
    expect(calls['/truncated']).toBe(2)
    expect(await stored('GET/truncated')).toBe(false)
  })

  it('caches responses delivering the announced bytes', async () => {
    // content-length is expressed in bytes, not in characters
    expect((await app.request('/complete')).text).toBe('héllo')
    const hit = await app.request('/complete')
    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(hit.text).toBe('héllo')

    await app.request('/complete-binary')
    const binary = await app.request('/complete-binary')
    expect(binary.headers.get('x-cache-hit')).toBe('1')
    expect(binary.body.toString('hex')).toBe('fffe')
  })

  it('caches HEAD responses announcing the length of the omitted body', async () => {
    await app.request('/head', { method: 'HEAD' })
    const hit = await app.request('/head', { method: 'HEAD' })
    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(calls['/head']).toBe(1)
  })

  it('reports invalid x-cache-timeout values, without caching or failing the response', async () => {
    expect((await app.request('/empty-timeout')).text).toBe('call 1')
    expect((await app.request('/empty-timeout')).text).toBe('call 2')
    expect(await waitFor(() => errors.length === 2)).toBe(true)
    expect(app.errors).toEqual([])
  })

  it('caches the response that was actually sent when res.end() throws', async () => {
    expect((await app.request('/end-throws')).text).toBe('second attempt')
    const hit = await app.request('/end-throws')
    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(hit.text).toBe('second attempt')
    expect(calls['/end-throws']).toBe(1)
  })

  it('supports res.writeHead() calls with an undefined reason, or with no headers', async () => {
    await app.request('/write-head-undefined-reason')
    const inline = await app.request('/write-head-undefined-reason')
    expect(inline.headers.get('x-cache-hit')).toBe('1')
    expect(inline.text).toBe('inline headers after an undefined reason')

    await app.request('/write-head-status-only')
    const hit = await app.request('/write-head-status-only')
    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(hit.status).toBe(201)
    expect(hit.text).toBe('created 1')
  })

  it('does not cache an error response using the headers of a failed res.writeHead()', async () => {
    const first = await app.request('/write-head-throws')
    expect(first.status).toBe(500)
    expect(first.text).toBe('failed 1')
    const second = await app.request('/write-head-throws')
    expect(second.text).toBe('failed 2')
    expect(second.headers.get('x-cache-hit')).toBeNull()
    expect(await stored('GET/write-head-throws')).toBe(false)
  })

  it('only evaluates If-None-Match for GET and HEAD requests', async () => {
    const init = { method: 'POST', headers: { 'if-none-match': '*' } }
    expect((await app.request('/unsafe', init)).text).toBe('POST 1')
    // cached, but the precondition does not turn it into a 304
    const hit = await app.request('/unsafe', init)
    expect(hit.status).toBe(200)
    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(hit.text).toBe('POST 1')

    await app.request('/unsafe')
    expect((await app.request('/unsafe', { headers: { 'if-none-match': '"v1"' } })).status).toBe(304)
  })

  it('does not store the body handlers provide on HEAD requests', async () => {
    await app.request('/head-with-body', { method: 'HEAD' })
    const hit = await app.request('/head-with-body', { method: 'HEAD' })
    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(JSON.parse(await cache.get('HEAD/head-with-body')).data).toBeUndefined()
  })

  it('treats malformed entries as a miss', async () => {
    const entry = { v: 2, status: 200, headers: {}, expires: Date.now() + 60000, data: 'seeded' }
    const variants = [
      { status: 'abc' },
      { status: 99 },
      { status: 600 },
      { status: 200.5 },
      { data: 5 },
      { data: { type: 'Buffer', data: [1] } }
    ]
    for (const variant of variants) {
      await cache.set('GET/seeded', JSON.stringify({ ...entry, ...variant }))
      const res = await app.request('/seeded')
      expect(res.status).toBe(200)
      expect(res.headers.get('x-cache-hit')).toBeNull()
    }

    await cache.set('GET/seeded', JSON.stringify(entry))
    const hit = await app.request('/seeded')
    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(hit.text).toBe('seeded')
  })

  it('does not store HTTP/2 pseudo-headers', async () => {
    const store = memoryCache()
    const middleware = require('./../index')({ stores: [store] })
    const pseudo = await serve(middleware, {
      '/pseudo': (req, res) => {
        res.setHeader('x-cache-timeout', '1 minute')
        res.end('pseudo')
      }
    }, (req, res) => {
      // HTTP/2 compat responses expose pseudo-headers once the headers were flushed
      const { getHeaders } = res
      res.getHeaders = function () {
        return Object.assign(getHeaders.call(this), { ':status': 200 })
      }
    })

    await pseudo.request('/pseudo')
    const hit = await pseudo.request('/pseudo')
    await pseudo.close()

    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(Object.keys(JSON.parse(await store.get('GET/pseudo')).headers)).not.toContain(':status')
  })
})
