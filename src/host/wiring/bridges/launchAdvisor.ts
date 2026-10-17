// The `LaunchAdvisor` bridge (05 §4; 16 §4.5 `LaunchAdvisor`, §6.4, §13 O-16-06; ADR-020 item 2;
// ADR-028; ISSUE-182, this bridge's only writer): launching asks Jev for a normal "Let Jev choose"
// launch through jev's `JevAdvisor.suggest({ prompt, purpose: 'launch' })`, with the abort signal
// launching fires when its routing budget runs out (16 §6.5). It lives in host/wiring because
// launching never imports jev's application (R3, R4); jev's `index.ts` exports the advisor
// (ISSUE-196).
//
// - Jev's suggestion and its two launch causes (`jev-unreachable`, `jev-could-not-choose`) come back
//   unchanged; the launch maps them (launching/domain/jevFallback.ts).
// - `not-configured` (no Jev key stored) is reported as the `no-key` fallback, a suggestion with no
//   provider (16 §6.4, O-16-06): the launch then fails `jev-could-not-choose` with `jevReason:
//   'no-key'` and offers Pick manually (S5.15), or runs on the pickers' values when they are set
//   (S5.12).
// - The mine is not part of Jev's request (16 §4.9 `suggest` takes no mine): it is the launch's own.
import type { MineId } from '../../kernel/domain/values'
import type { AbortableJevAdvisor, JevSuggestionView } from '../../modules/jev'
import type { AbortableLaunchAdvisor, LaunchAdviceOptions } from '../../modules/launching'

/** 16 §6.4: what `not-configured` is reported as. */
const NO_KEY: JevSuggestionView = {
  confidence: {},
  truncated: false,
  parts: {},
  fallback: 'no-key'
}

export function createLaunchAdvisor(deps: {
  advisor: Pick<AbortableJevAdvisor, 'suggest'>
}): AbortableLaunchAdvisor {
  return {
    suggest: async (prompt: string, _mineId: MineId, opts?: LaunchAdviceOptions) => {
      const answer = await deps.advisor.suggest(
        { prompt, purpose: 'launch' },
        opts?.signal === undefined ? {} : { signal: opts.signal }
      )
      if (answer.ok) return answer
      if (answer.error === 'not-configured') return { ok: true, value: { ...NO_KEY } }
      return { ok: false, error: answer.error }
    }
  }
}
