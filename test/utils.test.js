'use strict'

const { describe, it, expect } = require('bun:test')
const { matches, getKeys, deleteKeys } = require('./../utils')
const { memoryCache } = require('./helpers')

describe('utils.matches', () => {
  const cases = [
    // [pattern, key, expected]
    ['GET/numbers', 'GET/numbers', true],
    ['GET/numbers', 'GET/numbers2', false],
    ['GET/numbers', 'get/numbers', false], // case-sensitive
    ['*', '', true],
    ['*', 'anything at all', true],
    ['**', 'x', true],
    ['*/numbers', 'GET/numbers', true],
    ['*/numbers', 'GET/numbers?page=1', false], // leading wildcard only, the tail is anchored
    ['GET/*', 'GET/numbers', true],
    ['GET/*', 'POST/numbers', false],
    ['GET/*', 'GET/', true], // "*" also matches the empty sequence
    ['*/users/*/posts', 'GET/users/12/posts', true],
    ['*/users/*/posts', 'GET/users/12/comments', false],
    ['a**b', 'ab', true], // adjacent wildcards
    ['a*b*c', 'abc', true],
    ['*b*c*', 'cb', false], // order of the parts matters
    ['*b*c*', 'cbc', true],
    ['a*b*c', 'aXbYbZc', true],
    ['a*a*a', 'aa', false], // the three "a" can't overlap
    ['a*a*a', 'aaa', true],
    ['ab*ba', 'aba', false], // head and tail can't overlap
    ['ab*ba', 'abba', true],
    ['*ab*', 'xaby', true],
    ['*ab*', 'xa', false],
    // anything but "*" is a literal, there is no regex or glob semantic
    ['GET/a.c', 'GET/abc', false],
    ['GET/a.c', 'GET/a.c', true],
    ['GET/(a|b)', 'GET/a', false],
    ['GET/(a|b)', 'GET/(a|b)', true],
    ['GET/a?c', 'GET/abc', false],
    ['GET/[ab]*', 'GET/a1', false],
    ['GET/[ab]*', 'GET/[ab]1', true],
    ['!*/numbers', 'GET/numbers', false], // "!" is not a negation
    ['!*/numbers', '!GET/numbers', true],
    ['*\\*', 'GET/*', false], // "\" does not escape the wildcard
    ['*\\*', 'GET/a\\b', true]
  ]

  for (const [pattern, key, expected] of cases) {
    it(`${JSON.stringify(pattern)} ${expected ? 'matches' : 'does not match'} ${JSON.stringify(key)}`, () => {
      expect(matches(pattern, key)).toBe(expected)
    })
  }

  it('handles adversarial inputs without backtracking', () => {
    // the equivalent regex (^x.*a.*a ... .*a.*y$) backtracks catastrophically on this input:
    // head and tail match, and only the last of the 20000 "a" parts is missing
    const pattern = 'x' + '*a'.repeat(20000) + '*y'
    const key = 'x' + 'a'.repeat(19999) + 'y'
    const start = performance.now()
    expect(matches(pattern, key)).toBe(false)
    expect(matches(pattern, key.replace('y', 'ay'))).toBe(true)
    expect(performance.now() - start).toBeLessThan(500)
  })
})

