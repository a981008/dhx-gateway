/**
 * Plugin configuration for `dhx-gateway` with
 * load-time resolution: every deployment-varying choice is a validated field,
 * and defaults materialize here, never inside handlers.
 * @module
 */

import { join, resolve } from 'node:path'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'

/** Raw plugin config accepted from `cordis.yml`. */
export interface Config {
  /**
   * Absolute root holding the account store and the gateway signing secret.
   * Default: `<DSH_HOME>/dhx-gateway`.
   */
  stateRoot?: string
  /**
   * Absolute root holding one directory per user — `<name>/home` becomes the
   * upstream's `DSH_HOME` and `<name>/workspaces` its default working
   * directory. Default: `<stateRoot>/users`.
   */
  usersRoot?: string
  /**
   * argv launching one upstream `dsh web` process, for example `['dsh', 'web']`;
   * the gateway appends `--host`, `--port`, and `--no-open`.
   */
  dshCommand: string[]
  /** Gateway browser-session cookie lifetime in days. Default: 30. */
  sessionMaxAgeDays?: number
  /** Minutes of upstream inactivity before one running instance stops; omission never stops instances. */
  idleStopMinutes?: number
  /** Milliseconds to wait for one upstream instance's ready URL line. Default: 30000. */
  startTimeoutMs?: number
  /** Mark the gateway session cookie `Secure`; enable behind an HTTPS terminator. Default: false. */
  secureCookies?: boolean
  /** Print the single-use bootstrap invite URL when the account store has no users. Default: true. */
  printBootstrapInvite?: boolean
  /** Origin used to display invite links; omission prints loopback URLs built from the listening port. */
  publicOrigin?: string
}

export const Config: z<Config> = z.object({
  stateRoot: z.string(),
  usersRoot: z.string(),
  dshCommand: z.array(String).required(),
  sessionMaxAgeDays: z.number(),
  idleStopMinutes: z.number(),
  startTimeoutMs: z.number(),
  secureCookies: z.boolean(),
  printBootstrapInvite: z.boolean(),
  publicOrigin: z.string(),
})

/** Validated runtime form of {@link Config} with every default materialized. */
export interface ResolvedConfig {
  stateRoot: string
  usersRoot: string
  dshCommand: readonly string[]
  sessionMaxAgeDays: number
  idleStopMinutes: number | undefined
  startTimeoutMs: number
  secureCookies: boolean
  printBootstrapInvite: boolean
  publicOrigin: string | undefined
}

const DEFAULT_SESSION_MAX_AGE_DAYS = 30
const DEFAULT_START_TIMEOUT_MS = 30_000
const MAX_SESSION_MAX_AGE_DAYS = 3650

function resolveConfigPath(value: string): string {
  return resolve(expandHomePath(value))
}

function fail(field: string, requirement: string): never {
  throw new Error(`dhx-gateway: config ${field} ${requirement}`)
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * Validate raw config and materialize defaults; a violation throws at plugin
 * load, because a gateway that starts with an unusable launch command, port
 * policy, or state root would fail later in a harder-to-diagnose way.
 * @param config - raw config validated by the schemastery schema.
 * @param env - environment mapping used to resolve the default state root.
 * @returns the resolved config used by every gateway component.
 */
export function resolveConfig(config: Config, env: Record<string, string | undefined> = process.env): ResolvedConfig {
  const stateRoot = resolveConfigPath(config.stateRoot ?? join(resolveDshHome(undefined, env), 'dhx-gateway'))
  const usersRoot = resolveConfigPath(config.usersRoot ?? join(stateRoot, 'users'))
  if (config.dshCommand.length === 0) fail('dshCommand', 'must be a non-empty argv array')
  for (const part of config.dshCommand) {
    if (typeof part !== 'string' || part.length === 0) fail('dshCommand', 'must contain only non-empty strings')
  }
  const { sessionMaxAgeDays = DEFAULT_SESSION_MAX_AGE_DAYS } = config
  if (!isPositiveSafeInteger(sessionMaxAgeDays) || sessionMaxAgeDays > MAX_SESSION_MAX_AGE_DAYS) {
    fail('sessionMaxAgeDays', `must be a positive integer of at most ${String(MAX_SESSION_MAX_AGE_DAYS)} days`)
  }
  if (config.idleStopMinutes !== undefined && !(config.idleStopMinutes > 0)) {
    fail('idleStopMinutes', 'must be a positive number of minutes when set')
  }
  const startTimeoutMs = config.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
  if (!isPositiveSafeInteger(startTimeoutMs)) fail('startTimeoutMs', 'must be a positive integer of milliseconds')
  let publicOrigin: string | undefined
  if (config.publicOrigin !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(config.publicOrigin)
    } catch {
      fail('publicOrigin', 'must be an absolute http(s) origin')
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || (parsed.pathname !== '/' && parsed.pathname !== '')
      || parsed.search !== '' || parsed.hash !== '') {
      fail('publicOrigin', 'must be an origin without path, query, or fragment')
    }
    publicOrigin = parsed.origin
  }
  return {
    stateRoot,
    usersRoot,
    dshCommand: [...config.dshCommand],
    sessionMaxAgeDays,
    idleStopMinutes: config.idleStopMinutes,
    startTimeoutMs,
    secureCookies: config.secureCookies ?? false,
    printBootstrapInvite: config.printBootstrapInvite ?? true,
    publicOrigin,
  }
}
