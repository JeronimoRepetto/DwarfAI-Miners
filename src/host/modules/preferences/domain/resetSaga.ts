// The Reset-metrics saga (07 machine 13; ADR-023 item 4): its step order and its transition
// function. The journal's value is the LAST COMPLETED step, with one precision for `db`: `db` is
// written inside the `db` transaction, and its post-commit cleanup runs after that commit, still
// in `db` (07 §13). Pure: no I/O, no clock (05 §2.2, R1).

/** ADR-023 item 5 `ResetStep`, in its order (07 §13). */
export type ResetStep =
  'begun' | 'db' | 'secrets' | 'external-config' | 'ui-prefs' | 'install-moment' | 'done'

/** Where the saga is: `none` is the diagram's `[*]` (no unfinished saga). */
export type ResetSagaState = ResetStep | 'none'

export type ResetSagaTrigger = 'confirmed' | 'step-done' | 'step-failed' | 'boot-resume'

export type ResetTransitionId =
  'S13.01' | 'S13.02' | 'S13.03' | 'S13.04' | 'S13.05' | 'S13.06' | 'S13.07' | 'S13.08'

export type ResetTransition = { ok: true; id: ResetTransitionId; to: ResetStep } | { ok: false }

/** The steps in their order (ADR-023 item 4). */
export const RESET_STEPS: readonly ResetStep[] = Object.freeze([
  'begun',
  'db',
  'secrets',
  'external-config',
  'ui-prefs',
  'install-moment',
  'done'
])

/** The S13.02…S13.06 transition that completes each step the saga can be found in. */
const STEP_DONE: Readonly<Partial<Record<ResetStep, ResetTransitionId>>> = Object.freeze({
  db: 'S13.02',
  secrets: 'S13.03',
  'external-config': 'S13.04',
  'ui-prefs': 'S13.05',
  'install-moment': 'S13.06'
})

const NO: ResetTransition = Object.freeze({ ok: false })

/** The step after `step` (`done` has none). */
export function nextResetStep(step: ResetStep): ResetStep | null {
  return RESET_STEPS[RESET_STEPS.indexOf(step) + 1] ?? null
}

/**
 * 07 machine 13:
 * - S13.01 `[*]` + confirmed → `db` (`begun` and `db` are written in one transaction, so the saga is
 *   never found at `begun`);
 * - S13.02…S13.06 a step done → the next step;
 * - S13.07 a step failed → the same step (nothing is rolled back);
 * - S13.08 boot resume of an unfinished saga → the next step (from `db`, after its cleanup re-ran).
 * Every other pair is rejected: `done` has no way out, and a saga is started only from `[*]`.
 */
export function resetTransition(from: ResetSagaState, trigger: ResetSagaTrigger): ResetTransition {
  if (from === 'none') return trigger === 'confirmed' ? { ok: true, id: 'S13.01', to: 'db' } : NO
  const done = STEP_DONE[from]
  const next = nextResetStep(from)
  if (done === undefined || next === null) return NO
  switch (trigger) {
    case 'step-done':
      return { ok: true, id: done, to: next }
    case 'step-failed':
      return { ok: true, id: 'S13.07', to: from }
    case 'boot-resume':
      return { ok: true, id: 'S13.08', to: next }
    case 'confirmed':
      return NO
  }
}

// As ADR-023 items 4–5 write them. The command is validated in UI main and in the Host (ADR-019).
export interface ResetMetricsCommand {
  confirmed: 'yes'
}
export type MetricsResetResult =
  | { outcome: 'reset'; epoch: number }
  | { outcome: 'failed'; reason: string; resumesOnNextStart: boolean }
