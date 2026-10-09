// The Host's revert mode: `DwarfAI-Miners --revert-integrations` (ADR-016 item 7; 16 §7.4; 13
// FM-128; ISSUE-225). UI main recognises the flag and runs this build's versioned Host copy with
// it (lead decision 2026-09-30: R10 keeps the config writer and the database in the Host); the
// composition root (host/main.ts) dispatches here before the normal boot, which never runs in this
// mode, and exits with the code `runRevertIntegrations` returns. No window, no dispatcher, no
// module is built.
//
// In order (ADR-016 item 7 steps 1–2):
// 1. A Host of the same profile that answers `hello` as `ui` (its per-boot `ui.token`, ADR-003) is
//    sent `host.shutdown {mode:'stop-all'}` (ADR-002 D7): it ends the sessions it launched, then
//    checkpoints and exits. A Host that refuses the hello, reports an owned session it could not
//    end (`failed` not empty, S12.21: it keeps running), or does not answer and close within
//    REVERT_STOP_BOUND_MS is not stopped: nothing is reverted and the exit code is non-zero.
// 2. The command takes the endpoint itself (ADR-002 D3: the bind is the mutex, so no Host starts
//    meanwhile), retried every ENDPOINT_RETRY_MS while something still holds it, within the same
//    30 s bound. It serves nothing on it: a connection is held unread until the command releases
//    the endpoint.
// 3. It opens `<hostDataDir>/dwarfai.db` through the migration runner (no Host epoch is begun:
//    the stopped Host's clean marker stays the last one) and reverts every target with an active
//    `config_writes` row through the one config writer, exactly as turning the integration off
//    does (ownership probe, foreign bytes identical, `reverted_at`, the integration `off`), then
//    revokes that channel's token (16 §7.4). A revert that fails (a locked file) keeps its row
//    active, the command goes on with the other targets and exits non-zero.
// 4. It closes the database, releases the endpoint and exits: 0 when every active row was
//    reverted (none is a success too, so a second run changes nothing).
//
// User data is kept: the database, the logs, the preferences and the secrets (no SecretStore is
// composed). Out of scope here (EPIC-17): the Host copies, the login entry, the per-channel
// uninstall hooks. `config.revert` is the engine's record per target; `host.revert-integrations` is
// this command's one outcome record (package gap: 19 §9 names no event for the command itself).
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import {
  encodeFrame,
  endpointFor,
  FrameDecoder,
  HOST_METHOD_SCHEMAS,
  helloOkSchema,
  isAdvertised,
  resFrameSchema,
  type Hello,
  type HelloOk,
  type HostEndpoint
} from '@dwarfai/contracts'
import { HostInvariantError } from '../kernel/domain/errors'
import type { Clock } from '../kernel/ports/clock'
import type { DiagnosticEntry, DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { FileSystem } from '../kernel/ports/fileSystem'
import type { IdGenerator } from '../kernel/ports/idGenerator'
import type { Scheduler } from '../kernel/ports/scheduler'
import type { SqliteDatabase } from '../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../kernel/ports/transactionRunner'
import { ClaudeHooksConfigWriter } from '../modules/preferences/adapters/external-config/claudeHooks/ClaudeHooksConfigWriter'
import { ConfigWriterEngine } from '../modules/preferences/adapters/external-config/configWriterEngine'
import { SqliteChannelTokenStore } from '../modules/preferences/adapters/sqlite/SqliteChannelTokenStore'
import { SqliteConfigWriteLedger } from '../modules/preferences/adapters/sqlite/SqliteConfigWriteLedger'
import { SqliteIntegrationSettingStore } from '../modules/preferences/adapters/sqlite/SqliteIntegrationSettingStore'
import type { ConfigTarget, ExternalConfigWriter } from '../modules/preferences'
import type { EndpointFacts } from '../platform/endpoint/nodeEndpointEnv'
import { SqliteTransactionRunner } from '../platform/sqlite/SqliteTransactionRunner'
import {
  isDevBuildOnReleaseData,
  openHostDb,
  type OpenHostDbOptions
} from '../platform/sqlite/migrations/runner'
import { bindEndpoint, EndpointBindError } from '../transport/endpoint/server'
import type { ListenOwnerOnlyPipe } from '../transport/endpoint/windowsPipeSecurity'
import { createHelloProbe } from '../transport/helloProbe'
import { HOST_DB_FILE } from './hostDatabase'
import { decideBind } from './singleInstance'

/** The command-line flag (ADR-016 item 7; `20` §6); UI main passes it on to the Host copy. */
export const REVERT_INTEGRATIONS_FLAG = '--revert-integrations'
/** ADR-016 item 7: the wait for a running Host to stop and its endpoint to close. */
export const REVERT_STOP_BOUND_MS = 30_000
/**
 * The wait between two attempts to take an endpoint still held. Package gap: ADR-016 names only
 * the 30 s bound; 250 ms is the launcher's own poll of an endpoint (ADR-002 D4 item 3).
 */
export const ENDPOINT_RETRY_MS = 250
/** Nothing, or not everything, was reverted (ADR-016 item 7: "a non-zero code"). */
export const REVERT_FAILED_EXIT_CODE = 1
/** ADR-003 item 9: a `ui` connection pings after 5 s without sending, so the Host never drops it as silent. */
const PING_EVERY_MS = 5_000
/** How long one connect may take before the endpoint counts as unreachable. */
const CONNECT_TIMEOUT_MS = 1_000
/** ADR-003 item 5: the hello bound. */
const HELLO_ANSWER_TIMEOUT_MS = 5_000

/** The Host's answer to `host.shutdown {stop-all}`: how many owned sessions it failed to end. */
export type StopAllAnswer = { ok: true; failed: number } | { ok: false; code: string }

/** A `ui` connection to the running Host of the same profile. */
export interface RevertHostLink {
  stopAll(): Promise<StopAllAnswer>
  /** Settles once the connection closed: the Host's clean exit closes it with its endpoint. */
  readonly closed: Promise<void>
  close(): void
}

export type RevertHostAttach =
  /** No Host answered `hello` (nothing listens, or nothing answers). */
  | { kind: 'none' }
  /** A Host answered the hello with a protocol `error` frame: it runs and cannot be stopped from here. */
  | { kind: 'refused'; code: string }
  | { kind: 'attached'; link: RevertHostLink }

export type TakenEndpoint = { kind: 'taken'; release(): Promise<void> } | { kind: 'in-use' }

/** The Host database as the command uses it. */
export interface RevertStore {
  /** The targets with an active `config_writes` row (`reverted_at IS NULL`). */
  activeTargets(): readonly ConfigTarget[]
  readonly writer: Pick<ExternalConfigWriter, 'revert'>
  /** 16 §7.4: the reverted channel's token is revoked. */
  revokeToken(target: ConfigTarget): void
  close(): void
}

export interface RevertIntegrationsDeps {
  /** Connects as `ui` when a Host answers `hello`. */
  attach(): Promise<RevertHostAttach>
  /** One attempt to bind the UI endpoint (ADR-002 D3). */
  takeEndpoint(): Promise<TakenEndpoint>
  /** `absent`: no database file, so nothing was ever written; `read-only`: a newer file (ADR-005 item 5). */
  openStore(): Promise<RevertStore | 'absent' | 'read-only'>
  clock: Clock
  scheduler: Scheduler
  log: DiagnosticsLog
}

/** Why the command reverted nothing, or not everything (`host.revert-integrations` `causeClass`). */
type RevertFailure =
  | 'host-refused'
  | 'host-not-stopped'
  | 'stop-all-failed'
  | 'stop-all-incomplete'
  | 'db-read-only'
  | 'revert-failed'
  | 'error'

class RevertStop extends Error {
  constructor(readonly failure: RevertFailure) {
    super(`--revert-integrations stopped: ${failure}`)
    this.name = 'RevertStop'
  }
}

/** ADR-016 item 7 steps 1–2; resolves with the process exit code and never throws. */
export async function runRevertIntegrations(deps: RevertIntegrationsDeps): Promise<number> {
  const deadline = deps.clock.now() + REVERT_STOP_BOUND_MS
  let endpoint: { release(): Promise<void> } | null = null
  try {
    await stopRunningHost(deps, deadline)
    endpoint = await takeEndpointBy(deps, deadline)
    const store = await deps.openStore()
    if (store === 'read-only') throw new RevertStop('db-read-only')
    const reverted = store === 'absent' ? { count: 0, failed: false } : await revertAll(store)
    if (reverted.failed) throw new RevertStop('revert-failed')
    record(deps.log, { level: 'info', outcome: 'ok', count: reverted.count })
    return 0
  } catch (error) {
    const failure = error instanceof RevertStop ? error.failure : 'error'
    record(deps.log, {
      level: 'warn',
      outcome: 'failed',
      causeClass: failure,
      ...(failure === 'error' ? { errCode: errorName(error) } : {})
    })
    return REVERT_FAILED_EXIT_CODE
  } finally {
    await endpoint?.release()
  }
}

/** Step 1: a Host that answers is stopped, or the command stops here. */
async function stopRunningHost(deps: RevertIntegrationsDeps, deadline: number): Promise<void> {
  const attach = await deps.attach()
  if (attach.kind === 'none') return
  if (attach.kind === 'refused') throw new RevertStop('host-refused')
  const { link } = attach
  try {
    const answer = await within(deps, link.stopAll(), deadline)
    if (answer === TIMED_OUT) throw new RevertStop('host-not-stopped')
    if (!answer.ok) throw new RevertStop('stop-all-failed')
    if (answer.failed > 0) throw new RevertStop('stop-all-incomplete')
    // The Host closes its endpoint, and this connection with it, at its clean exit (ADR-002 D7).
    if ((await within(deps, link.closed, deadline)) === TIMED_OUT) {
      throw new RevertStop('host-not-stopped')
    }
  } finally {
    link.close()
  }
}

/** Step 2: the bind is the mutex; an endpoint still held is retried until the bound. */
async function takeEndpointBy(
  deps: RevertIntegrationsDeps,
  deadline: number
): Promise<{ release(): Promise<void> }> {
  for (;;) {
    const taken = await deps.takeEndpoint()
    if (taken.kind === 'taken') return taken
    const left = deadline - deps.clock.now()
    if (left <= 0) throw new RevertStop('host-not-stopped')
    await sleep(deps.scheduler, Math.min(ENDPOINT_RETRY_MS, left))
  }
}

/** Every target with an active row, through the one writer; a failed one keeps its row. */
async function revertAll(store: RevertStore): Promise<{ count: number; failed: boolean }> {
  let count = 0
  let failed = false
  try {
    for (const target of store.activeTargets()) {
      const reverted = await store.writer.revert(target)
      if (!reverted.ok) {
        failed = true
        continue
      }
      store.revokeToken(target)
      count += 1
    }
  } finally {
    store.close()
  }
  return { count, failed }
}

const TIMED_OUT = Symbol('timed-out')

/** `promise`, or TIMED_OUT once the scheduler reached `deadline`. */
function within<T>(
  deps: Pick<RevertIntegrationsDeps, 'clock' | 'scheduler'>,
  promise: Promise<T>,
  deadline: number
): Promise<T | typeof TIMED_OUT> {
  const left = deadline - deps.clock.now()
  if (left <= 0) return Promise.resolve(TIMED_OUT)
  return new Promise((resolve) => {
    const timer = deps.scheduler.after(left, () => resolve(TIMED_OUT))
    promise.then(
      (value) => {
        timer.cancel()
        resolve(value)
      },
      () => {
        timer.cancel()
        resolve(TIMED_OUT)
      }
    )
  })
}

function sleep(scheduler: Scheduler, ms: number): Promise<void> {
  return new Promise((resolve) => scheduler.after(ms, resolve))
}

function record(log: DiagnosticsLog, entry: Omit<DiagnosticEntry, 'event' | 'subsystem'>): void {
  log.record({ ...entry, event: 'host.revert-integrations', subsystem: 'host' })
}

function errorName(error: unknown): string {
  if (error instanceof EndpointBindError) return error.code
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code)) return code
  return error instanceof Error ? error.name : 'unknown'
}

