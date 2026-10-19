// The `DelegationLifecycle` driving port (owner amendment N (AMENDMENT-14, OQ-85), 2026-10-15,
// A14-01/A14-02/A14-03/A14-06, and addendum A14-07; 16 §4.8 rows, §5.3; ADR-013 items 3-4;
// ADR-015 item 6).
//
// - `issueFor({ launchId, mechanism, launchedWithLetJevChoose })` (the `SessionStarter` bridge,
//   before the driver starts): only with "Subagent delegation" on and a launch that used "Let Jev
//   choose" (PO #50, INV-80); a delegated worker's launch never is (INV-81). For a relay entry
//   (`ticket-file`, `protocol`) it mints the credential, commits the `delegation_tokens` row with
//   its SHA-256 only and no parent, then writes the credential file through `CredentialFileStore`
//   and returns the 15 §1.2 `DelegationInjection`: the relay program (`AppPaths.execPath`) and its
//   entry argument, and the file PATH. The value is never in the injection, a row or a log (ADR-013
//   item 2, C-16). A file that cannot be written revokes the row and returns `null`: the launch
//   proceeds without delegation (logged). `none` and `in-process` (no v1 driver) get `null`.
// - `issuePromptRelay(launchId)` (AMENDMENT-21; the stream-json driver, before its spawn, for a launch
//   `issueFor` left out): the same row and file whatever the gates, so the relay can serve the
//   permission prompt tool; only `issueFor` leads to the delegation tools' pre-approval.
// - `bindParent(launchId, dwarfId)` (route of `DwarfLaunched`): the launch's dwarf becomes its
//   token's parent, once; a launch with no token is a no-op. Releasing the `delegate` calls that
//   wait for the bind (16 §5.2 item 5) is the endpoint's (ISSUE-199).
// - `revokeLaunch(launchId)` (the bridge, when `start` fails after `issueFor`): revokes the
//   launch's token and deletes its file. Closing the launch's relay connection is the endpoint's
//   (ISSUE-199).
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
// boot's sweep retries. Suppliers' types come through the type-only edge of A14-07.
import type { DwarfId, EventId, HostEpoch, LaunchId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { AppPaths } from '../../../kernel/ports/appPaths'
import type { CredentialMinter, PreferencesQueries } from '../../preferences'
import type { DelegationInjection, ProviderCapabilities } from '../../suppliers'
import { applyEvent, type Delegation } from '../domain/delegation'
import { allows } from '../domain/delegationGate'
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
  /** The Host preference "Subagent delegation" (06 §14.2), read at each issue. */
  preferences: Pick<PreferencesQueries, 'get'>
  /** Mints a per-launch credential (host/transport `mintCredential`, lead decision 2026-09-30). */
  mintCredential: CredentialMinter
  /** `execPath` is the Host's versioned-copy executable the relay runs (ADR-002 D5). */
  appPaths: Pick<AppPaths, 'execPath'>
  /** The relay entry argument(s), passed in by the composition root (ISSUE-200 owns the relay). */
  relayEntryArgs: readonly string[]
}

/** What `issueFor` is told about the launch (AMENDMENT-14 A14-02). */
export interface DelegationIssueRequest {
  launchId: LaunchId
  mechanism: ProviderCapabilities['mcpInjection']
  launchedWithLetJevChoose: boolean
}

// As AMENDMENT-14 writes it for 05 §3.8 / 16 §4.8 (names, members and comments; layout by prettier)
export interface DelegationLifecycle {
  // the SessionStarter bridge calls it before the driver starts; when it resolves, the row and the credential file exist (ADR-013 item 3)
  issueFor(launch: {
    launchId: LaunchId
    mechanism: ProviderCapabilities['mcpInjection']
    launchedWithLetJevChoose: boolean
  }): Promise<DelegationInjection | null> // 15 §1.2; null when a gate is closed, for 'none', and for a delegated worker (its launch always has launchedWithLetJevChoose = false, 09 D-17)
  bindParent(launchId: LaunchId, dwarfId: DwarfId): void // route of DwarfLaunched: the launch's dwarf becomes the token's parent; once
  revokeLaunch(launchId: LaunchId): Promise<void> // the bridge, when start fails after issue: revoke the token, delete its file
  revokeFor(dwarfId: DwarfId): Promise<void> // route of DwarfDeparted: revoke its token, delete its file; fail its running delegations (as parent: 'parent-gone')
  sweepOrphans(): Promise<{ revoked: number; deleted: number }> // boot, after the ADR-015 reconcile: revoke live tokens with no parent; delete every credential file without a live token
}

