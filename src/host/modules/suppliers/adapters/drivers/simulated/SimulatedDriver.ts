// SimulatedDriver (15 §4.12): the deterministic reference implementation of the ADR-009 D3
// contract. It reads no disk, spawns no process and talks to no provider: every answer is a pure
// function of its seed, driven by the injected Clock and Scheduler, so a run replays exactly.
// Development builds only (the catalog record is development-only); its capability set is test
// configuration. The full conformance suite C-01…C-29 runs against it with the harness
// (later: ISSUE-144).
//
// Candidate decision (21 §6): `src/main/providers/simulated/*` is replaced, not kept — it is an
// observation-side `Provider` (snapshot scans) with no launch, handshake or turn, so it cannot
// satisfy ADR-009 D3. Its seeded FNV-1a hash (`rng.ts`) is the design reused here, reimplemented
// rather than imported (R16).
import type { ProcessIdentity } from '../../../../../kernel/domain/processIdentity'
import type { AnswerOutcome, TurnEnded } from '../../../../../kernel/domain/sharedContracts'
import type { DwarfId } from '../../../../../kernel/domain/values'
import type { Clock } from '../../../../../kernel/ports/clock'
import type { Scheduler } from '../../../../../kernel/ports/scheduler'
import type { ProviderCapabilities } from '../../../domain/capabilities'
import type { DriverTransport, ProviderProfile } from '../../../domain/profile'
import type {
  CloseOutcome,
  DetectResult,
  DriverEvent,
  DriverLaunchError,
  DriverLaunchRequest,
  DriverSendError,
  DriverSession,
  ProviderDriver,
  SendReceipt,
  SessionRef,
  TurnInput
} from '../../../ports/providerDriver'

/** How long the simulated handshake takes after the simulated spawn. */
export const SIMULATED_HANDSHAKE_MS = 50
/** The spacing of the simulated events of one turn. */
export const SIMULATED_STEP_MS = 10

/**
 * The `dwarfId` of a `turn.ended` this driver emits. A driver cannot know the dwarf: launching
 * binds it after `launch()` resolves (ADR-015 item 7), and `DriverLaunchRequest` carries none.
 * Suppliers stamps the dwarf it resolves from the session's `SessionRef`, as it does for
 * `AskInput` (15 §1.2). Package gap reported with ISSUE-143.
 */
export const UNBOUND_DWARF_ID = '' as DwarfId

/** Lines the simulated dwarf answers with, picked by the seed. Provider output, not app copy. */
const REPLIES = [
  'Opened the seam and checked the timbering.',
  'Ran the numbers on the last cart of ore.',
  'Rerouted the lantern line past the wet section.',
  'Marked the face for tomorrow morning.'
] as const

export interface SimulatedDriverOptions {
  readonly profile: ProviderProfile
  readonly transport: DriverTransport
  /** The session's effective set: test configuration (15 §4.12). */
  readonly capabilities: ProviderCapabilities
  /** Same seed, same run (ids, picks), on any machine. */
  readonly seed: string
  readonly clock: Clock
  readonly scheduler: Scheduler
}

/** A simulated session, plus the fault a test can inject. */
export interface SimulatedSession extends DriverSession {
  /** The transport drops before an exit was observed (C-18). */
  simulateTransportLoss(): void
}

export class SimulatedDriver implements ProviderDriver {
  readonly profile: ProviderProfile
  readonly transport: DriverTransport
  private readonly launchIds = new Set<string>()

  constructor(private readonly options: SimulatedDriverOptions) {
    this.profile = options.profile
    this.transport = options.transport
  }

  async detect(): Promise<DetectResult> {
    return {
      kind: 'installed',
      install: {
        providerId: this.profile.id,
        binaryPath: `simulated:${this.profile.id}`,
        version: 'simulated',
        resolvedVia: 'path',
        statMtimeMs: 0
      }
    }
  }

  async probe(): Promise<ProviderCapabilities> {
    return structuredClone(this.options.capabilities)
  }

  async launch(req: DriverLaunchRequest): Promise<SimulatedSession> {
    const { clock, scheduler, seed } = this.options
    if (this.launchIds.has(req.launchId)) {
      // One call per launchId (15 §1.3): a repeat spawns nothing.
      const repeated: DriverLaunchError = {
        cause: 'could-not-start',
        detail: 'launch id already used'
      }
      throw repeated
    }
    this.launchIds.add(req.launchId)
    const key = `${seed}:${req.launchId}`
    // No process exists. The identity's boot id never equals a real one, so no ADR-014 identity
    // check can ever match it to a live process.
    const identity: ProcessIdentity = {
      pid: 100_000 + (hashString(`${key}:pid`) % 900_000),
      processStartTimeMs: clock.now(),
      bootId: `simulated:${seed}`
    }
    await req.onSpawned(identity)
    await new Promise<void>((resolve) => scheduler.after(SIMULATED_HANDSHAKE_MS, resolve))
    const ref: SessionRef = {
      providerId: this.profile.id,
      providerSessionId: `sim-${hashString(key).toString(16).padStart(8, '0')}`
    }
    return new SimulatedRun(ref, this.options).session
  }
}

/** One simulated session: its event stream and the scheduled steps of its turns. */
class SimulatedRun {
  readonly session: SimulatedSession
  private readonly channel = new EventChannel<DriverEvent>()
  private readonly adapterId: string
  private readonly streamId: string
  private turns = 0
  private exited = false
  /** The open turn: its key and the steps still scheduled. */
  private openTurn: { turnKey: string; pending: { cancel(): void }[] } | null = null

