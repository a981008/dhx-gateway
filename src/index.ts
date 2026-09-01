/**
 * `dhx-gateway` — the multi-user serving
 * gateway. Composed as the only route owner of a webserver, it turns one
 * host process into a signed-in gateway for several people: each account
 * gets its own upstream `dsh web` child process with its own `DSH_HOME`, and
 * the gateway proxies authenticated browser traffic to it, including the
 * upstream's token/cookie handshake performed server-side. The gateway owns
 * accounts, invites, sessions, and the fallback seat; the upstream keeps
 * every harness concept, and no upstream package changes.
 * @module dhx-gateway
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, resolveConfig, type ResolvedConfig } from './config.ts'
import { createUpstreamAgent } from './proxy.ts'
import { loadOrCreateGatewaySecret } from './secret.ts'
import { registerGatewayRoutes } from './routes.ts'
import { AccountStore } from './store.ts'
import { InstanceSupervisor } from './supervisor.ts'
import { UpstreamCookieJar } from './upstream-jar.ts'

export const name = 'dhx-gateway'

/** Services required before the gateway can claim its routes. */
export const inject = ['webServer']

export { Config } from './config.ts'

/**
 * Activate the gateway: resolve config, open state, register routes on the
 * webserver, and print the bootstrap invite while the deployment has no
 * accounts. Disposal releases every route, stops every upstream instance,
 * and drops the upstream agent and cookie jar.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  const secret = loadOrCreateGatewaySecret(resolved.stateRoot)
  const store = AccountStore.open(join(resolved.stateRoot, 'users.json'))
  const supervisor = new InstanceSupervisor({
    dshCommand: resolved.dshCommand,
    usersRoot: resolved.usersRoot,
    startTimeoutMs: resolved.startTimeoutMs,
    idleStopMinutes: resolved.idleStopMinutes,
    log: (message) =>{  ctx.logger.info('%s', message) },
  })
  const jar = new UpstreamCookieJar()
  const agent = createUpstreamAgent()

  ctx.effect(function* () {
    for (const disposer of registerGatewayRoutes({
      ctx,
      resolved,
      store,
      secret,
      supervisor,
      jar,
      agent,
      log: (message) =>{  ctx.logger.info('%s', message) },
    })) {
      yield disposer
    }
    yield () =>{  agent.destroy() }
    yield () =>{  jar.clearAll() }
    yield () => supervisor.dispose()
  }, 'dhx-gateway')

  if (resolved.printBootstrapInvite) {
    void (async () => {
      if (store.countUsers() > 0) return
      const token = await store.createInvite({ bootstrap: true })
      const origin = resolved.publicOrigin ?? `http://127.0.0.1:${String(ctx.webServer.port)}`
      console.log(`dhx-gateway: bootstrap invite (single use): ${origin}/invite/${token}`)
    })().catch((error: unknown) => {
      ctx.logger.warn('dhx-gateway: could not print the bootstrap invite: %s', (error as Error).message)
    })
  }
}
