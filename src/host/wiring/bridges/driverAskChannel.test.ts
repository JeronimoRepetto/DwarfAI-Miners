// layer: L2
// The `driver` answer channel (05 §3.7 `DriverAskChannel` bridge → suppliers; 16 §4.7; ADR-010
// items 1, 5, 8): an answer to a launched session's ask reaches that session's own
// `DriverSession.answer*`, and its outcome comes back unchanged. No live session answers
// `channel-unavailable` (fail closed). In-memory doubles only.
import { describe, expect, it } from 'vitest'
import type { AnswerOutcome, QuestionAnswers } from '../../kernel/domain/sharedContracts'
import type { DwarfId } from '../../kernel/domain/values'
import type { DriverSession } from '../../modules/suppliers'
import { createDriverAskChannel } from './driverAskChannel'

const DWARF = '00000000-0000-7000-8000-0000000182d1' as DwarfId
const OTHER = '00000000-0000-7000-8000-0000000182d2' as DwarfId

function recordingSession(outcome: AnswerOutcome) {
  const calls: unknown[] = []
  const session = {
    answerPermission: async (req: { providerRequestId: string; decision: 'allow' | 'deny' }) => {
      calls.push({ permission: req })
      return outcome
    },
    answerQuestion: async (
      req:
        | { providerRequestId: string; answers: QuestionAnswers }
        | { providerRequestId: string; decline: true }
    ) => {
      calls.push({ question: req })
      return outcome
    }
  } as unknown as DriverSession
  return { session, calls }
}

describe('driver ask channel', () => {
  it('[ADR-010] an Allow on a launched session ask reaches that session and its outcome comes back unchanged', async () => {
    const { session, calls } = recordingSession({ kind: 'accepted' })
    const channel = createDriverAskChannel({
      sessionOf: (dwarfId) => (dwarfId === DWARF ? session : null)
    })

    const outcome = await channel.answerPermission({ dwarfId: DWARF }, 'tool-use-7', 'allow')

    expect(outcome).toEqual({ kind: 'accepted' })
    expect(calls).toEqual([{ permission: { providerRequestId: 'tool-use-7', decision: 'allow' } }])
  })

  it('[ADR-010] a question answer and a decline reach the session as its two answerQuestion forms', async () => {
    const { session, calls } = recordingSession({ kind: 'not-open' })
    const channel = createDriverAskChannel({ sessionOf: () => session })
    const answers = [{ step: 0, option: 'Yes', picked: true }] as unknown as QuestionAnswers

    expect(await channel.answerQuestion({ dwarfId: DWARF }, 'q-1', answers)).toEqual({
      kind: 'not-open'
    })
    expect(await channel.declineQuestion({ dwarfId: DWARF }, 'q-2')).toEqual({ kind: 'not-open' })
    expect(calls).toEqual([
      { question: { providerRequestId: 'q-1', answers } },
      { question: { providerRequestId: 'q-2', decline: true } }
    ])
  })

  it('[ADR-010] a dwarf with no live driver session is refused channel-unavailable and nothing is handed over', async () => {
    const { session, calls } = recordingSession({ kind: 'accepted' })
    const channel = createDriverAskChannel({
      sessionOf: (dwarfId) => (dwarfId === DWARF ? session : null)
    })

    expect(await channel.answerPermission({ dwarfId: OTHER }, 'tool-use-7', 'deny')).toEqual({
      kind: 'refused',
      reason: 'channel-unavailable'
    })
    expect(calls).toEqual([])
  })

  it('[ADR-010] a late driver answer has no side effect: the channel is stale-answer safe', () => {
    const channel = createDriverAskChannel({ sessionOf: () => null })
    expect(channel.capabilities.staleAnswerSafe).toBe(true)
  })
})