// --- the store over the Host database -----------------------------------------------------

export interface RevertStoreDeps {
  db: SqliteDatabase
  transactions: TransactionRunner
  fs: FileSystem
  clock: Clock
  ids: IdGenerator
  scheduler: Scheduler
  log: DiagnosticsLog
  /** Claude Code's `settings.json` (16 §7.1): `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  claudeSettingsPath: string
  /** The OS Claude Code runs the hook command on: the owned prefix differs (`curl` / `curl.exe`). */
  platform: NodeJS.Platform
  /** Closes the database the store was opened over. */
  close: () => void
}

/**
 * The config writer engine over the Host database with every target this build writes (ISSUE-220
 * `claude-hooks`; the OpenCode target joins with ISSUE-227 and is then covered unchanged).
 */
export function createRevertStore(deps: RevertStoreDeps): RevertStore {
  const ledger = new SqliteConfigWriteLedger({ db: deps.db })
  const tokens = new SqliteChannelTokenStore({ db: deps.db, ids: deps.ids })
  const targets = [
    new ClaudeHooksConfigWriter({
      path: deps.claudeSettingsPath,
      platform: deps.platform,
      // A revert only removes entries; it never renders one.
      ingressPort: () => {
        throw new HostInvariantError('the revert mode never renders a hook entry')
      }
    })
  ]
  const writer = new ConfigWriterEngine({
    fs: deps.fs,
    transactions: deps.transactions,
    ledger,
    settings: new SqliteIntegrationSettingStore({ db: deps.db }),
    clock: deps.clock,
    ids: deps.ids,
    scheduler: deps.scheduler,
    log: deps.log,
    targets
  })
  return {
    activeTargets: () =>
      targets
        .filter((target) => ledger.active(target.target, target.path) !== null)
        .map((target) => target.target),
    writer,
    revokeToken: (target) =>
      deps.transactions.inTransaction(() => tokens.revoke(target, deps.clock.now())),
    close: deps.close
  }
}

