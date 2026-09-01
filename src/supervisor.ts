/**
 * Per-user upstream instance supervisor: one `dsh web` child process per
 * account, each with its own `DSH_HOME`, started on demand against an
 * OS-assigned loopback port, readiness taken from the process's ready URL
 * line, and optional idle shutdown. The URL line is the upstream's documented
 * supervisor protocol; nothing else about the child is parsed.
 * @module
 */

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { UpstreamEndpoint } from './upstream-jar.ts'

/** Stable supervisor failure codes the proxy maps to response diagnostics. */
export type StartErrorCode = 'start-timeout' | 'start-cooldown' | 'spawn-failed' | 'upstream-exited'

/** Typed start failure. */
export class StartError extends Error {
  /**
   * @param code - stable failure code.
   * @param message - diagnostic detail.
   */
  constructor(readonly code: StartErrorCode, message: string) {
    super(message)
  }
}

const READY_LINE_PREFIX = 'dsh web: '
const STOP_GRACE_MS = 5_000
const STOP_KILL_GRACE_MS = 2_000
const CRASH_COOLDOWN_MS = 5_000
/** Environment keys the operator's gateway process must not leak into user instances. */
const STRIPPED_ENV_KEYS: ReadonlySet<string> = new Set(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'])

/** One running upstream instance. */
interface RunningInstance {
  child: ChildProcessWithoutNullStreams
  endpoint: UpstreamEndpoint
  ready: Promise<UpstreamEndpoint>
  startedAtMs: number
  lastActivityMs: number
  stopping: boolean
  idleTimer: NodeJS.Timeout | undefined
}

/** Supervisor options resolved from the plugin config. */
export interface SupervisorOptions {
  /** argv launching one upstream `dsh web` process. */
  dshCommand: readonly string[]
  /** Absolute root holding one directory per user. */
  usersRoot: string
  /** Milliseconds to wait for the ready URL line. */
  startTimeoutMs: number
  /** Minutes of inactivity before one instance stops; undefined never stops. */
  idleStopMinutes: number | undefined
  /** Log sink for lifecycle and child output lines. */
  log: (message: string) => void
}

/** One admin-facing row describing a running instance. */
export interface RunningRow {
  user: string
  port: number
  startedAtMs: number
  lastActivityMs: number
}

function childEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !STRIPPED_ENV_KEYS.has(name)) env[name] = value
  }
  env.DSH_HOME = home
  return env
}

/**
 * Starts, tracks, and stops the upstream child processes. Concurrent
 * `ensureEndpoint` calls for one user share one start; an unexpected child
 * exit arms a short cooldown so a crash-looping upstream cannot spin the
 * gateway.
 */
export class InstanceSupervisor {
  private readonly running = new Map<string, RunningInstance>()
  private readonly pending = new Map<string, Promise<UpstreamEndpoint>>()
  private readonly lastExitMs = new Map<string, number>()

  constructor(private readonly options: SupervisorOptions) {}

  /**
   * Per-user `DSH_HOME` directory under the users root.
   * @param user - account name.
   * @returns the home directory path for one upstream instance.
   */
  homeDirectory(user: string): string {
    return join(this.options.usersRoot, user, 'home')
  }

  /**
   * Per-user default working directory under the users root.
   * @param user - account name.
   * @returns the default working-directory path for one upstream instance.
   */
  workspacesDirectory(user: string): string {
    return join(this.options.usersRoot, user, 'workspaces')
  }

  /**
   * Ensure one user's upstream is running and return its endpoint, starting
   * it when necessary. Concurrent callers share the same start.
   * @param user - account name; also the per-user directory name.
   * @returns the ready endpoint.
   * @throws {StartError} when the start fails or exceeds its deadline.
   */
  async ensureEndpoint(user: string): Promise<UpstreamEndpoint> {
    const existing = this.running.get(user)
    if (existing !== undefined && !existing.stopping) {
      await existing.ready
      this.touch(user)
      return existing.endpoint
    }
    const inFlight = this.pending.get(user)
    if (inFlight !== undefined) return inFlight
    const start = this.start(user)
    this.pending.set(user, start)
    try {
      return await start
    } finally {
      // While this start is pending, ensureEndpoint returns it instead of
      // creating a newer entry, so the pending slot is always ours here.
      this.pending.delete(user)
    }
  }

