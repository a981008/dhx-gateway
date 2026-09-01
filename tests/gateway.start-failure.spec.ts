import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as Gateway from '../src/index.ts'

const FIXTURE_PATH = join(import.meta.dirname, 'fixtures/fake-dsh-web.mjs')

class Browser {
  #cookie: string | undefined

  get cookieHeader(): Record<string, string> {
    return this.#cookie === undefined ? {} : { cookie: this.#cookie }
  }

  absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0] ?? ''
      if (pair.startsWith('dhxgw_session=')) this.#cookie = pair
      if (pair.startsWith('dhxgw_session=;')) this.#cookie = undefined
    }
  }
}

/**
 * A deployment whose upstream command exits before the ready line: the
 * gateway still boots and serves its routes, but every fallback proxy
 * attempt answers 503 with the supervisor's failure reason.
 */
describe('gateway when the upstream cannot start', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'dshgw-start-fail-'))
  const logSpy = vi.spyOn(console, 'log')
  let ctx: Context | undefined
  let origin: string
  const admin = new Browser()

  beforeAll(async () => {
    process.env.FAKE_MODE = 'crash'
    const configPath = join(stateRoot, 'cordis.yml')
    const config = [
      '- name: cordis:test-webserver',
      '  config:',
      '    host: 127.0.0.1',
      '    port: 0',
      '- name: cordis:test-dhx-gateway',
      '  config:',
      `    stateRoot: ${JSON.stringify(stateRoot)}`,
      `    dshCommand: [${JSON.stringify(process.execPath)}, ${JSON.stringify(FIXTURE_PATH)}]`,
      '    startTimeoutMs: 5000',
    ].join('\n')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(configPath, config)
    ctx = await boot('dhx-gateway-start-failure-test', configPath, undefined, (bootContext) => {
      bootContext.loader.builtins['test-webserver'] = WebServer
      bootContext.loader.builtins['test-dhx-gateway'] = Gateway
    })
    origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  }, 30_000)

  afterAll(async () => {
    delete process.env.FAKE_MODE
    logSpy.mockRestore()
    await ctx?.fiber.dispose()
  })

  it('creates the administrator through the bootstrap invite', async () => {
    // The invite print is fire-and-forget; give it its microtasks.
    const line = await vi.waitFor(() => {
      const found = logSpy.mock.calls.map(args => args.join(' ')).find(text => text.includes('bootstrap invite'))
      if (found === undefined) throw new Error('bootstrap invite not printed yet')
      return found
    })
    const invitePath = new URL(line.split(' ').at(-1) as string).pathname
    const accepted = await fetch(`${origin}${invitePath}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'root', password: 'root-password' }).toString(),
    })
    expect(accepted.status).toBe(303)
    admin.absorb(accepted)
  })

  it('answers 503 with the start failure when the workspace cannot start', async () => {
    const response = await fetch(`${origin}/workspace`, { headers: admin.cookieHeader, redirect: 'manual' })
    expect(response.status).toBe(503)
    const text = await response.text()
    expect(text).toContain('上游不可用')
    expect(text).toContain('exited before its ready URL line')
  })
})
