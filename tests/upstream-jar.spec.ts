import { createServer, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { mintUpstreamSession, UpstreamCookieJar } from '../src/upstream-jar.ts'

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

describe('upstream cookie jar', () => {
  it('scopes entries to the upstream port and clears on demand', () => {
    const jar = new UpstreamCookieJar()
    expect(jar.get('sid', 4000)).toBeUndefined()
    jar.set('sid', 'a=1', 4000)
    expect(jar.get('sid', 4000)).toBe('a=1')
    // A restarted instance listens on a new port: the entry is stale.
    expect(jar.get('sid', 4001)).toBeUndefined()
    jar.set('sid', 'a=2', 4001)
    expect(jar.get('sid', 4001)).toBe('a=2')
    jar.clear('sid')
    expect(jar.get('sid', 4001)).toBeUndefined()
    jar.set('sid', 'a=3', 4001)
    jar.set('other', 'b=1', 4001)
    jar.clearAll()
    expect(jar.get('sid', 4001)).toBeUndefined()
    expect(jar.get('other', 4001)).toBeUndefined()
  })
})

describe('upstream token exchange', () => {
  it('joins every set-cookie pair of the redirect answer', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(303, {
        'set-cookie': ['a=1; Path=/', 'b=2; HttpOnly'],
      })
      res.end()
    })
    const port = await listen(server)
    try {
      expect(await mintUpstreamSession({ port, token: 'tok' })).toBe('a=1; b=2')
    } finally {
      server.close()
    }
  })

  it('fails when the upstream refuses the token exchange', async () => {
    await expect(mintUpstreamSession({ port: 1, token: 'tok' })).rejects.toThrow(/upstream token exchange failed/)
  })

  it('fails when the exchange answers a non-redirect status', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('not a redirect')
    })
    const port = await listen(server)
    try {
      await expect(mintUpstreamSession({ port, token: 'tok' })).rejects.toThrow(/answered 200 instead of 303/)
    } finally {
      server.close()
    }
  })

  it('fails when the redirect carries no session cookie', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(303, { location: '/' })
      res.end()
    })
    const port = await listen(server)
    try {
      await expect(mintUpstreamSession({ port, token: 'tok' })).rejects.toThrow(/without a session cookie/)
    } finally {
      server.close()
    }
  })
})
