// The Host's UI endpoint (ADR-003 items 1–2, frozen; ADR-002 D2, D3): a named pipe on Windows, a
// Unix socket elsewhere, never TCP or HTTP. Step 1 of the boot binds it, and the bind is the
// Host's single-instance mutex (ADR-002 D3; the decision itself is decideBind's, injected as
// `decide` by host/wiring).
//
// - Unix socket: the run directory is created `0700` (and set to `0700` when it already exists),
//   the socket `0600` right after the bind (ADR-003 item 1; 09 §1). The directory keeps the socket
//   owner-only in the moment between the bind and the chmod.
// - Named pipe: created by the owner-only pipe helper (windowsPipeSecurity.ts; ADR-003 item 2, as
//   spike SP-05 made it mandatory) with the protected DACL and remote clients rejected; the helper
//   hands each connected client over as a socket. Without the helper a named pipe is never served:
//   the bind fails closed with PIPE_ACL_UNAVAILABLE, never a Node pipe with the default DACL.
// - In use: a socket path holding something that is not a socket is never touched; a socket that
//   refuses the connection is stale; a live endpoint is asked `probeExisting` (a `hello`). What
//   follows is `decide`'s: bound, ALREADY_RUNNING, remove the stale socket and bind once more, or
//   an error the boot logs (FM-008, FM-009, FM-037).
// - Every accepted connection is held: the endpoint itself never reads or writes it, and hands it
//   to `accept`, the auth layer (host/transport/connection.ts: hello first with its 5 s timeout,
//   no byte before authentication, ADR-003 item 2; 18 C-11; throttling, later: ISSUE-024).
//   Without `accept` a connection stays silent until it closes. A named pipe's connections come
//   from the owner-only pipe helper and are held and accepted the same way.
// - `close` ends the held connections, stops listening and removes the socket file.
//
// The endpoint's kind, not the OS, selects the steps (R18: the OS was read by the platform adapter
// that produced the endpoint).
import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import type { HostEndpoint } from '@dwarfai/contracts'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { BindAttempt, BindDecision } from '../../wiring/singleInstance'
import {
  PIPE_ACL_UNAVAILABLE,
  PIPE_NAME_IN_USE,
  type ListenOwnerOnlyPipe
} from './windowsPipeSecurity'

/** What a live endpoint answered when asked whether it is a Host. */
export type ExistingEndpoint = 'answers-hello' | 'no-hello'

export interface EndpointServerDeps {
  log: DiagnosticsLog
  scheduler: Scheduler
  /** The single-instance rule (decideBind, ADR-002 D3). */
  decide: (attempt: BindAttempt) => BindDecision
  /**
   * Asks a live endpoint, over a connection to it, whether it is a Host that answers `hello`. The
   * caller closes the connection afterwards.
   */
  probeExisting: (connection: Socket) => Promise<ExistingEndpoint>
  /**
   * Creates a named pipe owner-only (ADR-003 item 2): the native helper in production. A
   * named-pipe endpoint without it is never served (PIPE_ACL_UNAVAILABLE).
   */
  ownerOnlyPipe?: ListenOwnerOnlyPipe
  /** Takes each accepted connection (the auth layer); the endpoint still ends it on close. */
  accept?: (connection: Socket) => void
}

export interface BoundEndpoint {
  /** The pipe name or socket path the endpoint listens on: always a path, never a port. */
  address(): string
  /** The connections accepted and held right now. */
  readonly heldConnections: number
  /** Ends the held connections, stops listening and removes the socket file. */
  close(): Promise<void>
}

export type BindOutcome = { kind: 'bound'; endpoint: BoundEndpoint } | { kind: 'already-running' }

/**
 * A bind that ended in an error. `code` is what the boot logs as the step's `errCode`; `detail`,
 * a fixed phrase such as a read's cause, reaches the log only through the error's stack.
 */
export class EndpointBindError extends Error {
  constructor(
    readonly code: string,
    detail?: string
  ) {
    super(`the UI endpoint could not be bound: ${code}${detail === undefined ? '' : `, ${detail}`}`)
    this.name = 'EndpointBindError'
  }
}

