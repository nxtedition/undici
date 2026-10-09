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
