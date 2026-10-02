// The Reset-metrics saga (16 §4.12 `PreferencesCommands.resetMetrics`; ADR-023 items 1–5; 07
// machine 13; 11 F8; UC-027). One journaled Host saga that always converges:
//
//   db → secrets → external-config → ui-prefs → install-moment → done
//
// - `db` (S13.01): ONE transaction joins `ResetJournal.begin` (journal row at `db`, epoch + 1, the
//   first-run answer cleared) and every registered module `ResetDbStep` (16 §2.2). After the commit
//   `MetricsResetStarted` is published (16 §2.3), then, still in `db`, the post-commit cleanup runs:
//   backups deleted, WAL truncated, `VACUUM` (`ResetDbMaintenance`, host/platform/sqlite). The
//   journal moves past `db` only after all three, so a saga found at `db` re-runs them first.
// - `secrets` (S13.02): `SecretStore.delete` of both names; `'unavailable'` completes the step
//   (ADR-017 item 1, AMENDMENT-2), a delete that throws fails it.
// - `external-config` (S13.03): `ExternalConfigWriter.revert` of every target whose toggle defaults
//   to off (both: OQ-17, OQ-68); with no active `config_writes` row it is a no-op (lead decision
//   2026-09-30). A locked file fails the step.
// - `ui-prefs` (S13.04, S13.05): `ui.resetPreferences {epoch}` to every attached UI; the step is done
//   when each acked or detached (`ResetUiFanout`, host/transport). No ack timeout (07 §24 I-14).
// - `install-moment` (S13.05): the registered install-moment step in its own transaction.
// - `done` (S13.06): `MetricsResetFinished`, and only now `{outcome:'reset', epoch}`.
//
// Each step's work runs between transactions (16 §2.2) and is idempotent; the journal advances
// after it, and `reset.progress` (B-F27) reports the step reached. A step that cannot complete is
// never rolled back (S13.07): its reason in `reset_journal.last_failure`, `MetricsResetFailed`,
// `reset.failed`, and `{outcome:'failed', resumesOnNextStart:true}`; the next Host boot resumes the
// saga from its journal (`resumeOnBoot`, S13.08). A failure of the `db` transaction itself commits nothing, so nothing
// resumes: `resumesOnNextStart:false`.
//
// A second `resetMetrics` while the saga runs waits for it and answers its result (lead decision
// 2026-09-30, 07 §24 I-14). One after a failed step continues the same saga from its journal.
// The saga never ends a session, closes an ask or cancels a launch (INV-109): it holds no port that
// could.
import type { EventId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { PreferencesEvent } from '../domain/events'
import {
  resetTransition,
  type MetricsResetResult,
  type ResetMetricsCommand,
  type ResetStep
} from '../domain/resetSaga'
import type { ConfigTarget, ExternalConfigWriter } from '../ports/externalConfigWriter'
import type { ResetDbStep, ResetJournal } from '../ports/resetJournal'
import type { SecretName, SecretStore } from '../ports/secretStore'

/** The post-commit part of the `db` step (ADR-023 item 4.2): each action idempotent. */
export interface ResetDbMaintenance {
  /** Deletes every `dwarfai.db.bak-*` pre-migration backup. */
  deleteBackups(): void
  /** `PRAGMA wal_checkpoint(TRUNCATE)`. */
  truncateWal(): void
  /** `VACUUM`, outside any transaction. */
  vacuum(): void
}

/** How the saga reaches the attached UIs (14 B-F26, B-F27, B-M09). */
export interface ResetUiFanout {
  /** B-F27 `reset.progress` to every `ui` connection. */
  progress(progress: { resetId: string; epoch: number; step: ResetStep }): void
  /**
   * B-F26 `ui.resetPreferences {epoch}` to every attached `ui` connection; settles when each of
   * them acked with B-M09 or detached (07 S13.05).
   */
  resetPreferences(epoch: number): Promise<void>
}

export interface ResetSagaDeps {
  journal: ResetJournal
  transactions: TransactionRunner
  /** Every module's table set, in the 09 §7.2 order (host/wiring/resetParticipants.ts). */
  dbSteps: readonly ResetDbStep[]
  /** Writes `install_moment(now, 'reset')` in its own transaction (07 S13.05). */
  installMoment: ResetDbStep
  maintenance: ResetDbMaintenance
  secrets: SecretStore
  externalConfig: ExternalConfigWriter
  ui: ResetUiFanout
  bus: DomainEventBus<PreferencesEvent>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch, carried by every event (ADR-015). */
  hostEpoch: HostEpoch
  log: DiagnosticsLog
}

/** The saga being run: its journal row id and its reset epoch. */
interface Saga {
  id: string
  epoch: number
}

/** Both secrets DwarfAI holds (OQ-12; ADR-017 item 7). */
const SECRETS: readonly SecretName[] = ['jev-key', 'opencode-password']

/** The targets whose toggle defaults to off: both (OQ-17; OQ-68, AMENDMENT-7). */
const DEFAULT_OFF_TARGETS: readonly ConfigTarget[] = ['claude-hooks', 'opencode-plugin']

/** A step that could not complete: the step and the fixed reason the result carries. */
class StepFailure extends Error {
  constructor(
    readonly step: ResetStep,
    readonly reason: string,
    readonly cause?: unknown
  ) {
    super(`reset step ${step} failed: ${reason}`)
    this.name = 'StepFailure'
  }
}

export class ResetSaga {
  private running: Promise<MetricsResetResult> | null = null
  private unfinished: Saga | null = null

  constructor(private readonly deps: ResetSagaDeps) {}

  resetMetrics(cmd: ResetMetricsCommand): Promise<MetricsResetResult> {
    // The transport refuses any other value with INVALID_PARAMS; this is the Host's own check
    // (ADR-019, ADR-023 item 5).
    if (cmd.confirmed !== 'yes') throw new Error('resetMetrics needs confirmed: yes')
    if (this.running !== null) return this.running
    const run = this.unfinished === null ? this.start() : this.continueFrom(this.unfinished)
    this.running = run.finally(() => {
      this.running = null
    })
    return this.running
  }

  /**
   * S13.08: the boot resume, before commands and observation (16 §8.2 step 3). It continues the
   * unfinished saga from its journal's last completed step (from `db`, the cleanup runs again
   * first); `null` when no saga is unfinished.
   */
  resumeOnBoot(): Promise<MetricsResetResult | null> {
    if (this.running !== null) return this.running
    const found = this.deps.journal.unfinished()
    if (found === null) return Promise.resolve(null)
    const saga: Saga = { id: found.id, epoch: found.epoch }
    this.deps.log.record({
      level: 'info',
      event: 'reset.resumed',
      subsystem: 'preferences',
      resetId: saga.id,
      msg: found.step
    })
    this.unfinished = saga
    this.running = this.continueFrom(saga).finally(() => {
      this.running = null
    })
    return this.running
  }

  /** S13.01: the `db` transaction, then the rest of the saga. */
  private start(): Promise<MetricsResetResult> {
    const { transactions, journal, dbSteps } = this.deps
    let saga: Saga
    try {
      saga = transactions.inTransaction(() => {
        const begun = journal.begin(transactions)
        for (const step of dbSteps) step.reset(transactions)
        return begun
      })
    } catch (error) {
      this.deps.log.record({
        level: 'error',
        event: 'reset.failed',
        subsystem: 'preferences',
        msg: 'db',
        causeClass: 'db-transaction-failed',
        errCode: errorCode(error)
      })
      return Promise.resolve({
        outcome: 'failed',
        reason: 'db-transaction-failed',
        resumesOnNextStart: false
      })
    }
    this.unfinished = saga
    this.publish('MetricsResetStarted', { resetId: saga.id, epoch: saga.epoch })
    this.reached(saga, 'db')
    return this.continueFrom(saga)
  }

  /** From the journal's last completed step to `done` (S13.02…S13.06), or to a failed step. */
  private async continueFrom(saga: Saga): Promise<MetricsResetResult> {
    let step = this.deps.journal.step(saga.id)
    while (step !== 'done') {
      const next = resetTransition(step, 'step-done')
      if (!next.ok) throw new Error(`the reset journal holds a step the saga cannot leave: ${step}`)
      try {
        await this.work(saga, step, next.to)
      } catch (error) {
        if (error instanceof StepFailure) return this.failed(saga, error)
        throw error
      }
      this.deps.journal.advance(saga.id, next.to)
      this.reached(saga, next.to)
      step = next.to
    }
    this.unfinished = null
    this.publish('MetricsResetFinished', { resetId: saga.id, epoch: saga.epoch })
    return { outcome: 'reset', epoch: saga.epoch }
  }

  /** The work that completes the step `to`, coming from the last completed step `from`. */
  private async work(saga: Saga, from: ResetStep, to: ResetStep): Promise<void> {
    switch (to) {
      case 'secrets':
        if (from === 'db') this.cleanUp(saga)
        return this.deleteSecrets()
      case 'external-config':
        return this.revertConfigs()
      case 'ui-prefs':
        return attempt('ui-prefs', 'ui-reset-failed', () =>
          this.deps.ui.resetPreferences(saga.epoch)
        )
      case 'install-moment':
        return attempt('install-moment', 'install-moment-failed', () =>
          this.deps.transactions.inTransaction(() =>
            this.deps.installMoment.reset(this.deps.transactions)
          )
        )
      default:
        return
    }
  }

  /** The `db` step's post-commit part, logged as a `db` step of its own (19 §9.5). */
  private cleanUp(saga: Saga): void {
    const { maintenance } = this.deps
    try {
      maintenance.deleteBackups()
      maintenance.truncateWal()
      maintenance.vacuum()
    } catch (error) {
      throw new StepFailure('db', 'db-cleanup-failed', error)
    }
    this.logStep(saga, 'db')
  }

  private async deleteSecrets(): Promise<void> {
    for (const name of SECRETS) {
      // 'deleted' and 'unavailable' both complete the step (ADR-017 item 1, AMENDMENT-2).
      await attempt('secrets', 'secret-delete-failed', () => this.deps.secrets.delete(name))
    }
  }

  private async revertConfigs(): Promise<void> {
    let failure: StepFailure | null = null
    for (const target of DEFAULT_OFF_TARGETS) {
      const reverted = await attempt('external-config', 'config-revert-io', () =>
        this.deps.externalConfig.revert(target)
      )
      if (!reverted.ok && failure === null) {
        failure = new StepFailure('external-config', `config-revert-${reverted.error}`)
      }
    }
    if (failure !== null) throw failure
  }

  /** The journal reached `step`: logged and reported to the UIs (B-F27). */
  private reached(saga: Saga, step: ResetStep): void {
    this.logStep(saga, step)
    this.deps.ui.progress({ resetId: saga.id, epoch: saga.epoch, step })
  }

  private logStep(saga: Saga, step: ResetStep): void {
    this.deps.log.record({
      level: 'info',
      event: 'reset.step',
      subsystem: 'preferences',
      resetId: saga.id,
      msg: step,
      outcome: 'ok'
    })
  }

  /** S13.07: nothing is rolled back; the saga resumes at the next Host boot. */
  private failed(saga: Saga, failure: StepFailure): MetricsResetResult {
    this.deps.journal.fail(saga.id, failure.reason)
    this.deps.log.record({
      level: 'error',
      event: 'reset.failed',
      subsystem: 'preferences',
      resetId: saga.id,
      msg: failure.step,
      causeClass: failure.reason,
      ...(failure.cause === undefined ? {} : { errCode: errorCode(failure.cause) })
    })
    this.publish('MetricsResetFailed', {
      resetId: saga.id,
      step: failure.step,
      reason: failure.reason,
      resumesOnNextStart: true
    })
    return { outcome: 'failed', reason: failure.reason, resumesOnNextStart: true }
  }

  private publish<K extends PreferencesEvent['type']>(
    type: K,
    payload: Extract<PreferencesEvent, { type: K }>['payload']
  ): void {
    this.deps.bus.publish({
      type,
      v: 1,
      id: this.deps.ids.uuidv7() as EventId,
      at: this.deps.clock.now(),
      hostEpoch: this.deps.hostEpoch,
      payload
    } as Extract<PreferencesEvent, { type: K }>)
  }
}

/** Runs `work`; anything it throws or rejects with fails `step` with `reason`. */
async function attempt<T>(step: ResetStep, reason: string, work: () => T | Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw new StepFailure(step, reason, error)
  }
}

/** ADR-026 item 5: a thrown error is reduced to its code, else its class name. */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' || typeof code === 'number') return String(code)
    if (error instanceof Error) return error.name
  }
  return 'unknown'
}
