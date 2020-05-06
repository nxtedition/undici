'use strict'

const { test } = require('tap')
const { Client } = require('..')
const { createServer } = require('http')
const { readFileSync, createReadStream } = require('fs')
const { finished } = require('readable-stream')

test('basic get', (t) => {
  t.plan(7)

  const server = createServer((req, res) => {
    t.strictEqual('/', req.url)
    t.strictEqual('GET', req.method)
    t.strictEqual('localhost', req.headers.host)
    res.setHeader('content-type', 'text/plain')
    res.end('hello')
  })
  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.tearDown(client.close.bind(client))

    client.request({ path: '/', method: 'GET' }, (err, { statusCode, headers, body }) => {
      t.error(err)
      t.strictEqual(statusCode, 200)
      t.strictEqual(headers['content-type'], 'text/plain')
      const bufs = []
      body.on('data', (buf) => {
        bufs.push(buf)
      })
      body.on('end', () => {
        t.strictEqual('hello', Buffer.concat(bufs).toString('utf8'))
      })
    })
  })
})

test('basic head', (t) => {
  t.plan(7)

  const server = createServer((req, res) => {
    t.strictEqual('/', req.url)
    t.strictEqual('HEAD', req.method)
    t.strictEqual('localhost', req.headers.host)
    res.setHeader('content-type', 'text/plain')
    res.end('hello')
  })
  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.tearDown(client.close.bind(client))

    client.request({ path: '/', method: 'HEAD' }, (err, { statusCode, headers, body }) => {
      t.error(err)
      t.strictEqual(statusCode, 200)
      t.strictEqual(headers['content-type'], 'text/plain')
      t.strictEqual(body, null)
    })
  })
})

test('get with host header', (t) => {
  t.plan(7)

  const server = createServer((req, res) => {
    t.strictEqual('/', req.url)
    t.strictEqual('GET', req.method)
    t.strictEqual('example.com', req.headers.host)
    res.setHeader('content-type', 'text/plain')
    res.end('hello from ' + req.headers.host)
  })
  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.tearDown(client.close.bind(client))

    client.request({ path: '/', method: 'GET', headers: { host: 'example.com' } }, (err, { statusCode, headers, body }) => {
      t.error(err)
      t.strictEqual(statusCode, 200)
      t.strictEqual(headers['content-type'], 'text/plain')
      const bufs = []
      body.on('data', (buf) => {
        bufs.push(buf)
      })
      body.on('end', () => {
        t.strictEqual('hello from example.com', Buffer.concat(bufs).toString('utf8'))
      })
    })
  })
})

test('head with host header', (t) => {
  t.plan(7)

  const server = createServer((req, res) => {
    t.strictEqual('/', req.url)
    t.strictEqual('HEAD', req.method)
    t.strictEqual('example.com', req.headers.host)
    res.setHeader('content-type', 'text/plain')
    res.end('hello from ' + req.headers.host)
  })
  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.tearDown(client.close.bind(client))

    client.request({ path: '/', method: 'HEAD', headers: { host: 'example.com' } }, (err, { statusCode, headers, body }) => {
      t.error(err)
      t.strictEqual(statusCode, 200)
      t.strictEqual(headers['content-type'], 'text/plain')
      t.strictEqual(body, null)
    })
  })
})

function postServer (t, expected) {
  return function (req, res) {
    t.strictEqual(req.url, '/')
    t.strictEqual(req.method, 'POST')

    req.setEncoding('utf8')
    let data = ''

    req.on('data', function (d) { data += d })

    req.on('end', () => {
      t.strictEqual(data, expected)
      res.end('hello')
    })
  }
}

