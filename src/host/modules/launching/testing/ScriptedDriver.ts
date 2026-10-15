// A scripted `ProviderDriver` (ADR-009 D3) for the SessionStarter bridge's contract run
// (wiring/bridges/sessionStarter.contract.test.ts): each `launch` meets the next arranged
// `StartScript`, the way a real driver would — `onSpawned` right after the (pretend) spawn, then the
// handshake answer or a `DriverLaunchError` — and its sessions can exit. `sessions` is the suppliers
// `SessionChannels` read the bridge's early window asks: a session that exited is no longer live.
// It spawns nothing. Never imported by production code (R14).
import type { ProviderId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type {
  DriverLaunchError,
  DriverLaunchRequest,
  DriverRegistry,
  DriverSession,
  ProviderDriver,
  SendReceipt,
  SessionChannels,
  SessionRef
} from '../../suppliers'
import type { StartScript } from './sessionStarter.contract'

/** How long after the spawn the scripted handshake answers. */
export const SCRIPTED_HANDSHAKE_MS = 20

export interface ScriptedDriverDeps {
  providerId: ProviderId
  label: string
  clock: Clock
  scheduler: Scheduler
}

export class ScriptedDriver {
  private readonly scripts: StartScript[] = []
  private readonly live = new Map<string, DriverSession>()
  private spawns = 0
  readonly driver: ProviderDriver
  readonly registry: DriverRegistry
  readonly sessions: Pick<SessionChannels, 'sessionFor'>

  constructor(private readonly deps: ScriptedDriverDeps) {
    this.driver = {
      profile: {
        id: deps.providerId,
        label: deps.label,
        binaries: ['tool'],
        models: [],
        efforts: [],
        permissionModes: [],
        drivers: ['stream-json'],
        publicLaunch: 'enabled'
      },
      transport: 'stream-json',
      detect: async () => ({ kind: 'not-installed' }),
      probe: async () => {
        throw new Error('the scripted driver is never probed')
      },
      launch: (req) => this.launch(req)
    }
    this.registry = {
      drivers: (id) => (id === deps.providerId ? [this.driver] : [])
    }
    this.sessions = {
      sessionFor: (ref) => this.live.get(ref.providerSessionId) ?? null
    }
  }

  /** What the next `launch` meets; unscripted launches are ready. */
  arrange(script: StartScript): void {
    this.scripts.push(script)
  }

  private async launch(req: DriverLaunchRequest): Promise<DriverSession> {
    const script = this.scripts.shift() ?? { kind: 'ready' }
    if (script.kind === 'not-installed') {
      const enoent: DriverLaunchError = { cause: 'not-installed', detail: 'ENOENT at spawn' }
      throw enoent
    }
    this.spawns += 1
    await req.onSpawned({
      pid: 50_000 + this.spawns,
      processStartTimeMs: this.deps.clock.now(),
      bootId: 'scripted-driver'
    })
    if (script.kind === 'rejects') {
      const rejected: DriverLaunchError = {
        cause: script.cause,
        ...(script.toolOutputTail === undefined ? {} : { toolOutputTail: script.toolOutputTail })
      }
      throw rejected
    }
    await new Promise<void>((resolve) => this.deps.scheduler.after(SCRIPTED_HANDSHAKE_MS, resolve))
    const ref: SessionRef = {
      providerId: this.deps.providerId,
      providerSessionId: `scripted-${req.launchId}`
    }
    const session = this.session(ref)
    this.live.set(ref.providerSessionId, session)
    if (script.kind === 'exits-in-window') {
      this.deps.scheduler.after(SCRIPTED_HANDSHAKE_MS, () =>
        this.live.delete(ref.providerSessionId)
      )
    }
    return session
  }

  private session(ref: SessionRef): DriverSession {
    const receipt: SendReceipt = {
      confidence: 'confirmed',
      heldUntilTurnEnd: false,
      correlation: 'scripted'
    }
    return {
      ref,
      get capabilities(): never {
        throw new Error('the scripted session reports no capabilities')
      },
      events: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) })
      }),
      sendTurn: async () => receipt,
      interrupt: async () => undefined,
      answerPermission: async () => ({ kind: 'refused', reason: 'ask-closed' }),
      answerQuestion: async () => ({ kind: 'refused', reason: 'ask-closed' }),
      close: async () => {
        this.live.delete(ref.providerSessionId)
        return { kind: 'closed' }
      }
    }
  }
}
