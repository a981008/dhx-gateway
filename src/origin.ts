/**
 * Display-origin derivation for invite links. The gateway must print
 * shareable invite URLs, but the address members actually use is a
 * deployment fact no single component owns, so derivation is layered:
 * explicit `publicOrigin` wins; a request-aware context derives from its
 * Host header; a context-free startup print enumerates the machine's own
 * non-internal IPv4 addresses. Every layer degrades honestly instead of
 * inventing a wrong-but-confident address.
 * @module
 */

import { readFileSync } from 'node:fs'
import os from 'node:os'
import type { IncomingMessage } from 'node:http'

/**
 * The interface name holding the default route, when the platform exposes
 * it. Only Linux's /proc/net/route is read; everywhere else the answer is
 * undefined and candidates keep enumeration order.
 * @param routeFile - the routing table to read; overridable for tests.
 * @returns the default-route interface name, or undefined when unknown.
 */
export function defaultRouteInterface(routeFile = '/proc/net/route'): string | undefined {
  try {
    const lines = readFileSync(routeFile, 'utf8').split('\n')
    for (const line of lines.slice(1)) {
      const columns = line.trim().split(/\s+/)
      if (columns[1] === '00000000' && columns[0] !== undefined) return columns[0]
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Enumerate the machine's candidate display origins: every non-internal
 * IPv4 interface address, best-first (default-route interface before the
 * rest, otherwise enumeration order), with loopback always last so a
 * same-machine test remains available. The first candidate is the single
 * best guess; the rest exist so an operator never has to guess why the
 * printed link does not match their addressing.
 * @param port - the gateway's listening port.
 * @param options - injectable inputs for tests.
 * @param options.interfaces - interface table; defaults to os.networkInterfaces().
 * @param options.defaultIface - default-route interface name; defaults to detection.
 * @returns candidate http origins, best first, loopback last.
 */
export function localInterfaceOrigins(
  port: number,
  options: {
    interfaces?: ReturnType<typeof os.networkInterfaces>
    defaultIface?: string | undefined
  } = {},
): string[] {
  const interfaces = options.interfaces ?? os.networkInterfaces()
  const defaultIface = options.defaultIface ?? defaultRouteInterface()
  const byInterface = new Map<string, string[]>()
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.internal) continue
      if (String(address.family) !== 'IPv4') continue
      const list = byInterface.get(name) ?? []
      list.push(address.address)
      byInterface.set(name, list)
    }
  }
  const names = [...byInterface.keys()]
  names.sort((left, right) => (left === defaultIface ? -1 : right === defaultIface ? 1 : 0))
  const origins = names.flatMap(name => (byInterface.get(name) ?? []).map(address => `http://${address}:${String(port)}`))
  origins.push(`http://127.0.0.1:${String(port)}`)
  return origins
}

/**
 * Derive the display origin from an incoming request's Host header. Only
 * Host is trusted: forwarded headers are client-spoofable without a
 * trusted-proxy declaration, and the deployment shape where the proxy
 * rewrites Host (TLS termination) is exactly the case `publicOrigin`
 * exists to declare.
 * @param req - the incoming request.
 * @param fallbackPort - gateway port used when no usable Host is present.
 * @returns the http origin matching how this request was addressed.
 */
export function requestOrigin(req: IncomingMessage, fallbackPort: number): string {
  const host = req.headers.host
  return `http://${typeof host === 'string' && host !== '' ? host : `127.0.0.1:${String(fallbackPort)}`}`
}
