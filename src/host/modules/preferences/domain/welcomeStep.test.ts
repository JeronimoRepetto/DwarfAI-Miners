import { describe, expect, it } from 'vitest'
import type { IntegrationId } from '../../../kernel/domain/values'
import {
  evaluate,
  welcomeTransition,
  type WelcomeMachineState,
  type WelcomeTransitionId,
  type WelcomeTrigger
} from './welcomeStep'

// L1 (17 §1.1): the diagram-conformance walk of 07 machine 41, and the boot evaluation that picks
// its boot transition (S41.01, S41.02, S41.03, S41.09) from the facts the Host read at boot.

const LISTED: ReadonlyArray<{
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

const STATES: readonly WelcomeMachineState[] = ['none', 'not-due', 'due', 'answering']
const TRIGGERS: readonly WelcomeTrigger[] = [
  'boot-first-run',
  'boot-legacy-found',
  'boot-answered',
  'boot-none-offered',
  'answer',
  'settled',
  'reset',
  'closed-unanswered'
]

const ANSWERED_AT = 1_750_000_000_000
const CUT_2: readonly IntegrationId[] = ['claude-hooks']
const BOTH: readonly IntegrationId[] = ['claude-hooks', 'opencode-permissions']

describe('first-run consent step (07 machine 41)', () => {
  it('[S41.01, S41.02, S41.03, S41.07, S41.09] every machine-41 boot transition reaches its target state and an unlisted one is rejected', () => {
    for (const { id, from, trigger, to } of LISTED) {
      expect(welcomeTransition(from, trigger), `${from} + ${trigger}`).toStrictEqual({
        ok: true,
        id,
        to
      })
    }
    for (const from of STATES) {
      for (const trigger of TRIGGERS) {
        if (LISTED.some((row) => row.from === from && row.trigger === trigger)) continue
        expect(welcomeTransition(from, trigger), `${from} + ${trigger}`).toStrictEqual({
          ok: false
        })
      }
    }

    // S41.01: never answered (fresh DB or a finished Reset, S41.07) and a tool offered.
    expect(
      evaluate({ answeredAt: null, installed: ['claude-hooks'], legacyFound: [], cutFilter: CUT_2 })
    ).toStrictEqual({ due: true, reason: 'first-run', legacyFound: [], offered: ['claude-hooks'] })
    // S41.02: an old-app entry of an offered target wins over first-run, answered or not.
    for (const answeredAt of [null, ANSWERED_AT]) {
      expect(
        evaluate({
          answeredAt,
          installed: ['claude-hooks'],
          legacyFound: ['claude-hooks'],
          cutFilter: CUT_2
        })
      ).toStrictEqual({
        due: true,
        reason: 'legacy-entries',
        legacyFound: ['claude-hooks'],
        offered: ['claude-hooks']
      })
    }
    // S41.03: answered and nothing found.
    expect(
      evaluate({
        answeredAt: ANSWERED_AT,
        installed: ['claude-hooks'],
        legacyFound: [],
        cutFilter: CUT_2
      })
    ).toStrictEqual({ due: false, legacyFound: [], offered: ['claude-hooks'] })
    // S41.09: nothing offered — neither tool installed, or only one the cut does not offer — is a
    // skip, never due, whatever the answer and the old-app entries.
    for (const installed of [[], ['opencode-permissions']] as IntegrationId[][]) {
      for (const answeredAt of [null, ANSWERED_AT]) {
        expect(
          evaluate({
            answeredAt,
            installed,
            legacyFound: ['opencode-permissions'],
            cutFilter: CUT_2
          })
        ).toStrictEqual({ due: false, legacyFound: [], offered: [] })
      }
    }
  })

  it('[US-SET-012.AC07, S41.01] offered holds only the installed tools the cut filter allows, in the step order', () => {
    expect(
      evaluate({ answeredAt: null, installed: BOTH, legacyFound: [], cutFilter: CUT_2 }).offered
    ).toStrictEqual(['claude-hooks'])
    expect(
      evaluate({
        answeredAt: null,
        installed: ['opencode-permissions', 'claude-hooks'],
        legacyFound: [],
        cutFilter: BOTH
      }).offered
    ).toStrictEqual(['claude-hooks', 'opencode-permissions'])
    expect(
      evaluate({
        answeredAt: null,
        installed: ['opencode-permissions'],
        legacyFound: [],
        cutFilter: BOTH
      }).offered
    ).toStrictEqual(['opencode-permissions'])
  })

  it('[S41.02, ADR-016] an old-app entry of a target that is not offered is not listed and does not make the step due', () => {
    expect(
      evaluate({
        answeredAt: ANSWERED_AT,
        installed: BOTH,
        legacyFound: ['opencode-permissions'],
        cutFilter: CUT_2
      })
    ).toStrictEqual({ due: false, legacyFound: [], offered: ['claude-hooks'] })
  })
})
