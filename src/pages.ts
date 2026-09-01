/**
 * Server-rendered gateway pages: login, invite acceptance, and the admin
 * dashboard. Plain HTML forms without scripts — every mutation is a POST and
 * the session cookie's SameSite=Lax keeps cross-site forms from carrying it.
 * All dynamic text is escaped; account names are validated against the store
 * pattern before they ever reach markup.
 * @module
 */

const STYLE = `*{box-sizing:border-box}body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f5f7;color:#1a1c1e}
main{background:#fff;border:1px solid #ddd;border-radius:8px;padding:2rem;min-width:20rem;max-width:36rem}
h1{font-size:1.1rem;margin-top:0}table{border-collapse:collapse;width:100%;margin:.75rem 0}th,td{border:1px solid #ddd;padding:.35rem .5rem;text-align:left;font-size:.9rem}
label{display:block;margin:.75rem 0 .25rem;font-size:.9rem}input{width:100%;padding:.4rem;border:1px solid #ccc;border-radius:4px}
button{margin-top:.75rem;padding:.45rem .9rem;border:0;border-radius:4px;background:#2563eb;color:#fff;cursor:pointer}
button.danger{background:#b91c1c}p.notice{background:#ecfdf5;border:1px solid #a7f3d0;border-radius:4px;padding:.5rem;font-size:.9rem;word-break:break-all}
p.error{background:#fef2f2;border:1px solid #fecaca;border-radius:4px;padding:.5rem;font-size:.9rem}code{word-break:break-all}`

/**
 * Escape text for interpolation into HTML content.
 * @param value - raw text.
 * @returns the escaped form safe for element content and double-quoted attributes.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`
}

/**
 * Login page; a message renders as an error paragraph.
 * @param message - error text shown above the form, or undefined.
 * @returns the page HTML.
 */
export function loginPage(message: string | undefined): string {
  return page('DSH 网关 — 登录', `
<h1>DSH 多用户网关</h1>
${message === undefined ? '' : `<p class="error">${escapeHtml(message)}</p>`}
<form method="post" action="/login">
<label for="username">账号</label>
<input id="username" name="username" required autocapitalize="none" autocomplete="username">
<label for="password">密码</label>
<input id="password" name="password" type="password" required autocomplete="current-password">
<button type="submit">登录</button>
</form>`)
}

/**
 * Invite acceptance page.
 * @param token - the invite token from the URL.
 * @param message - error text shown above the form, or undefined.
 * @returns the page HTML.
 */
export function invitePage(token: string, message: string | undefined): string {
  return page('DSH 网关 — 接受邀请', `
<h1>创建你的账号</h1>
<p>本邀请链接仅可使用一次,请设置账号名和密码。</p>
${message === undefined ? '' : `<p class="error">${escapeHtml(message)}</p>`}
<form method="post" action="/invite/${encodeURIComponent(token)}">
<label for="username">账号</label>
<input id="username" name="username" required autocapitalize="none" autocomplete="username">
<label for="password">密码(至少 8 个字符)</label>
<input id="password" name="password" type="password" required autocomplete="new-password">
<button type="submit">创建账号</button>
</form>`)
}

/**
 * Admin dashboard: accounts, invites, invite creation, and running instances.
 * @param rows - rendered tables state.
 * @param rows.users - account rows.
 * @param rows.invites - invite rows.
 * @param rows.running - user names with a running upstream and their port.
 * @param notice - confirmation text (for example a freshly created invite link), or undefined.
 * @returns the page HTML.
 */
export function adminPage(
  rows: {
    users: Array<{ name: string; admin: boolean; disabled: boolean; createdAt: string }>
    invites: Array<{ id: string; createdAt: string; expiresAt: string | undefined; usedBy: string | undefined; bootstrap: boolean }>
    running: Array<{ user: string; port: number }>
  },
  notice: string | undefined,
): string {
  const runningByUser = new Map(rows.running.map(row => [row.user, row.port]))
  const userRows = rows.users.map(user => `
<tr><td><code>${escapeHtml(user.name)}</code></td><td>${user.admin ? '管理员' : ''}</td><td>${user.disabled ? '已停用' : '正常'}</td>
<td>${runningByUser.get(user.name) === undefined ? '' : `运行中(端口 ${String(runningByUser.get(user.name))})`}</td>
<td><form method="post" action="/gw-admin/users/${user.disabled ? 'enable' : 'disable'}"><input type="hidden" name="name" value="${escapeHtml(user.name)}"><button class="danger" type="submit">${user.disabled ? '启用' : '停用'}</button></form></td></tr>`)
  const inviteRows = rows.invites.map(invite => `
<tr><td><code>${escapeHtml(invite.id)}</code></td><td>${invite.bootstrap ? '引导' : '管理员'}</td><td>${escapeHtml(invite.createdAt)}</td>
<td>${invite.expiresAt === undefined ? '永不过期' : escapeHtml(invite.expiresAt)}</td><td>${invite.usedBy === undefined ? '未使用' : escapeHtml(invite.usedBy)}</td>
<td>${invite.usedBy === undefined ? `<form method="post" action="/gw-admin/invite/revoke"><input type="hidden" name="id" value="${escapeHtml(invite.id)}"><button class="danger" type="submit">撤销</button></form>` : ''}</td></tr>`)
  return page('DSH 网关 — 管理台', `
<h1>网关管理台</h1>
${notice === undefined ? '' : `<p class="notice">${notice}</p>`}
<h2>创建邀请</h2>
<form method="post" action="/gw-admin/invite">
<label for="ttl">有效期(分钟,留空永不过期)</label>
<input id="ttl" name="ttlMinutes" inputmode="numeric">
<button type="submit">创建邀请</button>
</form>
<h2>邀请列表</h2>
<table><tr><th>ID</th><th>类型</th><th>创建时间</th><th>过期时间</th><th>使用者</th><th></th></tr>${inviteRows.join('')}</table>
<h2>账号</h2>
<table><tr><th>账号</th><th>角色</th><th>状态</th><th>上游</th><th></th></tr>${userRows.join('')}</table>
<p><form method="post" action="/logout"><button type="submit">退出登录</button></form></p>`)
}

/**
 * Sign-out confirmation page. Reaching it by URL gives every member a logout
 * entry point; the actual session clear stays a POST form, matching the
 * no-scripts mutation rule.
 * @returns the page HTML.
 */
export function logoutPage(): string {
  return page('DSH 网关 — 退出登录', `
<h1>退出登录</h1>
<p>将在此浏览器退出网关会话。你的工作区实例会继续运行,数据保持不变。</p>
<form method="post" action="/logout">
<button class="danger" type="submit">退出登录</button>
</form>`)
}

/**
 * Simple message page for outcome diagnostics.
 * @param title - page title and heading.
 * @param body - message body text.
 * @returns the page HTML.
 */
export function messagePage(title: string, body: string): string {
  return page(`DSH Gateway — ${title}`, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>`)
}
