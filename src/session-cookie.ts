/**
 * Gateway browser-session cookies: HMAC-SHA256 signed payloads carrying the
 * session id, account name, and absolute lifetime. The signing secret is the
 * gateway's durable secret, so sessions survive gateway restarts; the session
 * id additionally keys the server-side upstream cookie jar.
 * @module
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Cookie name of the gateway's own browser session. */
export const GATEWAY_COOKIE_NAME = 'dhxgw_session'

const PAYLOAD_VERSION = 1
const DAY_MS = 86_400_000
const SESSION_ID_BYTES = 18

/** Verified gateway browser session. */
export interface GatewaySession {
  /** Random session id; keys the upstream cookie jar. */
  sid: string
  /** Account name the session authenticates. */
  user: string
  /** Issuance time in epoch milliseconds. */
  issuedAt: number
  /** Absolute expiry in epoch milliseconds. */
  expiresAt: number
}

interface CookiePayload {
  v: number
  sid: string
  user: string
  iat: number
  exp: number
}

function mac(secret: Buffer, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

function encodeSession(payload: CookiePayload, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${mac(secret, body)}`
}

/**
 * Issue a fresh gateway session for one account.
 * @param secret - gateway signing secret.
 * @param user - account name the session authenticates.
 * @param maxAgeDays - positive session lifetime in days.
 * @returns the signed cookie value and its absolute expiry.
 */
export function issueGatewaySession(
  secret: Buffer,
  user: string,
  maxAgeDays: number,
): { value: string; expiresAt: number } {
  const issuedAt = Date.now()
  const expiresAt = issuedAt + maxAgeDays * DAY_MS
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error('dhx-gateway: sessionMaxAgeDays exceeds the safe timestamp range')
  }
  const payload: CookiePayload = {
    v: PAYLOAD_VERSION,
    sid: randomBytes(SESSION_ID_BYTES).toString('base64url'),
    user,
    iat: issuedAt,
    exp: expiresAt,
  }
  return { value: encodeSession(payload, secret), expiresAt }
}

/**
 * Verify a presented gateway session cookie. Tampered, malformed, and expired
 * values all verify undefined, and the caller cannot distinguish them — a
 * session value carries no authority beyond re-presenting a valid one.
 * @param secret - gateway signing secret.
 * @param value - raw cookie value.
 * @returns the verified session, or undefined when untrusted or expired.
 */
export function verifyGatewaySession(secret: Buffer, value: string): GatewaySession | undefined {
  const dot = value.indexOf('.')
  if (dot === -1) return undefined
  const body = value.slice(0, dot)
  const presented = Buffer.from(value.slice(dot + 1), 'base64url')
  const expected = Buffer.from(mac(secret, body), 'base64url')
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  if (record.v !== PAYLOAD_VERSION
    || typeof record.sid !== 'string' || record.sid === ''
    || typeof record.user !== 'string' || record.user === ''
    || !Number.isSafeInteger(record.iat)
    || !Number.isSafeInteger(record.exp)) return undefined
  const { sid, user, iat, exp } = record
  if ((exp as number) <= Date.now()) return undefined
  return { sid, user, issuedAt: iat as number, expiresAt: exp as number }
}

/**
 * Serialize the `Set-Cookie` header establishing one gateway session.
 * @param value - signed cookie value.
 * @param expiresAt - absolute expiry in epoch milliseconds.
 * @param secure - whether to mark the cookie `Secure`.
 * @returns the header value.
 */
export function sessionCookieHeader(value: string, expiresAt: number, secure: boolean): string {
  return `${GATEWAY_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure ? '; Secure' : ''}`
}

/**
 * Serialize the `Set-Cookie` header expiring the gateway session.
 * @param secure - whether the cookie being replaced was marked `Secure`.
 * @returns the header value.
 */
export function clearSessionCookieHeader(secure: boolean): string {
  return `${GATEWAY_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`
}

/**
 * Parse one `Cookie` request header into name/value pairs. Values stay raw:
 * the gateway's own cookie value is base64url plus one separator dot and
 * needs no decoding.
 * @param header - raw header value, or undefined when the request has none.
 * @returns the first value per cookie name, in header order.
 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  if (header === undefined) return cookies
  for (const pair of header.split(';')) {
    const equals = pair.indexOf('=')
    if (equals === -1) continue
    const name = pair.slice(0, equals).trim()
    const value = pair.slice(equals + 1).trim()
    if (name !== '' && !cookies.has(name)) cookies.set(name, value)
  }
  return cookies
}
