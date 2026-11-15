# Changelog

## 2.0.0

This release contains breaking changes, marked with **Breaking** below.

### Upgrade notes
- The cache starts cold: entries written by previous versions are ignored.
- Don't let previous versions and this one share a cache store (i.e: Redis during a rolling upgrade). Previous versions keep response bodies under a separate `<key>-d` key, which this version neither reads nor expires: an old instance could then serve a stale body together with the headers of a newer entry. Point the new version to a different Redis database, or stop the old instances first.
- If you use `cacheAppendKey`, or expire keys of an Express mounted router, review your `x-cache-expire` patterns (see **Changed**).

### Security
- The `set-cookie` header and hop-by-hop headers (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `proxy-connection`, `te`, `trailer`, `transfer-encoding`, `upgrade`) are no longer stored, so they are never replayed to other clients.
- Keys extended with `cacheAppendKey` can no longer collide: the appended value is now separated by a single space. Previously user `12` on `/me` and user `2` on `/me1` shared the key `GET/me12`. URLs containing a space bypass the cache.
- Cache store failures no longer crash the process (unhandled promise rejections) nor fail the request: a failed read is handled as a cache miss, and the failures reported by the stores are passed to the new `onError` option.

### Added
- `onError(err)` option, called when a cache store operation fails. Default: no-op.
- `deleteKeys(stores, patterns)` also accepts a comma separated string of patterns, and returns a promise.

### Changed
- **Breaking:** requires Node.js >= 22.
- **Breaking:** the value returned by `cacheAppendKey` is appended after a single space: `GET/me 12` instead of `GET/me12`. `undefined`, `null` and `''` append nothing. Patterns such as `*/numbers` don't match `GET/numbers 12`, use `*/numbers *` or `*/numbers*`.
- Default cache keys include the mount path of mounted routers (Express routers, restana nested routers) when the middleware is registered inside them (was the stripped `req.url`), so the same relative URL on different mount paths no longer shares a cache entry. URLs rewritten by upstream middlewares are still honoured.
- **Breaking:** `x-cache-expire` and `deleteKeys` patterns: `*` is the only wildcard, matching is case-sensitive and `!` is a literal character. Previously the `matcher` package matched case-insensitively and supported `!` negation. Whitespace around comma separated patterns is ignored.
- **Breaking:** the `s-maxage` directive takes precedence over `max-age`. `x-cache-timeout` is used when the resulting value is missing or `0`.
- **Breaking:** `Cache-Control: no-store` responses are no longer cached, unless the `x-cache-timeout` header is set.
- Unparseable, zero and negative `x-cache-timeout` values are no longer cached (zero and negative values were cached for 1 second). TTLs are rounded up to whole seconds (minimum 1 second).
- Each response is stored as a single cache entry (previously two: `<key>` and `<key>-d`), binary bodies are stored base64 encoded. The default memory store (`max: 1000`) now holds up to 1000 responses instead of 500.
- Generated ETags are quoted strings (i.e: `"8c3bd1a9f6e2a07d"`) generated with `crypto.randomBytes`.
- `If-None-Match` supports lists of ETags, weak validators (`W/`) and `*`. `304` responses include the `ETag`, `Cache-Control`, `Content-Location`, `Expires` and `Vary` headers of the cached response.
- Response bodies are only buffered when the response is going to be cached (previously every response was buffered, with a copy per written chunk).
- `x-cache-expire` patterns given without wildcard no longer also delete `<pattern>-d` keys.
- Dependencies: `@tusbar/cache-control` 3.x, `middleware-if-unless` ^1.6.1. `cache-manager` intentionally stays on 4.x: 5+ changes the stores contract, and `cache-manager-ioredis` only works with 4.x.

### Fixed
- `deleteKeys(stores, '*/pattern1,*/pattern2')`, as documented, threw `TypeError: patterns.map is not a function`.
- `206 Partial Content` responses are no longer cached.
- Responses announcing a `content-length` that differs from the bytes actually sent are no longer cached.
- Headers passed to `res.writeHead(status, headers)` were ignored, so those responses were neither cached nor able to expire keys.
- A compression middleware registered before the cache, combined with explicit `res.writeHead()` / `res.flushHeaders()` calls, stored uncompressed bodies labelled as compressed.
- HTTP/2 pseudo-headers (i.e: `:status`) are no longer stored, replaying them failed every cache hit.
- Cached non-2xx responses, and requests using methods other than `GET` and `HEAD`, no longer answer `If-None-Match` requests with `304`. `304` responses served from cache carry the `x-cache-hit` header and set `req.cacheHit`.
- An error response following a failed `res.writeHead()` / `res.end()` call is no longer cached using the headers of the failed attempt.
- Bodies provided by handlers on `HEAD` requests are no longer buffered nor stored.
- Expiring several wildcard patterns lists the keys of non-Redis stores once, instead of once per pattern. Stores whose `keys()` / `del()` return promises are supported.
- Bodies written using non-utf8 encodings, mixed string/Buffer chunks or `Uint8Array` chunks were replayed corrupted.
- `deleteKeys` waits for the stores to delete the keys, and reports their failures.
- Fractional TTLs (i.e: `x-cache-timeout: 1500ms` resolved to `1.5`) were passed as is to the stores, Redis `SETEX` only accepts integers.
- `HEAD` requests using a custom `req.cacheKey` are still served from cache, but no longer stored, so a `HEAD` response (which may carry no body) can't be served to `GET` requests sharing the key.
- On Redis, the `?`, `[`, `]` and `\` characters of wildcard patterns are escaped before running `KEYS`, so they match literally, as with the other stores.

### Removed
- `matcher` and `on-http-end` dependencies, replaced by internal implementations.
- `DATA_POSTFIX` export from `http-cache-middleware/utils`.
- Development tooling moved to Bun (`bun run test`, `bun run lint`): `mocha`, `nyc`, `chai`, `got` and the Travis CI configuration were removed.

### Development
- Framework integration tests for restana and Express (`express` 5 added as dev dependency): the same scenarios run using Bun (`bun run test`) and Node.js (`bun run test:node`).
