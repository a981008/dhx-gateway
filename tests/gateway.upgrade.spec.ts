import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as Gateway from '../src/index.ts'

const FIXTURE_PATH = join(import.meta.dirname, 'fixtures/fake-dsh-web.mjs')
const MUX_PATH = '/api/remote.mux'

interface FixtureFacts {
  pid: number
  port: number
}

/** Cookie jar the tests use like a browser would. */
class Browser {
  #cookie: string | undefined

  get cookieHeader(): Record<string, string> {
    return this.#cookie === undefined ? {} : { cookie: this.#cookie }
  }

  absorb(response: Response): void {
    const setCookie = response.headers.getSetCookie()
    for (const header of setCookie) {
      const pair = header.split(';', 1)[0] ?? ''
      if (pair.startsWith('dhxgw_session=')) this.#cookie = pair
      if (pair.startsWith('dhxgw_session=;')) this.#cookie = undefined
    }
  }
}

async function formPost(origin: string, path: string, fields: Record<string, string>, browser?: Browser): Promise<Response> {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...browser?.cookieHeader,
    },
    body: new URLSearchParams(fields).toString(),
  })
  browser?.absorb(response)
  return response
}

interface HandshakeResult {
  statusLine: string
  headers: Record<string, string>
  socket: Socket
  rest: string
}