/** The run directory and socket modes of ADR-003 item 1 and 09 §1. */
export const RUN_DIR_MODE = 0o700
export const SOCKET_MODE = 0o600

/**
 * The bound on connecting to an endpoint in use before it is asked for `hello`. The package names
 * none; a local connect answers at once, so 2 000 ms only stops a wedged endpoint from holding
 * the boot (the hello itself has its own 5 s bound, ADR-003 item 5).
 */
export const PROBE_CONNECT_TIMEOUT_MS = 2_000

const SUBSYSTEM = 'host'

/** A bound endpoint before it serves: how it stops, and the connections it holds. */
interface Listener {
  close(): Promise<void>
  held: Set<Socket>
}

export async function bindEndpoint(
  endpoint: HostEndpoint,
  deps: EndpointServerDeps
): Promise<BindOutcome> {
  if (endpoint.kind === 'unix-socket') await prepareRunDirectory(endpoint.dir)
  let retried = false
  for (;;) {
    const { attempt, listener } = await tryBind(endpoint, deps, retried)
    const decision = deps.decide(attempt)
    switch (decision.kind) {
      case 'continue':
        if (listener === undefined) throw new EndpointBindError('ENDPOINT_NOT_LISTENING')
        return { kind: 'bound', endpoint: await serve(endpoint, listener) }
      case 'exit':
        return { kind: 'already-running' }
      case 'remove-stale-and-retry':
        await rm(endpoint.path, { force: true })
        deps.log.record({
          level: 'info',
          event: 'host.endpoint.stale-removed',
          subsystem: SUBSYSTEM,
          msg: 'a stale socket file with no listener was removed before binding again'
        })
        retried = true
        break
      case 'error':
        throw new EndpointBindError(
          decision.cause === 'bind-failed'
            ? decision.errCode
            : decision.cause === 'stale-socket-again'
              ? 'ENDPOINT_STALE_AGAIN'
              : 'ENDPOINT_IN_USE_WITHOUT_HELLO'
        )
    }
  }
}

/** `0700`, created with its parents when missing; a symlink or a file there is refused. */
async function prepareRunDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: RUN_DIR_MODE })
  const stats = await lstat(dir)
  if (!stats.isDirectory()) throw new EndpointBindError('ENDPOINT_RUN_DIR_NOT_A_DIRECTORY')
  await chmod(dir, RUN_DIR_MODE)
}

async function tryBind(
  endpoint: HostEndpoint,
  deps: EndpointServerDeps,
  retried: boolean
): Promise<{ attempt: BindAttempt; listener?: Listener }> {
  const held = new Set<Socket>()
  // Held, and never written to or read here: nothing reaches a connection before it
  // authenticates, which is the auth layer's to decide.
  const hold = (socket: Socket): void => {
    held.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => held.delete(socket))
    deps.accept?.(socket)
  }
  const listened =
    endpoint.kind === 'named-pipe'
      ? await listenOwnerOnly(endpoint.path, deps, hold)
      : await listenSocket(endpoint.path, deps.log, hold)
  if (listened.ok) {
    return { attempt: { outcome: 'bound', retried }, listener: { close: listened.close, held } }
  }
  if (listened.code !== PIPE_NAME_IN_USE) {
    return { attempt: { outcome: 'failed', errCode: listened.code, retried } }
  }
  return { attempt: { outcome: 'in-use', existing: await whoHolds(endpoint, deps), retried } }
}

type Listened = { ok: true; close: () => Promise<void> } | { ok: false; code: string }

/** A Unix socket from Node's `net`; an accept failure after the bind is logged. */
function listenSocket(
  path: string,
  log: DiagnosticsLog,
  hold: (socket: Socket) => void
): Promise<Listened> {
  const server: Server = createServer(hold)
  return new Promise((resolve) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      resolve({ ok: false, code: error.code ?? 'unknown' })
    )
    server.listen(path, () => {
      server.removeAllListeners('error')
      server.on('error', (error: NodeJS.ErrnoException) =>
        logAcceptError(log, error.code ?? error.name)
      )
      resolve({ ok: true, close: () => new Promise((done) => server.close(() => done())) })
    })
  })
}

