'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { Pool } = require('../..')

async function main () {
  const server = createServer((req, res) => {
    res.end('ok')
  })
  server.keepAliveTimeout = 300e3
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const pool = new Pool(`http://127.0.0.1:${server.address().port}`, {
    connections: 1,
    keepAliveTimeout: 300e3
  })

  try {
    const responses = await Promise.all(Array.from({ length: 10 }, async () => {
      const { body } = await pool.request({ path: '/', method: 'GET' })
      return body.text()
    }))

    assert.deepStrictEqual(responses, Array(10).fill('ok'))
  } finally {
    await pool.destroy()
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve())
    })
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
