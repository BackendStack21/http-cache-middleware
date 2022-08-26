'use strict'

const matcher = require('matcher')

const DATA_POSTFIX = '-d'

const getKeys = (cache, pattern) => new Promise((resolve) => {
  if (pattern.indexOf('*') > -1) {
    const args = [pattern, (_, res) => resolve(matcher(res, [pattern]))]
    if (cache.store.name !== 'redis') {
      args.shift()
    }

    cache.keys.apply(cache, args)
  } else resolve([pattern])
})

const get = (cache, key) => cache.getAndPassUp(key)

const deleteKeys = (stores, patterns) => {
  patterns = patterns.map(pattern => pattern.endsWith('*')
    ? pattern
    : [pattern, pattern + DATA_POSTFIX]
  ).reduce((acc, item) => {
    if (Array.isArray(item)) {
      acc.push(...item)
    } else {
      acc.push(item)
    }

    return acc
  }, [])

  patterns.forEach(pattern => stores.forEach(store => getKeys(store, pattern).then(keys => keys.length > 0 ? store.del(keys) : null)))
}

module.exports = {
  get,
  deleteKeys,
  getKeys,
  DATA_POSTFIX
}
