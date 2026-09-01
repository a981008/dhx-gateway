import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  clearSessionCookieHeader,
  GATEWAY_COOKIE_NAME,
  issueGatewaySession,
  parseCookies,
  sessionCookieHeader,
  verifyGatewaySession,
} from '../src/session-cookie.ts'

const SECRET = Buffer.alloc(32, 7)
const USER = 'alice'

/** Forge a correctly signed cookie carrying an arbitrary payload. */
function forge(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = createHmac('sha256', SECRET).update(body).digest('base64url')
  return `${body}.${mac}`
}

/** Forge a correctly signed cookie whose body is not JSON at all. */
function forgeRawBody(body: string): string {
  const encoded = Buffer.from(body).toString('base64url')
  const mac = createHmac('sha256', SECRET).update(encoded).digest('base64url')
  return `${encoded}.${mac}`
}

const VALID_PAYLOAD = { v: 1, sid: 'abc', user: USER, iat: 1, exp: Date.now() + 60_000 }

describe('gateway session cookies', () => {
  it('round-trips an issued session', () => {
    const { value, expiresAt } = issueGatewaySession(SECRET, USER, 30)
    const session = verifyGatewaySession(SECRET, value)
    expect(session?.sid).toBeTypeOf('string')
    expect(session?.user).toBe(USER)
    expect(session?.expiresAt).toBe(expiresAt)
    expect(session?.expiresAt).toBeGreaterThan(Date.now())
  })

  it('rejects an expiry timestamp outside the safe integer range', () => {
    expect(() => issueGatewaySession(SECRET, USER, Number.MAX_VALUE)).toThrow(/safe timestamp range/)
  })

  it('rejects tampered payloads, wrong secrets, and junk', () => {
    const { value } = issueGatewaySession(SECRET, USER, 30)
    const [rawBody, rawMac] = value.split('.')
    const body = rawBody as string
    const mac = rawMac as string
    expect(verifyGatewaySession(Buffer.alloc(32, 9), value)).toBeUndefined()
    const tamperedBody = `${body.slice(0, -2)}${body.at(-1) === 'A' ? 'B' : 'A'}`
    expect(verifyGatewaySession(SECRET, `${tamperedBody}.${mac}`)).toBeUndefined()
    const tamperedMac = `${mac.slice(0, -2)}${mac.at(-1) === 'A' ? 'B' : 'A'}`
    expect(verifyGatewaySession(SECRET, `${body}.${tamperedMac}`)).toBeUndefined()
    expect(verifyGatewaySession(SECRET, 'not-a-cookie')).toBeUndefined()
    expect(verifyGatewaySession(SECRET, `${body}.`)).toBeUndefined()
  })

  it('rejects correctly signed values with unusable payloads', () => {
    expect(verifyGatewaySession(SECRET, forgeRawBody('not json'))).toBeUndefined()
    expect(verifyGatewaySession(SECRET, forgeRawBody('"a string"'))).toBeUndefined()
    expect(verifyGatewaySession(SECRET, forge({ ...VALID_PAYLOAD, v: 2 }))).toBeUndefined()
    expect(verifyGatewaySession(SECRET, forge({ ...VALID_PAYLOAD, sid: '' }))).toBeUndefined()
    expect(verifyGatewaySession(SECRET, forge({ ...VALID_PAYLOAD, user: '' }))).toBeUndefined()
    expect(verifyGatewaySession(SECRET, forge({ ...VALID_PAYLOAD, iat: 'early' }))).toBeUndefined()
    expect(verifyGatewaySession(SECRET, forge({ ...VALID_PAYLOAD, exp: 'late' }))).toBeUndefined()
  })

  it('rejects expired sessions', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const { value } = issueGatewaySession(SECRET, USER, 30)
      vi.setSystemTime(new Date('2026-02-15T00:00:00Z'))
      expect(verifyGatewaySession(SECRET, value)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('serializes cookie headers with the right attributes', () => {
    const { value, expiresAt } = issueGatewaySession(SECRET, USER, 30)
    const header = sessionCookieHeader(value, expiresAt, false)
    expect(header).toContain(`${GATEWAY_COOKIE_NAME}=${value}`)
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Lax')
    expect(header).not.toContain('Secure')
    expect(sessionCookieHeader(value, expiresAt, true)).toContain('; Secure')
    expect(clearSessionCookieHeader(false)).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT')
    expect(clearSessionCookieHeader(true)).toContain('; Secure')
  })

  it('parses cookie headers into first-value pairs', () => {
    const cookies = parseCookies('a=1; b=2 ; a=3; broken')
    expect(cookies.get('a')).toBe('1')
    expect(cookies.get('b')).toBe('2')
    expect(cookies.has('broken')).toBe(false)
    expect(parseCookies(undefined).size).toBe(0)
  })
})
