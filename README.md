# @nxtedition/undici

Internal HTTP/1.1 client for Node.js 26.

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
- Otherwise the request is sent with an empty body (`content-length: 0`). That
  includes a stream destroyed without an error before it ended
  (`body.readableEnded === false`), such as one whose reader was cancelled
  midway: the incomplete upload is not detected.

A stream destroyed without an error while it is being sent fails the request
with `RequestAbortedError`.

If an incomplete upload must not succeed, destroy the stream with an error, or
check `body.readableEnded` before sending it.
