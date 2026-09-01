import http, { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { createUpstreamAgent, proxyRequest } from '../src/proxy.ts'

/** JSON facts of one observed upstream request. */
type Seen = Record<string, unknown>

/** Start a JSON-echo upstream on an OS-assigned loopback port. */
function startUpstream(): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        cookie: req.headers.cookie ?? null,
        origin: req.headers.origin ?? null,
        referer: req.headers.referer ?? null,
        te: req.headers.te ?? null,
        connection: req.headers.connection ?? null,
        xForwardedFor: req.headers['x-forwarded-for'] ?? null,
        xForwardedHost: req.headers['x-forwarded-host'] ?? null,
        xForwardedProto: req.headers['x-forwarded-proto'] ?? null,
        body: chunks.length === 0 ? null : Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-custom': 'kept',
        'connection': 'keep-alive, x-hop-along',
        'x-hop-along': 'stripped',
        'set-cookie': 'upstream=value; Path=/',
      })
      res.write(JSON.stringify(seen.at(-1)))
      res.end()
    })
  })
  return listenOnFreePort(server, { server, port: 0, seen })
}

function startStatusUpstream(status: number): Promise<{ server: Server; port: number }> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'text/plain' })
    res.end('upstream status body')
  })
  return listenOnFreePort(server, { server, port: 0 })
}

function startStreamUpstream(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.write('chunk-1\n')
    setTimeout(() => {
      res.end('chunk-2\n')
    }, 50)
  })
  return listenOnFreePort(server, { server, port: 0 })
}

/** Start the client-side host whose handler proxies through proxyRequest. */
function startProxyHost(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<{ server: Server; port: number }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handler(req, res)
  })
  return listenOnFreePort(server, { server, port: 0 })
}

function listenOnFreePort<T>(server: Server, value: T): Promise<T & { port: number }> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ ...value, port: typeof address === 'object' && address !== null ? address.port : 0 })
    })
  })
}

