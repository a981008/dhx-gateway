import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadOrCreateGatewaySecret } from '../src/secret.ts'

describe('gateway signing secret', () => {
  it('creates a 32-byte secret once and reuses it', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'dshgw-secret-'))
    try {
      const first = loadOrCreateGatewaySecret(stateRoot)
      expect(first.byteLength).toBe(32)
      const second = loadOrCreateGatewaySecret(stateRoot)
      expect(second.equals(first)).toBe(true)
    } finally {
      rmSync(stateRoot, { recursive: true, force: true })
    }
  })

  it('fails loudly on an undersized existing secret', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'dshgw-secret-short-'))
    try {
      writeSecretFile(stateRoot, Buffer.alloc(8, 1))
      expect(() => loadOrCreateGatewaySecret(stateRoot)).toThrow(/bytes; expected at least 32/)
    } finally {
      rmSync(stateRoot, { recursive: true, force: true })
    }
  })

  it('creates the state root when missing with owner-only permissions', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dshgw-secret-root-'))
    const stateRoot = join(parent, 'nested', 'state')
    try {
      const secret = loadOrCreateGatewaySecret(stateRoot)
      expect(secret.byteLength).toBe(32)
      // Skip the permission assertions on Windows, where POSIX modes do not apply.
      if (process.platform !== 'win32') {
        expect(statSync(stateRoot).mode & 0o777).toBe(0o700)
        expect(statSync(join(stateRoot, 'secret.key')).mode & 0o777).toBe(0o600)
      }
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('rethrows read failures other than a missing file', async () => {
    if (process.platform === 'win32') return
    const stateRoot = mkdtempSync(join(tmpdir(), 'dshgw-secret-eacces-'))
    try {
      writeSecretFile(stateRoot, Buffer.alloc(32, 3))
      chmodSync(stateRoot, 0o000)
      expect(() => loadOrCreateGatewaySecret(stateRoot)).toThrow(/EACCES|EACCES: permission denied/)
    } finally {
      chmodSync(stateRoot, 0o700)
      rmSync(stateRoot, { recursive: true, force: true })
    }
  })

  it('rethrows write failures other than the create race', async () => {
    if (process.platform === 'win32') return
    const stateRoot = mkdtempSync(join(tmpdir(), 'dshgw-secret-ero-'))
    try {
      chmodSync(stateRoot, 0o500)
      expect(() => loadOrCreateGatewaySecret(stateRoot)).toThrow(/EACCES|permission denied/)
    } finally {
      chmodSync(stateRoot, 0o700)
      rmSync(stateRoot, { recursive: true, force: true })
    }
  })

  it('falls back to reading when the create race loses to an existing path', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'dshgw-secret-race-'))
    try {
      // A dangling symlink exists as a path entry, so the exclusive create
      // answers EEXIST while the initial read answers ENOENT; the fallback
      // read then fails on the same dangling link.
      symlinkSync(join(stateRoot, 'missing-target'), join(stateRoot, 'secret.key'))
      expect(() => loadOrCreateGatewaySecret(stateRoot)).toThrow(/ENOENT/)
    } finally {
      rmSync(stateRoot, { recursive: true, force: true })
    }
  })
})

function writeSecretFile(stateRoot: string, content: Buffer): void {
  mkdirSync(stateRoot, { recursive: true })
  writeFileSync(join(stateRoot, 'secret.key'), content)
}
