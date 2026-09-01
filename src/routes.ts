/**
 * Gateway route wiring on the webserver: login, logout, invite acceptance,
 * the admin dashboard, and the fallback proxy that authenticates the browser
 * session, ensures the user's upstream instance, and proxies with the
 * server-side upstream cookie. Named routes own their methods; the fallback
 * seat owns everything else.
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ResolvedConfig } from './config.ts'
import { adminPage, invitePage, loginPage, logoutPage, messagePage } from './pages.ts'
import { proxyRequest } from './proxy.ts'
import {
  clearSessionCookieHeader,
  GATEWAY_COOKIE_NAME,
  issueGatewaySession,
  parseCookies,
  sessionCookieHeader,
  verifyGatewaySession,
} from './session-cookie.ts'
import { AccountStore, StoreError } from './store.ts'
import type { InstanceSupervisor } from './supervisor.ts'
import { mintUpstreamSession, UpstreamCookieJar } from './upstream-jar.ts'
import { proxyUpgrade, createUpgradeAgent } from './upgrade.ts'

/** Maximum accepted form body; gateway forms carry only account fields. */
const MAX_FORM_BYTES = 32_768

/**
 * The exact path the dsh web client streams its mux WebSocket on. The
 * webserver dispatches upgrades by exact pathname, so the fallback seat must
 * claim this path explicitly and splice it to the user's upstream instance.
 */
export const UPSTREAM_MUX_PATH = '/api/remote.mux'

/** Services and state the route handlers share. */
export interface GatewayDeps {
  /** Plugin context; used for the listening port when displaying links. */
  ctx: Context
  /** Resolved plugin config. */
  resolved: ResolvedConfig
  /** Account store. */
  store: AccountStore
  /** Gateway signing secret. */
  secret: Buffer
  /** Upstream instance supervisor. */
  supervisor: InstanceSupervisor
  /** Server-side upstream cookie jar. */
  jar: UpstreamCookieJar
  /** Shared upstream keep-alive agent. */
  agent: import('node:http').Agent
  /** Log sink for diagnostics the routes produce directly. */
  log: (message: string) => void
}

/**
 * Register every gateway route and return the disposers in registration
 * order; the caller yields them inside its effect.
 * @param deps - shared gateway state.
 * @returns one disposer per registered route, including the fallback seat.
 */
