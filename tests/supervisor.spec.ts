import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { InstanceSupervisor, StartError, type StartErrorCode } from '../src/supervisor.ts'

const FIXTURE_PATH = join(import.meta.dirname, 'fixtures/fake-dsh-web.mjs')

type SupervisorOptions = ConstructorParameters<typeof InstanceSupervisor>[0]

function options(overrides: Partial<SupervisorOptions> = {}): SupervisorOptions {
  return {
    dshCommand: [process.execPath, FIXTURE_PATH],
    usersRoot: mkdtempSync(join(tmpdir(), 'dshgw-super-')),
    startTimeoutMs: 5_000,
    idleStopMinutes: undefined,
    log: () => {},
    ...overrides,
  }
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function startErrorOf(run: () => Promise<unknown>): Promise<StartErrorCode> {
  try {
    await run()
  } catch (error) {
    if (error instanceof StartError) return error.code
    throw error
  }
  throw new Error('expected the start to reject with StartError')
}

describe('upstream instance supervisor', () => {
  it('starts one instance per user from the ready URL line and reuses it', async () => {
    const supervisor = new InstanceSupervisor(options())
    try {
      const first = await supervisor.ensureEndpoint('alice')
      expect(first.port).toBeGreaterThan(0)
      expect(first.token).toMatch(/^tok-\d+$/)
      expect(supervisor.isRunning('alice')).toBe(true)
      const second = await supervisor.ensureEndpoint('alice')
      expect(second).toEqual(first)
      // The child saw its per-user DSH_HOME and wrote its facts there.
      const fixture = JSON.parse(readFileSync(join(supervisor.homeDirectory('alice'), 'fixture.json'), 'utf8')) as { pid: number; port: number }
      expect(fixture.port).toBe(first.port)
      const response = await fetch(`http://127.0.0.1:${String(first.port)}/probe`)
      const body = await response.json() as { path: string; dshHome: string; fsFence: string }
      expect(body.path).toBe('/probe')
      expect(body.dshHome).toBe(supervisor.homeDirectory('alice'))
      // The child's filesystem fence is the user's own subtree root.
      expect(body.fsFence).toBe(supervisor.options.usersRoot + '/alice')
    } finally {
      await supervisor.dispose()
    }
  })

  it('strips operator secrets from the child environment', async () => {
    process.env.DEEPSEEK_API_KEY = 'operator-secret'
    process.env.DEEPSEEK_BASE_URL = 'https://operator-proxy.invalid'
    const supervisor = new InstanceSupervisor(options())
    try {
      const endpoint = await supervisor.ensureEndpoint('bob')
      const response = await fetch(`http://127.0.0.1:${String(endpoint.port)}/env`)
      const body = await response.json() as { hasDeepseekKey: boolean; dshHome: string }
      expect(body.hasDeepseekKey).toBe(false)
      expect(body.dshHome).toBe(supervisor.homeDirectory('bob'))
    } finally {
      delete process.env.DEEPSEEK_API_KEY
      delete process.env.DEEPSEEK_BASE_URL
      await supervisor.dispose()
    }
  })

  it('stops the child on dispose and reports it not running', async () => {
    const supervisor = new InstanceSupervisor(options())
    const endpoint = await supervisor.ensureEndpoint('carol')
    const fixture = JSON.parse(readFileSync(join(supervisor.homeDirectory('carol'), 'fixture.json'), 'utf8')) as { pid: number }
    const [row] = supervisor.runningRows()
    expect(row?.user).toBe('carol')
    expect(row?.port).toBe(endpoint.port)
    expect(row?.startedAtMs).toBeTypeOf('number')
    expect(row?.lastActivityMs).toBeTypeOf('number')
    await supervisor.dispose()
    expect(supervisor.isRunning('carol')).toBe(false)
    await waitFor(() => {
      try {
        process.kill(fixture.pid, 0)
        return false
      } catch {
        return true
      }
    }, 'child process exit')
  })

  it('times out when the child never prints the ready line', async () => {
    const supervisor = new InstanceSupervisor(options({
      startTimeoutMs: 300,
      dshCommand: [process.execPath, FIXTURE_PATH],
    }))
    process.env.FAKE_MODE = 'silent'
    try {
      expect(await startErrorOf(() => supervisor.ensureEndpoint('silent'))).toBe('start-timeout')
      await waitFor(() => !supervisor.isRunning('silent'), 'supervisor entry release after the timeout kill')
    } finally {
      delete process.env.FAKE_MODE
      await supervisor.dispose()
    }
  })

  it('reports exit before ready and applies the crash cooldown', async () => {
    process.env.FAKE_MODE = 'crash'
    const supervisor = new InstanceSupervisor(options({ startTimeoutMs: 2_000 }))
    try {
      expect(await startErrorOf(() => supervisor.ensureEndpoint('crasher'))).toBe('upstream-exited')
      expect(await startErrorOf(() => supervisor.ensureEndpoint('crasher'))).toBe('start-cooldown')
    } finally {
      delete process.env.FAKE_MODE
      await supervisor.dispose()
    }
  })

  it('fails loudly when the command cannot spawn', async () => {
    const supervisor = new InstanceSupervisor(options({ dshCommand: ['/nonexistent/dsh-binary'] }))
    try {
      expect(await startErrorOf(() => supervisor.ensureEndpoint('spawnless'))).toBe('spawn-failed')
    } finally {
      await supervisor.dispose()
    }
  })

  it('stops instances after the idle window and restarts on demand', async () => {
    const supervisor = new InstanceSupervisor(options({ idleStopMinutes: 0.005 }))
    try {
      const first = await supervisor.ensureEndpoint('idle-user')
      await waitFor(() => !supervisor.isRunning('idle-user'), 'idle stop')
      const second = await supervisor.ensureEndpoint('idle-user')
      expect(second.port).toBeGreaterThan(0)
      expect(second.token).not.toBe(first.token)
    } finally {
      await supervisor.dispose()
    }
  })

  it('coalesces concurrent starts into one instance', async () => {
    const supervisor = new InstanceSupervisor(options())
    try {
      const [first, second] = await Promise.all([
        supervisor.ensureEndpoint('twin'),
        supervisor.ensureEndpoint('twin'),
      ])
      expect(second).toEqual(first)
      expect(supervisor.runningRows()).toHaveLength(1)
    } finally {
      await supervisor.dispose()
    }
  })

  it('ignores activity touches for unknown users', async () => {
    const supervisor = new InstanceSupervisor(options())
    try {
      expect(() =>{  supervisor.touch('ghost') }).not.toThrow()
    } finally {
      await supervisor.dispose()
    }
  })

  it('rejects starts when per-user directories cannot be created', async () => {
    if (process.platform === 'win32') return
    const parent = mkdtempSync(join(tmpdir(), 'dshgw-readonly-'))
    chmodSync(parent, 0o500)
    try {
      const supervisor = new InstanceSupervisor(options({ usersRoot: join(parent, 'users') }))
      expect(await startErrorOf(() => supervisor.ensureEndpoint('boxed'))).toBe('spawn-failed')
      await supervisor.dispose()
    } finally {
      chmodSync(parent, 0o700)
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('rejects starts whose command is empty', async () => {
    const supervisor = new InstanceSupervisor(options({ dshCommand: [''] }))
    try {
      expect(await startErrorOf(() => supervisor.ensureEndpoint('empty-cmd'))).toBe('spawn-failed')
    } finally {
      await supervisor.dispose()
    }
  })

  it('finds the ready line among unrelated and malformed output', async () => {
    process.env.FAKE_MODE = 'noisy'
    const supervisor = new InstanceSupervisor(options({ startTimeoutMs: 5_000 }))
    try {
      const endpoint = await supervisor.ensureEndpoint('noisy')
      expect(endpoint.token).toMatch(/^tok-\d+$/)
      expect(endpoint.port).toBeGreaterThan(0)
    } finally {
      delete process.env.FAKE_MODE
      await supervisor.dispose()
    }
  })

  it('escalates to SIGKILL when the upstream ignores SIGTERM', async () => {
    process.env.FAKE_MODE = 'stubborn'
    const supervisor = new InstanceSupervisor(options())
    try {
      await supervisor.ensureEndpoint('stubborn')
      const stopped = supervisor.stop('stubborn')
      await expect(stopped).resolves.toBeUndefined()
      expect(supervisor.isRunning('stubborn')).toBe(false)
    } finally {
      delete process.env.FAKE_MODE
      await supervisor.dispose()
    }
  }, 20_000)

  it('coalesces a start requested after its stop was initiated', async () => {
    process.env.FAKE_MODE = 'slow'
    const supervisor = new InstanceSupervisor(options({ startTimeoutMs: 5_000 }))
    try {
      const first = supervisor.ensureEndpoint('interleaved')
      // stop() marks the instance stopping synchronously, before its first
      // await; the second ensure then finds a stopping entry with the start
      // still pending and must share that in-flight start.
      void supervisor.stop('interleaved')
      const second = supervisor.ensureEndpoint('interleaved')
      await expect(first).rejects.toBeInstanceOf(StartError)
      await expect(second).rejects.toBeInstanceOf(StartError)
    } finally {
      delete process.env.FAKE_MODE
      await supervisor.dispose()
    }
  })

  it('replaces a stopping instance with a fresh start while the old child dies', async () => {
    process.env.FAKE_MODE = 'stubborn'
    const supervisor = new InstanceSupervisor(options({ startTimeoutMs: 5_000 }))
    try {
      const first = await supervisor.ensureEndpoint('replacee')
      const stop = supervisor.stop('replacee')
      // The stubborn first child ignores SIGTERM, so a new start happens while
      // it is still dying; its close then finds the replacement's entry.
      const second = await supervisor.ensureEndpoint('replacee')
      expect(second.port).not.toBe(first.port)
      await stop
      expect(supervisor.isRunning('replacee')).toBe(true)
      const stillThere = await supervisor.ensureEndpoint('replacee')
      expect(stillThere.port).toBe(second.port)
    } finally {
      delete process.env.FAKE_MODE
      await supervisor.dispose()
    }
  }, 30_000)
})
