// The resume of one owned session by its stored provider session id (ADR-015 items 5, 7; 07 S4.16,
// S4.18, S4.19, S4.20, S4.21; ADR-009 D3), shared by the boot recovery pass
// (recoverAfterHostStart.ts) and the person's Retry of the grouped message (recoveryActions.ts):
// both re-attempt the SAME provider session, never a new one, and never re-send a prompt (OQ-41 A).
//
// - The resume asks the session's own driver (the registry's driver of the record's transport).
//   A driver without `resume` answers `no-resume`; a refusal maps `DriverResumeError.reason` 1:1
//   (`stale-ref`), anything else is `resume-error`.
// - A resumed session is bound to the same dwarf (`SessionBindings.bind`, ADR-015 item 7); a new
//   provider session id rebinds the dwarf (crew `rebind`, S4.18, `previousProviderSessionId`), so its
//   id and custom name stay. Its record then names the new session, its new process (read back by
//   pid, INV-51) and this epoch, so a later crash recovers it again.
// - A re-adopted live server-kind session (S4.11) keeps its process and is bound the same way.
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type { DwarfId, HostEpoch, ProviderIdentity, Result } from '../../../kernel/domain/values'
import type { ProcessControl } from '../../../kernel/ports/processControl'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { CrewCommands } from '../../crew'
import type {
  DriverRegistry,
  DriverSession,
  ProviderDriver,
  SessionBindings,
  SessionRef
} from '../../suppliers'
import type { UnrecoveredReason } from '../domain/recoveryReport'
import type { LaunchRecord, LaunchRecordStore } from '../ports/launchRecordStore'
import type { ProcessRecordStore } from '../ports/processRecordStore'

export interface SessionResumerDeps {
  records: LaunchRecordStore
  processes: ProcessRecordStore
  transactions: TransactionRunner
  suppliers: {
    registry: Pick<DriverRegistry, 'drivers'>
    bindings: SessionBindings
  }
  crew: Pick<CrewCommands, 'rebind'>
  processControl: Pick<ProcessControl, 'probe'>
  hostEpoch: HostEpoch
}

/** Why a resume did not own the session again (ADR-015 item 5 `UnrecoveredReason`). */
export type ResumeFailure = Extract<UnrecoveredReason, 'no-resume' | 'stale-ref' | 'resume-error'>

function identityOf(ref: SessionRef): ProviderIdentity {
  return {
    providerId: ref.providerId,
    providerSessionId: ref.providerSessionId,
    ...(ref.providerAgentId === undefined ? {} : { providerAgentId: ref.providerAgentId })
  }
}

/** `DriverResumeError.reason` (ADR-009 D3) maps 1:1 to the report; anything else is an error. */
function resumeFailure(error: unknown): Extract<ResumeFailure, 'stale-ref' | 'resume-error'> {
  const reason = (error as { reason?: unknown } | null)?.reason
  return reason === 'stale-ref' ? 'stale-ref' : 'resume-error'
}

export class SessionResumer {
  constructor(private readonly deps: SessionResumerDeps) {}

  /** The record's own driver: the registry's driver of its provider and transport. */
  driverOf(record: LaunchRecord): ProviderDriver | undefined {
    return this.deps.suppliers.registry
      .drivers(record.ref.providerId)
      .find((driver) => driver.transport === record.driverTransport)
  }

  /** S4.16 / S4.20: the same provider session resumed and owned again by the same dwarf. */
  async resume(record: LaunchRecord): Promise<Result<void, ResumeFailure>> {
    const driver = this.driverOf(record)
    if (driver?.resume === undefined) return { ok: false, error: 'no-resume' }
    let session: DriverSession
    try {
      session = await driver.resume(record.ref)
    } catch (error) {
      return { ok: false, error: resumeFailure(error) }
    }
    await this.ownResumed(record, session)
    return { ok: true, value: undefined }
  }

  /** S4.11: a re-adopted session keeps its process; it is bound to the same dwarf. */
  owned(record: LaunchRecord, session: DriverSession): void {
    this.deps.suppliers.bindings.bind(session.ref, record.dwarfId)
    this.deps.transactions.inTransaction(() =>
      this.deps.records.put({ ...record, ref: session.ref, hostEpoch: this.deps.hostEpoch })
    )
  }

  /** The probe of a recorded pid; a probe that throws is `unknown` (INV-51). */
  async probe(pid: number): Promise<Awaited<ReturnType<ProcessControl['probe']>>> {
    try {
      return await this.deps.processControl.probe(pid)
    } catch {
      return 'unknown'
    }
  }

  /** S4.18: the same dwarf, its record moved to the resumed session and this epoch. */
  private async ownResumed(record: LaunchRecord, session: DriverSession): Promise<void> {
    const { ref } = session
    const identity = await this.processOf(ref)
    this.deps.suppliers.bindings.bind(ref, record.dwarfId)
    if (ref.providerSessionId !== record.ref.providerSessionId) {
      this.deps.crew.rebind(record.dwarfId as DwarfId, identityOf(ref))
    }
    this.deps.transactions.inTransaction(() => {
      if (identity !== null) {
        this.deps.processes.put({
          identity,
          purpose: 'session',
          launchId: record.launchId,
          hostEpoch: this.deps.hostEpoch
        })
      }
      const { process: _old, ...rest } = record
      void _old
      this.deps.records.put({
        ...rest,
        ref,
        ...(identity === null ? {} : { process: identity }),
        hostEpoch: this.deps.hostEpoch
      })
    })
  }

  /** The full identity of the resumed session's process, read back by its pid (INV-51). */
  private async processOf(ref: SessionRef): Promise<ProcessIdentity | null> {
    if (ref.pid === undefined) return null
    const probed = await this.probe(ref.pid)
    if (probed === 'absent' || probed === 'unknown') return null
    return probed
  }
}