export function registerGatewayRoutes(deps: GatewayDeps): Array<() => void> {
  const { ctx, resolved, store, secret, supervisor, jar, agent, log } = deps
  const webServer = ctx.webServer
  // Upgraded sockets must never enter the shared keep-alive pool; upgrade
  // requests get their own connection-per-handshake agent, destroyed on disposal.
  const upgradeAgent = createUpgradeAgent()

  const issueSession = (res: ServerResponse, user: string): void => {
    const session = issueGatewaySession(secret, user, resolved.sessionMaxAgeDays)
    res.setHeader('set-cookie', sessionCookieHeader(session.value, session.expiresAt, resolved.secureCookies))
  }

  const readForm = async (req: IncomingMessage): Promise<URLSearchParams> => {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      total += (chunk as Buffer).byteLength
      if (total > MAX_FORM_BYTES) throw new Error('form body too large')
      chunks.push(chunk as Buffer)
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
  }

  const respondHtml = (res: ServerResponse, status: number, html: string): void => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  }

  /**
   * Guard shared by the POST form routes: reject non-POST methods with 405,
   * reject oversized bodies with 413, and return the submitted fields.
   * @returns the form fields, or undefined when the guard already answered.
   */
  const readPostedForm = async (req: IncomingMessage, res: ServerResponse, allowed: string): Promise<URLSearchParams | undefined> => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: allowed })
      res.end()
      return undefined
    }
    try {
      return await readForm(req)
    } catch {
      respondHtml(res, 413, messagePage('Request too large', 'The submitted form was too large.'))
      return undefined
    }
  }

  const authenticatedUser = (req: IncomingMessage): { sid: string; user: string } | undefined => {
    const cookies = parseCookies(req.headers.cookie)
    const raw = cookies.get(GATEWAY_COOKIE_NAME)
    if (raw === undefined) return undefined
    const session = verifyGatewaySession(secret, raw)
    if (session === undefined || !store.hasUser(session.user) || store.isUserDisabled(session.user)) return undefined
    return { sid: session.sid, user: session.user }
  }

  const adminLinkOrigin = (): string => resolved.publicOrigin ?? `http://127.0.0.1:${String(webServer.port)}`

  const renderAdmin = (res: ServerResponse, notice?: string): void => {
    respondHtml(res, 200, adminPage(
      {
        users: store.getUserRows(),
        invites: store.getInviteRows(),
        running: supervisor.runningRows(),
      },
      notice,
    ))
  }

  const requireAdmin = (req: IncomingMessage, res: ServerResponse): { user: string } | undefined => {
    const session = authenticatedUser(req)
    if (session === undefined) {
      res.writeHead(303, { location: '/login' })
      res.end()
      return undefined
    }
    if (!store.isUserAdmin(session.user)) {
      respondHtml(res, 403, messagePage('Forbidden', 'This page is for gateway administrators.'))
      return undefined
    }
    return session
  }

  const loginHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === 'GET') {
      if (authenticatedUser(req) !== undefined) {
        res.writeHead(303, { location: '/' })
        res.end()
        return
      }
      respondHtml(res, 200, loginPage(undefined))
      return
    }
    const form = await readPostedForm(req, res, 'GET, POST')
    if (form === undefined) return
    const username = form.get('username') ?? ''
    const password = form.get('password') ?? ''
    if (await store.verifyLogin(username, password)) {
      issueSession(res, username)
      res.writeHead(303, { location: '/' })
      res.end()
      return
    }
    respondHtml(res, 401, loginPage('Invalid username or password.'))
  }

  const logoutHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method === 'GET') {
      // The confirmation page is the members' logout entry point; without a
      // session there is nothing to sign out of, so go straight to the form.
      if (authenticatedUser(req) === undefined) {
        res.writeHead(303, { location: '/login' })
        res.end()
        return
      }
      respondHtml(res, 200, logoutPage())
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
      return
    }
    res.writeHead(303, {
      location: '/login',
      'set-cookie': clearSessionCookieHeader(resolved.secureCookies),
    })
    res.end()
  }

  const inviteTokenFromPath = (rawPath: string): string | undefined => {
    const rest = rawPath.slice('/invite'.length)
    if (rest === '' || rest === '/') return undefined
    try {
      return decodeURIComponent(rest.slice(1))
    } catch {
      return undefined
    }
  }

  const inviteHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    /* v8 ignore next -- node:http always sets url on server requests. */
    const rawPath = new URL(req.url ?? '/', 'http://gateway.invalid').pathname
    const token = inviteTokenFromPath(rawPath)
    if (token === undefined) {
      respondHtml(res, 404, messagePage('Invite required', 'Open the invite link an administrator shared with you.'))
      return
    }
    const invite = store.describeInvite(token)
    if (!invite.usable) {
      respondHtml(res, 404, messagePage('Invite invalid', 'This invite is unknown, already used, or expired. Ask an administrator for a new one.'))
      return
    }
    if (req.method === 'GET') {
      respondHtml(res, 200, invitePage(token, undefined))
      return
    }
    const form = await readPostedForm(req, res, 'GET, POST')
    if (form === undefined) return
    const username = form.get('username') ?? ''
    const password = form.get('password') ?? ''
    try {
      const created = await store.acceptInvite(token, username, password)
      issueSession(res, created)
      res.writeHead(303, { location: '/' })
      res.end()
    } catch (error) {
      // Every StoreError acceptInvite can reject with is mapped; the fallback
      // arms keep unexpected failures from leaking internals to the page.
      /* v8 ignore next 7 -- the fallbacks are unreachable: the codes are
      exhaustively mapped and acceptInvite rejects only with StoreError. */
      const message = error instanceof StoreError
        ? ({
          'invalid-username': 'Account names use lowercase letters, digits, and dashes (at most 32 characters).',
          'username-taken': 'That account name is already taken.',
          'weak-password': 'Passwords need at least 8 characters.',
          'invalid-invite': 'This invite is unknown, already used, or expired.',
          'unknown-user': 'This invite is unknown, already used, or expired.',
        } as Record<string, string>)[error.code] ?? 'The account could not be created.'
        : 'The account could not be created.'
      respondHtml(res, 400, invitePage(token, message))
    }
  }

  const adminHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    /* v8 ignore next -- node:http always sets url on server requests. */
    const rawPath = new URL(req.url ?? '/', 'http://gateway.invalid').pathname
    if (req.method === 'GET') {
      if (requireAdmin(req, res) !== undefined) renderAdmin(res)
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
      return
    }
    if (requireAdmin(req, res) === undefined) return
    const form = await readPostedForm(req, res, 'POST')
    if (form === undefined) return
    try {
      if (rawPath === '/gw-admin/invite') {
        const ttlRaw = form.get('ttlMinutes') ?? ''
        const ttlMinutes = ttlRaw === '' ? undefined : Number(ttlRaw)
        if (ttlMinutes !== undefined && (!(ttlMinutes > 0) || !Number.isFinite(ttlMinutes))) {
          renderAdmin(res, 'Invite lifetime must be a positive number of minutes.')
          return
        }
        const token = await store.createInvite(ttlMinutes === undefined ? {} : { ttlMinutes })
        renderAdmin(res, `New invite link (shown once): ${adminLinkOrigin()}/invite/${token}`)
        return
      }
      if (rawPath === '/gw-admin/invite/revoke') {
        await store.revokeInvite(form.get('id') ?? '')
        renderAdmin(res, 'Invite revoked.')
        return
      }
      if (rawPath === '/gw-admin/users/disable' || rawPath === '/gw-admin/users/enable') {
        const name = form.get('name') ?? ''
        await store.setDisabled(name, rawPath === '/gw-admin/users/disable')
        renderAdmin(res, `Account ${JSON.stringify(name)} updated.`)
        return
      }
      respondHtml(res, 404, messagePage('Unknown action', 'The submitted admin action does not exist.'))
    } catch (error) {
      const detail = error instanceof StoreError ? error.message : 'The action failed.'
      renderAdmin(res, detail)
    }
  }

  const respondUnauthenticated = (req: IncomingMessage, res: ServerResponse): void => {
    /* v8 ignore next -- node:http always sets url on server requests. */
    const path = new URL(req.url ?? '/', 'http://gateway.invalid').pathname
    if (path === '/api' || path.startsWith('/api/')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"dhx-gateway: sign in at /login"}')
      return
    }
    res.writeHead(303, { location: '/login' })
    res.end()
  }

  const proxyWithUpstreamSession = async (
    req: IncomingMessage,
    res: ServerResponse,
    sid: string,
    port: number,
    token: string,
  ): Promise<void> => {
    const acquire = async (): Promise<string> => {
      const jarred = jar.get(sid, port)
      if (jarred !== undefined) return jarred
      const minted = await mintUpstreamSession({ port, token })
      jar.set(sid, minted, port)
      return minted
    }
    const retryableWithoutBody = (req.method === 'GET' || req.method === 'HEAD')
      && req.headers['content-length'] === undefined
      && req.headers['transfer-encoding'] === undefined
    let cookie = await acquire()
    const status = await proxyRequest(req, res, { port, cookie, agent, forwardStatus: candidate => candidate !== 401 })
    if (status === 401 && retryableWithoutBody) {
      jar.clear(sid)
      cookie = await mintUpstreamSession({ port, token })
      jar.set(sid, cookie, port)
      await proxyRequest(req, res, { port, cookie, agent })
      return
    }
    if (status === 401) {
      // A bodied request cannot be replayed: drop the stale jar entry so the
      // next request re-acquires, and answer 401 for this one.
      jar.clear(sid)
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dhx-gateway: the upstream session expired; reload the page')
    }
  }

  const fallbackHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const cookies = parseCookies(req.headers.cookie)
    const raw = cookies.get(GATEWAY_COOKIE_NAME)
    const session = raw === undefined ? undefined : verifyGatewaySession(secret, raw)
    if (session === undefined || !store.hasUser(session.user) || store.isUserDisabled(session.user)) {
      respondUnauthenticated(req, res)
      return
    }
    let port: number
    let token: string
    try {
      const endpoint = await supervisor.ensureEndpoint(session.user)
      port = endpoint.port
      token = endpoint.token
    } catch (error) {
      log(`start failed for ${session.user}: ${(error as Error).message}`)
      respondHtml(res, 503, messagePage('Upstream unavailable', `Your workspace instance could not start: ${(error as Error).message}`))
      return
    }
    try {
      await proxyWithUpstreamSession(req, res, session.sid, port, token)
    } finally {
      supervisor.touch(session.user)
    }
  }

  /**
   * WebSocket upgrade handler for the upstream's stream mux path. It mirrors
   * the fallback seat's contract at the socket level: authenticate, ensure
   * the instance, mint the upstream cookie server-side, splice the upgraded
   * sockets, and retry the handshake exactly once when the upstream expires
   * the jarred cookie (an upgrade carries no body, so the retry never
   * replays bytes the browser sent).
   */
  const upgradeHandler = async (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): Promise<void> => {
    const session = authenticatedUser(req)
    if (session === undefined) {
      socket.destroy()
      return
    }
    let port: number
    let token: string
    try {
      const endpoint = await supervisor.ensureEndpoint(session.user)
      port = endpoint.port
      token = endpoint.token
    } catch (error) {
      log(`upgrade start failed for ${session.user}: ${(error as Error).message}`)
      socket.destroy()
      return
    }
    const acquire = async (): Promise<string> => {
      const jarred = jar.get(session.sid, port)
      if (jarred !== undefined) return jarred
      const minted = await mintUpstreamSession({ port, token })
      jar.set(session.sid, minted, port)
      return minted
    }
    let cookie: string
    try {
      cookie = await acquire()
    } catch {
      socket.destroy()
      return
    }
    const status = await proxyUpgrade(req, socket, head, {
      port,
      cookie,
      agent: upgradeAgent,
      onActivity: () => supervisor.touch(session.user),
    })
    if (status === 401) {
      jar.clear(session.sid)
      let minted: string
      try {
        minted = await mintUpstreamSession({ port, token })
      } catch {
        if (!socket.destroyed) socket.destroy()
        return
      }
      jar.set(session.sid, minted, port)
      await proxyUpgrade(req, socket, head, { port, cookie: minted, agent: upgradeAgent, onActivity: () => supervisor.touch(session.user) })
    }
    supervisor.touch(session.user)
  }

  return [
    webServer.register({ kind: 'exact', path: '/login', handler: loginHandler }),
    webServer.register({ kind: 'exact', path: '/logout', handler: logoutHandler }),
    webServer.register({ kind: 'prefix', path: '/invite', handler: inviteHandler }),
    webServer.register({ kind: 'prefix', path: '/gw-admin', handler: adminHandler }),
    webServer.registerUpgrade({ path: UPSTREAM_MUX_PATH, handler: upgradeHandler }),
    webServer.registerFallback(fallbackHandler),
    () => { upgradeAgent.destroy() },
  ]
}