test('basic POST with string', (t) => {
  t.plan(6)

  const expected = readFileSync(__filename, 'utf8')

  const server = createServer(postServer(t, expected))
  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.tearDown(client.close.bind(client))

    client.request({ path: '/', method: 'POST', body: expected }, (err, { statusCode, headers, body }) => {
      t.error(err)
      t.strictEqual(statusCode, 200)
      const bufs = []
      body.on('data', (buf) => {
        bufs.push(buf)
      })
      body.on('end', () => {
        t.strictEqual('hello', Buffer.concat(bufs).toString('utf8'))
      })
    })
  })
})

test('basic POST with empty string', (t) => {
  t.plan(6)

  const server = createServer(postServer(t, ''))
  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.tearDown(client.close.bind(client))

    client.request({ path: '/', method: 'POST', body: '' }, (err, { statusCode, headers, body }) => {
      t.error(err)
      t.strictEqual(statusCode, 200)
      const bufs = []
      body.on('data', (buf) => {
        bufs.push(buf)
      })
      body.on('end', () => {
        t.strictEqual('hello', Buffer.concat(bufs).toString('utf8'))
      })
    })
  })
})

test('basic POST with string and content-length', (t) => {
  t.plan(6)

  const expected = readFileSync(__filename, 'utf8')

  const server = createServer(postServer(t, expected))
  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.tearDown(client.close.bind(client))

    client.request({
      path: '/',
      method: 'POST',
      headers: {
        'content-length': Buffer.byteLength(expected)
      },
      body: expected
    }, (err, { statusCode, headers, body }) => {
      t.error(err)
      t.strictEqual(statusCode, 200)
      const bufs = []
      body.on('data', (buf) => {
        bufs.push(buf)
      })
      body.on('end', () => {
        t.strictEqual('hello', Buffer.concat(bufs).toString('utf8'))
      })
    })
  })
})

test('basic POST with Buffer', (t) => {
  t.plan(6)

  const expected = readFileSync(__filename)

  const server = createServer(postServer(t, expected.toString()))
  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.tearDown(client.close.bind(client))

    client.request({ path: '/', method: 'POST', body: expected }, (err, { statusCode, headers, body }) => {
      t.error(err)
      t.strictEqual(statusCode, 200)
      const bufs = []
      body.on('data', (buf) => {
        bufs.push(buf)
      })
      body.on('end', () => {
        t.strictEqual('hello', Buffer.concat(bufs).toString('utf8'))
      })
    })
  })
})

test('basic POST with stream', (t) => {
  t.plan(6)

  const expected = readFileSync(__filename, 'utf8')

  const server = createServer(postServer(t, expected))
  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.tearDown(client.close.bind(client))

    client.request({
      path: '/',
      method: 'POST',
      headers: {
        'content-length': Buffer.byteLength(expected)
      },
      body: createReadStream(__filename)
    }, (err, { statusCode, headers, body }) => {
      t.error(err)
      t.strictEqual(statusCode, 200)
      const bufs = []
      body.on('data', (buf) => {
        bufs.push(buf)
      })
      body.on('end', () => {
        t.strictEqual('hello', Buffer.concat(bufs).toString('utf8'))
      })
    })
  })
})

test('basic POST with transfer encoding: chunked', (t) => {
  t.plan(6)

  const expected = readFileSync(__filename, 'utf8')

  const server = createServer(postServer(t, expected))
  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.tearDown(client.close.bind(client))

    client.request({
      path: '/',
      method: 'POST',
      // no content-length header
      body: createReadStream(__filename)
    }, (err, { statusCode, headers, body }) => {
      t.error(err)
      t.strictEqual(statusCode, 200)
      const bufs = []
      body.on('data', (buf) => {
        bufs.push(buf)
      })
      body.on('end', () => {
        t.strictEqual('hello', Buffer.concat(bufs).toString('utf8'))
      })
    })
  })
})