describe('utils.getKeys', () => {
  const keyList = ['GET/numbers', 'GET/numbers 12', 'POST/numbers', 'GET/letters']
  const memoryLike = (keys = keyList) => {
    const calls = []
    return {
      calls,
      store: { name: 'memory' },
      keys: (...args) => {
        calls.push(args)
        args[args.length - 1](null, keys)
      }
    }
  }

  it('resolves a pattern without wildcard as the key itself, without listing keys', async () => {
    const cache = memoryLike()
    expect(await getKeys(cache, 'GET/a?b')).toEqual(['GET/a?b'])
    expect(cache.calls).toHaveLength(0)
  })

  it('lists all keys from non-redis stores and filters them locally', async () => {
    const cache = memoryLike()
    expect(await getKeys(cache, '*/numbers*')).toEqual(['GET/numbers', 'GET/numbers 12', 'POST/numbers'])
    // the callback is the only argument for non-redis stores
    expect(cache.calls).toHaveLength(1)
    expect(cache.calls[0]).toHaveLength(1)
    expect(typeof cache.calls[0][0]).toBe('function')
  })

  it('works with the cache-manager memory store', async () => {
    const cache = memoryCache()
    await cache.set('GET/numbers', 'a')
    await cache.set('GET/letters', 'b')
    expect(await getKeys(cache, 'GET/num*')).toEqual(['GET/numbers'])
  })

  it('works with caches without store metadata', async () => {
    const cache = { keys: (cb) => cb(null, ['GET/x', 'GET/y']) }
    expect(await getKeys(cache, '*/y')).toEqual(['GET/y'])
  })

  it('tolerates stores calling back with no key list', async () => {
    expect(await getKeys(memoryLike(null), '*')).toEqual([])
    expect(await getKeys({ keys: (cb) => cb() }, '*')).toEqual([])
  })

  it('rejects when the store can not list keys', async () => {
    await expect(getKeys({ store: { name: 'memory' } }, '*/numbers'))
      .rejects.toThrow('Cache store does not support listing keys, wildcard patterns can not be expired!')
  })

  it('rejects when listing keys fails', async () => {
    const failure = new Error('keys failed')
    const cache = { store: { name: 'memory' }, keys: (cb) => cb(failure) }
    await expect(getKeys(cache, '*/numbers')).rejects.toBe(failure)
  })

  it('escapes redis glob characters other than "*", and still filters locally with the original pattern', async () => {
    const received = []
    const cache = {
      store: { name: 'redis' },
      keys: (pattern, cb) => {
        received.push(pattern)
        // a store may return more than what was asked for: results are filtered locally
        cb(null, ['GET/a?b=[1]\\x', 'GET/aXb=11\\x', 'GET/a?b=[1]x', 'POST/a?b=[1]\\x', 'GET/a?b=[1]\\x/y'])
      }
    }

    expect(await getKeys(cache, 'GET/a?b=[1]\\*')).toEqual(['GET/a?b=[1]\\x', 'GET/a?b=[1]\\x/y'])
    expect(received).toEqual(['GET/a\\?b=\\[1\\]\\\\*'])
  })

  it('rejects when listing redis keys fails', async () => {
    const failure = new Error('redis keys failed')
    const cache = { store: { name: 'redis' }, keys: (pattern, cb) => cb(failure) }
    await expect(getKeys(cache, '*')).rejects.toBe(failure)
  })
})

