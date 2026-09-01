/**
 * Gateway account store: users, hashed passwords, and single-use invite
 * tokens in one owner-only JSON file. Reads are synchronous over the
 * in-memory state (the gateway process is the single writer); every mutation
 * serializes through an internal queue and commits with an atomic
 * owner-only file replacement, so a crash leaves either the old or the new
 * complete store.
 * @module
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, verifyPassword } from './password.ts'

/** Account names are directory names too: lowercase alphanumerics and dashes. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/** Stable error codes routes map to user-facing messages. */
export type StoreErrorCode =
  | 'invalid-username'
  | 'username-taken'
  | 'weak-password'
  | 'invalid-invite'
  | 'unknown-user'

/** Typed store rejection carrying a stable code. */
export class StoreError extends Error {
  /**
   * @param code - stable error code.
   * @param message - diagnostic detail.
   */
  constructor(readonly code: StoreErrorCode, message: string) {
    super(message)
  }
}

interface StoredUser {
  passwordHash: string
  createdAt: string
  admin: boolean
  disabled: boolean
}

interface StoredInvite {
  createdAt: string
  expiresAt: string | undefined
  usedBy: string | undefined
  bootstrap: boolean
  /** Plaintext retained only for the bootstrap invite, which must be re-displayable until first use. */
  token: string | undefined
}

interface StoreFile {
  version: number
  users: Record<string, StoredUser>
  invites: Record<string, StoredInvite>
}

/** Read-only account row served to the admin page. */
export interface UserRow {
  name: string
  admin: boolean
  disabled: boolean
  createdAt: string
}

/** Read-only invite row served to the admin page; `id` is the token-hash prefix. */
export interface InviteRow {
  id: string
  createdAt: string
  expiresAt: string | undefined
  usedBy: string | undefined
  bootstrap: boolean
}

const STORE_VERSION = 1
const INVITE_TOKEN_BYTES = 24
const INVITE_ID_PREFIX_LENGTH = 12

function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function assertStoreShape(value: unknown, file: string): asserts value is StoreFile {
  if (!isRecord(value) || value.version !== STORE_VERSION
    || !isRecord(value.users) || !isRecord(value.invites)) {
    throw new Error(`dhx-gateway: account store at ${file} is not a version ${String(STORE_VERSION)} store`)
  }
  for (const user of Object.values(value.users)) {
    if (!isRecord(user) || typeof user.passwordHash !== 'string'
      || typeof user.createdAt !== 'string' || typeof user.admin !== 'boolean'
      || typeof user.disabled !== 'boolean') {
      throw new Error(`dhx-gateway: account store at ${file} holds a malformed user row`)
    }
  }
  for (const invite of Object.values(value.invites)) {
    if (!isRecord(invite) || typeof invite.createdAt !== 'string'
      || (invite.expiresAt !== undefined && typeof invite.expiresAt !== 'string')
      || (invite.usedBy !== undefined && typeof invite.usedBy !== 'string')
      || typeof invite.bootstrap !== 'boolean'
      || (invite.token !== undefined && typeof invite.token !== 'string')) {
      throw new Error(`dhx-gateway: account store at ${file} holds a malformed invite row`)
    }
  }
}

function inviteExpired(invite: StoredInvite, now: number): boolean {
  return invite.expiresAt !== undefined && Date.parse(invite.expiresAt) <= now
}

/**
 * Durable account and invite state for one gateway deployment.
 */
export class AccountStore {
  private constructor(
    private readonly file: string,
    private data: StoreFile,
  ) {}

