/**
 * HTTP proxying from the gateway fallback seat to one upstream instance.
 * Requests are rewritten for the upstream's trust fence (Host becomes the
 * loopback authority, browser-origin headers are dropped, forwarding facts
 * are added) and both directions stream without buffering, so the upstream's
 * event streams pass through untouched. Hop-by-hop headers are stripped in
 * both directions, upstream `Set-Cookie` headers are swallowed because the
 * gateway owns the upstream session, and the gateway's own cookie never
 * reaches the upstream.
 * @module
 */

import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'

const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Create the shared upstream agent. Keep-alive avoids a fresh TCP handshake
 * per request against the loopback upstream; the caller destroys it on
 * gateway disposal.
 * @returns the shared keep-alive agent for upstream requests.
 */
export function createUpstreamAgent(): http.Agent {
  return new http.Agent({ keepAlive: true })
}

type HeaderTable = Record<string, string | string[] | undefined>

function connectionListedHeaders(headers: IncomingHttpHeaders): ReadonlySet<string> {
  const raw = headers.connection
  return new Set(typeof raw === 'string'
    ? raw.split(',').map(name => name.trim().toLowerCase()).filter(name => name !== '')
    : new Set<string>())
}

function stripHopByHop(headers: IncomingHttpHeaders): HeaderTable {
  const connection = connectionListedHeaders(headers)
  const out: HeaderTable = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || connection.has(lower) || lower === 'set-cookie') continue
    out[name] = value
  }
  return out
}

/** Options for one proxied request. */
export interface ProxyRequestOptions {
  /** Upstream loopback port. */
  port: number
  /** Upstream `Cookie` header value; undefined proxies the request without cookies. */
  cookie: string | undefined
  /** Shared upstream agent. */
  agent: http.Agent
  /**
   * Whether the upstream response may reach the caller's response. A false
   * verdict consumes the upstream response unanswered and resolves with its
   * status, letting the caller retry (401 re-authentication) before anything
   * reaches the browser; omission always forwards.
   */
  forwardStatus?: (status: number) => boolean
}

/**
 * Proxy one request to the loopback upstream and resolve with the upstream
 * status. Transport failures answer 502 when the response has not started and
 * destroy it afterwards; the function never rejects, so the fallback route
 * keeps a single response-owner per request.
 * @param req - the browser request; its body streams to the upstream.
 * @param res - the browser response owned for the request's lifetime.
 * @param options - proxy target and forwarding policy.
 * @returns the upstream status, or 0 when transport failed after the headers left.
 */
export function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyRequestOptions,
): Promise<number> {
  return new Promise((resolve) => {
    const connection = connectionListedHeaders(req.headers)
    const headers: HeaderTable = {}
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase()
      if (HOP_BY_HOP_HEADERS.has(lower) || connection.has(lower)) continue
      if (lower === 'cookie' || lower === 'host' || lower === 'origin' || lower === 'referer') continue
      headers[name] = value
    }
    headers.host = `127.0.0.1:${String(options.port)}`
    if (options.cookie !== undefined) headers.cookie = options.cookie
    const remoteAddress = req.socket.remoteAddress
    const priorForwarded = req.headers['x-forwarded-for']
    /* v8 ignore next 1 -- a connected TCP socket always carries a remote address; the guard exists for the type. */
    if (remoteAddress !== undefined) {
      headers['x-forwarded-for'] = typeof priorForwarded === 'string'
        ? `${priorForwarded}, ${remoteAddress}`
        : remoteAddress
    }
    if (typeof req.headers.host === 'string') headers['x-forwarded-host'] = req.headers.host
    // TLS terminates at the reverse proxy in front of the gateway; the
    // webserver here always serves plain HTTP.
    headers['x-forwarded-proto'] = 'http'

    const upstream = http.request(
      { host: '127.0.0.1', port: options.port, method: req.method, path: req.url, headers, agent: options.agent },
      (upstreamResponse) => {
        /* v8 ignore next 1 -- a parsed upstream response always carries a status; the fallback keeps the resolution a number. */
        const status = upstreamResponse.statusCode ?? 502
        if (options.forwardStatus !== undefined && !options.forwardStatus(status)) {
          upstreamResponse.destroy()
          upstream.destroy()
          resolve(status)
          return
        }
        res.writeHead(status, stripHopByHop(upstreamResponse.headers))
        upstreamResponse.pipe(res)
        upstreamResponse.on('end', () =>{  resolve(status) })
        upstreamResponse.on('close', () =>{  resolve(status) })
        upstreamResponse.on('error', () => {
          res.destroy()
          resolve(status)
        })
      },
    )
    upstream.on('error', () => {
      // Request-level transport failures after a response began surface on the
      // response (handled above); this arm guards earlier socket errors that
      // raced past the sent headers.
      /* v8 ignore next 5 -- unreachable through node:http's error surface. */
      if (res.headersSent) {
        res.destroy()
        resolve(0)
        return
      }
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dhx-gateway: the upstream request failed')
      resolve(502)
    })
    req.on('error', () => upstream.destroy())
    req.pipe(upstream)
  })
}
