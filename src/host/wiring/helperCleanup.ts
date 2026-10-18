// The helper half of the ADR-015 item 6 cleanup pass (FM-025, INV-57; HO-26; ISSUE-209), run at boot
// step 5 once the Host recovery classified (16 §8.2).
//
// - An orphan is a DwarfAI helper (`mcp-relay`, `hook-shim`, `launcher`) recorded by an earlier
//   Host epoch, whose Host is gone (one Host per OS user, ADR-002 D1). A provider session
//   (`session`, `session-server`) is never one: the recovery pass owns those (ADR-015 items 3-5).
// - The helper is ended only through the kernel's identity-checked tree kill (ADR-014 items 1-4): a
//   pid that now names another process is ended with nothing signalled (its record is stale), and an
//   unreadable identity (`no-identity`) or a tree that refused or survived is kept for the next boot
//   (inconclusive → keep). A helper is never this process group's (`foreign`).
// - Its record is dropped once it is gone (10 §`processes`: deleted on observed exit), in its own
//   transaction after the kill (16 §2.2: the row outlives the act, never the reverse).
// - The pass is bounded (HO-26): no new kill starts once `CLEANUP_BUDGET_MS` have passed since it
//   began; what is left is the next boot's.
// - Package gap (resolved in development): the pass serves the helpers of several modules
//   (delegation's relay, asking's hook shim, attention's launcher), so it is composed here in
//   `host/wiring` over launching's process records, not inside one module's recovery.
//
// Each outcome is logged by class only (19 §9.3): never a path or an argument.
import type { HostEpoch } from '../kernel/domain/values'
import type { Clock } from '../kernel/ports/clock'
import type { DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { ProcessControl } from '../kernel/ports/processControl'
import type { TransactionRunner } from '../kernel/ports/transactionRunner'
import type { ProcessPurpose, ProcessRecordStore } from '../modules/launching'

/** The DwarfAI helpers of ADR-015 item 1: never a provider session. */
export const HELPER_PURPOSES: ReadonlySet<ProcessPurpose> = new Set<ProcessPurpose>([
  'mcp-relay',
  'hook-shim',
  'launcher'
])

/** HO-26: the pass starts no kill after this long. */
export const CLEANUP_BUDGET_MS = 5_000

/** The TERM grace of one helper tree before its KILL (ADR-014 item 3). */
export const HELPER_TERM_GRACE_MS = 1_000

export interface HelperCleanupDeps {
  processes: ProcessRecordStore
  transactions: TransactionRunner
  processControl: Pick<ProcessControl, 'killTree'>
  clock: Clock
  /** This boot's epoch: its own helpers are alive by definition. */
  hostEpoch: HostEpoch
  log: DiagnosticsLog
}

export async function cleanUpHelpers(
  deps: HelperCleanupDeps
): Promise<{ ended: number; kept: number }> {
  const { processes, transactions, processControl, clock, log } = deps
  const startedAt = clock.now()
  const orphans = processes
    .live()
    .filter((record) => HELPER_PURPOSES.has(record.purpose) && record.hostEpoch !== deps.hostEpoch)
  let ended = 0
  let kept = 0
  for (const orphan of orphans) {
    if (clock.now() - startedAt >= CLEANUP_BUDGET_MS) {
      kept += 1
      continue
    }
    const outcome = await processControl
      .killTree(orphan.identity, { graceMs: HELPER_TERM_GRACE_MS, group: 'foreign' })
      .catch(() => ({ kind: 'failed' as const, reason: 'no-identity' as const }))
    if (outcome.kind !== 'ended') {
      kept += 1
      log.record({
        level: 'warn',
        event: 'host.cleanup.helper',
        subsystem: 'host',
        outcome: 'skipped',
        causeClass: outcome.reason
      })
      continue
    }
    transactions.inTransaction(() => processes.ended(orphan.identity.pid, clock.now()))
    ended += 1
  }
  return { ended, kept }
}
