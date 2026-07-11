'use strict'

const { createServer } = require('node:http')
const { Client } = require('../..')

const expected = new Error('request callback failure')
const timeout = setTimeout(() => {
  process.stderr.write('request callback exception was swallowed\n')
  process.exit(1)
}, 1000)

process.once('uncaughtException', (err) => {
  clearTimeout(timeout)

  if (err !== expected) {
    process.stderr.write(`unexpected exception: ${err?.stack ?? err}\n`)
    process.exit(2)
  }

  process.stdout.write('caught request callback failure\n')
  process.exit(0)
})

const server = createServer((req, res) => {
  res.end('hello')
})

server.listen(0, () => {
  const client = new Client(`http://localhost:${server.address().port}`)

  client.request({ path: '/', method: 'GET' }, (err) => {
    if (err) {
      throw err
    }

    throw expected
  })
})
