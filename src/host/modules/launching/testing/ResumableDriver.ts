// A resumable `ProviderDriver` double (ADR-009 D3; 16 §2.8) for the Host recovery flows
// (wiring/flows/hostRecovery.test.ts): `resume` and `adopt` meet the next arranged answer, the way a
// real driver would answer a stored provider session id after a Host restart (ADR-015 items 5, 7).
// It spawns nothing: a resumed session's process is a pid the test scripts on its
// FakeProcessControl. Never imported by production code (R14).
import type { ProviderId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type {
  DriverResumeError,
  DriverSession,
  DriverTransport,
  ProviderDriver,
  SendReceipt,
  SessionRef
} from '../../suppliers'

/** How the next `resume` (or `adopt`) answers. */
export type ResumeAnswer =
  | { kind: 'same-id' } // SP-15: `--resume <id>` keeps the provider session id
  | { kind: 'new-id'; providerSessionId: string } // a resume that minted a new id (C-16)
  | { kind: 'rejects'; reason: DriverResumeError['reason'] }
  | { kind: 'adopt-null' }

export interface ResumableDriverDeps {
  providerId: ProviderId
  transport?: DriverTransport
  clock: Clock
  scheduler: Scheduler
  /** How long a resume takes to answer. */
  resumeMs?: number
  /** Whether the driver can re-attach a live server-kind session. */
  adopt?: boolean
  /** The pid each resumed session's process gets, in order. */
  pids?: number[]
}

export class ResumableDriver {
  private readonly answers: ResumeAnswer[] = []
  private readonly pids: number[]
  /** Every call in order: which operation, at which instant, for which provider session id. */
  readonly calls: Array<{ op: 'resume' | 'adopt'; at: number; providerSessionId: string }> = []
  readonly driver: ProviderDriver

  constructor(private readonly deps: ResumableDriverDeps) {
    this.pids = [...(deps.pids ?? [])]
    const resume = (ref: SessionRef) => this.answer('resume', ref)
    this.driver = {
      profile: {
        id: deps.providerId,
        label: 'Resumable',
        binaries: ['tool'],
        models: [],
        efforts: [],
        permissionModes: [],
        drivers: [deps.transport ?? 'stream-json'],
        publicLaunch: 'enabled'
      },
      transport: deps.transport ?? 'stream-json',
      detect: async () => ({ kind: 'not-installed' }),
      probe: async () => {
        throw new Error('the resumable driver is never probed')
      },
      launch: async () => {
        throw new Error('the resumable driver only resumes')
      },
      resume,
      ...(deps.adopt === true
        ? {
            adopt: async (ref: SessionRef) => {
              const session = await this.answer('adopt', ref).catch(() => null)
              return session
            }
          }
        : {})
    }
  }

  /** What the next `resume` / `adopt` meets; unarranged calls keep the id (SP-15). */
  arrange(answer: ResumeAnswer): void {
    this.answers.push(answer)
  }

  private async answer(op: 'resume' | 'adopt', ref: SessionRef): Promise<DriverSession> {
    this.calls.push({ op, at: this.deps.clock.now(), providerSessionId: ref.providerSessionId })
    const answer = this.answers.shift() ?? { kind: 'same-id' }
    await new Promise<void>((resolve) =>
      this.deps.scheduler.after(this.deps.resumeMs ?? 0, resolve)
    )
    if (answer.kind === 'rejects') {
      const error: DriverResumeError = { reason: answer.reason, detail: 'scripted' }
      throw error
    }
    if (answer.kind === 'adopt-null') {
      if (op === 'adopt') return null as unknown as DriverSession
      throw { reason: 'resume-error' } satisfies DriverResumeError
    }
    const pid = this.pids.shift()
    const next: SessionRef = {
      providerId: ref.providerId,
      providerSessionId:
        answer.kind === 'new-id' ? answer.providerSessionId : ref.providerSessionId,
      ...(answer.kind === 'new-id' ? { previousProviderSessionId: ref.providerSessionId } : {}),
      ...(pid === undefined ? {} : { pid, processStartTimeMs: this.deps.clock.now() })
    }
    return this.session(next)
  }

  private session(ref: SessionRef): DriverSession {
    const receipt: SendReceipt = {
      confidence: 'confirmed',
      heldUntilTurnEnd: false,
      correlation: 'resumable'
    }
    return {
      ref,
      get capabilities(): never {
        throw new Error('the resumable session reports no capabilities')
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
}