/**
 * AMENDMENT-21 (owner-approved 2026-10-17): every Claude `stream-json` launch carries the relay
 * `--mcp-config` entry, because the relay also serves its permission prompt tool. A launch the
 * delegation gates leave out (`issueFor` gave `null`) gets its relay credential here: the same
 * hash-only `delegation_tokens` row and owner-only credential file, so the same bind, revoke and
 * sweep cover it. The gates stay where they are: the endpoint re-reads them on every delegation
 * call (16 §5.2 item 5) and refuses `gate-closed` for this launch, and only `issueFor` leads to
 * the delegation tools' pre-approval (ADR-013 item 4).
 */
export interface PermissionPromptRelayIssuer {
  // the stream-json driver calls it before its spawn when the launch carries no DelegationInjection; null when the file cannot be written
  issuePromptRelay(launchId: LaunchId): Promise<DelegationInjection | null>
}

export class DelegationLifecycleService
  implements DelegationLifecycle, PermissionPromptRelayIssuer
{
  constructor(private readonly deps: DelegationLifecycleDeps) {}

  async issueFor(launch: DelegationIssueRequest): Promise<DelegationInjection | null> {
    const { mechanism, launchId } = launch
    // A delegated worker's launch always has launchedWithLetJevChoose = false (09 D-17), so it is
    // never gated in: depth one (INV-81). The input carries no `delegated` flag (A14-02).
    const gate = allows(this.deps.preferences.get(), {
      launchedWithLetJevChoose: launch.launchedWithLetJevChoose,
      delegated: false
    })
    // `none`: no delegation for this driver. `in-process`: no v1 driver uses it (OQ-52; 15 §4.1),
    // and its server object is built only when such a driver is cleared.
    if (!gate || (mechanism !== 'ticket-file' && mechanism !== 'protocol')) return null
    return this.issueRelay(launchId, mechanism)
  }

  async issuePromptRelay(launchId: LaunchId): Promise<DelegationInjection | null> {
    return this.issueRelay(launchId, 'ticket-file')
  }

  /** Mints the launch's credential: the hash-only row first, then the owner-only file. */
  private async issueRelay(
    launchId: LaunchId,
    mechanism: 'ticket-file' | 'protocol'
  ): Promise<DelegationInjection | null> {
    const { transactions, tokens, clock, files } = this.deps
    const credential = this.deps.mintCredential()
    transactions.inTransaction(() =>
      tokens.issue({
        launchId,
        parentDwarfId: null,
        mechanism,
        credentialHash: credential.sha256,
        issuedAt: clock.now()
      })
    )
    // Outside the transaction (16 §2.2): the row is recorded before the file exists.
    // A store that throws (an invariant, e.g. a launch id that cannot name a file) fails closed
    // like a refused write: the committed row must not stay live without its file.
    const written = await files.write(launchId, credential.value).catch(() => null)
    if (written === null || !written.ok) {
      transactions.inTransaction(() => tokens.revoke(launchId, clock.now()))
      this.deps.log.record({
        level: 'warn',
        event: 'delegation.credential.write',
        subsystem: SUBSYSTEM,
        outcome: 'failed',
        causeClass: written === null ? 'unknown' : written.error,
        launchId
      })
      return null
    }
    return {
      mechanism,
      relay: { program: this.deps.appPaths.execPath, args: [...this.deps.relayEntryArgs] },
      credentialFilePath: written.value.path
    }
  }

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
