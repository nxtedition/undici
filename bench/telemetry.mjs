// Compare identical checkouts with BENCH_IMPLS=before=/path/one,after=/path/two.
// Each sample gets a fresh client process; the HTTP server has its own process.
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { Session } from 'node:inspector/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { PerformanceObserver } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const env = process.env
const requests = Number(env.BENCH_REQUESTS ?? 30000)
const warmup = Number(env.BENCH_WARMUP ?? 10000)
const concurrency = Number(env.BENCH_CONCURRENCY ?? 16)
const connections = Number(env.BENCH_CONNECTIONS ?? 8)
const rounds = Number(env.BENCH_ROUNDS ?? 5)
for (const n of [requests, warmup, concurrency, connections, rounds]) {
  assert.ok(Number.isSafeInteger(n) && n > 0)
}
const percentile = (values, p) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

async function client() {
  const root = resolve(env.BENCH_ROOT)
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'))
  const api = await import(
    pathToFileURL(`${root}/${pkg.type === 'module' ? 'lib/index.ts' : 'index.js'}`)
  )
  const agent = new api.Agent({ connections })
  const storage = new AsyncLocalStorage()
  const parent = { id: 'parent' }
  let starts = 0
  let ends = 0
  let invalidResult = false
  const telemetry =
    env.BENCH_MODE === 'on'
      ? {
          capture() {
            const context = storage.getStore()
            return {
              run: (callback) => storage.run(context, callback),
              headers: { traceparent: undefined },
              start() {
                const id = (++starts).toString(16).padStart(16, '0')
                const attempt = { id }
                let statusCode
                return {
                  headers: { traceparent: `00-0123456789abcdef0123456789abcdef-${id}-01` },
                  run: (callback) => storage.run(attempt, callback),
                  // The same hooks also work against the earlier PR API.
                  onHeaders(code) {
                    statusCode = code
                  },
                  end(result) {
                    ends++
                    invalidResult ||=
                      result.type !== 'complete' || (result.statusCode ?? statusCode) !== 200
                  },
                }
              },
            }
          },
        }
      : undefined
  const options = {
    dispatcher: agent,
    method: 'GET',
    headers: { accept: '*/*' },
    retry: false,
    follow: false,
    cache: false,
    verify: false,
    dns: false,
    trace: null,
    ...(telemetry ? { telemetry } : {}),
  }
  const url = `http://127.0.0.1:${env.BENCH_PORT}/`
  const batch = async (count) => {
    const latencies = []
    await Promise.all(
      Array.from({ length: concurrency }, async (_, worker) => {
        for (let i = worker; i < count; i += concurrency) {
          const begin = performance.now()
          await storage.run(parent, async () => {
            const response = await api.request(url, options)
            assert.equal(response.statusCode, 200)
            await response.body.dump()
          })
          latencies.push(performance.now() - begin)
        }
      }),
    )
    return latencies
  }
  const inspector = env.BENCH_PROFILE === '1' ? new Session() : null
  let gcCount = 0
  let gcMs = 0
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcCount++
      gcMs += entry.duration
    }
  })
  try {
    await batch(warmup)
    globalThis.gc?.()
    await new Promise((resolve) => setImmediate(resolve))
    observer.observe({ entryTypes: ['gc'] })
    if (inspector) {
      inspector.connect()
      await inspector.post('Profiler.enable')
      await inspector.post('Profiler.start')
      await inspector.post('HeapProfiler.startSampling', {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      })
    }
    const cpuStart = process.cpuUsage()
    const begin = performance.now()
    const latencies = await batch(requests)
    const ms = performance.now() - begin
    const cpu = process.cpuUsage(cpuStart)
    await new Promise((resolve) => setImmediate(resolve))
    const row = {
      type: inspector ? 'profile' : 'sample',
      impl: env.BENCH_IMPL,
      mode: env.BENCH_MODE,
      package: pkg.name,
      node: process.version,
      arch: process.arch,
      requests,
      warmup,
      concurrency,
      connections,
      rps: (requests * 1000) / ms,
      cpuUsPerRequest: (cpu.user + cpu.system) / requests,
      p50ms: percentile(latencies, 0.5),
      p99ms: percentile(latencies, 0.99),
      gcCount,
      gcMs,
    }
    if (inspector) {
      const { profile: cpuProfile } = await inspector.post('Profiler.stop')
      const { profile: heapProfile } = await inspector.post('HeapProfiler.stopSampling')
      row.cpuProfile = cpuProfile
      row.heapProfile = heapProfile
    }
    assert.equal(invalidResult, false)
    assert.equal(starts, telemetry ? requests + warmup : 0)
    assert.equal(ends, starts)
    console.log(JSON.stringify(row))
  } finally {
    observer.disconnect()
    inspector?.disconnect()
    await agent.destroy()
  }
}

async function parent() {
  const implementations = (
    env.BENCH_IMPLS ?? `current=${fileURLToPath(new URL('..', import.meta.url))}`
  )
    .split(',')
    .map((value) => {
      const at = value.indexOf('=')
      assert.ok(at > 0)
      return { name: value.slice(0, at), root: resolve(value.slice(at + 1)) }
    })
  const variants = implementations.flatMap((impl) =>
    ['off', 'on'].map((mode) => ({ ...impl, mode })),
  )
  const server = fork(fileURLToPath(import.meta.url), ['--server'], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const exited = once(server, 'exit')
  const run = async (variant, profile) => {
    const child = fork(fileURLToPath(import.meta.url), ['--client'], {
      execArgv: ['--expose-gc'],
      env: {
        ...env,
        BENCH_ROOT: variant.root,
        BENCH_IMPL: variant.name,
        BENCH_MODE: variant.mode,
        BENCH_PORT: String(port),
        BENCH_PROFILE: profile ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
    try {
      const [code, signal] = await once(child, 'close')
      assert.equal(code, 0, `${variant.name}/${variant.mode}: ${signal ?? code}`)
      const row = JSON.parse(output.trim())
      console.log(JSON.stringify(row))
      return row
    } finally {
      clearTimeout(timer)
    }
  }
  let port
  try {
    const [ready] = await Promise.race([
      once(server, 'message'),
      exited.then(() => {
        throw new Error('benchmark server exited before readiness')
      }),
    ])
    port = ready.port
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 ? variants.toReversed() : variants
      for (const variant of order) {
        await run(variant, false)
      }
    }
    if (env.BENCH_PROFILES === '1') {
      for (const variant of variants) {
        await run(variant, true)
      }
    }
  } finally {
    server.kill()
    await exited
  }
}

if (process.argv.includes('--server')) {
  const body = Buffer.alloc(1024, 'x')
  createServer((_req, res) => {
    res.setHeader('content-length', body.length)
    res.end(body)
  }).listen(0, '127.0.0.1', function () {
    process.send({ port: this.address().port })
  })
} else if (process.argv.includes('--client')) {
  await client()
} else {
  await parent()
}
