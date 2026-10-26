'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')
const https = require('node:https')
const { Readable } = require('node:stream')
const { setImmediate: tick } = require('node:timers/promises')
const { test } = require('node:test')
const fc = require('fast-check')
const pem = require('@metcoder95/https-pem')
const { Client } = require('..')
const { kSocket } = require('../lib/core/symbols')
const timers = require('../lib/util/timers')

const CHUNK = Buffer.alloc(256 * 1024, 'a')
const ACTIONS = ['complete', 'abort', 'destroy-client', 'socket-error', 'peer-close', 'body-error', 'early-response']

async function waitFor (predicate, message) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message)
    await tick()
  }
}

// A bounded scheduler shared by several requests. Each facade keeps its own
// ledger, so releasing another request's slot cannot hide a leak. Reservations
// count against concurrency even when their callbacks are deferred.
class Scheduler {
  constructor (concurrency, timing) {
    this.concurrency = concurrency
    this.timing = timing
    this.paused = true
    this.running = 0
    this.queue = []
    this.owners = []
    this.errors = []
    this.dispatching = false
  }

  request (priority, error) {
    const owner = { requested: 0, granted: 0, released: 0, held: 0 }
    this.owners.push(owner)
    return Object.assign(owner, {
      acquire: (fn, actualPriority) => {
        if (error) throw error
        if (actualPriority !== priority) this.errors.push('priority changed')
        owner.requested++
        this.queue.push({ owner, fn })
        this.pump()
      },
      release: () => {
        if (owner.held === 0) {
          this.errors.push('released an unowned slot')
          return
        }
        owner.held--
        owner.released++
        this.running--
        this.pump()
      }
    })
  }

  resume () {
    this.paused = false
    this.pump()
  }

  pump () {
    if (this.paused || this.dispatching) return
    this.dispatching = true
    try {
      while (this.running < this.concurrency && this.queue.length > 0) {
        const { owner, fn } = this.queue.shift()
        this.running++
        const grant = () => {
          owner.granted++
          owner.held++
          fn()
          const afterGrant = owner.afterGrant
          owner.afterGrant = null
          afterGrant?.()
        }
        if (this.timing === 'sync') grant()
        else if (this.timing === 'microtask') queueMicrotask(grant)
        else setImmediate(grant)
      }
    } finally {
      this.dispatching = false
    }
  }

  async settled () {
    this.resume()
    await waitFor(() => this.queue.length === 0 && this.running === 0, 'scheduler did not return every slot')
    assert.deepEqual(this.errors, [])
    for (const owner of this.owners) {
      assert.equal(owner.granted, owner.requested, 'an acquisition never completed')
      assert.equal(owner.released, owner.granted, 'a slot leaked')
      assert.equal(owner.held, 0)
    }
  }
}