/** A named pipe from the owner-only pipe helper (ADR-003 item 2); never one without it. */
async function listenOwnerOnly(
  path: string,
  deps: EndpointServerDeps,
  hold: (socket: Socket) => void
): Promise<Listened> {
  if (deps.ownerOnlyPipe === undefined) return { ok: false, code: PIPE_ACL_UNAVAILABLE }
  const outcome = await deps.ownerOnlyPipe(path, {
    onConnection: hold,
    onError: (code) => logAcceptError(deps.log, code)
  })
  if (outcome.ok) return { ok: true, close: () => outcome.server.close() }
  if (outcome.code === PIPE_ACL_UNAVAILABLE) {
    deps.log.record({
      level: 'error',
      event: 'host.endpoint.acl',
      subsystem: SUBSYSTEM,
      outcome: 'failed',
      ...(outcome.causeClass === undefined ? {} : { causeClass: outcome.causeClass }),
      msg: 'the owner-only pipe helper is unavailable, so the UI pipe is not created'
    })
  }
  return { ok: false, code: outcome.code }
}

/** An accept failure after the bind (for example out of file handles) is logged; it never ends the Host. */
function logAcceptError(log: DiagnosticsLog, errCode: string): void {
  log.record({ level: 'error', event: 'host.endpoint.error', subsystem: SUBSYSTEM, errCode })
}

/** What holds an endpoint in use (ADR-002 D3). */
async function whoHolds(
  endpoint: HostEndpoint,
  deps: EndpointServerDeps
): Promise<'answers-hello' | 'stale-socket' | 'no-hello'> {
  if (endpoint.kind === 'unix-socket') {
    const stats = await lstat(endpoint.path).catch(() => null)
    // Gone since the bind failed: treated as stale, so the one retry binds.
    if (stats === null) return 'stale-socket'
    // A file, a directory or a link is never a stale socket, and is never removed.
    if (!stats.isSocket()) return 'no-hello'
  }
  const connection = await connectBounded(endpoint.path, deps.scheduler)
  if (!connection.ok) {
    const nobodyListens = connection.code === 'ECONNREFUSED' || connection.code === 'ENOENT'
    return endpoint.kind === 'unix-socket' && nobodyListens ? 'stale-socket' : 'no-hello'
  }
  try {
    return await deps.probeExisting(connection.socket)
  } finally {
    connection.socket.destroy()
  }
}

function connectBounded(
  path: string,
  scheduler: Scheduler
): Promise<{ ok: true; socket: Socket } | { ok: false; code: string }> {
  return new Promise((resolve) => {
    const socket = connect(path)
    const timer = scheduler.after(PROBE_CONNECT_TIMEOUT_MS, () => {
      socket.destroy()
      resolve({ ok: false, code: 'ETIMEDOUT' })
    })
    socket.once('connect', () => {
      timer.cancel()
      socket.removeAllListeners('error')
      socket.on('error', () => {})
      resolve({ ok: true, socket })
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      timer.cancel()
      resolve({ ok: false, code: error.code ?? 'unknown' })
    })
  })
}

async function serve(endpoint: HostEndpoint, listener: Listener): Promise<BoundEndpoint> {
  if (endpoint.kind === 'unix-socket') {
    try {
      await chmod(endpoint.path, SOCKET_MODE)
    } catch (error) {
      await stop(endpoint, listener)
      throw error
    }
  }
  return {
    address: () => endpoint.path,
    get heldConnections() {
      return listener.held.size
    },
    close: () => stop(endpoint, listener)
  }
}

async function stop(endpoint: HostEndpoint, { close, held }: Listener): Promise<void> {
  for (const socket of held) socket.destroy()
  await close()
  if (endpoint.kind === 'unix-socket') {
    // libuv removes the file on close; a socket left behind is removed here, anything else kept.
    const stats = await lstat(endpoint.path).catch(() => null)
    if (stats?.isSocket() === true) await rm(endpoint.path, { force: true })
  }
}
