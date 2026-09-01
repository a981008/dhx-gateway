import { describe, expect, it } from 'vitest'
import { adminPage, escapeHtml, invitePage, loginPage, messagePage } from '../src/pages.ts'

describe('gateway pages', () => {
  it('escapes HTML-sensitive text', () => {
    expect(escapeHtml('<script>&"\'')).toBe('&lt;script&gt;&amp;&quot;&#39;')
  })

  it('renders the login form and optional error', () => {
    const plain = loginPage(undefined)
    expect(plain).toContain('<form method="post" action="/login">')
    expect(plain).toContain('name="username"')
    expect(plain).toContain('type="password"')
    expect(loginPage('Invalid username or password.')).toContain('Invalid username or password.')
  })

  it('renders the invite form with the encoded token', () => {
    const page = invitePage('tok/123?x', undefined)
    expect(page).toContain('action="/invite/tok%2F123%3Fx"')
    expect(invitePage('tok', 'Already used.')).toContain('Already used.')
  })

  it('renders the admin dashboard with users, invites, and running ports', () => {
    const page = adminPage(
      {
        users: [{ name: 'alice', admin: true, disabled: false, createdAt: '2026-01-01' }],
        invites: [
          { id: 'abc123', createdAt: '2026-01-02', expiresAt: undefined, usedBy: undefined, bootstrap: false },
          { id: 'def456', createdAt: '2026-01-03', expiresAt: '2026-02-01T00:00:00.000Z', usedBy: 'bob', bootstrap: false },
        ],
        running: [{ user: 'alice', port: 4321 }],
      },
      'New invite link: /invite/xyz',
    )
    expect(page).toContain('<code>alice</code>')
    expect(page).toContain('running on port 4321')
    expect(page).toContain('action="/gw-admin/users/disable"')
    expect(page).toContain('<code>abc123</code>')
    expect(page).toContain('action="/gw-admin/invite/revoke"')
    expect(page).toContain('New invite link: /invite/xyz')
    expect(page).toContain('<td>never</td>')
    expect(page).toContain('<td>2026-02-01T00:00:00.000Z</td>')
    expect(page).toContain('<td>bob</td>')
  })

  it('escapes dynamic values on the admin dashboard', () => {
    const page = adminPage(
      {
        users: [{ name: '<img>', admin: false, disabled: true, createdAt: 'x' }],
        invites: [],
        running: [],
      },
      undefined,
    )
    expect(page).not.toContain('<img>')
    expect(page).toContain('&lt;img&gt;')
    expect(page).toContain('action="/gw-admin/users/enable"')
  })

  it('renders message pages with escaped bodies', () => {
    const page = messagePage('Invite invalid', 'Token <bad>')
    expect(page).toContain('Invite invalid')
    expect(page).toContain('Token &lt;bad&gt;')
    expect(page).not.toContain('<bad>')
  })
})
