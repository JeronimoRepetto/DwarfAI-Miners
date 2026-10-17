// The SessionStarter double (16 §4.5 `FakeSessionStarter`; 16 §2.8): it runs
// `runSessionStarterContract` like the real bridge (wiring/bridges/sessionStarter.ts). Each `start`
// meets the script arranged for it (`arrange`, by default a ready session): it calls `onSpawned`
// with a fake identity as a driver does right after the OS spawn, then settles on the injected
// scheduler exactly as the bridge classifies (ADR-020 D4): ok once the 3-second early window
// passed, `exited-at-once` when the process left inside it, the driver's own cause on a rejection,
// `not-installed` without any spawn. It spawns nothing and reads no clock of its own. Never
// imported by production code (R14).
import type { ProviderId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type {
  DriverLaunchRequest,
  DriverSession,
  ProviderCapabilities,
  SendReceipt
} from '../../suppliers'
import { EARLY_FAILURE_WINDOW_MS } from '../domain/classifyLaunchOutcome'
import { buildLaunchFailure } from '../domain/launchFailure'
import type { SessionStarter, StartResult } from '../ports/sessionStarter'
import type { StartScript } from './sessionStarter.contract'

export interface FakeSessionStarterDeps {
  clock: Clock
  scheduler: Scheduler
  /** The chip label a failure names (US-LAUNCH-006.AC10). */
  supplierLabel?: string
  /**
   * The effective capabilities every fake session reports (suppliers' `catalogue.capabilities`);
   * without them, reading a session's capabilities is a test defect and throws.
   */
  capabilities?: ProviderCapabilities
}

export interface RecordedStart {
  providerId: ProviderId
  req: DriverLaunchRequest
  gate: { launchedWithLetJevChoose: boolean }
}

/** A session nothing reads: the double hands it out on a ready start. */
function fakeSession(
  req: DriverLaunchRequest,
  caps: ProviderCapabilities | undefined
): DriverSession {
  const receipt: SendReceipt = {
    confidence: 'confirmed',
    heldUntilTurnEnd: false,
    correlation: 'fake'
  }
  return {
    ref: { providerId: req.install.providerId, providerSessionId: `fake-${req.launchId}` },
    get capabilities(): ProviderCapabilities {
      if (caps === undefined) throw new Error('FakeSessionStarter was given no capabilities')
      return caps
    },
    events: () => ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) })
    }),
    sendTurn: async () => receipt,
    interrupt: async () => undefined,
    answerPermission: async () => ({ kind: 'refused', reason: 'ask-closed' }),
    answerQuestion: async () => ({ kind: 'refused', reason: 'ask-closed' }),
    close: async () => ({ kind: 'closed' })
  }
}

export class FakeSessionStarter implements SessionStarter {
  /** Every start, in call order. */
  readonly starts: RecordedStart[] = []
  private readonly scripts: StartScript[] = []
  private spawns = 0

  constructor(private readonly deps: FakeSessionStarterDeps) {}

  /** What the next unscripted `start` meets; starts with no script are ready. */
  arrange(script: StartScript): void {
    this.scripts.push(script)
  }

  async start(
    providerId: ProviderId,
    req: DriverLaunchRequest,
    gate: { launchedWithLetJevChoose: boolean }
  ): Promise<StartResult> {
    this.starts.push({ providerId, req, gate })
    const script = this.scripts.shift() ?? { kind: 'ready' }
    const fail = (
      cause: 'not-installed' | 'could-not-start' | 'exited-at-once',
      toolOutputTail?: string
    ): StartResult => ({
      ok: false,
      error: buildLaunchFailure({
        cause,
        supplierLabel: this.deps.supplierLabel ?? 'Fake supplier',
        ...(toolOutputTail === undefined ? {} : { toolOutputTail })
      })
    })
    if (script.kind === 'not-installed') return fail('not-installed')
    const t0 = this.deps.clock.now()
    this.spawns += 1
    await req.onSpawned({
      pid: 40_000 + this.spawns,
      processStartTimeMs: t0,
      bootId: 'fake-session-starter'
    })
    if (script.kind === 'rejects') return fail(script.cause, script.toolOutputTail)
    await new Promise<void>((resolve) =>
      this.deps.scheduler.after(t0 + EARLY_FAILURE_WINDOW_MS - this.deps.clock.now(), resolve)
    )
    if (script.kind === 'exits-in-window') return fail('exited-at-once')
    return { ok: true, value: fakeSession(req, this.deps.capabilities) }
  }
}
