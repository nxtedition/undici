# @nxtedition/undici

Internal HTTP/1.1 client for Node.js 26.

## 204 and 304 responses

These responses never have a body, so the response ends at the blank line
after the header section, whatever header fields it carries (RFC 9112 §6.3).
This client deliberately differs from upstream undici
([nodejs/undici#5864](https://github.com/nodejs/undici/pull/5864)) in how it
treats their `Content-Length`. The table describes responses to non-HEAD
requests without `Transfer-Encoding`, when connection reuse is otherwise
allowed:

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

## Closed stream bodies

A stream passed as a request `body` may already be closed when the request is
created. It has nothing left to read, so:

- If it closed because it errored (`body.errored` is set), the request fails
  with that error and nothing is sent.
- Otherwise the request is sent with an empty body. Methods that normally
  carry a payload, such as POST and PUT, send `content-length: 0`; other
  methods may omit that header. This includes a stream destroyed without an
  error before it ended
  (`body.readableEnded === false`), such as one whose reader was cancelled
  midway: the incomplete upload is not detected.

A stream destroyed without an error while it is being sent fails the request
with `RequestAbortedError`.

If an incomplete upload must not succeed, destroy the stream with an error, or
check `body.readableEnded` before sending it.