  /**
   * Open the store at `file`, initializing an empty in-memory store when the
   * file does not exist yet. A present but unreadable or wrong-version file
   * fails loudly instead of falling back to an empty store, which would
   * silently drop every account.
   * @param file - absolute store path.
   * @returns the opened store.
   */
  static open(file: string): AccountStore {
    if (!existsSync(file)) {
      return new AccountStore(file, { version: STORE_VERSION, users: {}, invites: {} })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`dhx-gateway: account store at ${file} is not valid JSON: ${(error as Error).message}`)
    }
    assertStoreShape(parsed, file)
    return new AccountStore(file, parsed)
  }

  /**
   * Number of accounts; zero keeps the bootstrap invite alive.
   * @returns the account count.
   */
  countUsers(): number {
    return Object.keys(this.data.users).length
  }

  /**
   * Whether the named account exists.
   * @param name - account name.
   * @returns whether the account is present in the store.
   */
  hasUser(name: string): boolean {
    return this.data.users[name] !== undefined
  }

  /**
   * Whether the named account is disabled. An unknown account reports
   * disabled so every authorization check fails closed on the same answer.
   * @param name - account name.
   * @returns whether the account is disabled or unknown.
   */
  isUserDisabled(name: string): boolean {
    return this.data.users[name]?.disabled ?? true
  }

  /**
   * Whether the named account carries the admin flag. Unknown accounts are not admin.
   * @param name - account name.
   * @returns whether the account is an administrator.
   */
  isUserAdmin(name: string): boolean {
    return this.data.users[name]?.admin ?? false
  }

  /**
   * All account rows ordered by creation time, then name.
   * @returns the account rows for the admin page.
   */
  getUserRows(): UserRow[] {
    return Object.entries(this.data.users)
      .map(([name, user]) => ({ name, admin: user.admin, disabled: user.disabled, createdAt: user.createdAt }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
  }

  /**
   * All invite rows ordered by creation time; each id is the token-hash prefix.
   * @returns the invite rows for the admin page.
   */
  getInviteRows(): InviteRow[] {
    return Object.entries(this.data.invites)
      .map(([tokenHash, invite]) => ({
        id: tokenHash.slice(0, INVITE_ID_PREFIX_LENGTH),
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        usedBy: invite.usedBy,
        bootstrap: invite.bootstrap,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Whether one presented invite token is currently acceptable.
   * @param token - raw invite token from the invite URL.
   * @returns usability plus the reason when unusable.
   */
  describeInvite(token: string): { usable: boolean; reason: 'unknown' | 'used' | 'expired' } {
    const invite = this.data.invites[hashInviteToken(token)]
    if (invite === undefined) return { usable: false, reason: 'unknown' }
    if (invite.usedBy !== undefined) return { usable: false, reason: 'used' }
    if (inviteExpired(invite, Date.now())) return { usable: false, reason: 'expired' }
    return { usable: true, reason: 'unknown' }
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const tail = this.tail.then(operation, operation)
    this.tail = tail.then(() => undefined, () => undefined)
    return tail
  }

  private tail: Promise<unknown> = Promise.resolve()

  private async persist(): Promise<void> {
    await writeFileAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  /**
   * Create one single-use invite and return its plaintext token exactly once.
   * The store keeps only the token hash; the bootstrap invite additionally
   * retains its token so re-activation of an empty deployment re-displays the
   * same link instead of minting a second live invite.
   * @param options - bootstrap invites never expire and grant the admin flag.
   * @param options.bootstrap - whether this invite creates the deployment's admin account.
   * @param options.ttlMinutes - minutes until expiry; bootstrap invites ignore this.
   * @returns the plaintext invite token.
   */
  async createInvite(options: { bootstrap?: boolean; ttlMinutes?: number } = {}): Promise<string> {
    return this.run(async () => {
      const bootstrap = options.bootstrap ?? false
      if (bootstrap) {
        const existing = Object.values(this.data.invites).find(
          invite => invite.bootstrap && invite.usedBy === undefined && invite.token !== undefined,
        )
        if (existing?.token !== undefined) return existing.token
      }
      const token = randomBytes(INVITE_TOKEN_BYTES).toString('base64url')
      const createdAt = new Date().toISOString()
      const expiresAt = bootstrap || options.ttlMinutes === undefined
        ? undefined
        : new Date(Date.now() + options.ttlMinutes * 60_000).toISOString()
      this.data.invites[hashInviteToken(token)] = {
        createdAt,
        expiresAt,
        usedBy: undefined,
        bootstrap,
        token: bootstrap ? token : undefined,
      }
      await this.persist()
      return token
    })
  }

  /**
   * Consume one invite by creating its account. The token is single-use: a
   * second accept of the same token fails after the first commit.
   * @param token - presented plaintext invite token.
   * @param username - requested account name.
   * @param password - requested password, at least {@link MIN_PASSWORD_LENGTH} bytes.
   * @returns the created account name.
   * @throws {StoreError} with a stable code for every rejection reason.
   */
  async acceptInvite(token: string, username: string, password: string): Promise<string> {
    return this.run(async () => {
      if (!USERNAME_PATTERN.test(username)) throw new StoreError('invalid-username', `account name ${JSON.stringify(username)} is not ${String(USERNAME_PATTERN)}`)
      if (this.data.users[username] !== undefined) throw new StoreError('username-taken', `account name ${JSON.stringify(username)} already exists`)
      if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        throw new StoreError('weak-password', `password must be ${String(MIN_PASSWORD_LENGTH)}–${String(MAX_PASSWORD_LENGTH)} characters`)
      }
      const tokenHash = hashInviteToken(token)
      const invite = this.data.invites[tokenHash]
      if (invite === undefined || invite.usedBy !== undefined || inviteExpired(invite, Date.now())) {
        throw new StoreError('invalid-invite', 'the invite is unknown, already used, or expired')
      }
      const passwordHash = await hashPassword(password)
      this.data.users[username] = {
        passwordHash,
        createdAt: new Date().toISOString(),
        admin: invite.bootstrap,
        disabled: false,
      }
      invite.usedBy = username
      await this.persist()
      return username
    })
  }

  /**
   * Verify a login pair. Disabled accounts never verify.
   * @param username - presented account name.
   * @param password - presented password.
   * @returns true only for an existing, enabled account with a matching password.
   */
  async verifyLogin(username: string, password: string): Promise<boolean> {
    const user = this.data.users[username]
    if (user === undefined || user.disabled) return false
    return verifyPassword(password, user.passwordHash)
  }

  /**
   * Enable or disable one account. Disabled accounts fail login and lose
   * gateway session validity on their next request.
   * @param name - account name.
   * @param disabled - next disabled state.
   * @throws {StoreError} code `unknown-user` when the account does not exist.
   */
  async setDisabled(name: string, disabled: boolean): Promise<void> {
    await this.run(async () => {
      const user = this.data.users[name]
      if (user === undefined) throw new StoreError('unknown-user', `account ${JSON.stringify(name)} does not exist`)
      user.disabled = disabled
      await this.persist()
    })
  }

  /**
   * Revoke one invite by its token-hash prefix id.
   * @param id - the prefix shown on the admin page.
   * @throws {StoreError} code `invalid-invite` when the prefix matches zero or several invites.
   */
  async revokeInvite(id: string): Promise<void> {
    await this.run(async () => {
      const matches = Object.keys(this.data.invites).filter(tokenHash => tokenHash.startsWith(id))
      if (matches.length !== 1) {
        throw new StoreError('invalid-invite', `invite id ${JSON.stringify(id)} does not match exactly one invite`)
      }
      const removed = matches[0] as string
      this.data.invites = Object.fromEntries(
        Object.entries(this.data.invites).filter(([tokenHash]) => tokenHash !== removed),
      )
      await this.persist()
    })
  }
}