async function fixture (protocol, scheduler, plans) {
  const states = plans.map((plan, id) => ({
    ...plan,
    id,
    scheduler: scheduler.request(plan.priority, plan.schedulerError),
    controller: new AbortController(),
    chunks: plan.chunks ?? 4,
    finalized: 0,
    failBody: false,
    received: 0
  }))
  const server = (protocol === 'https' ? https : http).createServer(protocol === 'https' ? pem : {}, (req, res) => {
    const state = states[Number(req.url.slice(1))]
    state.req = req
    state.res = res
    req.on('error', () => {})
    res.on('error', () => {})
    if (state.kind === 'read') {
      res.writeHead(200, { 'content-length': 1 + state.chunks * CHUNK.length })
      res.write('a')
    } else {
      if (state.duplex) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.write('uploaded:')
      }
      req.pause()
      req.on('data', chunk => { state.received += chunk.length })
      req.on('end', () => res.end(String(state.received)))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `${protocol}://127.0.0.1:${server.address().port}`

  for (const state of states) {
    const client = state.client = new Client(url, {
      tls: { rejectUnauthorized: false },
      maxResponseSize: state.maxResponseSize
    })
    let body
    if (state.kind === 'stream') {
      let sent = 0
      body = state.source = new Readable({
        read () {
          if (state.failBody) this.destroy(new Error('producer failed'))
          else this.push(sent++ < state.chunks ? CHUNK : null)
        },
        destroy (err, callback) {
          state.finalized++
          callback(err)
        }
      })
    } else if (state.kind === 'iterable') {
      body = (async function * () {
        try {
          for (let i = 0; i < state.chunks; i++) {
            if (state.failBody) throw new Error('producer failed')
            yield CHUNK
          }
        } finally {
          state.finalized++
        }
      })()
    }
    // Attach rejection handlers immediately, including failures before headers.
    state.result = client.request({
      path: `/${state.id}`,
      method: state.kind === 'read' ? 'GET' : 'PUT',
      body,
      signal: state.controller.signal,
      scheduler: state.scheduler,
      priority: state.priority,
      bodyTimeout: state.bodyTimeout
    }).then(async ({ body }) => {
      state.body = body
      const data = await body.text()
      if (state.kind === 'read') {
        assert.equal(data, 'a'.repeat(1 + state.chunks * CHUNK.length))
      } else if (state.action !== 'early-response') {
        assert.equal(data, (state.duplex ? 'uploaded:' : '') + String(state.chunks * CHUNK.length))
      }
      return { ok: true }
    }).catch(error => ({ error }))
  }

  return {
    states,
    async close () {
      await Promise.all(states.map(state => state.client.destroy()))
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      await Promise.all(states.map(state => state.result))
    },
    async probe (existingClient) {
      // Prove that the same scheduler still admits useful work after failures.
      const state = { kind: 'read', chunks: 1, received: 0 }
      states.push(state)
      const client = existingClient ?? new Client(url, { tls: { rejectUnauthorized: false } })
      try {
        const pending = client.request({ path: `/${states.length - 1}`, method: 'GET', scheduler: scheduler.request(0), priority: 0 })
        const result = pending.then(async ({ body }) => body.text())
        result.catch(() => {})
        await waitFor(() => state.res != null, 'healthy follow-up never reached the server')
        state.res.end(CHUNK)
        let done = false
        result.finally(() => { done = true }).catch(() => {})
        await waitFor(() => done, 'healthy follow-up made no progress')
        assert.equal(await result, 'a'.repeat(1 + CHUNK.length))
      } finally {
        if (!existingClient) await client.destroy()
        states.pop()
      }
    }
  }
}

function finish (state) {
  if (state.kind === 'read') {
    let sent = 0
    const write = () => {
      if (state.res.destroyed) return
      if (sent++ < state.chunks) {
        state.res.write(CHUNK)
        setImmediate(write)
      } else {
        state.res.end()
      }
    }
    write()
  } else {
    state.req.resume()
  }
}

function interrupt (state) {
  switch (state.action) {
    case 'complete': return
    case 'abort': state.controller.abort(); break
    case 'destroy-client': state.client.destroy(); break
    case 'socket-error': {
      const error = Object.assign(new Error('injected read error'), { code: 'ECONNRESET', syscall: 'read' })
      state.client[kSocket].destroy(error)
      break
    }
    case 'peer-close': state.req.socket.destroy(); break
    case 'body-error':
      if (state.kind === 'read') state.body.destroy(new Error('consumer failed'))
      else if (state.kind === 'stream') state.source.destroy(new Error('producer failed'))
      else state.failBody = true
      break
    case 'early-response': state.res.end('early'); break
  }
}

for (const protocol of ['http', 'https']) {
  for (const kind of ['read', 'stream', 'iterable']) {
    test(`scheduler acquire failure rejects a ${kind} request (${protocol})`, { timeout: 15000 }, async () => {
      const scheduler = new Scheduler(1, 'sync')
      scheduler.resume()
      const error = new Error('scheduler rejected priority')
      const run = await fixture(protocol, scheduler, [{ kind, action: 'complete', priority: 0, schedulerError: error }])
      try {
        const [state] = run.states
        let result
        state.result.then(value => { result = value })
        await waitFor(() => result, 'scheduler failure did not reject the request')
        assert.equal(result.error, error)
        await scheduler.settled()
        await run.probe(state.client)
      } finally {
        await run.close()
        await scheduler.settled()
      }
    })
  }
  for (const failure of ['timeout', 'response-too-large', 'truncated']) {
    for (const queued of [true, false]) {
      test(`scheduler releases ${queued ? 'queued' : 'held'} reads after ${failure} (${protocol})`, { timeout: 15000 }, async () => {
        const scheduler = new Scheduler(1, 'sync')
        if (!queued) scheduler.resume()
        const run = await fixture(protocol, scheduler, [{
          kind: 'read',
          action: 'complete',
          priority: 0,
          bodyTimeout: failure === 'timeout' ? 100 : 0,
          maxResponseSize: failure === 'response-too-large' ? 1024 : -1
        }])
        try {
          const [state] = run.states
          await waitFor(() => state.body && (queued ? state.scheduler.requested > 0 : state.scheduler.held > 0), 'read did not reach its checkpoint')
          if (failure === 'timeout') {
            if (queued) {
              timers.tick(1000)
              assert.equal(state.client[kSocket].destroyed, false, 'queued time counted toward bodyTimeout')
            }
            scheduler.resume()
            timers.tick(1000)
          } else if (failure === 'response-too-large') {
            finish(state)
            scheduler.resume()
          } else {
            state.res.end()
            state.req.socket.end()
            scheduler.resume()
          }
          let result
          state.result.then(value => { result = value })
          await waitFor(() => result, 'failed response made no progress')
          assert.equal(result.error?.code, {
            timeout: 'UND_ERR_BODY_TIMEOUT',
            'response-too-large': 'UND_ERR_RES_EXCEEDED_MAX_SIZE',
            truncated: 'UND_ERR_SOCKET'
          }[failure])
          await scheduler.settled()
          await run.probe()
        } finally {
          await run.close()
          await scheduler.settled()
        }
      })
    }
  }
  for (const kind of ['stream', 'iterable']) {
    test(`scheduler makes progress with a response during a ${kind} upload (${protocol})`, { timeout: 15000 }, async () => {
      const scheduler = new Scheduler(1, 'sync')
      const run = await fixture(protocol, scheduler, [{ kind, action: 'complete', chunks: 64, priority: 0, duplex: true }])
      try {
        const [state] = run.states
        await waitFor(() => state.req && state.body && state.scheduler.requested > 0, 'upload did not queue after response headers')
        finish(state)
        scheduler.resume()
        let result
        state.result.then(value => { result = value })
        await waitFor(() => result, 'response and upload deadlocked on one scheduler slot')
        assert.deepEqual(result, { ok: true })
        await scheduler.settled()
        await run.probe()
      } finally {
        await run.close()
        await scheduler.settled()
      }
    })
  }
  // These checkpoints guarantee every destructive action runs both with a
  // queued acquisition and with a genuinely held slot, independently of seeds.
  for (const kind of ['read', 'stream', 'iterable']) {
    for (const queued of [true, false]) {
      for (const action of ACTIONS.filter(action => action !== 'complete' && (action !== 'early-response' || kind !== 'read'))) {
        test(`scheduler ${action}, ${queued ? 'queued' : 'held'} ${kind} (${protocol})`, { timeout: 15000 }, async () => {
          const scheduler = new Scheduler(1, 'sync')
          if (!queued) scheduler.resume()
          const run = await fixture(protocol, scheduler, [{ kind, action, chunks: 64, priority: 'low' }])
          try {
            const [state] = run.states
            await waitFor(() => state.req && (queued ? state.scheduler.requested > 0 : state.scheduler.held > 0), 'request never reached its scheduler checkpoint')
            if (kind === 'read') await waitFor(() => state.body, 'response headers were not delivered')
            interrupt(state)
            // A failing iterable must first leave waitForDrain before next()
            // can throw. Other queued failures must settle without a grant.
            if (action === 'body-error' && kind === 'iterable') {
              state.req.resume()
              scheduler.resume()
            }
            let done = false
            state.result.then(() => { done = true })
            await waitFor(() => done, 'failure waited for a scheduler grant')
            scheduler.resume()
            const result = await state.result
            if (action !== 'early-response') assert.ok(result.error, 'failed request unexpectedly succeeded')
            if (action === 'body-error') assert.match(result.error.message, /(?:producer|consumer) failed/)
            if (kind !== 'read') await waitFor(() => state.finalized === 1, 'upload producer was not finalized exactly once')
            await scheduler.settled()
            await run.probe()
            await scheduler.settled()
          } finally {
            await run.close()
            await scheduler.settled()
          }
        })
      }
    }
  }

  test(`scheduler contention fuzz (${protocol})`, { timeout: 120000 }, async () => {
    const plan = fc.record({
      kind: fc.constantFrom('read', 'stream', 'iterable'),
      action: fc.constantFrom(...ACTIONS),
      priority: fc.oneof(fc.integer({ min: -10, max: 10 }), fc.constantFrom('low', 'high')),
      chunks: fc.integer({ min: 1, max: 8 }),
      afterGrant: fc.boolean(),
      duplex: fc.boolean(),
      ticks: fc.integer({ min: 0, max: 4 })
    }).filter(plan => (plan.kind !== 'read' || plan.action !== 'early-response') &&
      (plan.action !== 'body-error' || plan.kind === 'read' || plan.chunks >= 3))
    await fc.assert(fc.asyncProperty(
      fc.array(plan, { minLength: 2, maxLength: 5 }),
      fc.integer({ min: 1, max: 3 }),
      fc.constantFrom('sync', 'microtask', 'immediate'),
      async (plans, concurrency, timing) => {
        const scheduler = new Scheduler(concurrency, timing)
        const run = await fixture(protocol, scheduler, plans)
        try {
          await waitFor(() => run.states.every(state => state.req && state.scheduler.requested > 0 && (state.kind !== 'read' || state.body)), 'requests did not queue')
          for (const state of run.states) {
            for (let i = 0; i < state.ticks; i++) await tick()
            if (state.afterGrant && state.action !== 'complete') {
              state.scheduler.afterGrant = () => {
                interrupt(state)
                if (state.action === 'body-error') finish(state)
              }
            } else {
              interrupt(state)
            }
          }
          // Complete survivors and return delayed grants after teardown, with
          // synchronous release->grant reentrancy as well as deferred grants.
          for (const state of run.states) {
            if (state.action === 'complete' || (!state.afterGrant && state.action === 'body-error')) finish(state)
          }
          scheduler.resume()
          let results
          Promise.all(run.states.map(state => state.result)).then(value => { results = value })
          await waitFor(() => results, 'contending requests made no progress')
          results.forEach((result, i) => {
            if (plans[i].action === 'complete') assert.deepEqual(result, { ok: true })
            else if (plans[i].action !== 'early-response') assert.ok(result.error, `failed ${plans[i].kind} request (${plans[i].action}) unexpectedly succeeded`)
          })
          await scheduler.settled()
          for (const state of run.states) {
            if (state.kind !== 'read') assert.equal(state.finalized, 1, 'producer cleanup missing or repeated')
          }
          await run.probe()
          await scheduler.settled()
        } finally {
          await run.close()
          await scheduler.settled()
        }
      }
    ), {
      numRuns: Number(process.env.SCHEDULER_FUZZ_RUNS ?? 100),
      ...(process.env.SCHEDULER_FUZZ_SEED ? { seed: Number(process.env.SCHEDULER_FUZZ_SEED) } : {}),
      endOnFailure: true
    })
  })

  test(`scheduler pipelining and consumer backpressure fuzz (${protocol})`, { timeout: 120000 }, async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        scheduled: fc.boolean(),
        chunks: fc.integer({ min: 1, max: 8 }),
        chunkSize: fc.integer({ min: 1, max: 8192 }),
        pauseTicks: fc.integer({ min: 0, max: 4 })
      }), { minLength: 2, maxLength: 6 }),
      fc.constantFrom('sync', 'microtask', 'immediate'),
      async (plans, timing) => {
        const scheduler = new Scheduler(1, timing)
        const server = (protocol === 'https' ? https : http).createServer(protocol === 'https' ? pem : {}, (req, res) => {
          const id = Number(req.url.slice(1))
          const plan = plans[id]
          res.on('error', () => {})
          res.writeHead(200, { 'content-length': 1 + plan.chunks * plan.chunkSize })
          res.write(Buffer.from([id]))
          let sent = 0
          const write = () => {
            if (res.destroyed) return
            if (sent++ < plan.chunks) {
              res.write(Buffer.alloc(plan.chunkSize, id))
              setImmediate(write)
            } else res.end()
          }
          setImmediate(write)
        })
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        const client = new Client(`${protocol}://127.0.0.1:${server.address().port}`, {
          tls: { rejectUnauthorized: false },
          pipelining: 6
        })
        const pending = plans.map(async (plan, id) => {
          const { body } = await client.request({
            path: `/${id}`,
            method: 'GET',
            blocking: false,
            highWaterMark: 1,
            scheduler: plan.scheduled ? scheduler.request(id) : null,
            priority: id
          })
          for (let i = 0; i < plan.pauseTicks; i++) await tick()
          const chunks = []
          for await (const chunk of body) {
            chunks.push(chunk)
            for (let i = 0; i < plan.pauseTicks; i++) await tick()
          }
          assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(1 + plan.chunks * plan.chunkSize, id))
        })
        let result
        Promise.all(pending).then(() => { result = { ok: true } }, error => { result = { error } })
        try {
          // Let the first read queue before allowing synchronous/deferred grants.
          await tick()
          scheduler.resume()
          await waitFor(() => result, 'pipeline or paused consumer made no progress')
          assert.deepEqual(result, { ok: true })
          await scheduler.settled()
          await client.close()
        } finally {
          await client.destroy()
          server.closeAllConnections()
          await new Promise(resolve => server.close(resolve))
          await scheduler.settled()
        }
      }
    ), {
      numRuns: Number(process.env.SCHEDULER_FUZZ_RUNS ?? 100),
      ...(process.env.SCHEDULER_FUZZ_SEED ? { seed: Number(process.env.SCHEDULER_FUZZ_SEED) } : {}),
      endOnFailure: true
    })
  })
}
