import { createHash, createHmac } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as Gateway from '../src/index.ts'

const FIXTURE_PATH = join(import.meta.dirname, 'fixtures/fake-dsh-web.mjs')

interface FixtureFacts {
  pid: number
  port: number
}

interface EchoBody {
  method: string
  path: string
  host: string | null
  cookie: string | null
  cookieName: string
  xForwardedFor: string | null
  xForwardedHost: string | null
  xForwardedProto: string | null
  origin: string | null
  referer: string | null
  body: string | null
  dshHome: string | null
  hasDeepseekKey: boolean
}

/** Cookie jar the tests use like a browser would. */
class Browser {
  #cookie: string | undefined

  get cookieHeader(): Record<string, string> {
    return this.#cookie === undefined ? {} : { cookie: this.#cookie }
  }

  absorb(response: Response): void {
    const setCookie = response.headers.getSetCookie()
    for (const header of setCookie) {
      const pair = header.split(';', 1)[0] ?? ''
      if (pair.startsWith('dhxgw_session=')) this.#cookie = pair
      if (pair.startsWith('dhxgw_session=;')) this.#cookie = undefined
    }
  }
}

async function formPost(origin: string, path: string, fields: Record<string, string>, browser?: Browser): Promise<Response> {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...browser?.cookieHeader,
    },
    body: new URLSearchParams(fields).toString(),
  })
  browser?.absorb(response)
  return response
}

