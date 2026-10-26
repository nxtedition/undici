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

## Scheduled socket I/O

Servers that don't honor request priority, such as S3, serve every request
alike. A request's `scheduler` option orders its socket I/O against other
requests instead. It takes an `@nxtedition/scheduler` `Scheduler`, or
anything with the same `acquire(fn, priority)` and `release()`. `priority` is
passed to `acquire()`.

```js
const scheduler = new Scheduler({ concurrency: 8 })

await client.request({ path, method: 'PUT', body, scheduler, priority: 'low' })
```

A request holds one of the scheduler's slots while it waits on the network:

- **Writes.** Once the socket pushes back, a stream or iterable body pauses
  until it is granted a slot, then holds it until the socket drains. Buffer
  and string bodies are written at once and aren't scheduled.
- **Reads.** Once the response body has read everything the socket received,
  it waits for a slot before reading more, then holds it until more bytes
  arrive. A body queued for a slot leaves its bytes unread, so the server's
  TCP window closes and the bandwidth goes to the responses holding slots.
  Waiting for the slot doesn't count toward `bodyTimeout`. A response whose
  socket ends while it waits reads the rest of its body without the slot.

So the scheduler's concurrency bounds how many requests use the network at
once, and priority decides which go first. A request queued for a slot stops
sending or reading, so a server may time out a request that waits too long.
Slots are released when a request finishes, fails or is aborted; one granted
after that is released at once.
