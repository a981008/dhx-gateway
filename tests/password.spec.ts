import { describe, expect, it } from 'vitest'
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../src/password.ts'

describe('gateway password hashing', () => {
  it('verifies the password it hashed', async () => {
    const stored = await hashPassword('correct horse')
    expect(await verifyPassword('correct horse', stored)).toBe(true)
    expect(await verifyPassword('wrong horse', stored)).toBe(false)
  })

  it('salts every hash independently', async () => {
    const first = await hashPassword('same password')
    const second = await hashPassword('same password')
    expect(first).not.toBe(second)
    expect(await verifyPassword('same password', first)).toBe(true)
    expect(await verifyPassword('same password', second)).toBe(true)
  })

  it('exposes the minimum password length used by the store', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8)
  })

  it('verifies false on malformed stored values instead of throwing', async () => {
    const cases = [
      '',
      'plain',
      's1$16384$8',
      's2$16384$8$1$abc$def',
      's1$zero$8$1$abc$def',
      's1$0$8$1$abc$def',
      's1$16384$8$1$$',
      's1$16384$8$1$abc$',
    ]
    for (const stored of cases) {
      expect(await verifyPassword('anything', stored)).toBe(false)
    }
  })
})
