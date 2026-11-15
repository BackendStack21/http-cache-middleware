'use strict'

const { describe, it, expect, beforeAll, afterAll, spyOn } = require('bun:test')
const { memoryCache, serve } = require('./helpers')

// Raw node:http handlers, as the response body capture has to support every way of
// writing a response: restana's res.send() only ever calls res.end() once.
describe('response body capture', () => {
  const cache = memoryCache()
  const setSpy = spyOn(cache.store, 'set')
  const storedKeys = () => setSpy.mock.calls.map(call => call[0])
  const calls = {}
  let endCallbackCalls = 0
  let app

  const cacheable = (handler) => (req, res) => {
    calls[req.url] = (calls[req.url] || 0) + 1
    res.setHeader('x-cache-timeout', '1 minute')
    handler(req, res)
  }

  const routes = {
    '/string': cacheable((req, res) => res.end('héllo wörld ✓')),
    '/buffer': cacheable((req, res) => res.end(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41]))),
    '/string-string': cacheable((req, res) => {
      res.write('é')
      res.write('-b-', 'utf-8')
      res.end('c')
    }),
    '/buffer-buffer': cacheable((req, res) => {
      res.write(Buffer.from([0xff]))
      res.write(Buffer.from([0xfe]))
      res.end()
    }),
    '/string-buffer': cacheable((req, res) => {
      res.write('ü')
      res.end(Buffer.from([0xff, 0xfe]))
    }),
    '/buffer-string': cacheable((req, res) => {
      res.write(Buffer.from([0xff, 0xfe]))
      res.write('ü')
      res.end('!')
    }),
    '/hex': cacheable((req, res) => res.end('68656c6c6f', 'hex')),
    '/encodings': cacheable((req, res) => {
      res.write('ff00', 'hex')
      res.write('/w==', 'base64')
      res.write('þ', 'latin1')
      res.end('é')
    }),
    '/uint8array': cacheable((req, res) => {
      // views on a larger ArrayBuffer: only the viewed bytes must be captured
      res.write(new Uint8Array([0x01, 0xff, 0xfe, 0x02]).subarray(1, 3))
      res.end(new Uint8Array([0x03, 0x04, 0x00, 0x80, 0x05]).subarray(2, 4))
    }),
    '/uint8array-end': cacheable((req, res) => {
      res.end(new Uint8Array([0x03, 0xff, 0xfe, 0x05]).subarray(1, 3))
    }),
    '/reused-buffer': cacheable((req, res) => {
      const chunk = Buffer.from('abcd')
      res.write(chunk)
      chunk.fill('z') // the caller reuses its buffer before the response ends
      res.end()
    }),
    '/empty': cacheable((req, res) => res.end()),
    '/empty-chunks': cacheable((req, res) => {
      res.write('')
      res.write(Buffer.alloc(0))
      res.end('', 'hex')
    }),
    '/end-callback': cacheable((req, res) => {
      res.end(() => { endCallbackCalls++ })
    }),
    '/double-end': cacheable((req, res) => {
      res.end('first')
      res.end()
    }),
    '/status': cacheable((req, res) => {
      res.statusCode = 201
      res.setHeader('content-type', 'application/json')
      res.end('{"created":true}')
    }),
    '/write-head': (req, res) => {
      calls[req.url] = (calls[req.url] || 0) + 1
      res.writeHead(200, { 'x-cache-timeout': '1 minute', 'content-type': 'text/plain' })
      res.end('headers passed to writeHead')
    },
    '/write-head-reason': (req, res) => {
      calls[req.url] = (calls[req.url] || 0) + 1
      res.writeHead(200, 'OK', { 'X-Cache-Timeout': '1 minute' })
      res.end('headers passed to writeHead, after the reason phrase')
    },
    '/write-head-flat': (req, res) => {
      calls[req.url] = (calls[req.url] || 0) + 1
      res.writeHead(200, ['X-Cache-Timeout', '1 minute', 'Content-Type', 'text/plain'])
      res.end('headers passed to writeHead as a flat array')
    },
    '/write-head-pairs': (req, res) => {
      calls[req.url] = (calls[req.url] || 0) + 1
      res.writeHead(200, [['X-Cache-Timeout', '1 minute'], ['Content-Type', 'text/plain']])
      res.end('headers passed to writeHead as pairs')
    },
    '/not-cacheable': (req, res) => {
      calls[req.url] = (calls[req.url] || 0) + 1
      res.write('no caching headers')
      res.end(`, call ${calls[req.url]}`)
    }
  }

  beforeAll(async () => {
    app = await serve(require('./../index')({ stores: [cache] }), routes)
  })

  afterAll(() => app.close())

  // requests the path twice: a miss that runs the handler, then a hit replaying the stored response
  const expectReplay = async (path, expected, status = 200) => {
    const miss = await app.request(path)
    expect(miss.status).toBe(status)
    expect(miss.headers.get('x-cache-hit')).toBeNull()
    expect(miss.body.toString('hex')).toBe(Buffer.from(expected).toString('hex'))

    const hit = await app.request(path)
    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(hit.status).toBe(miss.status)
    expect(hit.body.toString('hex')).toBe(miss.body.toString('hex'))
    expect(calls[path]).toBe(1)

    return { miss, hit }
  }

  it('replays string bodies', async () => {
    await expectReplay('/string', 'héllo wörld ✓')
  })

  it('replays binary bodies byte for byte', async () => {
    await expectReplay('/buffer', [0xff, 0xfe, 0x00, 0x80, 0x41])
  })

  it('replays bodies written as multiple string chunks', async () => {
    await expectReplay('/string-string', 'é-b-c')
  })

  it('replays bodies written as multiple Buffer chunks', async () => {
    await expectReplay('/buffer-buffer', [0xff, 0xfe])
  })

  it('replays bodies written as a string, then a Buffer', async () => {
    await expectReplay('/string-buffer', Buffer.concat([Buffer.from('ü'), Buffer.from([0xff, 0xfe])]))
  })

  it('replays bodies written as a Buffer, then strings', async () => {
    await expectReplay('/buffer-string', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ü!')]))
  })

  it('decodes string chunks using their encoding', async () => {
    await expectReplay('/hex', 'hello')
    await expectReplay('/encodings', Buffer.concat([Buffer.from([0xff, 0x00, 0xff, 0xfe]), Buffer.from('é')]))
  })

  it('replays Uint8Array chunks', async () => {
    await expectReplay('/uint8array', [0xff, 0xfe, 0x00, 0x80])
    await expectReplay('/uint8array-end', [0xff, 0xfe])
  })

  it('keeps a copy of written chunks, as callers may reuse their buffers', async () => {
    // NOTE: Bun copies written chunks, so the original response carries "abcd". Node queues the
    // chunk by reference and would send "zzzz" instead, while the cache would still replay "abcd".
    await expectReplay('/reused-buffer', 'abcd')
  })

  it('replays empty bodies', async () => {
    await expectReplay('/empty', '')
    await expectReplay('/empty-chunks', '')
    expect(storedKeys()).toContain('GET/empty')
    expect(storedKeys()).toContain('GET/empty-chunks')
  })

  it('supports res.end(callback)', async () => {
    await expectReplay('/end-callback', '')
    expect(endCallbackCalls).toBe(1)
  })

  it('captures the response only once when res.end() is called twice', async () => {
    await expectReplay('/double-end', 'first')
    expect(storedKeys().filter(key => key === 'GET/double-end')).toHaveLength(1)
  })

  it('replays the status code and headers', async () => {
    const { hit } = await expectReplay('/status', '{"created":true}', 201)
    expect(hit.status).toBe(201)
    expect(hit.headers.get('content-type')).toBe('application/json')
  })

  // Under Node, headers passed to res.writeHead() without any prior res.setHeader() call
  // are not visible through res.getHeaders(), so they are captured from the writeHead() call.
  it('caches responses whose headers were passed to res.writeHead()', async () => {
    const { hit } = await expectReplay('/write-head', 'headers passed to writeHead')
    expect(hit.headers.get('content-type')).toBe('text/plain')
  })

  it('caches responses for every res.writeHead() signature', async () => {
    await expectReplay('/write-head-reason', 'headers passed to writeHead, after the reason phrase')
    await expectReplay('/write-head-flat', 'headers passed to writeHead as a flat array')
    await expectReplay('/write-head-pairs', 'headers passed to writeHead as pairs')
  })

  it('does not cache responses without x-cache-timeout or cache-control headers', async () => {
    const first = await app.request('/not-cacheable')
    expect(first.text).toBe('no caching headers, call 1')
    const second = await app.request('/not-cacheable')
    expect(second.text).toBe('no caching headers, call 2')
    expect(second.headers.get('x-cache-hit')).toBeNull()
    expect(storedKeys()).not.toContain('GET/not-cacheable')
  })
})
