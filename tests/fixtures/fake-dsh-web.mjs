// Fake `dsh web` upstream used by the gateway tests. It reproduces the two
// integration points the gateway relies on: the ready URL line on stdout
// (with an OS-assigned port from `--port 0`) and the launch-token/cookie
// exchange on GET /?token=<token>. Everything else answers a JSON echo of
// the request facts the proxy rewrites, so tests can assert header handling.
// FAKE_MODE selects failure shapes: 'crash' exits before the ready line,
// 'silent' stays serving but never prints it, 'noisy' prints unrelated and
// malformed lines before the ready line, 'stubborn' ignores SIGTERM so only
// SIGKILL stops it, and 'expire' accepts each issued cookie exactly once on
// /expire/ paths before answering 401 (the gateway must re-mint). The mux
// upgrade path accepts any minted cookie; POSTing /__mux_arm_401 arms a
// one-shot 401 for the next upgrade so the retry branch is testable.

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const mode = process.env.FAKE_MODE ?? 'normal'
const args = process.argv.slice(2)
let port = 0
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--port') port = Number(args[index + 1])
}

const home = process.env.DSH_HOME
if (home !== undefined) mkdirSync(home, { recursive: true })

if (mode === 'crash') {
  console.error('fake-dsh-web: crashing before the ready line')
  process.exit(3)
}

if (mode === 'stubborn') {
  // Ignore the first SIGTERM so only the SIGKILL escalation stops it; the
  // second one exits normally so a restarted instance stops promptly.
  let sigterms = 0
  process.on('SIGTERM', () => {
    sigterms += 1
    if (sigterms >= 2) process.exit(0)
  })
}

let issuedCookies = 0
const cookieUses = new Map()
let muxRejectNext = false

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://gateway-fixture.invalid')
  if (url.pathname === '/__mux_arm_401') {
    muxRejectNext = true
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('fixture: next mux upgrade will answer 401 once')
    return
  }
  if (url.pathname === '/' && url.searchParams.has('token')) {
    issuedCookies += 1
    const cookie = `dsh_fixture_s${String(issuedCookies)}=value-${String(issuedCookies)}; Path=/`
    res.writeHead(303, { 'set-cookie': cookie })
    res.end()
    return
  }
  const rawCookie = req.headers.cookie
  const firstPair = rawCookie === undefined ? '' : rawCookie.split(';')[0]?.trim() ?? ''
  if (mode === 'expire' && url.pathname.startsWith('/expire/')) {
    // Each issued cookie is accepted exactly once on /expire/ paths; the
    // second attempt answers 401 so the gateway must re-mint.
    const uses = cookieUses.get(firstPair) ?? 0
    cookieUses.set(firstPair, uses + 1)
    if (firstPair === '' || uses >= 1) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('fixture: session expired')
      return
    }
  }
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      host: req.headers.host,
      cookie: rawCookie ?? null,
      cookieName: firstPair.split('=')[0] ?? '',
      xForwardedFor: req.headers['x-forwarded-for'] ?? null,
      xForwardedHost: req.headers['x-forwarded-host'] ?? null,
      xForwardedProto: req.headers['x-forwarded-proto'] ?? null,
      origin: req.headers.origin ?? null,
      referer: req.headers.referer ?? null,
      connection: req.headers.connection ?? null,
      body: chunks.length === 0 ? null : Buffer.concat(chunks).toString('utf8'),
      dshHome: process.env.DSH_HOME ?? null,
      fsFence: process.env.DSH_HOST_FS_FENCE ?? null,
      hasDeepseekKey: 'DEEPSEEK_API_KEY' in process.env,
      pid: process.pid,
    }))
  })
})

// The gateway claims the upstream's stream-mux upgrade path and splices the
// upgraded sockets to the browser. The fixture accepts the handshake on the
// same path and echoes raw bytes back, so tests can assert a live
// bidirectional stream without speaking real WebSocket framing.
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://gateway-fixture.invalid')
  if (url.pathname !== '/api/remote.mux') {
    socket.destroy()
    return
  }
  if (muxRejectNext) {
    // Armed over HTTP by the retry test: reject this handshake exactly once
    // so the gateway must re-mint the upstream cookie and retry the upgrade.
    muxRejectNext = false
    socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-type: text/plain\r\n\r\nfixture: mux session expired')
    socket.end()
    return
  }
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy()
    return
  }
  // Real accept-key derivation: sha1(key + GUID), base64. The client asserts it.
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ' + accept + '\r\n\r\n')
  if (head.length > 0) socket.write(head)
  const echo = (from, to) => {
    from.on('data', chunk => to.write(chunk))
    from.on('error', () => to.destroy())
    from.on('close', () => to.destroy())
  }
  echo(socket, socket)
  socket.on('error', () => socket.destroy())
})

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port
  if (home !== undefined) {
    writeFileSync(join(home, 'fixture.json'), JSON.stringify({ pid: process.pid, port: actual }))
  }
  const readyLine = () => {
    console.log(`dsh web: http://127.0.0.1:${String(actual)}/?token=tok-${String(process.pid)}`)
  }
  if (mode === 'silent') return
  if (mode === 'noisy') {
    // A separate chunk that ends the parse loop without a ready line, then
    // malformed ready-prefixed lines, then the real one.
    console.log('fake-dsh-web: starting up, nothing to see yet')
    setTimeout(() => {
      console.log('dsh web: ::not a url::')
      console.log('dsh web: http://127.0.0.1:99999/')
      console.log('dsh web: http://127.0.0.1/')
      readyLine()
    }, 30)
    return
  }
  const delay = mode === 'slow' ? 400 : 0
  setTimeout(readyLine, delay)
})