  constructor(
    private readonly ref: SessionRef,
    private readonly options: SimulatedDriverOptions
  ) {
    this.adapterId = ref.providerId
    this.streamId = `${ref.providerId}:${ref.providerSessionId}`
    this.session = {
      ref,
      capabilities: structuredClone(options.capabilities),
      events: () => this.channel,
      sendTurn: (input) => this.sendTurn(input),
      interrupt: async () => this.interrupt(),
      // The simulated world opens no ask, so no request id is ever pending (15 §1.3).
      answerPermission: async () => askClosed(),
      answerQuestion: async () => askClosed(),
      close: async (mode) => this.close(mode),
      simulateTransportLoss: () => this.loseTransport()
    }
  }

  private async sendTurn(input: TurnInput): Promise<SendReceipt> {
    if (this.exited) {
      const closed: DriverSendError = { kind: 'session-closed', reason: 'the session exited' }
      throw closed
    }
    this.turns += 1
    const turnKey = `${this.ref.providerSessionId}:turn-${this.turns}`
    const correlation = `${this.streamId}:${input.messageId}`
    const { clock, scheduler, seed, capabilities } = this.options
    const sourceKey = (eventId: string): string => `${this.adapterId}:${this.streamId}:${eventId}`

    this.emit({ t: 'status', value: 'working' })
    this.emit({
      t: 'message',
      record: {
        sourceKey: sourceKey(`${turnKey}:echo`),
        role: 'person',
        text: input.text,
        providerTime: clock.now(),
        echoOf: correlation
      }
    })
    const steps: (() => void)[] = [
      () =>
        this.emit({
          t: 'activity',
          step: {
            sourceKey: sourceKey(`${turnKey}:step-1`),
            turnKey,
            kind: 'tool',
            toolName: 'survey',
            summary: 'Surveying the seam',
            state: 'started',
            at: clock.now()
          }
        }),
      () =>
        this.emit({
          t: 'activity',
          step: {
            sourceKey: sourceKey(`${turnKey}:step-1`),
            turnKey,
            kind: 'tool',
            toolName: 'survey',
            summary: 'Surveying the seam',
            state: 'finished',
            at: clock.now()
          }
        }),
      () =>
        this.emit({
          t: 'message',
          record: {
            sourceKey: sourceKey(`${turnKey}:reply`),
            role: 'dwarf',
            text: REPLIES[hashString(`${seed}:${turnKey}`) % REPLIES.length] as string,
            providerTime: clock.now()
          }
        }),
      () => this.endTurn('concluded')
    ]
    this.openTurn = {
      turnKey,
      pending: steps.map((step, index) => scheduler.after(SIMULATED_STEP_MS * (index + 1), step))
    }

    return {
      confidence: 'confirmed',
      heldUntilTurnEnd: false,
      correlation,
      ...(capabilities.reactionEvidence === 'turn-id' ? { providerTurnId: turnKey } : {})
    }
  }

  /** No-op when no turn is open (15 §1.3). */
  private interrupt(): void {
    if (this.openTurn === null) return
    for (const step of this.openTurn.pending) step.cancel()
    this.endTurn('interrupted')
  }

  private endTurn(kind: 'concluded' | 'interrupted'): void {
    if (this.openTurn === null) return
    const end: TurnEnded = {
      dwarfId: UNBOUND_DWARF_ID,
      turnKey: this.openTurn.turnKey,
      kind,
      at: this.options.clock.now(),
      reliability: this.options.capabilities.turnEnd === 'reliable' ? 'reliable' : 'inferred',
      cancelledFromApp: kind === 'interrupted'
    }
    this.openTurn = null
    this.emit({ t: 'turn.ended', end })
    this.emit({ t: 'status', value: 'idle' })
  }

  /**
   * `end-thread` ends the simulated session (exit code 0); a second close resolves `closed`.
   * `detach` is unsupported: nothing would keep running without DwarfAI (15 §1.3).
   */
  private close(mode: 'detach' | 'end-thread'): CloseOutcome {
    if (mode === 'detach') return { kind: 'failed', reason: 'unsupported' }
    if (!this.exited) this.exit(0)
    return { kind: 'closed' }
  }

  private loseTransport(): void {
    if (this.exited) return
    this.emit({ t: 'error', cause: { kind: 'transport-lost', detail: 'simulated transport loss' } })
    this.exit(null)
  }

  /** `exited` is the last event, exactly once (15 §1.4); the open turn's steps never run. */
  private exit(code: number | null): void {
    for (const step of this.openTurn?.pending ?? []) step.cancel()
    this.openTurn = null
    this.emit({ t: 'exited', code })
    this.exited = true
    this.channel.close()
  }

  private emit(event: DriverEvent): void {
    if (!this.exited) this.channel.push(event)
  }
}

function askClosed(): AnswerOutcome {
  return { kind: 'refused', reason: 'ask-closed' }
}

/**
 * A single-consumer, unbounded async stream: events pushed before a read are buffered, never
 * dropped (15 §1.4), and the stream ends once closed and drained.
 */
class EventChannel<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private readonly waiting: ((result: IteratorResult<T>) => void)[] = []
  private closed = false

  push(value: T): void {
    const reader = this.waiting.shift()
    if (reader === undefined) this.buffer.push(value)
    else reader({ value, done: false })
  }

  close(): void {
    this.closed = true
    for (const reader of this.waiting.splice(0)) reader({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false })
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiting.push(resolve))
      },
      // A consumer that stops reading early leaves the stream open for the next read.
      return: () => Promise.resolve({ value: undefined, done: true })
    }
  }
}

/** FNV-1a 32-bit: the seeded hash of the legacy simulated valley (`rng.ts`), reimplemented. */
function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export type { DriverLaunchError }