  /**
   * Record proxy activity for one user and re-arm the idle timer.
   * @param user - account name.
   */
  touch(user: string): void {
    const instance = this.running.get(user)
    if (instance === undefined) return
    instance.lastActivityMs = Date.now()
    this.armIdleTimer(user, instance)
  }

  /**
   * Whether the named user currently has a live child process.
   * @param user - account name.
   * @returns whether a running, non-stopping instance exists.
   */
  isRunning(user: string): boolean {
    const instance = this.running.get(user)
    return instance !== undefined && !instance.stopping
  }

  /**
   * Rows describing every running instance, for the admin page.
   * @returns one row per live instance.
   */
  runningRows(): RunningRow[] {
    return [...this.running.entries()]
      .filter(([, instance]) => !instance.stopping)
      .map(([user, instance]) => ({
        user,
        port: instance.endpoint.port,
        startedAtMs: instance.startedAtMs,
        lastActivityMs: instance.lastActivityMs,
      }))
  }

  /**
   * Stop one user's instance: SIGTERM, then SIGKILL after the grace period.
   * The upstream manages its own subprocess tree on shutdown.
   * @param user - account name.
   */
  async stop(user: string): Promise<void> {
    const instance = this.running.get(user)
    if (instance === undefined || instance.stopping) return
    instance.stopping = true
    this.clearIdleTimer(instance)
    await terminateChild(instance.child)
  }

  /** Stop every instance; awaited by the plugin's effect disposal. */
  async dispose(): Promise<void> {
    await Promise.all([...this.running.keys()].map(user => this.stop(user)))
  }

