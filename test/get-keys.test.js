'use strict'

const { describe, it, expect } = require('bun:test')
const { getKeys } = require('./../utils')

describe('get-keys', () => {
  const pattern = '*/numbers'
  const redisCache = {
    store: { name: 'redis' },
    keys: (pattern, callback) => {
      if (!pattern) throw new Error('pattern is missing')
      return callback(null, ['GET/numbers'])
    }
  }

  const memoryCache = {
    store: { name: 'memory' },
    keys: (callback) => {
      return callback(null, ['GET/numbers'])
    }
  }

  it('should retrieve redis keys', async () => {
    const keys = await getKeys(redisCache, pattern)
    expect(keys).toContain('GET/numbers')
  })

  it('should skip pattern', async () => {
    const keys = await getKeys(redisCache, 'GET/numbers')
    expect(keys).toContain('GET/numbers')
  })

  it('should retrieve memory keys', async () => {
    const keys = await getKeys(memoryCache, pattern)
    expect(keys).toContain('GET/numbers')
  })
})
