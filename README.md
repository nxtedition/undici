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

| response                                           | this client                                                                                         | upstream undici                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 304 with a non-zero `Content-Length`               | succeeds and keeps the connection; the length describes the selected representation (RFC 9110 §8.6) | succeeds and closes the connection                           |
| bytes after a 304 with a non-zero `Content-Length` | parsed as the next pipelined response                                                               | discarded with the connection; pipelined requests are resent |
| 204 with a non-zero `Content-Length`               | fails with `ResponseContentLengthMismatchError` (RFC 9110 §8.6 forbids it)                          | succeeds and closes the connection                           |

A 204 or 304 to a non-HEAD request that also carries `Transfer-Encoding`
closes the connection, so bytes after it can't be taken for a pipelined
response.

## Async context

Async context is opt-in through a `{ telemetry }` hooks object on each
`request()` or `dispatch()` call. Omit it, or pass `null`/`false`, to leave the
request uninstrumented. The client installs no context manager,
SDK, exporter, `AsyncResource`, or async hooks. Without telemetry, transport
callbacks have no request-context guarantee.

```js
const client = new Client(origin);
try {
  const response = await client.request({
    path: "/",
    method: "GET",
    telemetry,
  });
  await response.body.dump();
  const untraced = await client.request({ path: "/", method: "GET" });
  await untraced.body.dump();
} finally {
  await client.close();
}
```

The application supplies `telemetry` with this synchronous contract:

- `capture()` returns a captured context or `null`/`undefined` to bypass tracing.
  Capture happens once, before shared Agent/Pool/Client queues can change context.
- The context's `run(callback)` calls the callback exactly once and returns its
  result. Public handler callbacks, their abort functions and resume callbacks
  run in this context. Handler receivers and backpressure returns are preserved.
- Optional context `headers` replace propagation fields without mutating the
  caller's headers. A value of `undefined` removes a copied field. `requestId`
  supplies a `request-id` header only when no explicit header is present. The
  `request-id` field is reserved and ignored in propagation header maps. Declare
  every field an attempt may change in the captured map, using undefined for
  absent values; an attempt cannot introduce undeclared propagation fields.
- Optional context `start(request)` creates an attempt. Its closure retains the
  captured parent and is called in its context; `request` supplies the logical origin, method, path and
  headers. Destination and baggage policy belong here. Return null/undefined
  for propagation without an attempt span.
- An attempt supplies optional `headers` and `run(callback)`, plus
  `end(result)`. End runs once with
  `{ type: 'complete' }`, `{ type: 'upgrade' }` or
  `{ type: 'error', error, aborted }`. Spans cover dispatch/queueing through full
  response completion, failure or upgrade; consume or destroy response bodies
  normally. Results include `statusCode` when a final response or upgrade was
  received; informational responses do not supply the final status.

The exported TypeScript interfaces are `Telemetry`, `TelemetryContext`,
`TelemetryRequest`, `TelemetrySpan` and `TelemetryResult`. There is no telemetry
runtime export or interceptor to install. Hooks must be synchronous;
`capture`, `start` and `run` failures follow normal request error handling.
Observer exceptions from `end` are ignored so transport cleanup and
terminal callback delivery still complete. Tracing integrations choose sampling,
suppression, parentless behavior and any OpenTelemetry SDK configuration.

Compare telemetry overhead across checkouts with the same workload:

```sh
BENCH_IMPLS=before=/path/to/before,after=/path/to/after BENCH_PROFILES=1 node bench/telemetry.mjs
```

The driver uses a separate HTTP server, 1 KiB responses, eight connections and
16 concurrent requests. Five rounds reverse the implementation order, with
10,000 warmup requests and 30,000 measured requests per sample. JSON output
includes throughput, latency, client CPU and GC time. Separate profiling runs
include CPU and sampled allocation profiles, including collected objects. The
enabled case uses lightweight AsyncLocalStorage hooks without an SDK or exporter.

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
const scheduler = new Scheduler({ concurrency: 8 });

await client.request({ path, method: "PUT", body, scheduler, priority: "low" });
```

A request holds one of the scheduler's slots while it waits on the network:

- **Writes.** Once the socket pushes back, a stream or iterable body pauses
  until it is granted a slot, then holds it until the socket drains. Buffer
  and string bodies over 64 KiB are written in 64 KiB chunks and pause the
  same way; like stream bodies, they wait for the requests pipelined before
  them to finish. Smaller ones are written at once and aren't scheduled.
- **Reads.** Once the response body has read everything the socket received,
  it waits for a slot before reading more, then holds it until more bytes
  arrive. A body queued for a slot leaves its bytes unread, so the server's
  TCP window closes and the bandwidth goes to the responses holding slots.
  Waiting for the slot doesn't count toward `bodyTimeout`. A response whose
  socket ends while it waits reads the rest of its body without the slot.
  If a response starts during an upload, reads continue without a read slot
  until the upload finishes, so the response cannot block its own upload
  from getting a write slot.

So the scheduler's concurrency bounds how many requests use the network at
once, and priority decides which go first. A request queued for a slot stops
sending or reading, so a server may time out a request that waits too long.
Slots are released when a request finishes, fails or is aborted; one granted
after that is released at once.
A completed request's scheduler can be garbage collected while its connection
stays alive.

Run `npm run test:fuzzing:scheduler` for the HTTP/HTTPS lifecycle matrix and
seeded contention and pipelining fuzz tests. They check progress, producer
cleanup, byte integrity, per-request slot accounting, and a healthy follow-up
using the same scheduler. They also run as part of the unit suite. Increase
the sample count with `SCHEDULER_FUZZ_RUNS=1000`; replay a failing seed with
`SCHEDULER_FUZZ_SEED=<seed>`.