// --- the process modes --------------------------------------------------------------------

/** host/main.ts: the revert mode when the flag is present, otherwise the normal boot. */
export async function dispatchHostMode(deps: {
  argv: readonly string[]
  revertIntegrations: () => Promise<number>
  boot: () => Promise<void>
  exit: (code: number) => void
}): Promise<void> {
  if (!deps.argv.includes(REVERT_INTEGRATIONS_FLAG)) return deps.boot()
  deps.exit(await deps.revertIntegrations())
}

// --- the Node adapters --------------------------------------------------------------------

export interface NodeRevertIntegrationsOptions {
  /** `DWARFAI_HOST_DATA_DIR` (ADR-002 D2). */
  hostDataDir: string
  /** The platform's endpoint facts (host/platform/endpoint/nodeEndpointEnv.ts). */
  facts: EndpointFacts
  /** The owner-only pipe helper (ADR-003 item 2), for a Windows bind. */
  ownerOnlyPipe: ListenOwnerOnlyPipe
  /** This Host build, as `hello.client` describes the caller. */
  client: Hello['client']
  protocolVersion: number
  /** The migration runner's build facts and migrations (as boot step 2 passes them). */
  open: Omit<OpenHostDbOptions, 'clock' | 'log' | 'onMigrating'>
  /** Narrows the database file and its companions owner-only once open (09 §1, §9). */
  protectDbFiles: (dbPath: string) => Promise<void>
  fs: FileSystem
  clock: Clock
  ids: IdGenerator
  scheduler: Scheduler
  log: DiagnosticsLog
  claudeSettingsPath: string
  platform: NodeJS.Platform
}

