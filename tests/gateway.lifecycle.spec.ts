import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import * as Gateway from '../src/index.ts'

const FIXTURE_PATH = join(import.meta.dirname, 'fixtures/fake-dsh-web.mjs')

const stateRoot = mkdtempSync(join(tmpdir(), 'dshgw-hmr-'))

const gatewayConfig = {
  stateRoot,
  usersRoot: join(stateRoot, 'users'),
  dshCommand: [process.execPath, FIXTURE_PATH],
  startTimeoutMs: 10_000,
}

describe('gateway route and disposal lifecycle', () => {
  it('claims routes and the fallback seat, releases them on fiber disposal, and releases the seat for reuse', async () => {
    const ctx = new Context()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const fiber = ctx.plugin(Gateway, gatewayConfig)
    await fiber
    const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`

    const before = await fetch(`${origin}/`, { redirect: 'manual' })
    expect(before.status).toBe(303)
    const login = await fetch(`${origin}/login`)
    expect(login.status).toBe(200)
    const inviteMissing = await fetch(`${origin}/invite`, { redirect: 'manual' })
    expect(inviteMissing.status).toBe(404)

    await fiber.dispose()

    // The fallback seat is free again: a second claim must not throw.
    expect(() => ctx.webServer.registerFallback((_req, res) => {
      res.writeHead(404)
      res.end()
    })).not.toThrow()
    // Named gateway routes are gone: /login now falls through to the new
    // fallback handler.
    const after = await fetch(`${origin}/login`)
    expect(after.status).toBe(404)
  }, 20_000)
})
