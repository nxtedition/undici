# The HTTP/1.1 parser

Responses are parsed by [milo](https://github.com/ShogunPanda/milo), a Rust
HTTP/1.1 parser compiled to WebAssembly. `lib/milo` is an unmodified copy of the
[`@perseveranza-pets/milo-cjs`](https://www.npmjs.com/package/@perseveranza-pets/milo-cjs)
0.8.0 package. To refresh it, bump the version in `build/milo.js` and run:

```sh
npm run build:milo
```

`MILO_PACKAGE_DIR=<dir> npm run build:milo` copies an unpacked package instead,
e.g. a local milo build.

The client loads `src/no-simd/index.js`, which embeds the scalar WASM build.

## Known issues in milo 0.8.0

- The SIMD build is not used. Its wasm32 field scanners pass the operands of
  `v128_andnot` in x86 order, so a 16-byte block of a header value, trailer
  value or reason phrase is only checked for control bytes when it also holds
  a CR, and a bare LF or a NUL inside a long header value is accepted.
  `test/milo.js` fails if the loaded build accepts them.
- For a field value that does not end in whitespace, milo drops only one
  leading SP. The client strips the rest of the leading whitespace itself, but
  a `Content-Length` sent after `":  "` or `": \t"` is rejected as
  `HPE_INVALID_CONTENT_LENGTH` before it gets there.
- The JS `dealloc()` drops the length the WASM export needs, so the client
  never frees its input area; it grows by doubling instead.
- The `should_upgrade` flag of a response ignores its status. The client
  switches protocols on a 101 only, as it did with llhttp.

## Differences from llhttp

milo is stricter than the llhttp build it replaces:

- HTTP/1.0 (and any version but HTTP/1.1) responses are rejected.
- obs-fold, bare LF and bare CR are rejected anywhere in the head.
- `Content-Length` is rejected on 1xx, 204 and 205 responses, and
  `Transfer-Encoding` on 1xx, 204, 205 and 304 responses.
- `Upgrade` without `Connection: upgrade`, and `Trailer` without chunked
  encoding, are rejected.
- Field values lose trailing whitespace as well as leading whitespace
  (RFC 9110 5.5); llhttp kept it.
- `HTTPParserError#code` is `HPE_` followed by a milo error name, such as
  `HPE_UNEXPECTED_CHARACTER` or `HPE_INVALID_STATUS`.

The client parses status codes below 100 as errors, and skips empty lines
ahead of a status line, as it did with llhttp.

milo reports what it parsed through a buffer of events once a call returns,
and a parse error replaces the events of the call that hits it. The client runs
the body decision in a call of its own, and consumes Content-Length bodies in
JavaScript, so a response without a body or with a Content-Length completes
before any byte after it is parsed. The last chunk of a chunked body is parsed
together with what follows it in the same read, so a malformed byte there fails
that response too.

Each parser has a 64 KiB event buffer in WASM memory, so a connection holds one
only while it parses a response and returns it to a shared pool in between.
