/**
 * WebSocket upgrade proxying from the gateway fallback seat to one upstream
 * instance. The dsh web client streams over a WebSocket at an exact path, so
 * the gateway registers that path as an upgrade route, authenticates the
 * browser session, rewrites the handshake for the upstream's trust fence the
 * same way HTTP proxying does, and splices the two upgraded sockets together
 * so frames flow untouched in both directions. The launch-token/cookie
 * handshake stays server-side, exactly as for plain HTTP.
 * @module
 */

import http, { type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * Create the shared upstream agent for upgrade requests. Upgraded sockets
 * leave the agent's pool once spliced, so keep-alive pooling is irrelevant
 * here; the agent exists for symmetry and testability.
 * @returns the agent for upgrade requests.
 */
export function createUpgradeAgent(): http.Agent {
  return new http.Agent({ keepAlive: false })
}

/** Options for one proxied upgrade. */
export interface ProxyUpgradeOptions {
  /** Upstream loopback port. */
  port: number
  /** Upstream `Cookie` header value; undefined proxies the handshake without cookies. */
  cookie: string | undefined
  /** Agent for the upstream upgrade request. */
  agent: http.Agent
  /**
   * Called on every byte either spliced socket moves after the upgrade, so
   * the caller can keep the upstream idle timer honest during long-lived
   * WebSocket sessions.
   */
  onActivity?: () => void
}

/**
 * Proxy one WebSocket upgrade request to the loopback upstream and resolve
 * with the upstream HTTP status. On a 101 the upgraded sockets are spliced
 * bidirectionally and the promise resolves once the handshake is complete;
 * the streams then continue independent of the promise. The function never
 * rejects; the caller owns destroying the browser socket on non-101 answers
 * (the response was consumed without reaching the browser).
 * @param req - the browser upgrade request; headers are the handshake source.
 * @param browserSocket - the browser socket handed over by the webserver.
 * @param head - bytes read after the browser's upgrade request headers.
 * @param options - proxy target and activity reporting.
 * @returns the upstream status: 101 once spliced, or the rejection status.
 */
export function proxyUpgrade(
  req: IncomingMessage,
  browserSocket: Duplex,
  head: Buffer,
  options: ProxyUpgradeOptions,
): Promise<number> {
  return new Promise((resolve) => {
    const headers: Record<string, string | string[] | undefined> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase()
      // The upgrade pair is rebuilt below; browser identity headers are
      // dropped exactly as in HTTP proxying; cookies are reattached by the caller.
      if (lower === 'connection' || lower === 'upgrade' || lower === 'cookie'
        || lower === 'host' || lower === 'origin' || lower === 'referer') continue
      if (typeof value === 'string' || Array.isArray(value)) headers[name] = value
    }
    headers.host = `127.0.0.1:${String(options.port)}`
    headers.connection = 'Upgrade'
    headers.upgrade = typeof req.headers.upgrade === 'string' ? req.headers.upgrade : 'websocket'
    if (options.cookie !== undefined) headers.cookie = options.cookie
    const remoteAddress = req.socket.remoteAddress
    /* v8 ignore next 1 -- a connected TCP socket always carries a remote address; the guard exists for the type. */
    if (remoteAddress !== undefined) {
      headers['x-forwarded-for'] = typeof req.headers['x-forwarded-for'] === 'string'
        ? `${req.headers['x-forwarded-for']}, ${remoteAddress}`
        : remoteAddress
    }
    if (typeof req.headers.host === 'string') headers['x-forwarded-host'] = req.headers.host
    headers['x-forwarded-proto'] = 'http'

    let settled = false
    const settle = (status: number): void => {
      if (settled) return
      settled = true
      resolve(status)
    }

    const upstream = http.request(
      { host: '127.0.0.1', port: options.port, method: req.method, path: req.url, headers, agent: options.agent },
    )

    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      // Rebuild the 101 head for the browser from the upstream's raw headers,
      // dropping upstream cookies (the gateway owns upstream sessions).
      const lines: string[] = []
      const raw = upstreamResponse.rawHeaders
      for (let index = 0; index < raw.length; index += 2) {
        const name = raw[index] ?? ''
        if (name.toLowerCase() === 'set-cookie') continue
        const value = raw[index + 1] ?? ''
        lines.push(`${name}: ${value}`)
      }
      browserSocket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) browserSocket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)

      const relay = (from: Duplex, to: Duplex): void => {
        from.on('data', () => options.onActivity?.())
        from.pipe(to)
        const fail = (): void => {
          from.destroy()
          to.destroy()
        }
        from.on('error', fail)
        to.on('error', fail)
        from.on('close', () => to.destroy())
        to.on('close', () => from.destroy())
      }
      relay(upstreamSocket, browserSocket)
      relay(browserSocket, upstreamSocket)

      settle(101)
    })

    upstream.on('response', (upstreamResponse) => {
      // A non-upgrade answer (401, 426, 500, ...): consume it without letting
      // any byte reach the browser socket, then close the upstream exchange.
      void upstreamResponse // body is intentionally discarded
      upstreamResponse.destroy()
      upstream.destroy()
      settle(upstreamResponse.statusCode ?? 502)
    })

    upstream.on('error', () => {
      settle(502)
    })

    // A close without an upgrade, response, or error (e.g. the browser socket
    // died first and destroyed the request) must still settle the promise.
    upstream.on('close', () => {
      settle(502)
    })

    browserSocket.on('error', () => {
      upstream.destroy()
    })

    upstream.end()
  })
}
