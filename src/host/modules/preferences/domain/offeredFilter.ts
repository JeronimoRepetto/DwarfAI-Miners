// The strangler-only per-cut filter of `WelcomeStepState.offered` (21 §2 cut 2; AMENDMENT-9,
// OQ-70): the step offers only the installed tools whose foreign entry the Host writes in this
// cut. In cuts 2–3e that is `claude-hooks` alone, even when OpenCode is installed: the OpenCode
// plugin file's writer is still the legacy installer, so its option is never offered and the boot
// legacy check never looks at the `opencode-plugin` target (07 S41.02 runs on offered targets
// only). From cut 4a the Host writes that entry too and this filter goes away (later: ISSUE-232,
// which deletes this file and its one reader).
import type { IntegrationId } from '../../../kernel/domain/values'

export const OFFERED_FILTER: {
  readonly offered: readonly IntegrationId[]
  readonly removedInCut: '4a'
  readonly removedBy: 'ISSUE-232'
} = Object.freeze({
  offered: Object.freeze<IntegrationId[]>(['claude-hooks']),
  removedInCut: '4a',
  removedBy: 'ISSUE-232'
})
