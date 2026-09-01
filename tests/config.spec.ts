import { mkdtempSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveConfig, type Config } from '../src/config.ts'

/** Project root, computed the same way the plugin computes it from src/. */
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function base(): Config {
  return { dshCommand: ['dsh', 'web'] }
}

function config(overrides: Partial<Config> = {}): Config {
  return Object.assign(base(), overrides)
}

function configErrorOf(candidate: Config): string {
  try {
    resolveConfig(candidate)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected resolveConfig to throw')
}

describe('gateway config resolution', () => {
  it('materializes defaults under the project-owned data directory', () => {
    const resolved = resolveConfig(base(), { DSH_HOME: '/tmp/gateway-home' })
    expect(resolved.stateRoot).toBe(join(PROJECT_ROOT, 'data'))
    expect(resolved.stateRoot).not.toContain('/tmp/gateway-home')
    expect(resolved.usersRoot).toBe(join(PROJECT_ROOT, 'data', 'users'))
    expect(resolved.dshCommand).toEqual(['dsh', 'web'])
    expect(resolved.sessionMaxAgeDays).toBe(30)
    expect(resolved.startTimeoutMs).toBe(30_000)
    expect(resolved.secureCookies).toBe(false)
    expect(resolved.printBootstrapInvite).toBe(true)
    expect(resolved.idleStopMinutes).toBeUndefined()
    expect(resolved.publicOrigin).toBeUndefined()
  })

  it('resolves explicit and tilde paths, and publicOrigin normalization', () => {
    const resolved = resolveConfig(config({ stateRoot: '~/gateway-state', usersRoot: '/srv/users', publicOrigin: 'https://dsh.example.com/' }))
    expect(resolved.stateRoot).toBe(join(process.env.HOME ?? '', 'gateway-state'))
    expect(resolved.usersRoot).toBe('/srv/users')
    expect(resolved.publicOrigin).toBe('https://dsh.example.com')
  })

  it('rejects malformed dshCommand', () => {
    expect(configErrorOf(config({ dshCommand: [] }))).toMatch(/dshCommand/)
    expect(configErrorOf(config({ dshCommand: ['dsh', ''] }))).toMatch(/dshCommand/)
  })

  it('rejects out-of-range numeric fields', () => {
    expect(configErrorOf(config({ sessionMaxAgeDays: 0 }))).toMatch(/sessionMaxAgeDays/)
    expect(configErrorOf(config({ sessionMaxAgeDays: 4000 }))).toMatch(/sessionMaxAgeDays/)
    expect(configErrorOf(config({ idleStopMinutes: 0 }))).toMatch(/idleStopMinutes/)
    expect(configErrorOf(config({ startTimeoutMs: 0 }))).toMatch(/startTimeoutMs/)
  })

  it('rejects a publicOrigin with path, query, or wrong scheme', () => {
    expect(configErrorOf(config({ publicOrigin: 'not a url' }))).toMatch(/publicOrigin/)
    expect(configErrorOf(config({ publicOrigin: 'https://dsh.example.com/base' }))).toMatch(/publicOrigin/)
    expect(configErrorOf(config({ publicOrigin: 'https://dsh.example.com/?x=1' }))).toMatch(/publicOrigin/)
    expect(configErrorOf(config({ publicOrigin: 'ftp://dsh.example.com' }))).toMatch(/publicOrigin/)
  })

  it('accepts a tmp state root with all options set', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'dshgw-config-'))
    const resolved = resolveConfig(config({
      dshCommand: ['/opt/dsh/bin/dsh', 'web'],
      stateRoot,
      idleStopMinutes: 45.5,
      startTimeoutMs: 1500,
      secureCookies: true,
      printBootstrapInvite: false,
    }))
    expect(resolved.stateRoot).toBe(stateRoot)
    expect(resolved.idleStopMinutes).toBe(45.5)
    expect(resolved.startTimeoutMs).toBe(1500)
    expect(resolved.secureCookies).toBe(true)
    expect(resolved.printBootstrapInvite).toBe(false)
  })
})