/** Perform one raw WebSocket handshake against the gateway and return the socket. */
function handshake(origin: string, browser: Browser | undefined, key: string): Promise<HandshakeResult> {
  return new Promise((resolveHandshake, rejectHandshake) => {
    const url = new URL(origin)
    const socket: Socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
      const request = [
        `GET ${MUX_PATH} HTTP/1.1`,
        `Host: ${url.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        ...(browser === undefined ? [] : Object.entries(browser.cookieHeader).map(([name, value]) => `${name}: ${value}`)),
        '\r\n',
      ].join('\r\n')
      socket.write(request)
    })
    let buffered = ''
    const fail = (error: Error): void => {
      socket.destroy()
      rejectHandshake(error)
    }
    socket.setTimeout(10_000, () => fail(new Error('handshake timeout')))
    socket.on('error', fail)
    // A destroyed socket closes without any data: report it as a rejected
    // handshake (the gateway answers nothing and closes) rather than hanging.
    socket.on('close', () => {
      if (buffered === '') {
        rejectHandshake(new Error('socket closed without a response (rejected)'))
        return
      }
      // Close after headers were parsed is fine; the data handler owns the rest.
    })
    socket.on('data', function onData(chunk) {
      buffered += chunk.toString('utf8')
      const end = buffered.indexOf('\r\n\r\n')
      if (end === -1) return
      const head = buffered.slice(0, end)
      const rest = buffered.slice(end + 4)
      const [statusLine = '', ...headerLines] = head.split('\r\n')
      const headers: Record<string, string> = {}
      for (const line of headerLines) {
        const colon = line.indexOf(':')
        if (colon === -1) continue
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      socket.off('data', onData)
      socket.setTimeout(0)
      resolveHandshake({ statusLine: statusLine ?? '', headers, socket, rest })
    })
  })
}

/** Exchange raw bytes over the spliced stream: send, then await the echo. */
async function roundTrip(socket: Socket, payload: string): Promise<string> {
  return new Promise((resolveRoundTrip, rejectRoundTrip) => {
    const timer = setTimeout(() => {
      socket.destroy()
      rejectRoundTrip(new Error('round-trip timeout'))
    }, 10_000)
    socket.once('data', (chunk: Buffer) => {
      clearTimeout(timer)
      resolveRoundTrip(chunk.toString('utf8'))
    })
    socket.once('error', (error: Error) => {
      clearTimeout(timer)
      rejectRoundTrip(error)
    })
    socket.write(payload)
  })
}

describe('gateway WebSocket upgrade proxying', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'dshgw-ws-state-'))
  const usersRoot = join(stateRoot, 'users')
  const logSpy = vi.spyOn(console, 'log')
  let ctx: Context | undefined
  let origin: string
  const admin = new Browser()

  async function bootComposition(): Promise<void> {
    const configPath = join(stateRoot, 'cordis.yml')
    const config = [
      '- name: cordis:test-webserver',
      '  config:',
      '    host: 127.0.0.1',
      '    port: 0',
      '- name: cordis:test-dhx-gateway',
      '  config:',
      `    stateRoot: ${JSON.stringify(stateRoot)}`,
      `    usersRoot: ${JSON.stringify(usersRoot)}`,
      `    dshCommand: [${JSON.stringify(process.execPath)}, ${JSON.stringify(FIXTURE_PATH)}]`,
      '    startTimeoutMs: 10000',
    ].join('\n')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(configPath, config)
    ctx = await boot('dhx-gateway-test', configPath, undefined, (bootContext) => {
      bootContext.loader.builtins['test-webserver'] = WebServer
      bootContext.loader.builtins['test-dhx-gateway'] = Gateway
    })
    origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  }

  beforeAll(async () => {
    await bootComposition()
    // Create the admin account through the bootstrap invite. The invite line
    // prints asynchronously after apply(), so wait for it before reading.
    let invitePath = ''
    await vi.waitFor(() => {
      const line = logSpy.mock.calls.map(args => args.join(' ')).find(text => text.includes('bootstrap invite'))
      expect(line).toBeDefined()
      invitePath = new URL(line?.split(' ').at(-1) as string).pathname
    }, { timeout: 10_000 })
    const accepted = await formPost(origin, invitePath, { username: 'root', password: 'root-password' }, admin)
    expect(accepted.status).toBe(303)
  }, 30_000)

  afterAll(async () => {
    delete process.env.FAKE_MODE
    logSpy.mockRestore()
    await ctx?.fiber.dispose()
    ctx = undefined
  })

  it('destroys the socket when the browser session is unauthenticated', async () => {
    await expect(handshake(origin, undefined, 'unauth-key=='))
      .rejects.toThrow('socket closed without a response')
  })

  it('splices an authenticated upgrade to the upstream with rewritten headers and a live echo stream', async () => {
    const key = 'dGhlIHNhbXBsZSBub25jZQ==' // RFC 6455 sample key
    const result = await handshake(origin, admin, key)
    expect(result.statusLine).toBe('HTTP/1.1 101 Switching Protocols')
    expect(result.headers['upgrade']).toBe('websocket')
    expect(result.headers['connection']).toBe('Upgrade')
    // The accept key the fixture derived from our key proves the handshake
    // reached the upstream and was answered there, not fabricated by the gateway.
    expect(result.headers['sec-websocket-accept'])
      .toBe(createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64'))
    expect(await roundTrip(result.socket, 'frame-one')).toBe('frame-one')
    expect(await roundTrip(result.socket, 'frame-two')).toBe('frame-two')
    // The spliced stream is bidirectional: bytes sent by the upstream (echo)
    // keep flowing after the first round trip, and the socket is still open.
    expect(result.socket.destroyed).toBe(false)
    // The instance the upgrade was spliced to is the user's own upstream.
    const facts = JSON.parse(readFileSync(join(usersRoot, 'root', 'home', 'fixture.json'), 'utf8')) as FixtureFacts
    expect(() => process.kill(facts.pid, 0)).not.toThrow()
    result.socket.destroy()
  })

  it('re-mints the upstream cookie and retries once when the upstream rejects the first handshake', async () => {
    // Arm the fixture's one-shot 401 through the plain HTTP fallback: this
    // request itself reuses the jarred cookie, the NEXT upgrade handshake is
    // rejected, and the gateway must re-mint and retry invisibly.
    const armed = await fetch(`${origin}/__mux_arm_401`, { headers: admin.cookieHeader })
    expect(armed.status).toBe(200)
    const first = await handshake(origin, admin, 'retry-key-1==')
    expect(first.statusLine).toBe('HTTP/1.1 101 Switching Protocols')
    expect(await roundTrip(first.socket, 'after-retry')).toBe('after-retry')
    // The jar now holds the re-minted cookie; a second upgrade succeeds immediately.
    const second = await handshake(origin, admin, 'retry-key-2==')
    expect(second.statusLine).toBe('HTTP/1.1 101 Switching Protocols')
    second.socket.destroy()
  })
})