/** The command over this OS's real endpoint, database and files. */
export function createNodeRevertIntegrations(
  options: NodeRevertIntegrationsOptions
): RevertIntegrationsDeps {
  const runDir = join(options.hostDataDir, 'run')
  const tokenFile = join(runDir, 'ui.token')
  let endpoint: HostEndpoint | null = null
  const resolveEndpoint = async (): Promise<HostEndpoint> => {
    if (endpoint !== null) return endpoint
    const facts = await options.facts()
    if (!facts.ok) throw new EndpointBindError('ENDPOINT_FACTS_UNREADABLE', facts.cause)
    const resolved = endpointFor(facts.value)
    if (!resolved.ok) throw new EndpointBindError('ENDPOINT_UNRESOLVED', resolved.error.kind)
    endpoint = resolved.value
    return endpoint
  }
  return {
    clock: options.clock,
    scheduler: options.scheduler,
    log: options.log,
    attach: async () => attachAsUi(await resolveEndpoint(), tokenFile, options),
    takeEndpoint: async () => {
      try {
        const bound = await bindEndpoint(await resolveEndpoint(), {
          log: options.log,
          scheduler: options.scheduler,
          decide: decideBind,
          probeExisting: createHelloProbe({
            tokenFile,
            scheduler: options.scheduler,
            protocolVersion: options.protocolVersion,
            client: options.client
          }),
          ownerOnlyPipe: options.ownerOnlyPipe
          // No `accept`: a connection is held unread until the endpoint is released.
        })
        return bound.kind === 'bound'
          ? { kind: 'taken', release: () => bound.endpoint.close() }
          : { kind: 'in-use' }
      } catch (error) {
        // Something holds the endpoint without answering yet (a Host mid-exit): try again.
        if (error instanceof EndpointBindError && error.code === 'ENDPOINT_IN_USE_WITHOUT_HELLO') {
          return { kind: 'in-use' }
        }
        throw error
      }
    },
    openStore: async () => {
      const path = join(options.hostDataDir, HOST_DB_FILE)
      // ADR-005 item 6: a dev or test build never opens the release data.
      if (isDevBuildOnReleaseData(path, options.open)) {
        throw new HostInvariantError('a dev build never reverts from the release database')
      }
      if (!existsSync(path)) return 'absent'
      const opened = openHostDb(path, { ...options.open, clock: options.clock, log: options.log })
      if (!opened.ok) throw new HostInvariantError(`the database was refused: ${opened.error}`)
      const { db } = opened.value
      if (opened.value.readOnly) {
        db.close()
        return 'read-only'
      }
      try {
        await options.protectDbFiles(path)
      } catch (error) {
        db.close()
        throw error
      }
      return createRevertStore({
        db,
        transactions: new SqliteTransactionRunner(db),
        fs: options.fs,
        clock: options.clock,
        ids: options.ids,
        scheduler: options.scheduler,
        log: options.log,
        claudeSettingsPath: options.claudeSettingsPath,
        platform: options.platform,
        close: () => db.close()
      })
    }
  }
}