  private start(user: string): Promise<UpstreamEndpoint> {
    const lastExit = this.lastExitMs.get(user)
    if (lastExit !== undefined && Date.now() - lastExit < CRASH_COOLDOWN_MS) {
      return Promise.reject(new StartError(
        'start-cooldown',
        `upstream for ${user} exited recently; retry in a few seconds`,
      ))
    }
    const home = this.homeDirectory(user)
    const workspaces = this.workspacesDirectory(user)
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 })
      mkdirSync(workspaces, { recursive: true, mode: 0o700 })
    } catch (error) {
      return Promise.reject(new StartError('spawn-failed', `cannot create per-user directories under ${this.options.usersRoot}: ${(error as Error).message}`))
    }
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(
        this.options.dshCommand[0] as string,
        [...this.options.dshCommand.slice(1), '--host', '127.0.0.1', '--port', '0', '--no-open'],
        {
          cwd: workspaces,
          env: childEnvironment(home),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      ) as unknown as ChildProcessWithoutNullStreams
    } catch (error) {
      return Promise.reject(new StartError('spawn-failed', `cannot spawn ${JSON.stringify(this.options.dshCommand[0])}: ${(error as Error).message}`))
    }
    const ready = this.awaitReady(user, child)
    const instance: RunningInstance = {
      child,
      endpoint: { port: 0, token: '' },
      ready,
      startedAtMs: Date.now(),
      lastActivityMs: Date.now(),
      stopping: false,
      idleTimer: undefined,
    }
    this.running.set(user, instance)
    void ready.then((endpoint) => {
      instance.endpoint = endpoint
      this.armIdleTimer(user, instance)
    }, () => {})
    return ready
  }

  private awaitReady(user: string, child: ChildProcessWithoutNullStreams): Promise<UpstreamEndpoint> {
    return new Promise<UpstreamEndpoint>((resolve, reject) => {
      let settled = false
      let stdoutRest = ''
      const timer = setTimeout(() => {
        settle()
        const instance = this.running.get(user)
        /* v8 ignore next 1 -- close and stop remove or settle the entry
        before the timer can fire again; the guard covers the timer race. */
        if (instance?.child === child) instance.stopping = true
        void this.killNow(child)
        reject(new StartError(
          'start-timeout',
          `upstream for ${user} printed no ready URL line within ${String(this.options.startTimeoutMs)}ms; dshCommand must launch \`dsh web\` with its URL line enabled`,
        ))
      }, this.options.startTimeoutMs)
      const settle = (): void => {
        // Idempotent by body: promise settlement and listener removal tolerate
        // repeated calls, and the close handler re-checks `settled`.
        settled = true
        clearTimeout(timer)
        child.stdout.off('data', onStdout)
      }
      const onStdout = (chunk: Buffer): void => {
        this.options.log(`[${user}] ${chunk.toString('utf8').trimEnd()}`)
        stdoutRest += chunk.toString('utf8')
        for (;;) {
          const newline = stdoutRest.indexOf('\n')
          if (newline === -1) break
          const line = stdoutRest.slice(0, newline).trim()
          stdoutRest = stdoutRest.slice(newline + 1)
          if (!line.startsWith(READY_LINE_PREFIX)) continue
          /* v8 ignore next 1 -- the split of a nonempty line always yields
          a first element; the fallback satisfies noUncheckedIndexedAccess. */
          const urlText = line.slice(READY_LINE_PREFIX.length).split(' (')[0]?.trim() ?? ''
          let url: URL
          try {
            url = new URL(urlText)
          } catch {
            continue
          }
          const port = Number(url.port)
          const token = url.searchParams.get('token') ?? ''
          if (!Number.isInteger(port) || port <= 0 || port > 65535 || token === '') continue
          settle()
          resolve({ port, token })
          return
        }
      }
      child.stdout.on('data', onStdout)
      child.stderr.on('data', (chunk: Buffer) => {
        this.options.log(`[${user}] ${chunk.toString('utf8').trimEnd()}`)
      })
      child.on('error', (error) => {
        settle()
        reject(new StartError('spawn-failed', `cannot spawn ${JSON.stringify(this.options.dshCommand[0])}: ${error.message}`))
      })
      child.on('close', (code, signal) => {
        const instance = this.running.get(user)
        if (instance?.child === child) {
          this.running.delete(user)
          this.clearIdleTimer(instance)
          if (!instance.stopping) this.lastExitMs.set(user, Date.now())
        }
        this.options.log(`[${user}] upstream exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
        if (!settled) {
          settle()
          reject(new StartError('upstream-exited', `upstream for ${user} exited before its ready URL line`))
        }
      })
    })
  }

  private armIdleTimer(user: string, instance: RunningInstance): void {
    this.clearIdleTimer(instance)
    const idleMs = this.options.idleStopMinutes === undefined ? undefined : this.options.idleStopMinutes * 60_000
    if (idleMs === undefined) return
    instance.idleTimer = setTimeout(() => {
      const current = this.running.get(user)
      /* v8 ignore next 1 -- stop and close clear this timer whenever the
      instance stops or is replaced; the guard covers the callback race. */
      if (current !== instance || instance.stopping) return
      // setTimeout never fires early, so the idle deadline is always met here.
      this.options.log(`[${user}] stopping idle upstream`)
      void this.stop(user)
    }, idleMs)
  }

  private clearIdleTimer(instance: RunningInstance): void {
    if (instance.idleTimer !== undefined) {
      clearTimeout(instance.idleTimer)
      instance.idleTimer = undefined
    }
  }

  private async killNow(child: ChildProcess): Promise<void> {
    child.kill('SIGKILL')
    await Promise.race([once(child, 'close'), new Promise<void>(resolve => setTimeout(resolve, STOP_KILL_GRACE_MS))])
  }
}

async function terminateChild(child: ChildProcess): Promise<void> {
  const closed = once(child, 'close')
  child.kill('SIGTERM')
  const grace = new Promise<void>(resolve => setTimeout(resolve, STOP_GRACE_MS))
  await Promise.race([closed, grace])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, STOP_KILL_GRACE_MS))])
  }
}
