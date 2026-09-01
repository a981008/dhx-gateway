/**
 * Password hashing for gateway accounts: scrypt with per-password random salt
 * and stored algorithm parameters, so a stored hash carries everything
 * verification needs and parameter upgrades stay possible without a rewrite.
 * @module
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>

const ALGORITHM_TAG = 's1'
const SALT_BYTES = 16
const KEY_BYTES = 32
const SCRYPT_COST = { N: 16384, r: 8, p: 1 } as const
/** Minimum accepted password length for account creation. */
export const MIN_PASSWORD_LENGTH = 8
/** Maximum accepted password length; scrypt input is unbounded otherwise. */
export const MAX_PASSWORD_LENGTH = 1024

/**
 * Hash one password for durable storage.
 * @param password - plaintext password; never persisted.
 * @returns the stored form `s1$N$r$p$salt$key` with base64url salt and key.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await scrypt(password, salt, KEY_BYTES, SCRYPT_COST)
  return [
    ALGORITHM_TAG,
    String(SCRYPT_COST.N),
    String(SCRYPT_COST.r),
    String(SCRYPT_COST.p),
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$')
}

function parseCost(value: string): { N: number; r: number; p: number } | undefined {
  const numbers = value.split(',').map(Number)
  if (numbers.length !== 3 || numbers.some(n => !Number.isSafeInteger(n) || n <= 0)) return undefined
  const [N, r, p] = numbers
  return { N: N as number, r: r as number, p: p as number }
}

/**
 * Verify one password against a stored hash. Any malformed stored value
 * verifies false instead of throwing: account data is deployment-owned state,
 * and a corrupt row must not take the login route down.
 * @param password - candidate plaintext password.
 * @param stored - stored form produced by {@link hashPassword}.
 * @returns true only when the password matches.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  const [tag, nRaw, rRaw, pRaw, saltRaw, keyRaw] = parts
  if (parts.length !== 6 || tag !== ALGORITHM_TAG
    || nRaw === undefined || rRaw === undefined || pRaw === undefined
    || saltRaw === undefined || keyRaw === undefined) return false
  const cost = parseCost(`${nRaw},${rRaw},${pRaw}`)
  if (cost === undefined) return false
  const salt = Buffer.from(saltRaw, 'base64url')
  const expected = Buffer.from(keyRaw, 'base64url')
  if (salt.length === 0 || expected.length === 0) return false
  const key = await scrypt(password, salt, expected.length, cost)
  return key.length === expected.length && timingSafeEqual(key, expected)
}