/** Opens a `ui` connection and reads the first frame (ADR-003 items 3–5, 12). */
async function attachAsUi(
  endpoint: HostEndpoint,
  tokenFile: string,
  options: Pick<NodeRevertIntegrationsOptions, 'client' | 'protocolVersion' | 'scheduler' | 'ids'>
): Promise<RevertHostAttach> {
  const socket = await connectBounded(endpoint.path, options.scheduler)
  if (socket === null) return { kind: 'none' }
  // Read for this one frame, never logged, never kept (ADR-003 item 3).
  const token = (await readFile(tokenFile, 'utf8').catch(() => '')).trim()
  const hello: Hello = {
    type: 'hello',
    endpointGeneration: 1,
    protocolVersion: options.protocolVersion,
    role: 'ui',
    token,
    client: options.client
  }
  return new Promise<RevertHostAttach>((resolve) => {
    const decoder = new FrameDecoder()
    let link: NodeRevertLink | null = null
    let settled = false
    const answer = (attach: RevertHostAttach): void => {
      if (settled) return
      settled = true
      timer.cancel()
      if (attach.kind !== 'attached') socket.destroy()
      resolve(attach)
    }
    const timer = options.scheduler.after(HELLO_ANSWER_TIMEOUT_MS, () => answer({ kind: 'none' }))
    socket.on('data', (chunk: Uint8Array) => {
      decoder.push(chunk)
      for (let next = decoder.next(); next !== null; next = decoder.next()) {
        if (next.kind !== 'frame') {
          socket.destroy()
          return
        }
        if (link !== null) {
          link.receive(next.message)
          continue
        }
        const ok = helloOkSchema.safeParse(next.message)
        if (ok.success) {
          decoder.helloOk()
          link = new NodeRevertLink(socket, ok.data, options)
          answer({ kind: 'attached', link })
          continue
        }
        const first = (next.message ?? {}) as { type?: unknown; code?: unknown }
        answer(
          first.type === 'error' && typeof first.code === 'string'
            ? { kind: 'refused', code: first.code }
            : { kind: 'none' }
        )
        return
      }
    })
    socket.on('error', () => {})
    socket.once('end', () => socket.destroy())
    socket.once('close', () => {
      link?.ended()
      answer({ kind: 'none' })
    })
    socket.write(encodeFrame(hello))
  })
}

