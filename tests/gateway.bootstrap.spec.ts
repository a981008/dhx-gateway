import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Gateway from '../src/index.ts'
import { AccountStore } from '../src/store.ts'

const FIXTURE_PATH = join(import.meta.dirname, 'fixtures/fake-dsh-web.mjs')

interface GatewayConfig {
  stateRoot: string
  usersRoot?: string
  dshCommand: string[]
  startTimeoutMs: number
  printBootstrapInvite?: boolean
}

async function bootGateway(config: GatewayConfig): Promise<{ ctx: Context; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const fiber = ctx.plugin(Gateway, config)
  await fiber
  return { ctx, fiber: fiber as unknown as Awaited<ReturnType<Context['plugin']>> }
}

function tmpStateRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dshgw-boot-'))
}

describe('gateway bootstrap invite printing', () => {
  const logSpy = vi.spyOn(console, 'log')
  const disposers: Array<() => Promise<void>> = []

  afterEach(async () => {
    logSpy.mockClear()
    for (const dispose of disposers.splice(0).reverse()) await dispose()
  })

  it('stays silent when the config disables the bootstrap invite', async () => {
    const stateRoot = tmpStateRoot()
    const { fiber } = await bootGateway({
      stateRoot,
      dshCommand: [process.execPath, FIXTURE_PATH],
      startTimeoutMs: 10_000,
      printBootstrapInvite: false,
    })
    disposers.push(async () => { await fiber.dispose() })
    await vi.waitFor(() => {
      // The activation settled without printing anything.
      expect(logSpy.mock.calls.some(args => args.join(' ').includes('bootstrap invite'))).toBe(false)
    })
    // Nothing was created either: the flag suppresses the whole bootstrap block.
    const store = AccountStore.open(join(stateRoot, 'users.json'))
    expect(store.getInviteRows()).toHaveLength(0)
    expect(store.countUsers()).toBe(0)
  }, 15_000)

  it('prints no invite while accounts already exist', async () => {
    const stateRoot = tmpStateRoot()
    // A deployment with at least one account never needs the bootstrap invite.
    const store = AccountStore.open(join(stateRoot, 'users.json'))
    await store.acceptInvite(await store.createInvite({ bootstrap: true }), 'founder', 'founder-pass')
    const { fiber } = await bootGateway({
      stateRoot,
      dshCommand: [process.execPath, FIXTURE_PATH],
      startTimeoutMs: 10_000,
    })
    disposers.push(async () => { await fiber.dispose() })
    await vi.waitFor(() => {
      expect(logSpy.mock.calls.some(args => args.join(' ').includes('bootstrap invite'))).toBe(false)
    })
  }, 15_000)

  it('warns through the logger when the invite cannot be printed', async () => {
    const stateRoot = tmpStateRoot()
    const { ctx, fiber } = await bootGateway({
      stateRoot,
      dshCommand: [process.execPath, FIXTURE_PATH],
      startTimeoutMs: 10_000,
    })
    disposers.push(async () => { await fiber.dispose() })
    const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    logSpy.mockImplementationOnce(() => {
      throw new Error('console is broken')
    })
    // The printed line races the activation; force a retry by waiting for the warn.
    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('could not print the bootstrap invite'),
        expect.stringContaining('console is broken'),
      )
    }, { timeout: 5_000 })
    warnSpy.mockRestore()
  }, 15_000)
})
