# The HTTP/1.1 parser

Responses use the SIMD build of [milo](https://github.com/ShogunPanda/milo).
`lib/milo` is an unmodified copy of `@perseveranza-pets/milo-cjs` 0.8.0.
To refresh it, update the pinned version in `build/milo.js` and run:

```sh
npm run build:milo
```

`MILO_PACKAGE_DIR=<dir> npm run build:milo` copies an unpacked package instead.

The adapter follows nodejs/undici's milo integration: one parser per connection,
field-section suspension, buffered events, and direct Content-Length bodies.
It retains this fork's HeaderMap conversion, timeout handling, idle-socket
validation, and paused-body EOF handling. It does not cache header names or pool
parsers; milo frees its event buffer when the parser is destroyed.

## milo 0.8.0 limitations

- Its SIMD scanners can miss control bytes in long header values, trailer
  values, and reason phrases. The adapter checks these with the existing
  `isValidHeaderValue` validator; `test/milo.js` covers the scanner gaps.
- Some leading OWS is left in field values; the adapter strips it. A
  Content-Length value preceded by multiple spaces or a space then a tab is
  rejected inside milo before the adapter receives it.
- Its JS `dealloc()` wrapper drops the allocation length. The shared input
  area grows by doubling, bounding abandoned allocations by its current size.
- Its upgrade flag ignores the response status. Only a 101 switches protocols.
- A parse error replaces the events of that call. Headers and Content-Length
  bodies complete separately; malformed bytes immediately after a chunked
  response in the same read can still fail that response.

## Differences from llhttp

This is a breaking parser replacement and requires a major release:

- HTTP/1.0 responses, including HTTP/1.0 CONNECT proxy responses, are rejected.
- obs-fold, bare LF, and bare CR are rejected.
- Content-Length is rejected on 1xx/204/205; Transfer-Encoding on 1xx/204/205/304.
- Upgrade without Connection: upgrade, and Trailer without chunked encoding,
  are rejected.
- Header and trailer values lose trailing OWS as well as leading OWS.
- HTTPParserError codes and descriptions use milo's error names.

The adapter continues to reject status codes below 100, skip empty lines before
a status line, preserve HEAD keep-alive and 304 Content-Length handling, and use
`Invalid EOF state` for a truncated chunked response.
