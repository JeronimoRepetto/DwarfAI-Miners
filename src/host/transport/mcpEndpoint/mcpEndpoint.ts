// The Host's MCP endpoint (ADR-013 item 3; ADR-003 items 2, 4–5, 12, frozen; 16 §5.2 as amended by
// owner amendment N (AMENDMENT-14, OQ-85), 2026-10-15): the second local endpoint, where the
// `dwarfai-mcp` relay of a delegating session connects. A named pipe or a Unix socket at its own
// per-OS path (mcpEndpointPath.ts), bound with the UI endpoint's server helpers (ISSUE-022), so the
// same owner-only rules hold: the socket `0600` in a `0700` run directory, the pipe created by the
// owner-only pipe helper with remote clients rejected (SP-05). Never loopback HTTP.
//
// One connection runs `awaiting-hello` → `authenticated(token)` → `closed`:
// - awaiting-hello: nothing is written before a valid `McpHello` (ADR-003 item 2). The first frame
//   must be `McpHello {type:'hello', endpointGeneration:1, protocolVersion, role:'mcp', launchId,
//   credential}`. A UI-role hello, anything else that is not that strict shape, or a malformed
//   frame → one PROTOCOL_ERROR frame and the close; another generation → INCOMPATIBLE_GENERATION;
//   a credential that is not accepted → one AUTH_FAILED frame, no detail, and the close. 5 s
//   without a hello → HELLO_TIMEOUT. Frames over 1 MiB close without a frame.
// - The credential is accepted only for its own `launchId`, with a constant-time compare of its
//   SHA-256 against that launch's `delegation_tokens.credential_hash`, and only while the row is
//   not revoked (`byLaunch` never returns a revoked row, 16 §5.7). A launch's token is revoked when
//   its session ends (`revokeFor`) or its start failed (`revokeLaunch`), so a live row is a live
//   session. A launch with no row runs the same compare, against itself, and still refuses.
// - authenticated: `hello.ok` is written, the connection is bound to the launch's token (without
//   its hash; the credential value is dropped here and never kept) and handed to the delegation
//   server. Frames up to 8 MiB, each carrying exactly one MCP JSON-RPC message, unchanged: a frame
//   that is not one JSON-RPC message object (a batch array, a second hello, a non-object) is a
//   PROTOCOL_ERROR and the close. Before each frame is handed over the token is read again: a
//   revoked launch is closed without a frame.
// - Throttle (16 §5.2 item 6, architect-proposed): the ADR-003 item 5 limiter, its own instance for
//   this endpoint. Every hello refusal counts; while engaged a new connection gets one
//   RATE_LIMITED frame and the close.
// - `closeLaunch(launchId)` ends every connection of that launch without a frame: the delegation
//   lifecycle's `revokeLaunch` and `revokeFor` routes call it (16 §5.2 item 5, AMENDMENT-14).
//
// The log carries `mcp.hello.refused` with `causeClass` and, when it is a well-formed id, the
// `launchId` (19 §9.3); never the credential, its hash or any frame content (NFR-SEC-12).
import { createHash, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'
import {
  encodeFrame,
  FrameDecoder,
  mcpHelloSchema,
  type ErrorFrame,
  type HelloOk,
  type HostEndpoint,
  type ProtocolErrorCode
} from '@dwarfai/contracts'
import type { LaunchId } from '../../kernel/domain/values'
import type { DiagnosticEntry, DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type {
  DelegationRelayConnection,
  DelegationRelayListener,
  DelegationToken,
  DelegationTokenStore,
  LoopbackEndpoint
} from '../../modules/delegation'
import type { HostStateReport } from '../../wiring/boot'
import { decideBind } from '../../wiring/singleInstance'
import type { HelloThrottle } from '../auth/throttle'
import { HELLO_TIMEOUT_MS } from '../connection'
import { bindEndpoint, EndpointBindError } from '../endpoint/server'
import type { ListenOwnerOnlyPipe } from '../endpoint/windowsPipeSecurity'
import type { HostIdentity } from '../hello'

/** A per-launch credential: 32 bytes as lower-case hex (ADR-013 item 3). */
const CREDENTIAL_PATTERN = /^[0-9a-f]{64}$/
/** 06 §0.1 `LaunchId`: a UUIDv7 (what the log accepts as `launchId`, ADR-026). */
const LAUNCH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DIGEST_BYTES = 32
const SUBSYSTEM = 'delegation'

export interface McpConnectionDeps {
  /** The token rows; `byLaunch` never returns a revoked row. */
  tokens: Pick<DelegationTokenStore, 'byLaunch'>
  scheduler: Scheduler
  log: DiagnosticsLog
  ids: IdGenerator
  identity: HostIdentity
  /** This boot's epoch (HelloOk.epoch). */
  epoch: string
  state: () => HostStateReport
  /** This endpoint's failed-hello throttle, shared by its connections (16 §5.2 item 6). */
  throttle: HelloThrottle
  /** Defaults to SHA-256 over the UTF-8 text. */
  sha256?: (text: string) => Uint8Array
  /** Defaults to `crypto.timingSafeEqual`. */
  timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean
}

/** The authenticated connections of the endpoint, by launch, so a revoked launch can be closed. */
export class McpConnectionRegistry {
  private readonly byLaunch = new Map<LaunchId, Set<() => void>>()

  add(launchId: LaunchId, close: () => void): () => void {
    let set = this.byLaunch.get(launchId)
    if (set === undefined) {
      set = new Set()
      this.byLaunch.set(launchId, set)
    }
    set.add(close)
    return () => {
      set.delete(close)
      if (set.size === 0) this.byLaunch.delete(launchId)
    }
  }

  /** Ends every connection of `launchId` without a frame. */
  closeLaunch(launchId: LaunchId): void {
    for (const close of [...(this.byLaunch.get(launchId) ?? [])]) close()
  }

  /** The launches with a connection right now. */
  get size(): number {
    return this.byLaunch.size
  }
}

type State =
  | { kind: 'awaiting-hello' }
  | { kind: 'authenticated'; token: DelegationToken; listeners: Array<(m: unknown) => void> }
  | { kind: 'closed' }

/** Takes a freshly accepted connection to the MCP endpoint. */
export function acceptMcpConnection(
  stream: Duplex,
  deps: McpConnectionDeps,
  accept: (connection: DelegationRelayConnection) => void,
  registry: McpConnectionRegistry = new McpConnectionRegistry()
): void {
  if (!deps.throttle.admits()) {
    const frame: ErrorFrame = { type: 'error', code: 'RATE_LIMITED' }
    stream.on('error', () => {})
    stream.end(encodeFrame(frame), () => stream.destroy())
    return
  }
  const hash = deps.sha256 ?? sha256
  const equal = deps.timingSafeEqual ?? nodeTimingSafeEqual
  let state: State = { kind: 'awaiting-hello' }
  const closeListeners: Array<() => void> = []
  let unregister: (() => void) | undefined
  const decoder = new FrameDecoder()
  const isClosed = (): boolean => state.kind === 'closed'

  const leave = (): void => {
    if (state.kind === 'closed') return
    state = { kind: 'closed' }
    helloTimer.cancel()
    unregister?.()
    for (const listener of closeListeners.splice(0)) listener()
  }

  /** Ends the connection; `error` is the one protocol error frame sent first, when there is one. */
  const close = (error?: ProtocolErrorCode): void => {
    if (state.kind === 'closed') return
    leave()
    if (error === undefined || stream.destroyed) {
      stream.destroy()
      return
    }
    const frame: ErrorFrame = { type: 'error', code: error }
    stream.end(encodeFrame(frame), () => stream.destroy())
  }

  const refuse = (code: ProtocolErrorCode, launchId?: unknown): void => {
    deps.log.record({
      level: 'warn',
      event: 'mcp.hello.refused',
      subsystem: SUBSYSTEM,
      causeClass: code,
      ...(typeof launchId === 'string' && LAUNCH_ID_PATTERN.test(launchId) ? { launchId } : {})
    } satisfies DiagnosticEntry)
    const verdict = deps.throttle.recordFailure()
    if (verdict.engaged) {
      deps.log.record({
        level: 'warn',
        event: 'channel.rate-limited',
        subsystem: SUBSYSTEM,
        count: verdict.count
      })
    }
    close(code)
  }

  const helloTimer = deps.scheduler.after(HELLO_TIMEOUT_MS, () => {
    if (state.kind === 'awaiting-hello') refuse('HELLO_TIMEOUT')
  })

  /** The launch's live token when `credential` is its own, compared in constant time. */
  const authenticate = (launchId: string, credential: string): DelegationToken | null => {
    const row = LAUNCH_ID_PATTERN.test(launchId) ? deps.tokens.byLaunch(launchId as LaunchId) : null
    const presented = CREDENTIAL_PATTERN.test(credential) ? hash(credential) : null
    const expected = storedDigest(row?.credentialHash)
    if (presented === null || expected === null || row === null) {
      // Same work as a real comparison, against itself, and still a refusal.
      const self = presented ?? hash('')
      equal(self, self)
      return null
    }
    if (!equal(presented, expected)) return null
    // The handle carries no hash and no credential (16 §5.2 item 5).
    return {
      launchId: row.launchId,
      parentDwarfId: row.parentDwarfId,
      mechanism: row.mechanism,
      issuedAt: row.issuedAt
    }
  }

  const onHello = (message: unknown): void => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      refuse('PROTOCOL_ERROR')
      return
    }
    const frame = message as { type?: unknown; role?: unknown; endpointGeneration?: unknown }
    // A UI-role hello (or anything that is not a hello) on the MCP endpoint (ADR-003 item 12).
    if (frame.type !== 'hello' || frame.role !== 'mcp') {
      refuse('PROTOCOL_ERROR')
      return
    }
    if (typeof frame.endpointGeneration === 'number' && frame.endpointGeneration !== 1) {
      refuse('INCOMPATIBLE_GENERATION')
      return
    }
    const hello = mcpHelloSchema.safeParse(message)
    if (!hello.success) {
      refuse('PROTOCOL_ERROR')
      return
    }
    const token = authenticate(hello.data.launchId, hello.data.credential)
    if (token === null) {
      refuse('AUTH_FAILED', hello.data.launchId)
      return
    }
    helloTimer.cancel()
    decoder.helloOk()
    const listeners: Array<(m: unknown) => void> = []
    state = { kind: 'authenticated', token, listeners }
    stream.write(encodeFrame(helloOk(deps)))
    unregister = registry.add(token.launchId, () => close())
    accept({
      token,
      send: (outgoing) => {
        if (state.kind === 'authenticated' && !stream.destroyed) {
          stream.write(encodeFrame(outgoing))
        }
      },
      onMessage: (listener) => listeners.push(listener),
      onClose: (listener) => {
        if (state.kind === 'closed') listener()
        else closeListeners.push(listener)
      },
      close: () => close()
    })
  }

  const onFrame = (message: unknown): void => {
    if (state.kind === 'awaiting-hello') {
      onHello(message)
      return
    }
    if (state.kind !== 'authenticated') return
    if (!isJsonRpcMessage(message)) {
      close('PROTOCOL_ERROR')
      return
    }
    // The launch may have been revoked since the hello (16 §5.2 (c)).
    if (deps.tokens.byLaunch(state.token.launchId) === null) {
      close()
      return
    }
    for (const listener of state.listeners) listener(message)
  }

  stream.on('data', (chunk: Uint8Array) => {
    if (state.kind === 'closed') return
    decoder.push(chunk)
    for (let next = decoder.next(); next !== null; next = decoder.next()) {
      if (next.kind === 'oversize') {
        deps.log.record({
          level: 'error',
          event: 'channel.frame.oversize',
          subsystem: SUBSYSTEM,
          bytes: next.bytes
        })
        close()
        return
      }
      if (next.kind === 'malformed') {
        if (state.kind === 'awaiting-hello') refuse('PROTOCOL_ERROR')
        else close('PROTOCOL_ERROR')
        return
      }
      onFrame(next.message)
      // onFrame may have closed the connection: nothing after that frame is read.
      if (isClosed()) return
    }
  })
  stream.on('error', () => close())
  stream.once('close', () => close())
}

