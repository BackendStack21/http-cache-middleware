'use strict'

const WILDCARD = '*'

/**
 * Case-sensitive wildcard matching, where "*" matches any sequence of characters.
 * Runs in linear time and keeps no state (no RegExp compilation or caching),
 * so it is safe to use with patterns and keys derived from request data.
 *
 * @param {string[]} parts The pattern, split by "*"
 * @param {string} key
 * @returns {boolean}
 */
const matchParts = (parts, key) => {
  const last = parts.length - 1
  const head = parts[0]
  const tail = parts[last]

  if (key.length < head.length + tail.length || !key.startsWith(head) || !key.endsWith(tail)) {
    return false
  }

  const end = key.length - tail.length
  let position = head.length
  for (let i = 1; i < last; i++) {
    const index = key.indexOf(parts[i], position)
    if (index === -1 || index + parts[i].length > end) return false

    position = index + parts[i].length
  }

  return true
}

const matches = (pattern, key) => pattern.includes(WILDCARD)
  ? matchParts(pattern.split(WILDCARD), key)
  : pattern === key

// "*" is the only wildcard we support, other Redis glob characters are matched literally
const escapeRedisPattern = (pattern) => pattern.replace(/[\\?[\]]/g, '\\$&')

const isRedis = (cache) => Boolean(cache.store) && cache.store.name === 'redis'

// stores either accept a callback or return a promise
const settle = (invoke) => new Promise((resolve, reject) => {
  const result = invoke((err, value) => err ? reject(err) : resolve(value))
  if (result && typeof result.then === 'function') result.then(resolve, reject)
})

// lists the keys of a store, Redis stores require (and pre-filter by) a glob pattern
const listKeys = async (cache, redisPattern) => {
  if (typeof cache.keys !== 'function') {
    throw new Error('Cache store does not support listing keys, wildcard patterns can not be expired!')
  }

  const keys = await settle(callback => isRedis(cache)
    ? cache.keys(escapeRedisPattern(redisPattern), callback)
    : cache.keys(callback)
  )

  return keys || []
}

const getKeys = async (cache, pattern) => {
  if (!pattern.includes(WILDCARD)) return [pattern]

  const parts = pattern.split(WILDCARD)

  return (await listKeys(cache, pattern)).filter(key => matchParts(parts, key))
}

// retrieves the keys of a store matching any of the patterns
const getKeysMatching = async (cache, patterns) => {
  const keys = new Set(patterns.filter(pattern => !pattern.includes(WILDCARD)))
  const wildcards = patterns.filter(pattern => pattern.includes(WILDCARD))

  if (wildcards.length > 0) {
    if (isRedis(cache)) {
      // Redis filters the keys server side, one pattern at a time
      for (const matching of await Promise.all(wildcards.map(pattern => getKeys(cache, pattern)))) {
        matching.forEach(key => keys.add(key))
      }
    } else {
      // other stores list all their keys, so they are listed just once
      const parts = wildcards.map(pattern => pattern.split(WILDCARD))
      for (const key of await listKeys(cache)) {
        if (parts.some(pattern => matchParts(pattern, key))) keys.add(key)
      }
    }
  }

  return [...keys]
}

const del = (store, keys) => settle(callback => store.del(keys, callback))

const get = (cache, key) => cache.getAndPassUp(key)

const toPatterns = (patterns) => (typeof patterns === 'string' ? patterns.split(',') : patterns)
  .map(pattern => pattern.trim())
  .filter(pattern => pattern.length > 0)

/**
 * Deletes the cache entries matching the given patterns on all the cache stores.
 *
 * @param {Array} stores cache-manager stores
 * @param {string|string[]} patterns Array of patterns, or a comma separated list of them
 * @returns {Promise<void>} Settles once all the matching keys were deleted
 */
const deleteKeys = async (stores, patterns) => {
  patterns = toPatterns(patterns)

  await Promise.all(stores.map(async (store) => {
    const keys = await getKeysMatching(store, patterns)
    if (keys.length > 0) await del(store, keys)
  }))
}

module.exports = {
  get,
  deleteKeys,
  getKeys,
  matches
}