test('10 times GET', (t) => {
  const num = 10
  t.plan(3 * 10)

  const server = createServer((req, res) => {
    res.end(req.url)
  })
  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.tearDown(client.close.bind(client))

    for (var i = 0; i < num; i++) {
      makeRequest(i)
    }

    function makeRequest (i) {
      client.request({ path: '/' + i, method: 'GET' }, (err, { statusCode, headers, body }) => {
        t.error(err)
        t.strictEqual(statusCode, 200)
        const bufs = []
        body.on('data', (buf) => {
          bufs.push(buf)
        })
        body.on('end', () => {
          t.strictEqual('/' + i, Buffer.concat(bufs).toString('utf8'))
        })
      })
    }
  })
})

test('10 times HEAD', (t) => {
  const num = 10
  t.plan(3 * 10)

  const server = createServer((req, res) => {
    res.end(req.url)
  })
  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.tearDown(client.close.bind(client))

    for (var i = 0; i < num; i++) {
      makeRequest(i)
    }

    function makeRequest (i) {
      client.request({ path: '/' + i, method: 'HEAD' }, (err, { statusCode, headers, body }) => {
        t.error(err)
        t.strictEqual(statusCode, 200)
        t.strictEqual(body, null)
      })
    }
  })
})

test('20 times GET with pipelining 10', (t) => {
  const num = 20
  t.plan(3 * num + 1)

  let count = 0
  let countGreaterThanOne = false
  const server = createServer((req, res) => {
    count++
    setTimeout(function () {
      countGreaterThanOne = countGreaterThanOne || count > 1
      res.end(req.url)
    }, 10)
  })
  t.tearDown(server.close.bind(server))

  // needed to check for a warning on the maxListeners on the socket
  process.on('warning', t.fail)
  t.tearDown(() => {
    process.removeListener('warning', t.fail)
  })

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`, {
      pipelining: 10
    })
    t.tearDown(client.close.bind(client))

    for (var i = 0; i < num; i++) {
      makeRequest(i)
    }

    function makeRequest (i) {
      makeRequestAndExpectUrl(client, i, t, () => {
        count--

        if (i === num - 1) {
          t.ok(countGreaterThanOne, 'seen more than one parallel request')
        }
      })
    }
  })
})

function makeRequestAndExpectUrl (client, i, t, cb) {
  return client.request({ path: '/' + i, method: 'GET' }, (err, { statusCode, headers, body }) => {
    cb()
    t.error(err)
    t.strictEqual(statusCode, 200)
    const bufs = []
    body.on('data', (buf) => {
      bufs.push(buf)
    })
    body.on('end', () => {
      t.strictEqual('/' + i, Buffer.concat(bufs).toString('utf8'))
    })
  })
}

test('20 times HEAD with pipelining 10', (t) => {
  const num = 20
  t.plan(3 * num + 1)

  let count = 0
  let countGreaterThanOne = false
  const server = createServer((req, res) => {
    count++
    setTimeout(function () {
      countGreaterThanOne = countGreaterThanOne || count > 1
      res.end(req.url)
    }, 10)
  })
  t.tearDown(server.close.bind(server))

  // needed to check for a warning on the maxListeners on the socket
  process.on('warning', t.fail)
  t.tearDown(() => {
    process.removeListener('warning', t.fail)
  })

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`, {
      pipelining: 10
    })
    t.tearDown(client.close.bind(client))

    for (let i = 0; i < num; i++) {
      makeRequest(i)
    }

    function makeRequest (i) {
      makeHeadRequestAndExpectUrl(client, i, t, () => {
        count--

        if (i === num - 1) {
          t.ok(countGreaterThanOne, 'seen more than one parallel request')
        }
      })
    }
  })
})

function makeHeadRequestAndExpectUrl (client, i, t, cb) {
  return client.request({ path: '/' + i, method: 'HEAD' }, (err, { statusCode, headers, body }) => {
    cb()
    t.error(err)
    t.strictEqual(statusCode, 200)
    t.strictEqual(body, null)
  })
}

// test('A client should enqueue as much as twice its pipelining factor', (t) => {
//   const num = 6
//   let sent = 0
//   t.plan(6 * num + 5)

