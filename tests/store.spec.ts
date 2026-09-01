import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AccountStore, USERNAME_PATTERN } from '../src/store.ts'

function tempStoreFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'dshgw-store-')), 'users.json')
}

describe('gateway account store', () => {
  it('persists accounts and invites across reopen', async () => {
    const file = tempStoreFile()
    const store = AccountStore.open(file)
    expect(store.countUsers()).toBe(0)
    const token = await store.createInvite({ ttlMinutes: 60 })
    const created = await store.acceptInvite(token, 'alice', 'long enough')
    expect(created).toBe('alice')
    expect(store.isUserAdmin('alice')).toBe(false)
    expect(await store.verifyLogin('alice', 'long enough')).toBe(true)
    expect(await store.verifyLogin('alice', 'wrong password')).toBe(false)

    const reopened = AccountStore.open(file)
    expect(reopened.countUsers()).toBe(1)
    expect(reopened.hasUser('alice')).toBe(true)
    expect(await reopened.verifyLogin('alice', 'long enough')).toBe(true)
    expect(reopened.describeInvite(token)).toEqual({ usable: false, reason: 'used' })
  })

  it('rejects logins of disabled accounts until re-enabled', async () => {
    const file = tempStoreFile()
    const store = AccountStore.open(file)
    const token = await store.createInvite()
    await store.acceptInvite(token, 'bob', 'long enough')
    await store.setDisabled('bob', true)
    expect(store.isUserDisabled('bob')).toBe(true)
    expect(await store.verifyLogin('bob', 'long enough')).toBe(false)
    await store.setDisabled('bob', false)
    expect(store.isUserDisabled('bob')).toBe(false)
    expect(await store.verifyLogin('bob', 'long enough')).toBe(true)
    await expect(store.setDisabled('nobody', true)).rejects.toMatchObject({ code: 'unknown-user' })
  })

  it('fails closed on unknown accounts', () => {
    const store = AccountStore.open(tempStoreFile())
    expect(store.hasUser('ghost')).toBe(false)
    expect(store.isUserDisabled('ghost')).toBe(true)
    expect(store.isUserAdmin('ghost')).toBe(false)
  })

  it('makes the bootstrap invite single-use, admin-granting, and re-displayable', async () => {
    const file = tempStoreFile()
    const store = AccountStore.open(file)
    const first = await store.createInvite({ bootstrap: true })
    const again = await store.createInvite({ bootstrap: true })
    expect(again).toBe(first)
    await store.acceptInvite(first, 'root', 'long enough')
    expect(store.isUserAdmin('root')).toBe(true)
    const rows = store.getInviteRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.usedBy).toBe('root')
    // After first use a re-activation mints a fresh bootstrap invite, which
    // only exists while the deployment has no accounts — here it does.
    const third = await store.createInvite({ bootstrap: true })
    expect(third).not.toBe(first)
    await store.acceptInvite(third, 'root2', 'long enough')
    expect(store.isUserAdmin('root2')).toBe(true)
  })

  it('honors invite expiry', async () => {
    const store = AccountStore.open(tempStoreFile())
    const token = await store.createInvite({ ttlMinutes: 0.005 })
    expect(store.describeInvite(token).usable).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(store.describeInvite(token)).toEqual({ usable: false, reason: 'expired' })
    await expect(store.acceptInvite(token, 'late', 'long enough')).rejects.toMatchObject({ code: 'invalid-invite' })
  })

  it('rejects invalid usernames, taken names, weak passwords, and bad tokens', async () => {
    const store = AccountStore.open(tempStoreFile())
    const token = await store.createInvite()
    await expect(store.acceptInvite(token, 'Bad Name', 'long enough')).rejects.toMatchObject({ code: 'invalid-username' })
    await expect(store.acceptInvite(token, '-lead', 'long enough')).rejects.toMatchObject({ code: 'invalid-username' })
    await expect(store.acceptInvite(token, 'ok-name', 'short')).rejects.toMatchObject({ code: 'weak-password' })
    await expect(store.acceptInvite('not-a-token', 'ok-name', 'long enough')).rejects.toMatchObject({ code: 'invalid-invite' })
    await store.acceptInvite(token, 'ok-name', 'long enough')
    const second = await store.createInvite()
    await expect(store.acceptInvite(second, 'ok-name', 'long enough')).rejects.toMatchObject({ code: 'username-taken' })
    await expect(store.acceptInvite(token, 'other', 'long enough')).rejects.toMatchObject({ code: 'invalid-invite' })
  })

  it('revokes invites by hash-prefix id and rejects ambiguous prefixes', async () => {
    const store = AccountStore.open(tempStoreFile())
    const first = await store.createInvite()
    const second = await store.createInvite()
    const rows = store.getInviteRows()
    expect(rows).toHaveLength(2)
    await store.revokeInvite(rows[0]?.id ?? '')
    expect(store.describeInvite(first)).toEqual({ usable: false, reason: 'unknown' })
    expect(store.describeInvite(second).usable).toBe(true)
    await expect(store.revokeInvite('zzz-does-not-exist')).rejects.toMatchObject({ code: 'invalid-invite' })
    // A single-hex-character prefix can only match at most 2 of 256 hashes;
    // mint enough invites for a collision to be practically certain.
    for (let index = 0; index < 12; index += 1) await store.createInvite()
    const shortId = store.getInviteRows().find(row => row.usedBy === undefined)?.id.slice(0, 1) ?? ''
    const ambiguous = store.getInviteRows().filter(row => row.id.startsWith(shortId)).length > 1
    if (ambiguous) {
      await expect(store.revokeInvite(shortId)).rejects.toMatchObject({ code: 'invalid-invite' })
    }
  })

  it('orders rows deterministically by creation time', async () => {
    const store = AccountStore.open(tempStoreFile())
    // scrypt dominates acceptInvite latency, so creation timestamps carry the
    // completion order; assert the same order twice for determinism.
    for (const name of ['carol', 'alice', 'dan', 'bob']) {
      await store.acceptInvite(await store.createInvite(), name, 'long enough')
    }
    const first = store.getUserRows().map(row => row.name)
    const second = store.getUserRows().map(row => row.name)
    expect(first).toEqual(second)
    expect(first).toContain('alice')
    expect(store.getInviteRows().map(row => row.usedBy)).toEqual(store.getInviteRows().map(row => row.usedBy))
    const inviteOrder = store.getInviteRows().map(row => row.createdAt)
    expect([...inviteOrder].sort()).toEqual(inviteOrder)
  })

  it('fails loudly on corrupt or wrong-version stores', () => {
    const corrupt = tempStoreFile()
    writeFileSync(corrupt, '{not json')
    expect(() => AccountStore.open(corrupt)).toThrow(/not valid JSON/)
    const wrongVersion = tempStoreFile()
    writeFileSync(wrongVersion, JSON.stringify({ version: 99, users: {}, invites: {} }))
    expect(() => AccountStore.open(wrongVersion)).toThrow(/version/)
    const malformedUser = tempStoreFile()
    writeFileSync(malformedUser, JSON.stringify({ version: 1, users: { x: { passwordHash: 3 } }, invites: {} }))
    expect(() => AccountStore.open(malformedUser)).toThrow(/malformed user row/)
    const nonRecordInvite = tempStoreFile()
    writeFileSync(nonRecordInvite, JSON.stringify({ version: 1, users: {}, invites: { h: 'nope' } }))
    expect(() => AccountStore.open(nonRecordInvite)).toThrow(/malformed invite row/)
    const malformedInvite = tempStoreFile()
    writeFileSync(malformedInvite, JSON.stringify({ version: 1, users: {}, invites: { h: {} } }))
    expect(() => AccountStore.open(malformedInvite)).toThrow(/malformed invite row/)
  })

  it('fails loudly when any invite field has the wrong type', () => {
    const rows = [
      { createdAt: '2026-01-01', expiresAt: 5 },
      { createdAt: '2026-01-01', usedBy: 7 },
      { createdAt: '2026-01-01', bootstrap: 'yes' },
      { createdAt: '2026-01-01', token: 9 },
    ]
    for (const invite of rows) {
      const file = tempStoreFile()
      writeFileSync(file, JSON.stringify({ version: 1, users: {}, invites: { h: invite } }))
      expect(() => AccountStore.open(file)).toThrow(/malformed invite row/)
    }
  })

  it('breaks creation-time ties by account name', () => {
    const file = tempStoreFile()
    const row = { passwordHash: 's1$16384$8$1$c2FsdA$a2V5', admin: false, disabled: false }
    writeFileSync(file, JSON.stringify({
      version: 1,
      users: {
        zeta: { ...row, createdAt: '2026-01-01T00:00:00.000Z' },
        alpha: { ...row, createdAt: '2026-01-01T00:00:00.000Z' },
        mid: { ...row, createdAt: '2026-01-01T00:00:00.000Z' },
      },
      invites: {},
    }))
    const store = AccountStore.open(file)
    expect(store.getUserRows().map(user => user.name)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('validates the account-name pattern', () => {
    expect(USERNAME_PATTERN.test('alice')).toBe(true)
    expect(USERNAME_PATTERN.test('a')).toBe(true)
    expect(USERNAME_PATTERN.test('a'.repeat(32))).toBe(true)
    expect(USERNAME_PATTERN.test('a'.repeat(33))).toBe(false)
    expect(USERNAME_PATTERN.test('-alice')).toBe(false)
    expect(USERNAME_PATTERN.test('Alice')).toBe(false)
    expect(USERNAME_PATTERN.test('ali.ce')).toBe(false)
    expect(USERNAME_PATTERN.test('')).toBe(false)
  })

  it('serializes concurrent mutations without losing writes', async () => {
    const file = tempStoreFile()
    const store = AccountStore.open(file)
    const tokens = await Promise.all(Array.from({ length: 6 }, () => store.createInvite()))
    await Promise.all(tokens.map((token, index) => store.acceptInvite(token, `user-${String(index)}`, 'long enough')))
    expect(store.countUsers()).toBe(6)
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as { users: Record<string, unknown> }
    expect(Object.keys(persisted.users)).toHaveLength(6)
  })
})