describe('utils.deleteKeys', () => {
  const populate = async (cache, keys) => {
    for (const key of keys) await cache.set(key, 'value')
  }
  const remaining = async (cache) => (await cache.keys()).sort()

  it('accepts an array of patterns', async () => {
    const cache = memoryCache()
    await populate(cache, ['GET/a', 'GET/b', 'GET/c', 'POST/a'])

    await deleteKeys([cache], ['GET/a', '*/b'])
    expect(await remaining(cache)).toEqual(['GET/c', 'POST/a'])
  })

  it('accepts a comma separated list of patterns, trimming them and dropping empty ones', async () => {
    const cache = memoryCache()
    await populate(cache, ['GET/a', 'GET/b', 'GET/c', 'GET/d'])
    const deleted = []
    const del = cache.del
    cache.del = (keys) => {
      deleted.push(...keys)
      return del(keys)
    }

    await deleteKeys([cache], ' GET/a , ,*/b,,  GET/c*  ,')
    expect(await remaining(cache)).toEqual(['GET/d'])
    // the empty patterns were dropped (an empty pattern would delete the "" key)
    expect(deleted.sort()).toEqual(['GET/a', 'GET/b', 'GET/c'])
  })

  it('does nothing for an empty list of patterns', async () => {
    const cache = memoryCache()
    await populate(cache, ['GET/a'])
    await deleteKeys([cache], ' , ')
    await deleteKeys([cache], [])
    expect(await remaining(cache)).toEqual(['GET/a'])
  })

  it('does not call del when a wildcard pattern matches nothing', async () => {
    let delCalls = 0
    const cache = { keys: (cb) => cb(null, ['GET/a']), del: () => { delCalls++ } }
    await deleteKeys([cache], '*/nothing')
    expect(delCalls).toBe(0)
  })

  it('deletes matching keys on all the stores', async () => {
    const tier1 = memoryCache()
    const tier2 = memoryCache()
    await populate(tier1, ['GET/a', 'GET/b'])
    await populate(tier2, ['GET/a', 'GET/c'])

    await deleteKeys([tier1, tier2], '*/a')
    expect(await remaining(tier1)).toEqual(['GET/b'])
    expect(await remaining(tier2)).toEqual(['GET/c'])
  })

  it('settles only once the store deletions completed', async () => {
    const keys = new Set(['GET/a', 'GET/b'])
    // a store whose deletions complete asynchronously, returning a promise like cache-manager stores do
    const cache = {
      keys: (cb) => setTimeout(() => cb(null, [...keys]), 5),
      del: (list) => new Promise(resolve => setTimeout(() => {
        list.forEach(key => keys.delete(key))
        resolve()
      }, 10))
    }

    const result = deleteKeys([cache], '*/a')
    expect(result).toBeInstanceOf(Promise)
    expect(await result).toBeUndefined()
    expect([...keys]).toEqual(['GET/b'])
  })

  it('rejects when a store fails deleting keys', async () => {
    const failure = new Error('del failed')
    const cache = { keys: (cb) => cb(null, ['GET/a']), del: () => Promise.reject(failure) }
    await expect(deleteKeys([cache], '*/a')).rejects.toBe(failure)
    await expect(deleteKeys([cache], 'GET/a')).rejects.toBe(failure)
  })

  it('rejects when a store fails listing keys', async () => {
    const failure = new Error('keys failed')
    const cache = { keys: (cb) => cb(failure), del: () => Promise.resolve() }
    await expect(deleteKeys([cache], 'GET/a,*/b')).rejects.toBe(failure)
  })
  // NOTE: callback-only stores (e.g. cache-manager-ioredis) are covered in stores.test.js

  describe('store contracts', () => {
    const { deleteKeys, getKeys } = require('./../utils')

    it('supports stores whose keys() and del() return promises, ignoring callbacks', async () => {
      const data = new Set(['GET/a', 'GET/b', 'POST/a'])
      const store = {
        keys: async () => [...data],
        del: async (keys) => keys.forEach(key => data.delete(key))
      }

      expect(await getKeys(store, '*/a')).toEqual(['GET/a', 'POST/a'])
      await deleteKeys([store], '*/a')
      expect([...data]).toEqual(['GET/b'])
    })

    it('lists the keys of a store once, no matter how many patterns are given', async () => {
      const data = new Set(['GET/a', 'GET/b', 'GET/c', 'GET/d'])
      let listed = 0
      let deleted
      const store = {
        keys: (cb) => {
          listed++
          cb(null, [...data])
        },
        del: (keys, cb) => {
          deleted = keys
          cb(null)
        }
      }

      await deleteKeys([store], '*/a, */b, GET/c, */a')
      expect(listed).toBe(1)
      expect(deleted.sort()).toEqual(['GET/a', 'GET/b', 'GET/c'])
    })

    it('queries redis stores once per wildcard pattern', async () => {
      const patterns = []
      let deleted
      const store = {
        store: { name: 'redis' },
        keys: (pattern, cb) => {
          patterns.push(pattern)
          cb(null, pattern === '*/a' ? ['GET/a'] : ['GET/b'])
        },
        del: (keys, cb) => {
          deleted = keys
          cb(null)
        }
      }

      await deleteKeys([store], ['*/a', '*/b'])
      expect(patterns.sort()).toEqual(['*/a', '*/b'])
      expect(deleted.sort()).toEqual(['GET/a', 'GET/b'])
    })
  })
})