describe('multi-user gateway over a real composition', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'dshgw-e2e-state-'))
  const usersRoot = join(stateRoot, 'users')
  const logSpy = vi.spyOn(console, 'log')
  let ctx: Context | undefined
  let origin: string
  const admin = new Browser()
  const member = new Browser()

  beforeAll(async () => {
    // The fixture's expire mode only enforces on /expire/ paths; every other
    // upstream request passes, so the rest of the suite exercises the normal
    // path while the dedicated test walks the 401 re-mint branches.
    process.env.FAKE_MODE = 'expire'
    const configPath = join(stateRoot, 'cordis.yml')
    const config = [
      '# Real-composition gateway test: the webserver and the gateway plugin,',
      '# with the fake upstream as the per-user dshCommand.',
      '- name: cordis:test-webserver',
      '  config:',
      '    host: 127.0.0.1',
      '    port: 0',
      '- name: cordis:test-dhx-gateway',
      '  config:',
      `    stateRoot: ${JSON.stringify(stateRoot)}`,
      `    usersRoot: ${JSON.stringify(usersRoot)}`,
      `    dshCommand: [${JSON.stringify(process.execPath)}, ${JSON.stringify(FIXTURE_PATH)}]`,
      '    startTimeoutMs: 10000',
    ].join('\n')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(configPath, config)
    ctx = await boot('dhx-gateway-test', configPath, undefined, (bootContext) => {
      bootContext.loader.builtins['test-webserver'] = WebServer
      bootContext.loader.builtins['test-dhx-gateway'] = Gateway
    })
    expect(ctx.webServer.port).toBeGreaterThan(0)
    origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  }, 30_000)

  afterAll(async () => {
    delete process.env.FAKE_MODE
    logSpy.mockRestore()
    await ctx?.fiber.dispose()
  })

  it('redirects unauthenticated browsers to the login page and 401s /api', async () => {
    const root = await fetch(`${origin}/`, { redirect: 'manual' })
    expect(root.status).toBe(303)
    expect(root.headers.get('location')).toBe('/login')
    const api = await fetch(`${origin}/api/session/list`, { redirect: 'manual' })
    expect(api.status).toBe(401)
    const login = await fetch(`${origin}/login`)
    expect(login.status).toBe(200)
    expect(await login.text()).toContain('Sign in')
  })

  it('prints a single-use bootstrap invite that creates the admin account', async () => {
    const line = logSpy.mock.calls.map(args => args.join(' ')).find(text => text.includes('bootstrap invite'))
    expect(line).toBeDefined()
    const invitePath = new URL(line?.split(' ').at(-1) as string).pathname
    const page = await fetch(`${origin}${invitePath}`)
    expect(page.status).toBe(200)
    const accepted = await formPost(origin, invitePath, { username: 'root', password: 'root-password' }, admin)
    expect(accepted.status).toBe(303)
    expect(accepted.headers.get('location')).toBe('/')
    // The invite is consumed: a second visit is gone.
    const again = await fetch(`${origin}${invitePath}`, { redirect: 'manual' })
    expect(again.status).toBe(404)
  })

  it('rejects a bad login', async () => {
    const response = await formPost(origin, '/login', { username: 'ghost', password: 'nope-nope' })
    expect(response.status).toBe(401)
    expect(await response.text()).toContain('Invalid username or password.')
  })

  it('answers method mismatches and empty forms on the named routes', async () => {
    const putLogin = await fetch(`${origin}/login`, { method: 'PUT', redirect: 'manual' })
    expect(putLogin.status).toBe(405)
    expect(putLogin.headers.get('allow')).toBe('GET, POST')
    const putLogout = await fetch(`${origin}/logout`, { method: 'PUT', redirect: 'manual' })
    expect(putLogout.status).toBe(405)
    expect(putLogout.headers.get('allow')).toBe('GET, POST')
    const putAdmin = await fetch(`${origin}/gw-admin`, { method: 'PUT', redirect: 'manual' })
    expect(putAdmin.status).toBe(405)
    // Missing form fields fall back to empty strings.
    const emptyLogin = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    })
    expect(emptyLogin.status).toBe(401)
  })

  it('logs the administrator in through the login form', async () => {
    const response = await formPost(origin, '/login', { username: 'root', password: 'root-password' })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/')
    // A signed-in visitor to /login is sent to the workspace root.
    const repeat = await fetch(`${origin}/login`, { headers: admin.cookieHeader, redirect: 'manual' })
    expect(repeat.status).toBe(303)
    expect(repeat.headers.get('location')).toBe('/')
  })

  it('accepts malformed invite tokens with the generic invalid page', async () => {
    const badEncoding = await fetch(`${origin}/invite/%zz`, { redirect: 'manual' })
    expect(badEncoding.status).toBe(404)
    expect(await badEncoding.text()).toContain('Invite required')
  })

  it('rejects invite form mistakes without consuming the invite', async () => {
    // Mint a fresh invite for the form-error tests.
    const invited = await formPost(origin, '/gw-admin/invite', { ttlMinutes: '30' }, admin)
    const invitePath = new URL((await invited.text()).match(/New invite link \(shown once\): (\S+?)<\//)?.[1] as string).pathname
    const put = await fetch(`${origin}${invitePath}`, { method: 'PUT', redirect: 'manual' })
    expect(put.status).toBe(405)
    const empty = await formPost(origin, invitePath, {})
    expect(empty.status).toBe(400)
    expect(await empty.text()).toContain('lowercase letters, digits, and dashes')
    const weak = await formPost(origin, invitePath, { username: 'form-test', password: 'short' })
    expect(weak.status).toBe(400)
    expect(await weak.text()).toContain('Passwords need at least 8 characters.')
    const badName = await formPost(origin, invitePath, { username: 'Bad Name', password: 'long enough' })
    expect(badName.status).toBe(400)
    expect(await badName.text()).toContain('lowercase letters, digits, and dashes')
    const taken = await formPost(origin, invitePath, { username: 'root', password: 'long enough' })
    expect(taken.status).toBe(400)
    expect(await taken.text()).toContain('already taken')
    // The invite survived every rejection and is still usable.
    const page = await fetch(`${origin}${invitePath}`)
    expect(page.status).toBe(200)
    const oversizedInvite = await formPost(origin, invitePath, { username: 'x'.repeat(40_000), password: 'x' })
    expect(oversizedInvite.status).toBe(413)
    expect(await oversizedInvite.text()).toContain('Request too large')
  })

  it('answers the generic failure message when persistence fails', async () => {
    if (process.platform === 'win32') return
    // Mint the invite to accept while the store still persists.
    const invited = await formPost(origin, '/gw-admin/invite', {}, admin)
    const invitePath = new URL((await invited.text()).match(/New invite link \(shown once\): (\S+?)<\//)?.[1] as string).pathname
    // A second invite to revoke: the failed persist keeps the in-memory
    // deletion, so revoking a different row keeps this one alive.
    const second = await formPost(origin, '/gw-admin/invite', {}, admin)
    const secondPath = new URL((await second.text()).match(/New invite link \(shown once\): (\S+?)<\//)?.[1] as string).pathname
    // Making the state root read-only fails every store persist with a plain
    // filesystem error, which the routes must not leak as an internal detail.
    chmodSync(stateRoot, 0o500)
    try {
      const secondId = createHash('sha256').update(decodeURIComponent(secondPath.slice('/invite/'.length)), 'utf8').digest('hex').slice(0, 12)
      const revoked = await formPost(origin, '/gw-admin/invite/revoke', { id: secondId }, admin)
      expect(revoked.status).toBe(200)
      expect(await revoked.text()).toContain('The action failed.')
      const rejected = await formPost(origin, invitePath, { username: 'boxed', password: 'long enough' })
      expect(rejected.status).toBe(400)
      expect(await rejected.text()).toContain('The account could not be created.')
    } finally {
      chmodSync(stateRoot, 0o700)
    }
  })

  it('answers 413 when a form exceeds the accepted size', async () => {
    const oversized = 'x'.repeat(40_000)
    const login = await formPost(origin, '/login', { username: oversized, password: 'x' })
    expect(login.status).toBe(413)
    expect(await login.text()).toContain('Request too large')
  })

  it('gives a signed-in but unknown or broken session the login page', async () => {
    const garbage = await fetch(`${origin}/login`, {
      headers: { cookie: 'dhxgw_session=broken.value' },
      redirect: 'manual',
    })
    expect(garbage.status).toBe(200)
    // A correctly signed cookie for an account that does not exist.
    const secret = readFileSync(join(stateRoot, 'secret.key'))
    const body = Buffer.from(JSON.stringify({ v: 1, sid: 'forged', user: 'ghost', iat: Date.now(), exp: Date.now() + 60_000 })).toString('base64url')
    const mac = createHmac('sha256', secret).update(body).digest('base64url')
    const ghost = await fetch(`${origin}/login`, {
      headers: { cookie: `dhxgw_session=${body}.${mac}` },
      redirect: 'manual',
    })
    expect(ghost.status).toBe(200)
  })

  it('routes the admin dashboard through requireAdmin', async () => {
    const anonymous = await fetch(`${origin}/gw-admin`, { redirect: 'manual' })
    expect(anonymous.status).toBe(303)
    expect(anonymous.headers.get('location')).toBe('/login')
    const anonymousPost = await formPost(origin, '/gw-admin/invite', {})
    expect(anonymousPost.status).toBe(303)
    const unknownAction = await formPost(origin, '/gw-admin/does-not-exist', {}, admin)
    expect(unknownAction.status).toBe(404)
    expect(await unknownAction.text()).toContain('Unknown action')
    const badTtl = await formPost(origin, '/gw-admin/invite', { ttlMinutes: 'abc' }, admin)
    expect(await badTtl.text()).toContain('Invite lifetime must be a positive number of minutes.')
    const zeroTtl = await formPost(origin, '/gw-admin/invite', { ttlMinutes: '0' }, admin)
    expect(await zeroTtl.text()).toContain('Invite lifetime must be a positive number of minutes.')
    const infiniteTtl = await formPost(origin, '/gw-admin/invite', { ttlMinutes: 'Infinity' }, admin)
    expect(await infiniteTtl.text()).toContain('Invite lifetime must be a positive number of minutes.')
    const oversizedAdmin = await formPost(origin, '/gw-admin/invite', { payload: 'x'.repeat(40_000) }, admin)
    expect(oversizedAdmin.status).toBe(413)
    const missingName = await formPost(origin, '/gw-admin/users/disable', {}, admin)
    expect(await missingName.text()).toContain('does not exist')
    const missingId = await formPost(origin, '/gw-admin/invite/revoke', {}, admin)
    expect(await missingId.text()).toContain('does not match exactly one invite')
  })

  it('proxies the admin session to a per-user upstream with rewritten headers', async () => {
    const response = await fetch(`${origin}/workspace/probe`, {
      headers: {
        ...admin.cookieHeader,
        'origin': 'https://gateway.example.com',
        'referer': 'https://gateway.example.com/page',
      },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as EchoBody
    expect(body.path).toBe('/workspace/probe')
    expect(body.host).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(body.cookie).toMatch(/^dsh_fixture_s1=/)
    expect(body.origin).toBeNull()
    expect(body.referer).toBeNull()
    expect(body.xForwardedHost).toBe(`127.0.0.1:${String(ctx?.webServer.port)}`)
    expect(body.xForwardedProto).toBe('http')
    expect(body.xForwardedFor).not.toBeNull()
    expect(body.dshHome).toBe(join(usersRoot, 'root', 'home'))
    expect(body.hasDeepseekKey).toBe(false)
    // The fixture wrote its facts into the per-user home: the child is alive.
    const facts = JSON.parse(readFileSync(join(usersRoot, 'root', 'home', 'fixture.json'), 'utf8')) as FixtureFacts
    expect(() => process.kill(facts.pid, 0)).not.toThrow()
    // A second request reuses the jar and the instance.
    const repeat = await fetch(`${origin}/workspace/again`, { headers: admin.cookieHeader })
    expect((await repeat.json() as EchoBody).host).toBe(body.host)
  })

  it('re-mints and retries when the upstream expires the session cookie', async () => {
    // The fixture accepts each minted cookie exactly once on /expire/ paths,
    // so this sequence walks every acquisition path deterministically:
    // jar hit, expired-cookie re-mint with GET retry, non-retryable POST 401,
    // and post-clear re-acquisition.
    const burned = await fetch(`${origin}/expire/1`, { headers: admin.cookieHeader })
    expect(burned.status).toBe(200)
    const retried = await fetch(`${origin}/expire/2`, { headers: admin.cookieHeader })
    expect(retried.status).toBe(200)
    expect((await retried.json() as EchoBody).cookieName).toMatch(/^dsh_fixture_s\d+$/)
    const stalePost = await fetch(`${origin}/expire/3`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...admin.cookieHeader },
      body: '{}',
      redirect: 'manual',
    })
    expect(stalePost.status).toBe(401)
    expect(await stalePost.text()).toContain('expired')
    const reacquired = await fetch(`${origin}/expire/4`, { headers: admin.cookieHeader })
    expect(reacquired.status).toBe(200)
  })

  it('keeps POST traffic working through the proxy', async () => {
    const response = await fetch(`${origin}/api/session/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...admin.cookieHeader },
      body: '{"hello":"gateway"}',
    })
    expect(response.status).toBe(200)
    const body = await response.json() as EchoBody
    expect(body.method).toBe('POST')
    expect(body.body).toBe('{"hello":"gateway"}')
  })

  it('serves the admin dashboard and mints admin invites for new members', async () => {
    const dashboard = await fetch(`${origin}/gw-admin`, { headers: admin.cookieHeader })
    expect(dashboard.status).toBe(200)
    const dashboardHtml = await dashboard.text()
    expect(dashboardHtml).toContain('<code>root</code>')
    expect(dashboardHtml).toContain('running on port')

    const invited = await formPost(origin, '/gw-admin/invite', { ttlMinutes: '' }, admin)
    expect(invited.status).toBe(200)
    const notice = (await invited.text()).match(/New invite link \(shown once\): (\S+?)<\//)
    expect(notice).not.toBeNull()
    const invitePath = new URL(notice?.[1] as string).pathname

    const accepted = await formPost(origin, invitePath, { username: 'member', password: 'member-password' }, member)
    expect(accepted.status).toBe(303)
    const memberPage = await fetch(`${origin}/gw-admin`, { headers: member.cookieHeader })
    expect(memberPage.status).toBe(403)
    // The member's own upstream instance starts with its own DSH_HOME.
    const proxied = await fetch(`${origin}/member/probe`, { headers: member.cookieHeader })
    expect((await proxied.json() as EchoBody).dshHome).toBe(join(usersRoot, 'member', 'home'))
  })

  it('revokes unused invites from the dashboard', async () => {
    const invited = await formPost(origin, '/gw-admin/invite', {}, admin)
    const invitePath = new URL((await invited.text()).match(/New invite link \(shown once\): (\S+?)<\//)?.[1] as string).pathname
    const token = decodeURIComponent(invitePath.slice('/invite/'.length))
    const liveId = createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12)
    const revoked = await formPost(origin, '/gw-admin/invite/revoke', { id: liveId }, admin)
    expect(revoked.status).toBe(200)
    const gone = await fetch(`${origin}${invitePath}`, { redirect: 'manual' })
    expect(gone.status).toBe(404)
  })

  it('invalidates sessions of disabled users and supports logout', async () => {
    const disabled = await formPost(origin, '/gw-admin/users/disable', { name: 'member' }, admin)
    expect(disabled.status).toBe(200)
    const bounced = await fetch(`${origin}/member/after-disable`, { ...member.cookieHeader, redirect: 'manual' })
    expect(bounced.status).toBe(303)
    expect(bounced.headers.get('location')).toBe('/login')
    await formPost(origin, '/gw-admin/users/enable', { name: 'member' }, admin)

    // GET /logout is the members' sign-out entry point: a confirmation page
    // while signed in, a redirect to the login form otherwise.
    const confirmPage = await fetch(`${origin}/logout`, { headers: member.cookieHeader, redirect: 'manual' })
    expect(confirmPage.status).toBe(200)
    const page = await confirmPage.text()
    expect(page).toContain('<form method="post" action="/logout">')
    expect(page).toContain('Sign out')
    const anonymous = await fetch(`${origin}/logout`, { redirect: 'manual' })
    expect(anonymous.status).toBe(303)
    expect(anonymous.headers.get('location')).toBe('/login')

    const out = await formPost(origin, '/logout', {}, member)
    expect(out.status).toBe(303)
    expect(out.headers.get('set-cookie')).toContain('Expires=Thu, 01 Jan 1970')
    // The session is really gone: the confirmation page now redirects too.
    const afterOut = await fetch(`${origin}/logout`, { headers: member.cookieHeader, redirect: 'manual' })
    expect(afterOut.status).toBe(303)
  })

  it('stops every upstream instance when the composition disposes', async () => {
    const facts = JSON.parse(readFileSync(join(usersRoot, 'root', 'home', 'fixture.json'), 'utf8')) as FixtureFacts
    await ctx?.fiber.dispose()
    ctx = undefined
    await vi.waitFor(() => {
      expect(() => process.kill(facts.pid, 0)).toThrow()
    }, { timeout: 10_000 })
  })
})