describe('upstream proxying', () => {
  it('rewrites identity headers and strips hop-by-hop and upstream cookies', async () => {
    const upstream = await startUpstream()
    const agent = createUpstreamAgent()
    const host = await startProxyHost(async (req, res) => {
      await proxyRequest(req, res, { port: upstream.port, cookie: 'upstream=minted', agent })
    })
    try {
      const response = await fetch(`http://127.0.0.1:${String(host.port)}/some/path?with=query`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cookie': 'browser=side',
          'origin': 'https://gateway.example.com',
          'referer': 'https://gateway.example.com/page',
          'te': 'trailers',
          'x-custom': 'kept',
        },
        body: '{"payload":true}',
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('x-custom')).toBe('kept')
      expect(response.headers.get('x-hop-along')).toBeNull()
      expect(response.headers.get('set-cookie')).toBeNull()
      const body = await response.json() as Seen
      expect(body.method).toBe('POST')
      expect(body.url).toBe('/some/path?with=query')
      expect(body.host).toBe(`127.0.0.1:${String(upstream.port)}`)
      expect(body.cookie).toBe('upstream=minted')
      expect(body.origin).toBeNull()
      expect(body.referer).toBeNull()
      expect(body.te).toBeNull()
      expect(String(body.xForwardedFor)).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)/)
      expect(body.xForwardedHost).toBe(`127.0.0.1:${String(host.port)}`)
      expect(body.xForwardedProto).toBe('http')
      expect(body.body).toBe('{"payload":true}')
    } finally {
      host.server.close()
      upstream.server.close()
      agent.destroy()
    }
  })

  it('consumes a filtered status unanswered so the caller can retry', async () => {
    const upstream = await startStatusUpstream(503)
    const agent = createUpstreamAgent()
    let clientStatus = 0
    const host = await startProxyHost(async (req, res) => {
      const status = await proxyRequest(req, res, {
        port: upstream.port,
        cookie: undefined,
        agent,
        forwardStatus: candidate => candidate !== 503,
      })
      clientStatus = status
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ proxyObserved: status }))
      }
    })
    try {
      const response = await fetch(`http://127.0.0.1:${String(host.port)}/filtered`)
      expect(clientStatus).toBe(503)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ proxyObserved: 503 })
    } finally {
      host.server.close()
      upstream.server.close()
      agent.destroy()
    }
  })

  it('answers 502 when the upstream refuses the connection', async () => {
    const agent = createUpstreamAgent()
    const host = await startProxyHost(async (req, res) => {
      await proxyRequest(req, res, { port: 1, cookie: undefined, agent })
    })
    try {
      const response = await fetch(`http://127.0.0.1:${String(host.port)}/down`)
      expect(response.status).toBe(502)
      expect(await response.text()).toContain('upstream request failed')
    } finally {
      host.server.close()
      agent.destroy()
    }
  })

  it('streams chunked responses without buffering', async () => {
    const upstream = await startStreamUpstream()
    const agent = createUpstreamAgent()
    const host = await startProxyHost(async (req, res) => {
      await proxyRequest(req, res, { port: upstream.port, cookie: undefined, agent })
    })
    try {
      const response = await fetch(`http://127.0.0.1:${String(host.port)}/stream`)
      expect(response.status).toBe(200)
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      const first = await reader?.read()
      expect(decoder.decode(first?.value)).toBe('chunk-1\n')
      const second = await reader?.read()
      expect(decoder.decode(second?.value)).toBe('chunk-2\n')
      await reader?.cancel()
    } finally {
      host.server.close()
      upstream.server.close()
      agent.destroy()
    }
  })

  it('appends to a prior x-forwarded-for chain', async () => {
    const upstream = await startUpstream()
    const agent = createUpstreamAgent()
    const host = await startProxyHost(async (req, res) => {
      await proxyRequest(req, res, { port: upstream.port, cookie: undefined, agent })
    })
    try {
      const response = await fetch(`http://127.0.0.1:${String(host.port)}/chained`, {
        headers: { 'x-forwarded-for': '10.0.0.1' },
      })
      const body = await response.json() as Seen
      const chain = String(body.xForwardedFor).split(', ')
      expect(chain).toHaveLength(2)
      expect(chain[0]).toBe('10.0.0.1')
      expect(chain[1]).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)/)
    } finally {
      host.server.close()
      upstream.server.close()
      agent.destroy()
    }
  })

  it('forwards HTTP/1.0 requests that carry no Host header', async () => {
    const upstream = await startUpstream()
    const agent = createUpstreamAgent()
    const host = await startProxyHost(async (req, res) => {
      await proxyRequest(req, res, { port: upstream.port, cookie: undefined, agent })
    })
    try {
      const body = await rawHttpRequest(host.port, 'GET /legacy HTTP/1.0\r\n\r\n')
      expect(body.host).toBe(`127.0.0.1:${String(upstream.port)}`)
      expect(body.xForwardedHost).toBeNull()
      expect(body.xForwardedProto).toBe('http')
      expect(body.url).toBe('/legacy')
    } finally {
      host.server.close()
      upstream.server.close()
      agent.destroy()
    }
  })

  it('keeps end-to-end headers when the upstream lists no connection headers', async () => {
    const seen: Seen[] = []
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      seen.push({ connection: req.headers.connection ?? null, xCustom: req.headers['x-custom'] ?? null })
      res.writeHead(200, { 'content-type': 'text/plain', 'x-plain': 'yes' })
      res.end('plain')
    })
    const upstream = await listenOnFreePort(server, { server, port: 0, seen })
    const agent = createUpstreamAgent()
    const host = await startProxyHost(async (req, res) => {
      await proxyRequest(req, res, { port: upstream.port, cookie: undefined, agent })
    })
    try {
      const response = await fetch(`http://127.0.0.1:${String(host.port)}/plain`, {
        headers: { 'x-custom': 'kept' },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('x-plain')).toBe('yes')
      // The upstream agent adds its own connection header; the browser's is
      // always stripped as hop-by-hop either way.
      expect(seen[0]?.connection).toBe('keep-alive')
      expect(seen[0]?.xCustom).toBe('kept')
    } finally {
      host.server.close()
      upstream.server.close()
      agent.destroy()
    }
  })

  it('destroys the browser response when the upstream dies mid-body', async () => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('partial')
      setTimeout(() => {
        res.socket?.destroy()
      }, 40)
    })
    const upstream = await listenOnFreePort(server, { server, port: 0 })
    const agent = createUpstreamAgent()
    const host = await startProxyHost(async (req, res) => {
      await proxyRequest(req, res, { port: upstream.port, cookie: undefined, agent })
    })
    try {
      // fetch resolves on the headers; reading the body surfaces the reset.
      const response = await fetch(`http://127.0.0.1:${String(host.port)}/dying`)
      await expect(response.text()).rejects.toThrow()
    } finally {
      host.server.close()
      upstream.server.close()
      agent.destroy()
    }
  })

  it('stops proxying when the browser aborts a bodied request', async () => {
    const upstream = await startUpstream()
    const agent = createUpstreamAgent()
    const host = await startProxyHost(async (req, res) => {
      await proxyRequest(req, res, { port: upstream.port, cookie: undefined, agent })
    })
    try {
      const outcome = await new Promise<string>((resolve, reject) => {
        const client = http.request(
          { host: '127.0.0.1', port: host.port, method: 'POST', path: '/abort', headers: { 'content-length': '100' } },
          () =>{  resolve('answered') },
        )
        client.on('error', (error: Error) =>{  resolve(`aborted: ${error.message}`) })
        client.on('close', () =>{  resolve('closed') })
        // Abort only after the request reached the server, so the proxy is
        // mid-body when the browser side disappears.
        client.on('socket', (socket) => {
          socket.once('connect', () => {
            client.write('half')
            setTimeout(() => {
              client.destroy()
            }, 30)
          })
        })
        setTimeout(() =>{  reject(new Error('abort test hung')) }, 5_000)
      })
      expect(outcome).not.toBe('answered')
    } finally {
      host.server.close()
      upstream.server.close()
      agent.destroy()
    }
  })
})

/** Send one raw request and return the parsed JSON the echo upstream produced. */
async function rawHttpRequest(port: number, raw: string): Promise<Seen> {
  return await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      // Half-closing with the request would end an HTTP/1.0 connection
      // before the answer can be written; wait for the response instead.
      socket.write(raw)
    })
    const chunks: Buffer[] = []
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      socket.end()
    })
    socket.on('error', reject)
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const bodyStart = text.indexOf('\r\n\r\n')
      try {
        resolve(JSON.parse(text.slice(bodyStart + 4)) as Seen)
      } catch {
        reject(new Error(`no JSON body in raw response: ${text.slice(0, 200)}`))
      }
    })
  })
}
