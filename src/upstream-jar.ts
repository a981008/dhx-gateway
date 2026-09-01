/**
 * Upstream session acquisition for the gateway proxy. The upstream's own
 * browser authentication exchanges a process launch token (the ready URL
 * line) for a signed cookie; the gateway performs that exchange once per
 * gateway session, server-side, and replays the resulting cookie on every
 * proxied request. The browser never sees an upstream cookie.
 * @module
 */

/** One ready upstream instance's endpoint facts. */
export interface UpstreamEndpoint {
  /** Listening port on the loopback interface. */
  port: number
  /** Process launch token parsed from the ready URL line. */
  token: string
}

/** Milliseconds the token exchange may take before it fails the request. */
const MINT_TIMEOUT_MS = 10_000

/**
 * Server-side jar of upstream cookies keyed by gateway session id. Entries
 * are process-local: losing them on gateway restart costs one token exchange
 * per active session, never user-visible state.
 */
export class UpstreamCookieJar {
  private readonly entries = new Map<string, { cookie: string; port: number }>()

  /**
   * Get the jarred cookie for one gateway session, valid only for the port it
   * was minted against — the upstream names its cookie after the request
   * authority, so a restarted instance on a new port invalidates the jar.
   * @param sid - gateway session id.
   * @param port - upstream port of the request about to be proxied.
   * @returns the cookie header value, or undefined when absent or stale.
   */
  get(sid: string, port: number): string | undefined {
    const entry = this.entries.get(sid)
    if (entry === undefined || entry.port !== port) return undefined
    return entry.cookie
  }

  /**
   * Store the cookie minted for one gateway session against one upstream port.
   * @param sid - gateway session id.
   * @param cookie - upstream cookie header value.
   * @param port - upstream loopback port the cookie belongs to.
   */
  set(sid: string, cookie: string, port: number): void {
    this.entries.set(sid, { cookie, port })
  }

  /**
   * Drop the jar entry for one gateway session.
   * @param sid - gateway session id.
   */
  clear(sid: string): void {
    this.entries.delete(sid)
  }

  /** Drop every entry; called on gateway disposal. */
  clearAll(): void {
    this.entries.clear()
  }
}

/** First `name=value` pair of one `Set-Cookie` header, before its attributes. */
function firstCookiePair(header: string): string {
  /* v8 ignore next -- the split of a nonempty header always yields a first element; the fallback satisfies noUncheckedIndexedAccess. */
  return header.split(';', 1)[0] ?? ''
}

/**
 * Exchange the upstream launch token for its browser-session cookie: request
 * the token URL with `Host` on the loopback authority and capture the
 * `Set-Cookie` headers the upstream answers its redirect with.
 * @param endpoint - ready upstream endpoint carrying port and launch token.
 * @returns the cookie pairs joined into one request `Cookie` header value.
 * @throws when the exchange fails, answers unexpectedly, or carries no cookie.
 */
export async function mintUpstreamSession(endpoint: UpstreamEndpoint): Promise<string> {
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${String(endpoint.port)}/?token=${encodeURIComponent(endpoint.token)}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`dhx-gateway: upstream token exchange failed: ${(error as Error).message}`)
  }
  if (response.status !== 303) {
    throw new Error(`dhx-gateway: upstream token exchange answered ${String(response.status)} instead of 303`)
  }
  const pairs = response.headers.getSetCookie()
    .map(firstCookiePair)
    .filter(pair => pair !== '')
  if (pairs.length === 0) {
    throw new Error('dhx-gateway: upstream token exchange answered without a session cookie')
  }
  return pairs.join('; ')
}
