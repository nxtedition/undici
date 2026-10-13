# @nxtedition/undici

Internal HTTP/1.1 client for Node.js 26.

## 204 and 304 responses

These responses never have a body, so the response ends at the blank line
after the header section, whatever header fields it carries (RFC 9112 §6.3).
This client deliberately differs from upstream undici
([nodejs/undici#5864](https://github.com/nodejs/undici/pull/5864)) in how it
treats their `Content-Length`:

| response | this client | upstream undici |
|---|---|---|
| 304 with a non-zero `Content-Length` | succeeds and keeps the connection; the length describes the selected representation (RFC 9110 §8.6) | succeeds and closes the connection |
| bytes after a 304 with a non-zero `Content-Length` | parsed as the next pipelined response | discarded with the connection; pipelined requests are resent |
| 204 with a non-zero `Content-Length` | fails with `ResponseContentLengthMismatchError` (RFC 9110 §8.6 forbids it) | succeeds and closes the connection |

A 204 or 304 to a non-HEAD request that also carries `Transfer-Encoding`
closes the connection, so bytes after it can't be taken for a pipelined
response.

## Async context

Async context propagation is not supported. This package deliberately does not
use `node:async_hooks`, create `AsyncResource` instances, or preserve
`AsyncLocalStorage` stores across internal queueing, dispatch, and callback
boundaries.

Do not rely on transport callbacks running in the context that submitted a
request. Applications that need request-scoped state must carry it explicitly
outside the transport.
