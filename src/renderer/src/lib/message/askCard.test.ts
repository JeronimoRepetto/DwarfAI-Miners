import { describe, expect, it } from 'vitest'
import type { AskRecord } from '@dwarfai/contracts'
import type { DwarfPermissionRequest, DwarfQuestion } from '../../types'
import { shownAskOf } from './askCard'

/*
 * The ask the message panel draws (ISSUE-138, the read half; 14 §6.4 row `useDwarfQuestion`): the dwarf's front card
 * of the dual-source read model, a Host ask in the card's own shape, else the legacy card, else the board's own asks
 * exactly as the panel drew them before the Host had any.
 */

const ASK_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const DWARF_ID = '01890a5d-ac96-774b-bcce-b302099a8001'

function hostAsk(overrides: Partial<AskRecord> = {}): AskRecord {
  return {
    id: ASK_ID,
    dwarfId: DWARF_ID,
    kind: 'question',
    channel: 'driver',
    providerRequestId: 'req-1',
    payload: {
      steps: [
        { text: 'Which database?', options: ['Postgres', 'SQLite'], allowsFreeText: true },
        { text: 'Run migrations?', options: ['Yes', 'No'], allowsFreeText: true }
      ]
    },
    currentStep: 1,
    state: 'open',
    reannounce: true,
    openedAt: Date.UTC(2026, 9, 14, 9, 0, 0),
    ...overrides
  }
}

const boardPermission: DwarfPermissionRequest = {
  toolUseId: 'toolu_09',
  toolName: 'Bash',
  input: 'rm -rf /tmp/scratch',
  channel: 'held',
  askedAt: '2026-09-05T09:00:00.000Z'
}

const boardQuestion: DwarfQuestion = {
  toolUseId: 'toolu_01',
  channel: 'terminal',
  questions: [{ question: 'Which one?', multiSelect: false, options: [{ label: 'A' }] }]
}

describe('shownAskOf', () => {
  it('[ADR-033] a Host question is drawn as a question card keyed by its AskId, one question per step', () => {
    expect(shownAskOf({ source: 'host', ask: hostAsk() }, {})).toEqual({
      kind: 'question',
      askId: ASK_ID,
      at: 1,
      question: {
        toolUseId: ASK_ID,
        channel: 'held',
        askedAt: '2026-10-14T09:00:00.000Z',
        questions: [
          {
            question: 'Which database?',
            multiSelect: false,
            options: [{ label: 'Postgres' }, { label: 'SQLite' }]
          },
          {
            question: 'Run migrations?',
            multiSelect: false,
            options: [{ label: 'Yes' }, { label: 'No' }]
          }
        ]
      }
    })
  })

  it('[ADR-033] a Host permission is drawn as a permission card keyed by its AskId, its request text as the input', () => {
    const ask = hostAsk({
      kind: 'permission',
      channel: 'hook-decision',
      payload: { toolName: 'Bash', requestText: 'npm test' },
      currentStep: 0
    })
    expect(shownAskOf({ source: 'host', ask }, {})).toEqual({
      kind: 'permission',
      askId: ASK_ID,
      permission: {
        toolUseId: ASK_ID,
        toolName: 'Bash',
        input: 'npm test',
        channel: 'held',
        askedAt: '2026-10-14T09:00:00.000Z'
      }
    })
  })

  it('[ADR-033] a Host ask wins over whatever the board still carries for the same dwarf', () => {
    const shown = shownAskOf(
      { source: 'host', ask: hostAsk() },
      { pendingPermission: boardPermission, pendingQuestion: boardQuestion }
    )
    expect(shown?.askId).toBe(ASK_ID)
  })

  it('[ADR-033] a Host ask with no answer channel draws no card (ADR-010 item 3)', () => {
    expect(
      shownAskOf(
        { source: 'host', ask: hostAsk({ channel: 'none' }) },
        { pendingQuestion: boardQuestion }
      )
    ).toBeNull()
  })

  it('[ADR-033] a legacy card is drawn in its own shape, by its legacy: id', () => {
    const permission = { ...boardPermission, toolUseId: 'legacy:toolu_09' }
    expect(
      shownAskOf(
        { source: 'legacy', kind: 'permission', permission },
        { pendingPermission: permission }
      )
    ).toEqual({ kind: 'permission', askId: 'legacy:toolu_09', permission })
  })

  it("[ADR-033] with no front card the board's own asks are drawn as before, a permission ahead of a question", () => {
    expect(
      shownAskOf(undefined, { pendingPermission: boardPermission, pendingQuestion: boardQuestion })
    ).toEqual({
      kind: 'permission',
      askId: 'toolu_09',
      permission: boardPermission
    })
    expect(shownAskOf(undefined, { pendingQuestion: boardQuestion })).toEqual({
      kind: 'question',
      askId: 'toolu_01',
      at: 0,
      question: boardQuestion
    })
    expect(shownAskOf(undefined, {})).toBeNull()
  })
})
