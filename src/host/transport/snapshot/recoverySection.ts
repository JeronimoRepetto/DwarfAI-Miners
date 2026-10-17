// The snapshot's `recovery` section (14 §3.7, §4.1, §4.3 rule 5, frozen; ADR-015 item 5; 07 S16.04,
// S16.08): the offered Host recovery report not settled yet, as 14 §3.6 `HostRecoveryReportView`,
// or null. `ui` only. Live updates: `host.recovered` (wiring/routes/launching.ts). Registered before
// the bind by the launching wiring, it is advertised as `section:recovery` (14 §4.4).
//
// - The report stays in every `ui` snapshot until it settles, whatever its state, so a window that
//   closed before the person acted shows it again at the next attach (S16.08).
// - Building the section for a `ui` snapshot is writing it to that connection: the report is marked
//   shown once, after its data was read, so the first snapshot still carries `pending-display`
//   (rule 5: the UI shows the grouped message once; the Host marks it `shown`, S16.04).
// - Synchronous like every provider (sectionRegistry.ts).
//
// Nothing here logs: the report names dwarfs and provider causes (14 §3.5 SENSITIVE_METHODS
// `session.snapshot`, SENSITIVE_FRAMES `host.recovered`).
import type { HostRecoveryReportView } from '@dwarfai/contracts'
import type { LaunchingRecovery, RecoveryReportView } from '../../modules/launching'
import type { SectionProvider, SectionRegistry } from './sectionRegistry'

/** 14 §3.6 `HostRecoveryReportView` of the module's report view: each wire field named and copied. */
export function toHostRecoveryReportView(view: RecoveryReportView): HostRecoveryReportView {
  const wire: HostRecoveryReportView = {
    hostEpoch: view.hostEpoch,
    at: view.at,
    resumed: [...view.resumed],
    unrecovered: view.unrecovered.map((item) => ({
      dwarfId: item.dwarfId,
      reason: item.reason,
      ...(item.messageIds === undefined ? {} : { messageIds: [...item.messageIds] })
    })),
    state: view.state
  }
  if (view.shownAt !== undefined) wire.shownAt = view.shownAt
  if (view.settledAt !== undefined) wire.settledAt = view.settledAt
  if (view.retryOutcomes !== undefined) {
    wire.retryOutcomes = view.retryOutcomes.map(({ dwarfId, outcome }) => ({ dwarfId, outcome }))
  }
  return wire
}

export interface RecoverySectionDeps {
  /** The Host recovery, once boot step 4 built it; null before (no report yet). */
  recovery: Pick<LaunchingRecovery, 'report' | 'shown'> | null
}

/** The `recovery` provider over `deps`. */
export function recoverySection(deps: RecoverySectionDeps): SectionProvider<'recovery'> {
  return () => {
    const view = deps.recovery?.report() ?? null
    if (view === null) return null
    const wire = toHostRecoveryReportView(view)
    deps.recovery?.shown()
    return wire
  }
}

/** Registers the `recovery` section (`ui` only), so it is advertised as `section:recovery`. */
export function registerRecoverySection(
  sections: SectionRegistry,
  deps: { recovery: () => RecoverySectionDeps['recovery'] }
): void {
  sections.registerSection('recovery', ['ui'], () =>
    recoverySection({ recovery: deps.recovery() })()
  )
}
