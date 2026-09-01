/**
 * Package-owned invariant companion for `dhx-gateway`.
 * @module dhx-gateway/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dhx-gateway'

/** Cordis companion plugin name. */
export const name = 'dhx-gateway-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package's owned relations cannot be probed from
 * the teardown stream. Route disposer symmetry on the shared webserver is
 * already probed by the webserver companion's reserved-path registers, and
 * the fallback seat cannot be probed at `internal/plugin` time because the
 * notification fires before the disposing fiber's effects release the seat.
 * Upstream child-process ownership — every live child maps to one account
 * and none survive fiber disposal — is covered by the package's
 * real-composition HMR-safety test.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
