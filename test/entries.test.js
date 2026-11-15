'use strict'

const { describe, it, expect, beforeAll, afterAll } = require('bun:test')
const { memoryCache, serve } = require('./helpers')

describe('cache entries', () => {
  const cache = memoryCache()
  const errors = []
  const calls = {}
  let app

  const respond = (body) => (req, res) => {
    calls[req.url] = (calls[req.url] || 0) + 1
    res.setHeader('x-cache-timeout', '1 minute')
    res.setHeader('content-type', 'text/plain')
    res.end(typeof body === 'string' ? `${body} ${calls[req.url]}` : body)
  }

  const routes = {}
  for (const name of ['text', 'legacy', 'garbage', 'not-a-string', 'null', 'no-headers', 'no-expires', 'other-version', 'expired', 'planted']) {
    routes[`/${name}`] = respond(name)
  }
  routes['/binary'] = respond(Buffer.from([0xff, 0xfe, 0x00]))

  beforeAll(async () => {
    app = await serve(require('./../index')({ stores: [cache], onError: (err) => errors.push(err) }), routes)
  })

  afterAll(() => app.close())

  // the store holds an unusable value: the request is served as a miss, then the entry is replaced
  const expectMissThenHit = async (path) => {
    const miss = await app.request(path)
    expect(miss.status).toBe(200)
    expect(miss.headers.get('x-cache-hit')).toBeNull()
    expect(miss.text).toBe(`${path.slice(1)} 1`)

    const hit = await app.request(path)
    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(hit.text).toBe(`${path.slice(1)} 1`)
  }

  it('stores one JSON value per key, using the v2 format', async () => {
    const before = Date.now()
    await app.request('/text')
    await app.request('/binary')

    // no companion keys, i.e. the "-d" payload keys of v1
    const keys = (await cache.keys()).filter(key => key.startsWith('GET/text') || key.startsWith('GET/binary'))
    expect(keys.sort()).toEqual(['GET/binary', 'GET/text'])

    const text = JSON.parse(await cache.get('GET/text'))
    expect(text).toEqual({
      v: 2,
      status: 200,
      headers: {
        'x-cache-timeout': '1 minute',
        'content-type': 'text/plain',
        'cache-control': 'private, no-cache, max-age=60',
        etag: expect.stringMatching(/^"[0-9a-f]{16}"$/)
      },
      expires: expect.any(Number),
      data: 'text 1'
    })
    expect(text.expires).toBeGreaterThanOrEqual(before + 60000)
    expect(text.expires).toBeLessThanOrEqual(Date.now() + 60000)

    // binary payloads are base64 encoded
    const binary = JSON.parse(await cache.get('GET/binary'))
    expect(binary.data).toBe('//4A')
    expect(binary.base64).toBe(true)
    expect(text.base64).toBeUndefined()
  })

  it('replays entries written by other instances sharing the store', async () => {
    await cache.set('GET/planted', JSON.stringify({
      v: 2,
      status: 203,
      headers: { 'content-type': 'application/octet-stream', etag: '"planted"' },
      expires: Date.now() + 60000,
      data: Buffer.from([0x00, 0xff, 0x10]).toString('base64'),
      base64: true
    }))

    const hit = await app.request('/planted')
    expect(hit.status).toBe(203)
    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(hit.headers.get('etag')).toBe('"planted"')
    expect(hit.body.toString('hex')).toBe('00ff10')
    expect(calls['/planted']).toBeUndefined()
  })

  it('ignores entries in the legacy (v1) format', async () => {
    // v1 stored the metadata and the payload under two keys
    await cache.set('GET/legacy', JSON.stringify({ status: 200, headers: { etag: 'legacy-etag', 'x-cache-timeout': '1 minute' } }))
    await cache.set('GET/legacy-d', JSON.stringify({ data: 'stale payload' }))

    // a legacy ETag must not produce a 304 either
    const conditional = await app.request('/legacy', { headers: { 'if-none-match': 'legacy-etag' } })
    expect(conditional.status).toBe(200)
    expect(conditional.text).toBe('legacy 1')

    const hit = await app.request('/legacy')
    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(hit.text).toBe('legacy 1')
    expect(JSON.parse(await cache.get('GET/legacy')).v).toBe(2)
    expect(errors).toEqual([])
  })

  it('ignores invalid JSON values, reporting them through onError', async () => {
    await cache.set('GET/garbage', 'not { json')
    await expectMissThenHit('/garbage')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(SyntaxError)
    errors.length = 0
  })

  it('ignores values in other formats', async () => {
    await cache.set('GET/not-a-string', { v: 2, status: 200, headers: {}, expires: Date.now() + 60000, data: 'object' })
    await expectMissThenHit('/not-a-string')

    await cache.set('GET/null', 'null')
    await expectMissThenHit('/null')

    await cache.set('GET/no-headers', JSON.stringify({ v: 2, status: 200, headers: null, expires: Date.now() + 60000, data: 'x' }))
    await expectMissThenHit('/no-headers')

    await cache.set('GET/no-expires', JSON.stringify({ v: 2, status: 200, headers: {}, data: 'x' }))
    await expectMissThenHit('/no-expires')

    // i.e. written by a newer release during a rolling deployment
    await cache.set('GET/other-version', JSON.stringify({ v: 3, status: 200, headers: {}, expires: Date.now() + 60000, data: 'x' }))
    await expectMissThenHit('/other-version')

    expect(errors).toEqual([])
  })

  it('ignores expired entries, even when the store still holds them', async () => {
    await expectMissThenHit('/expired')

    // i.e. an entry passed up from a lower cache tier, using the default TTL of the upper tier
    const entry = JSON.parse(await cache.get('GET/expired'))
    entry.expires = Date.now() - 1
    await cache.set('GET/expired', JSON.stringify(entry))

    const res = await app.request('/expired')
    expect(res.headers.get('x-cache-hit')).toBeNull()
    expect(res.text).toBe('expired 2')

    // the fresh response replaced the expired entry
    const hit = await app.request('/expired')
    expect(hit.headers.get('x-cache-hit')).toBe('1')
    expect(hit.text).toBe('expired 2')
  })
})