//   let count = 0
//   let countGreaterThanOne = false
//   const server = createServer((req, res) => {
//     count++
//     t.ok(count <= 5)
//     setTimeout(function () {
//       countGreaterThanOne = countGreaterThanOne || count > 1
//       res.end(req.url)
//     }, 10)
//   })
//   t.tearDown(server.close.bind(server))

//   server.listen(0, () => {
//     const client = new Client(`http://localhost:${server.address().port}`, {
//       pipelining: 2
//     })
//     t.tearDown(client.close.bind(client))

//     for (; sent < 2;) {
//       t.notOk(client.full, 'client is not full')
//       t.ok(makeRequest(), 'we can send more requests')
//     }

//     t.notOk(client.full, 'client is full')
//     t.notOk(makeRequest(), 'we must stop now')
//     t.ok(client.full, 'client is full')

//     client.on('drain', () => {
//       t.ok(countGreaterThanOne, 'seen more than one parallel request')
//       const start = sent
//       for (; sent < start + 3 && sent < num;) {
//         t.notOk(client.full, 'client is not full')
//         t.ok(makeRequest())
//       }
//     })

//     function makeRequest () {
//       return makeRequestAndExpectUrl(client, sent++, t, () => count--)
//     }
//   })
// })

test('Set-Cookie', (t) => {
  t.plan(4)

  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/plain')
    res.setHeader('Set-Cookie', ['a cookie', 'another cookie'])
    res.end('hello')
  })
  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    t.tearDown(client.close.bind(client))

    client.request({ path: '/', method: 'GET' }, (err, { statusCode, headers, body }) => {
      t.error(err)
      t.strictEqual(statusCode, 200)
      t.strictDeepEqual(headers['Set-Cookie'], ['a cookie', 'another cookie'])
      const bufs = []
      body.on('data', (buf) => {
        bufs.push(buf)
      })
      body.on('end', () => {
        t.strictEqual('hello', Buffer.concat(bufs).toString('utf8'))
      })
    })
  })
})

test('close should call callback once finished', (t) => {
  t.plan(6)

  const server = createServer((req, res) => {
    setTimeout(function () {
      res.end(req.url)
    }, 10)
  })
  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`, {
      pipelining: 1
    })

    t.ok(makeRequest())
    t.ok(!makeRequest())

    client.on('drain', () => {
      t.fail()
    })
    client.close((err) => {
      t.strictEqual(err, null)
      t.strictEqual(client.closed, true)
    })

    function makeRequest () {
      return client.request({ path: '/', method: 'GET' }, (err, data) => {
        t.error(err)
      })
    }
  })
})

test('close should still reconnect', (t) => {
  t.plan(6)

  const server = createServer((req, res) => {
    res.end(req.url)
  })
  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`, {
      pipelining: 1
    })

    t.ok(client.request({ path: '/', method: 'GET' }, (err, data) => {
      t.ok(err)
    }))
    t.ok(!client.request({ path: '/', method: 'GET' }, (err, data) => {
      t.error(err)
    }))
    client.close((err) => {
      t.error(err)
      t.strictEqual(client.closed, true)
    })
    client.socket.destroy()
  })
})

test('close waits until socket is destroyed', (t) => {
  t.plan(5)

  const server = createServer((req, res) => {
    res.end(req.url)
  })
  t.tearDown(server.close.bind(server))

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`, {
      pipelining: 1
    })

    makeRequest()

    client.on('connect', () => {
      let done = false
      finished(client.socket, () => {
        done = true
      })
      client.destroy(null, (err) => {
        // TODO: What erro should this be?
        t.ok(err)
      })
      client.close((err) => {
        // TODO: What erro should this be?
        t.ok(err)
        t.strictEqual(client.closed, true)
        t.strictEqual(done, true)
      })
    })

    function makeRequest () {
      return client.request({ path: '/', method: 'GET' }, (err, data) => {
        t.ok(err)
      })
    }
  })
})
