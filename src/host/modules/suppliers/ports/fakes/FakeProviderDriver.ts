// A scriptable `ProviderDriver` double (16 §2.8 `Fake<Port>`): `launch` resolves at once with a
// `FakeDriverSession` whose events the test pushes by hand. Used where a test needs to choose
// each event (SimulatedDriver, the reference, decides its own).
import type { ProviderCapabilities } from '../../domain/capabilities'
import type { DriverTransport, ProviderProfile } from '../../domain/profile'
import type {
  CloseOutcome,
  DetectResult,
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
  ProviderDriver,
  SendReceipt,
  SessionRef
} from '../providerDriver'

export class FakeDriverSession implements DriverSession {
  private readonly buffer: DriverEvent[] = []
  private readonly waiting: ((result: IteratorResult<DriverEvent>) => void)[] = []
  private readonly failing: ((error: unknown) => void)[] = []
  private ended = false
  private failure: { error: unknown } | null = null
  private readonly stream: AsyncIterable<DriverEvent>

  constructor(
    readonly ref: SessionRef,
    readonly capabilities: ProviderCapabilities
  ) {
    this.stream = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const value = this.buffer.shift()
          if (value !== undefined) return Promise.resolve({ value, done: false })
          if (this.failure !== null) return Promise.reject(this.failure.error)
          if (this.ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve, reject) => {
            this.waiting.push(resolve)
            this.failing.push(reject)
          })
        }
      })
    }
  }

  /** Pushes one event; `exited` also ends the stream. */
  emit(event: DriverEvent): void {
    const reader = this.waiting.shift()
    this.failing.shift()
    if (reader === undefined) this.buffer.push(event)
    else reader({ value: event, done: false })
    if (event.t === 'exited') this.end()
  }

  /** Makes the stream throw: a driver defect (the contract says `events()` never throws). */
  breakStream(error: unknown): void {
    this.failure = { error }
    this.waiting.splice(0)
    for (const reject of this.failing.splice(0)) reject(error)
  }

  events(): AsyncIterable<DriverEvent> {
    return this.stream
  }

  async sendTurn(): Promise<SendReceipt> {
    return { confidence: 'confirmed', heldUntilTurnEnd: false, correlation: 'fake' }
  }

  async interrupt(): Promise<void> {}

  async answerPermission(): Promise<{ kind: 'refused'; reason: 'ask-closed' }> {
    return { kind: 'refused', reason: 'ask-closed' }
  }

  async answerQuestion(): Promise<{ kind: 'refused'; reason: 'ask-closed' }> {
    return { kind: 'refused', reason: 'ask-closed' }
  }

  async close(): Promise<CloseOutcome> {
    return { kind: 'closed' }
  }

  private end(): void {
    this.ended = true
    for (const reader of this.waiting.splice(0)) reader({ value: undefined, done: true })
    this.failing.splice(0)
  }
}

export class FakeProviderDriver implements ProviderDriver {
  /** Every session handed out, in launch order. */
  readonly sessions: FakeDriverSession[] = []

  constructor(
    readonly profile: ProviderProfile,
    readonly transport: DriverTransport,
    private readonly capabilities: ProviderCapabilities
  ) {}

  async detect(): Promise<DetectResult> {
    return { kind: 'not-installed' }
  }

  async probe(): Promise<ProviderCapabilities> {
    return structuredClone(this.capabilities)
  }

  async launch(req: DriverLaunchRequest): Promise<FakeDriverSession> {
    const session = new FakeDriverSession(
      {
        providerId: this.profile.id,
        providerSessionId: `fake-${req.launchId}`
      },
      structuredClone(this.capabilities)
    )
    this.sessions.push(session)
    return session
  }
}
