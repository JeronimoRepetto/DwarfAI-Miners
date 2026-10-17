// The `SubtaskRouter` bridge (16 §4.8 row `SubtaskRouter`, §6.4 subtask column; ADR-013 item 4;
// ADR-028 D2; UC-017): delegation → jev. One subtask is one `JevAdvisor.suggest` with
// `purpose: 'subtask'`, the task as the prompt and the context apart (the advisor combines them for
// the request, 16 §6.2). The Jev key, the routing catalog and the 8 000 ms attempt timeout are the
// advisor's and its router's (16 §6.5).
//
// The subtask column of 16 §6.4 has two values only:
// - `jev-unreachable` stays `jev-unreachable` (the retryable reasons);
// - `jev-could-not-choose` and `not-configured` (no key, §13 O-16-06) become `jev-could-not-choose`.
// - A suggestion that fell back is never a subtask pick: the advisor answers one only for a launch
//   (`effort-ceiling`, ADR-028 D2), so a fallback reaching this bridge is mapped by its reason with
//   the same table (`effort-ceiling` → `jev-could-not-choose`), never launched.
import type { JevFallbackReason } from '../../kernel/domain/sharedContracts'
import type { SubtaskRouter } from '../../modules/delegation'
import type { JevAdvisor } from '../../modules/jev'

export interface SubtaskRouterDeps {
  /** The Host's Jev advisor (16 §4.9). */
  jev: JevAdvisor
}

type RouteError = 'jev-unreachable' | 'jev-could-not-choose'

/** 16 §6.4 rows 1, 3 and 4: the retryable reasons, everything else cannot choose. */
const RETRYABLE: ReadonlySet<JevFallbackReason> = new Set<JevFallbackReason>([
  'unreachable',
  'timeout',
  'rate-limited',
  'invalid-response'
])

export function createSubtaskRouter(deps: SubtaskRouterDeps): SubtaskRouter {
  return {
    async route(task, context) {
      const answer = await deps.jev.suggest({
        purpose: 'subtask',
        prompt: task,
        ...(context === undefined ? {} : { context })
      })
      if (!answer.ok) {
        return failed(
          answer.error === 'jev-unreachable' ? 'jev-unreachable' : 'jev-could-not-choose'
        )
      }
      const { fallback } = answer.value
      if (fallback !== undefined) {
        return failed(RETRYABLE.has(fallback) ? 'jev-unreachable' : 'jev-could-not-choose')
      }
      return answer
    }
  }
}

function failed(error: RouteError): { ok: false; error: RouteError } {
  return { ok: false, error }
}