class NodeRevertLink implements RevertHostLink {
  readonly closed: Promise<void>
  private settleClosed: () => void = () => {}
  private nextId = 0
  private readonly waiting = new Map<string, (answer: StopAllAnswer) => void>()
  private ping: { cancel(): void } | null = null

  constructor(
    private readonly socket: Socket,
    private readonly helloOk: HelloOk,
    private readonly options: Pick<NodeRevertIntegrationsOptions, 'scheduler' | 'ids'>
  ) {
    this.closed = new Promise((resolve) => (this.settleClosed = resolve))
    this.armPing()
  }

  stopAll(): Promise<StopAllAnswer> {
    return new Promise((resolve) => {
      const id = this.send('host.shutdown', {
        mode: 'stop-all',
        requestId: this.options.ids.uuidv7()
      })
      if (id === null) resolve({ ok: false, code: 'HOST_UNAVAILABLE' })
      else this.waiting.set(id, resolve)
    })
  }

  close(): void {
    this.socket.destroy()
  }

  /** One frame after `hello.ok`: the `res` of a call (each `evt` is not needed here). */
  receive(message: unknown): void {
    const res = resFrameSchema.safeParse(message)
    if (!res.success) return
    const resolve = this.waiting.get(res.data.id)
    if (resolve === undefined) return
    this.waiting.delete(res.data.id)
    if (!res.data.ok) {
      resolve({ ok: false, code: res.data.error.code })
      return
    }
    const result = HOST_METHOD_SCHEMAS['host.shutdown'].result.safeParse(res.data.result)
    resolve(
      result.success && result.data.mode === 'stop-all'
        ? { ok: true, failed: result.data.outcome.failed.length }
        : { ok: false, code: 'INVALID_RESULT' }
    )
  }

  /** The connection closed: a call still waiting gets no answer it could trust. */
  ended(): void {
    this.ping?.cancel()
    for (const resolve of this.waiting.values()) resolve({ ok: false, code: 'HOST_UNAVAILABLE' })
    this.waiting.clear()
    this.settleClosed()
  }

  private send(method: string, params: unknown): string | null {
    if (this.socket.destroyed) return null
    this.nextId += 1
    const id = `r${this.nextId}`
    this.socket.write(encodeFrame({ type: 'req', id, method, params }))
    this.armPing()
    return id
  }

  /** ADR-003 item 9: a stop-all that outlasts the Host's silence limit keeps the connection. */
  private armPing(): void {
    this.ping?.cancel()
    if (!isAdvertised(this.helloOk.capabilities, 'ping')) return
    this.ping = this.options.scheduler.after(PING_EVERY_MS, () => {
      // Its answer is matched to no waiting call and dropped.
      this.send('ping', {})
    })
  }
}

/** One connect to the endpoint, or null when nothing listens or it takes too long. */
function connectBounded(path: string, scheduler: Scheduler): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(path)
    const timer = scheduler.after(CONNECT_TIMEOUT_MS, () => {
      socket.destroy()
      resolve(null)
    })
    socket.once('connect', () => {
      timer.cancel()
      resolve(socket)
    })
    socket.once('error', () => {
      timer.cancel()
      socket.destroy()
      resolve(null)
    })
  })
}
