import { describe, expect, it } from 'vitest'
import {
  resetTransition,
  type ResetSagaState,
  type ResetSagaTrigger,
  type ResetStep,
  type ResetTransitionId
} from './resetSaga'

// L1 (17 §1.1): the diagram-conformance walk of 07 machine 13. Every listed transition reaches its
// target; every other (state, trigger) pair is rejected.

const LISTED: ReadonlyArray<{
  id: ResetTransitionId
  from: ResetSagaState
  trigger: ResetSagaTrigger
  to: ResetStep
}> = [
  { id: 'S13.01', from: 'none', trigger: 'confirmed', to: 'db' },
  { id: 'S13.02', from: 'db', trigger: 'step-done', to: 'secrets' },
  { id: 'S13.03', from: 'secrets', trigger: 'step-done', to: 'external-config' },
  { id: 'S13.04', from: 'external-config', trigger: 'step-done', to: 'ui-prefs' },
  { id: 'S13.05', from: 'ui-prefs', trigger: 'step-done', to: 'install-moment' },
  { id: 'S13.06', from: 'install-moment', trigger: 'step-done', to: 'done' },
  { id: 'S13.07', from: 'db', trigger: 'step-failed', to: 'db' },
  { id: 'S13.07', from: 'secrets', trigger: 'step-failed', to: 'secrets' },
  { id: 'S13.07', from: 'external-config', trigger: 'step-failed', to: 'external-config' },
  { id: 'S13.07', from: 'ui-prefs', trigger: 'step-failed', to: 'ui-prefs' },
  { id: 'S13.07', from: 'install-moment', trigger: 'step-failed', to: 'install-moment' },
  { id: 'S13.08', from: 'db', trigger: 'boot-resume', to: 'secrets' },
  { id: 'S13.08', from: 'secrets', trigger: 'boot-resume', to: 'external-config' },
  { id: 'S13.08', from: 'external-config', trigger: 'boot-resume', to: 'ui-prefs' },
  { id: 'S13.08', from: 'ui-prefs', trigger: 'boot-resume', to: 'install-moment' },
  { id: 'S13.08', from: 'install-moment', trigger: 'boot-resume', to: 'done' }
]

const STATES: readonly ResetSagaState[] = [
  'none',
  'begun',
  'db',
  'secrets',
  'external-config',
  'ui-prefs',
  'install-moment',
  'done'
]
const TRIGGERS: readonly ResetSagaTrigger[] = [
  'confirmed',
  'step-done',
  'step-failed',
  'boot-resume'
]

describe('reset saga (07 machine 13)', () => {
  it('[S13.01, S13.02, S13.03, S13.04, S13.05, S13.06, S13.07, S13.08] every machine-13 transition reaches its target and an unlisted one is rejected', () => {
    for (const { id, from, trigger, to } of LISTED) {
      expect(resetTransition(from, trigger), `${from} + ${trigger}`).toStrictEqual({
        ok: true,
        id,
        to
      })
    }
    for (const from of STATES) {
      for (const trigger of TRIGGERS) {
        if (LISTED.some((row) => row.from === from && row.trigger === trigger)) continue
        // `begun` is written with `db` in one transaction (S13.01), so it is never a state the
        // saga is found in; `done` has no way out; a second `confirmed` never starts a saga.
        expect(resetTransition(from, trigger), `${from} + ${trigger}`).toStrictEqual({ ok: false })
      }
    }
  })
})