export interface McpEndpointDeps extends McpConnectionDeps {
  /** The MCP endpoint (mcpEndpointPath.ts `mcpEndpointFor`). */
  endpoint: HostEndpoint
  /** Creates a named pipe owner-only (ADR-003 item 2); a pipe is never served without it. */
  ownerOnlyPipe?: ListenOwnerOnlyPipe
}

/** The MCP endpoint as the delegation server's listener, plus `closeLaunch` for the revoke routes. */
export interface McpEndpoint extends DelegationRelayListener {
  closeLaunch(launchId: LaunchId): void
}

export function createMcpEndpoint(deps: McpEndpointDeps): McpEndpoint {
  const registry = new McpConnectionRegistry()
  return {
    closeLaunch: (launchId) => registry.closeLaunch(launchId),
    async listen(accept) {
      const outcome = await bindEndpoint(deps.endpoint, {
        log: deps.log,
        scheduler: deps.scheduler,
        decide: decideBind,
        // Another Host's MCP endpoint is never spoken to: the UI endpoint already is the mutex
        // (ADR-002 D3), so a live MCP endpoint here is an error, a stale socket is removed.
        probeExisting: () => Promise.resolve('no-hello'),
        ...(deps.ownerOnlyPipe === undefined ? {} : { ownerOnlyPipe: deps.ownerOnlyPipe }),
        accept: (connection) => acceptMcpConnection(connection, deps, accept, registry)
      })
      if (outcome.kind !== 'bound') throw new EndpointBindError('MCP_ENDPOINT_IN_USE')
      const endpoint: LoopbackEndpoint = { path: outcome.endpoint.address() }
      return { endpoint, close: () => outcome.endpoint.close() }
    }
  }
}

function helloOk(deps: McpConnectionDeps): HelloOk {
  const { state, jobStatus } = deps.state()
  return {
    type: 'hello.ok',
    hostVersion: deps.identity.hostVersion,
    buildId: deps.identity.buildId,
    protocolVersion: deps.identity.protocolVersion,
    endpointGeneration: 1,
    epoch: deps.epoch,
    state,
    jobStatus,
    capabilities: [],
    clientId: deps.ids.uuidv7()
  }
}

/** One JSON-RPC 2.0 message object: never a batch array, never a DwarfAI frame. */
function isJsonRpcMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    !Array.isArray(message) &&
    (message as { jsonrpc?: unknown }).jsonrpc === '2.0'
  )
}

function sha256(text: string): Uint8Array {
  return createHash('sha256').update(text, 'utf8').digest()
}

/** The stored hash as 32 bytes, or `null` when there is none. */
function storedDigest(stored: string | undefined): Uint8Array | null {
  if (stored === undefined || !CREDENTIAL_PATTERN.test(stored)) return null
  const digest = Buffer.from(stored, 'hex')
  return digest.length === DIGEST_BYTES ? digest : null
}
