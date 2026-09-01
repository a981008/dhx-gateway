/**
 * Durable gateway signing secret: one random key per state root, created
 * owner-only on first activation and reused afterwards, so session cookies
 * survive gateway restarts exactly like the upstream's own browser-session
 * credential survives upstream restarts.
 * @module
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SECRET_FILE_NAME = 'secret.key'
const SECRET_BYTES = 32

/**
 * Load the gateway signing secret from `stateRoot/secret.key`, creating a
 * random one (file mode 0600, directory mode 0700) when absent. A present but
 * undersized file fails loudly: a truncated secret would otherwise silently
 * invalidate every outstanding session cookie.
 * @param stateRoot - absolute gateway state root.
 * @returns the signing secret bytes.
 */
export function loadOrCreateGatewaySecret(stateRoot: string): Buffer {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  const file = join(stateRoot, SECRET_FILE_NAME)
  let existing: Buffer | undefined
  try {
    existing = readFileSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing !== undefined) {
    if (existing.byteLength < SECRET_BYTES) {
      throw new Error(
        `dhx-gateway: gateway secret at ${file} is ${String(existing.byteLength)} bytes; expected at least ${String(SECRET_BYTES)}`,
      )
    }
    return existing
  }
  const secret = randomBytes(SECRET_BYTES)
  try {
    writeFileSync(file, secret, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    // A concurrent activation of the same state root won the create race; its
    // secret is equally valid, so fall back to reading it instead of failing.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return readFileSync(file)
  }
  return secret
}
