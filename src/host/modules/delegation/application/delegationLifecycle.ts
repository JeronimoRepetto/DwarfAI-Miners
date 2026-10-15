// The revocation half of the `DelegationLifecycle` driving port (owner amendment N (AMENDMENT-14,
// OQ-85), 2026-10-15, A14-02/A14-03/A14-06; 16 §4.8 rows, §5.3; ADR-013 item 3; ADR-015 item 6).
//
// - `bindParent(launchId, dwarfId)` (route of `DwarfLaunched`): the launch's dwarf becomes its
//   token's parent, once; a launch with no token is a no-op. Releasing the `delegate` calls that
//   wait for the bind (16 §5.2 item 5) is the endpoint's (ISSUE-199).
// - `revokeLaunch(launchId)` (the `SessionStarter` bridge, when `start` fails after `issueFor`):
//   revokes the launch's token and deletes its file. Closing the launch's relay connection is the
//   endpoint's (ISSUE-199).
// - `revokeFor(dwarfId)` (route of `DwarfDeparted`): revokes the dwarf's live tokens, fails its
//   `attempted`/`running` delegations as parent `parent-gone` (07 S8.11) in the same transaction,
//   then deletes the files and publishes one `DelegationFailed{parent-gone}` per delegation.
// - `sweepOrphans()` (boot, after the ADR-015 reconcile): revokes every live token whose parent
//   is still NULL (its launch never reached a dwarf and did not survive the restart), then deletes
//   every credential file whose launch has no live token.
//
// Record before acting (16 §2.2): every row change commits first, the file I/O and the events
// follow outside the transaction. A file that cannot be deleted or listed is logged (no path, no
// value) and is never fatal: the revoked row already refuses the credential (16 §5.7), and the next
// boot's sweep retries. No member ever holds a credential value.
//
// `issueFor` is not here: its signature (A14-01/A14-02) names `DelegationInjection` and
// `ProviderCapabilities['mcpInjection']` of suppliers, and 05 §1.3 has no delegation → suppliers
// edge (see the ISSUE-198 hand-off). The driving interface is declared once it can be whole.
import type { DwarfId, EventId, HostEpoch, LaunchId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { applyEvent, type Delegation } from '../domain/delegation'
import type { DelegationFailed, DelegationLifecycleEvent } from '../domain/events'
import type {
  CredentialFileStore,
  DelegationTicketStore,
  DelegationTokenStore
} from '../ports/delegationStores'

const SUBSYSTEM = 'delegation'

export interface DelegationLifecycleDeps {
  tokens: DelegationTokenStore
  tickets: DelegationTicketStore
  files: CredentialFileStore
  transactions: TransactionRunner
  /** Publishes after each commit (16 §2.3). */
  bus: DomainEventBus<DelegationLifecycleEvent>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
  log: DiagnosticsLog
}

export class DelegationLifecycleService {
  constructor(private readonly deps: DelegationLifecycleDeps) {}

  bindParent(launchId: LaunchId, dwarfId: DwarfId): void {
    const { transactions, tokens } = this.deps
    transactions.inTransaction(() => tokens.bindParent(launchId, dwarfId))
  }

  async revokeLaunch(launchId: LaunchId): Promise<void> {
    const { transactions, tokens, clock } = this.deps
    transactions.inTransaction(() => tokens.revoke(launchId, clock.now()))
    await this.removeFile(launchId)
  }

  async revokeFor(dwarfId: DwarfId): Promise<void> {
    const { transactions, tokens, tickets, clock, bus } = this.deps
    const { revoked, failed } = transactions.inTransaction(() => {
      const at = clock.now()
      const own = tokens.live().filter((token) => token.parentDwarfId === dwarfId)
      for (const token of own) tokens.revoke(token.launchId, at)
      const settled: Delegation[] = []
      for (const delegation of tickets.inFlight()) {
        if (delegation.parentDwarfId !== dwarfId) continue
        const moved = applyEvent(delegation, { type: 'parent-session-ended' }, at)
        if (!moved.ok) continue
        tickets.save(moved.value.delegation)
        settled.push(moved.value.delegation)
      }
      return { revoked: own.map((token) => token.launchId), failed: settled }
    })
    for (const delegation of failed) bus.publish(this.failedEvent(delegation))
    for (const launchId of revoked) await this.removeFile(launchId)
  }

  async sweepOrphans(): Promise<{ revoked: number; deleted: number }> {
    const { transactions, tokens, clock } = this.deps
    const { revoked, live } = transactions.inTransaction(() => {
      const at = clock.now()
      const unbound = tokens.live().filter((token) => token.parentDwarfId === null)
      for (const token of unbound) tokens.revoke(token.launchId, at)
      return {
        revoked: unbound.length,
        live: new Set(tokens.live().map((token) => token.launchId))
      }
    })
    let listed: LaunchId[]
    try {
      listed = await this.deps.files.list()
    } catch (error) {
      this.fileFailure('delegation.credential.sweep', error)
      return { revoked, deleted: 0 }
    }
    let deleted = 0
    for (const launchId of listed) {
      if (live.has(launchId)) continue
      if (await this.removeFile(launchId)) deleted += 1
    }
    return { revoked, deleted }
  }

  /** Deletes a launch's credential file; a failure is logged, never thrown. */
  private async removeFile(launchId: LaunchId): Promise<boolean> {
    try {
      await this.deps.files.remove(launchId)
      return true
    } catch (error) {
      this.fileFailure('delegation.credential.remove', error, launchId)
      return false
    }
  }

  /** The OS code class only: never a message or a path, which could carry a value (ADR-026). */
  private fileFailure(event: string, error: unknown, launchId?: LaunchId): void {
    const code = (error as { code?: unknown } | null)?.code
    this.deps.log.record({
      level: 'warn',
      event,
      subsystem: SUBSYSTEM,
      outcome: 'failed',
      causeClass: typeof code === 'string' && /^E[A-Z]+$/.test(code) ? code : 'unknown',
      ...(launchId === undefined ? {} : { launchId })
    })
  }

  private failedEvent(delegation: Delegation): DelegationFailed {
    const { ids, clock, hostEpoch } = this.deps
    return {
      type: 'DelegationFailed',
      v: 1,
      id: ids.uuidv7() as EventId,
      at: clock.now(),
      hostEpoch,
      payload: {
        delegationId: delegation.id,
        parentDwarfId: delegation.parentDwarfId,
        failure: 'parent-gone'
      }
    }
  }
}
