// The two driven ports a delegated subtask is routed and launched through (05 §3.8, 16 §4.8 rows
// `SubtaskRouter` and `WorkerLauncher`; ADR-013 items 4-5; UC-017). Type-only (R2): the jev
// module's `JevSuggestionView` comes through its index (05 §5.2 edge delegation → jev).
//
// - `SubtaskRouter` is the bridge → jev (`JevAdvisor.suggest` with `purpose: 'subtask'`, the
//   effort ceiling failing as `jev-could-not-choose`, 16 §6.4; ADR-028 D2). Built in
//   `host/wiring/bridges/subtaskRouter.ts`.
// - `WorkerLauncher` is the bridge → launching (a delegated launch, `delegated = 1`,
//   `launched_with_let_jev_choose = 0`, 09 D-17), answering once that launch settled (16 §2.9).
//   Built in `host/wiring/bridges/workerLauncher.ts` (ISSUE-180), whose structural copy ISSUE-209
//   binds to this port.
import type { LaunchFailureCause } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, Result } from '../../../kernel/domain/values'
import type { JevSuggestionView } from '../../jev'

export type { JevSuggestionView }

// As 16 §4.8 writes them (copy of 05 §3.8; names, members and comments; layout by prettier)
// Amended: 05 §3.8 / 16 §4.8 WorkerLauncher.launchWorker delegationId (AMENDMENT-15 (owner, 2026-10-15))
export interface WorkerLauncher {
  launchWorker(
    delegationId: string,
    parent: DwarfId,
    pick: JevSuggestionView,
    task: string
  ): Promise<Result<DwarfId, LaunchFailureCause>>
} // bridge → launching
export interface SubtaskRouter {
  route(
    task: string,
    context?: string
  ): Promise<Result<JevSuggestionView, 'jev-unreachable' | 'jev-could-not-choose'>>
} // bridge → jev
