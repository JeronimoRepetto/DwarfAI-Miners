// The first-run consent step (07 machine 41; OQ-68, AMENDMENT-7; ADR-016 item 5), pure (R1: no
// clock read, no I/O). The Host reads the facts at boot — the stored answer
// (`WelcomeAnswerStore.answeredAt`), the installed tools (`InstalledToolsReader`) and the old-app
// entries of the offered targets (`ExternalConfigWriter.findLegacy`) — and `evaluate` decides the
// step from them:
//
// - `offered` = the installed tools the cut filter allows (AMENDMENT-9, OQ-70; offeredFilter.ts), in
//   the step's order (`claude-hooks`, then `opencode-permissions`, 16 §4.12 `answerWelcome`);
// - nothing offered → skipped (S41.09): not due, nothing listed, and not an answer, so the next boot
//   with a tool installed evaluates again;
// - an old-app entry of an offered target → due with `legacy-entries` (S41.02), which wins; an entry
//   of a target not offered is never listed (ADR-016: never adopted silently, never shown either);
// - never answered (a fresh DB, or a finished Reset, S41.07) → due with `first-run` (S41.01);
// - otherwise not due (S41.03).
//
// `welcomeTransition` is the machine's table, walked by id in its L1 test (17 §1.1).
import type { Instant, IntegrationId } from '../../../kernel/domain/values'

// As 05 §3.12 writes it (names, members and comment; layout by prettier)
export interface WelcomeStepState {
  due: boolean
  reason?: 'first-run' | 'legacy-entries'
  legacyFound: IntegrationId[]
  offered: IntegrationId[]
} // AMENDMENT-7: 07 machine 41; persisted part app_meta.welcome_answered_at (09); offered = installed tools only (AMENDMENT-9, OQ-70)

/** The machine's states; `none` is `[*]`, the boot before the step is evaluated. */
export type WelcomeMachineState = 'none' | 'not-due' | 'due' | 'answering'

/** What moves the machine; the `boot-*` triggers are the outcomes of the boot evaluation. */
export type WelcomeTrigger =
  | 'boot-first-run'
  | 'boot-legacy-found'
  | 'boot-answered'
  | 'boot-none-offered'
  | 'answer'
  | 'settled'
  | 'reset'
  | 'closed-unanswered'

export type WelcomeTransitionId =
  'S41.01' | 'S41.02' | 'S41.03' | 'S41.04' | 'S41.05' | 'S41.06' | 'S41.07' | 'S41.08' | 'S41.09'

export type WelcomeTransition =
  { ok: true; id: WelcomeTransitionId; to: WelcomeMachineState } | { ok: false }

/** What the Host read at this boot. */
export interface WelcomeFacts {
  /** `app_meta.welcome_answered_at`: null until the step is answered, and again after a Reset. */
  answeredAt: Instant | null
  /** The integrations whose tool the installed detection found. */
  installed: readonly IntegrationId[]
  /** The integrations of the offered targets whose old-app entry the legacy check found. */
  legacyFound: readonly IntegrationId[]
  /** The integrations this cut offers (offeredFilter.ts). */
  cutFilter: readonly IntegrationId[]
}

/** The order the step shows and answers its options in (16 §4.12 `answerWelcome`). */
const STEP_ORDER: readonly IntegrationId[] = ['claude-hooks', 'opencode-permissions']

/** The step at this boot (S41.01, S41.02, S41.03, S41.09). */
export function evaluate(facts: WelcomeFacts): WelcomeStepState {
  const offered = STEP_ORDER.filter(
    (id) => facts.installed.includes(id) && facts.cutFilter.includes(id)
  )
  if (offered.length === 0) return { due: false, legacyFound: [], offered: [] }
  const legacyFound = offered.filter((id) => facts.legacyFound.includes(id))
  if (legacyFound.length > 0) return { due: true, reason: 'legacy-entries', legacyFound, offered }
  if (facts.answeredAt === null) return { due: true, reason: 'first-run', legacyFound, offered }
  return { due: false, legacyFound, offered }
}

const TABLE: ReadonlyArray<{
  id: WelcomeTransitionId
  from: WelcomeMachineState
  trigger: WelcomeTrigger
  to: WelcomeMachineState
}> = [
  { id: 'S41.01', from: 'none', trigger: 'boot-first-run', to: 'due' },
  { id: 'S41.02', from: 'none', trigger: 'boot-legacy-found', to: 'due' },
  { id: 'S41.02', from: 'not-due', trigger: 'boot-legacy-found', to: 'due' },
  { id: 'S41.03', from: 'none', trigger: 'boot-answered', to: 'not-due' },
  { id: 'S41.04', from: 'due', trigger: 'answer', to: 'answering' },
  { id: 'S41.05', from: 'answering', trigger: 'settled', to: 'not-due' },
  { id: 'S41.06', from: 'answering', trigger: 'boot-first-run', to: 'due' },
  { id: 'S41.07', from: 'not-due', trigger: 'reset', to: 'due' },
  { id: 'S41.08', from: 'due', trigger: 'closed-unanswered', to: 'due' },
  { id: 'S41.09', from: 'none', trigger: 'boot-none-offered', to: 'not-due' }
]

/** 07 machine 41: the listed transition for `(from, trigger)`, or `{ ok: false }`. */
export function welcomeTransition(
  from: WelcomeMachineState,
  trigger: WelcomeTrigger
): WelcomeTransition {
  const row = TABLE.find((r) => r.from === from && r.trigger === trigger)
  return row === undefined ? { ok: false } : { ok: true, id: row.id, to: row.to }
}
