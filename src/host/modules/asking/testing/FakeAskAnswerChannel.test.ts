// layer: L1
// The AskAnswerChannel double (16 §4.7 doubles row: `FakeAskAnswerChannel`, scripted outcomes,
// delay): it records every call, answers each with the next scripted outcome (`accepted` once the
// script is spent), and while `hold` is on keeps its answers pending until `release()`, so a test
// can look at the state in between or let a fake clock pass the 30 s bound.
import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../kernel/domain/values'
import { FakeAskAnswerChannel } from '../ports/fakes/FakeAskAnswerChannel'

const REF = { dwarfId: 'dwarf-1' as DwarfId }

describe('FakeAskAnswerChannel', () => {
  it('[ADR-010] records each call and answers the scripted outcomes in order, then accepted', async () => {
    const channel = new FakeAskAnswerChannel()
    channel.script({ kind: 'refused', reason: 'invalid-answer' }, { kind: 'not-open' })

    const first = await channel.answerPermission(REF, 'request-1', 'allow')
    const second = await channel.answerQuestion(REF, 'request-2', [{ step: 0, option: 'Yes' }])
    const third = await channel.declineQuestion(REF, 'request-3')

    expect([first, second, third]).toStrictEqual([
      { kind: 'refused', reason: 'invalid-answer' },
      { kind: 'not-open' },
      { kind: 'accepted' }
    ])
    expect(channel.calls).toStrictEqual([
      { method: 'answerPermission', ref: REF, providerRequestId: 'request-1', decision: 'allow' },
      {
        method: 'answerQuestion',
        ref: REF,
        providerRequestId: 'request-2',
        answers: [{ step: 0, option: 'Yes' }]
      },
      { method: 'declineQuestion', ref: REF, providerRequestId: 'request-3' }
    ])
  })

  it('[ADR-010] while hold is on, an answer stays pending until release', async () => {
    const channel = new FakeAskAnswerChannel()
    channel.hold = true
    let settled: unknown = null

    void channel.answerPermission(REF, 'request-1', 'deny').then((outcome) => {
      settled = outcome
    })
    await Promise.resolve()
    expect(channel.calls).toHaveLength(1)
    expect(settled).toBeNull()

    channel.release()
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toStrictEqual({ kind: 'accepted' })
  })
})
