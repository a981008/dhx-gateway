import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { defaultRouteInterface, localInterfaceOrigins, requestOrigin } from '../src/origin.ts'
import type { IncomingMessage } from 'node:http'

const eth0 = { address: '192.168.10.19', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo
const docker = { address: '172.17.0.1', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo
const v6 = { address: 'fe80::1', family: 'IPv6', internal: false } as os.NetworkInterfaceInfo
const loop = { address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo

describe('display-origin derivation', () => {
  it('lists non-internal IPv4 addresses best-first with loopback last', () => {
    const origins = localInterfaceOrigins(8080, {
      interfaces: { lo: [loop], eth0: [eth0], 'docker0': [docker], eth0v6: [v6] },
      defaultIface: 'docker0',
    })
    // The declared default-route interface outranks the others; internal and
    // IPv6 addresses are excluded; loopback is always the last resort.
    expect(origins).toEqual([
      'http://172.17.0.1:8080',
      'http://192.168.10.19:8080',
      'http://127.0.0.1:8080',
    ])
  })

  it('keeps enumeration order when no default-route interface is known', () => {
    const origins = localInterfaceOrigins(8080, {
      interfaces: { eth0: [eth0], 'docker0': [docker] },
      defaultIface: undefined,
    })
    expect(origins).toEqual([
      'http://192.168.10.19:8080',
      'http://172.17.0.1:8080',
      'http://127.0.0.1:8080',
    ])
  })

  it('degrades to loopback only on a machine with no non-internal address', () => {
    expect(localInterfaceOrigins(8080, { interfaces: { lo: [loop] }, defaultIface: undefined }))
      .toEqual(['http://127.0.0.1:8080'])
  })

  it('parses the Linux default-route interface, tolerating absence', () => {
    expect(defaultRouteInterface('/nonexistent/route/file')).toBeUndefined()
  })

  it('derives the request origin from Host and falls back to loopback', () => {
    const withHost = { headers: { host: '192.168.10.19:8080' } } as unknown as IncomingMessage
    expect(requestOrigin(withHost, 8080)).toBe('http://192.168.10.19:8080')
    const emptyHost = { headers: { host: '' } } as unknown as IncomingMessage
    expect(requestOrigin(emptyHost, 8080)).toBe('http://127.0.0.1:8080')
    const noHost = { headers: {} } as unknown as IncomingMessage
    expect(requestOrigin(noHost, 8080)).toBe('http://127.0.0.1:8080')
  })
})
