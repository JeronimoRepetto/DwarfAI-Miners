// OS lane (17 §1.8) for the S-021-1 analyzer, which runs on the maintainer's machines over a recorded Claude
// transcript. Synthetic records only; no provider CLI runs here (17 §5.5).
import { describe, expect, it } from 'vitest'
import { claudeTurnEnds } from './claudeTurnEnds.mjs'

const prompt = (text) => ({ type: 'user', message: { role: 'user', content: text } })
const toolResult = (id) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }
})
const assistant = (id, stopReason, content = [{ type: 'text', text: 'done' }], extra = {}) => ({
  type: 'assistant',
  message: { id, role: 'assistant', content, stop_reason: stopReason },
  ...extra
})
const toolUse = (id) => [{ type: 'tool_use', id, name: 'Bash', input: {} }]

// Turn 1: a tool-use continuation, the final message written as a partial row and then its stop-state row.
// Turn 2: a compaction boundary and a subagent's records (side chain) with an end of their own.
// Turn 3: ends on a tool use (interrupted): no end. Turn 4: two terminal ends in one turn.
const turn1 = [
  prompt('one'),
  assistant('m1', 'tool_use', toolUse('t1')),
  toolResult('t1'),
  assistant('m2', null),
  assistant('m2', 'end_turn')
]
const turn2 = [
  prompt('two'),
  { type: 'system', subtype: 'compact_boundary' },
  { ...prompt('sub'), isSidechain: true },
  assistant('s1', 'end_turn', undefined, { isSidechain: true }),
  assistant('m3', 'end_turn')
]
const turn3 = [prompt('three'), assistant('m4', 'tool_use', toolUse('t2'))]
const turn4 = [prompt('four'), assistant('m5', 'end_turn'), assistant('m6', 'end_turn')]

const row = (assistantMessages, toolUses, ends, lastStopReason, compaction, sidechainRecords) => ({
  assistantMessages,
  toolUses,
  ends,
  lastStopReason,
  compaction,
  sidechainRecords,
  oneEnd: ends === 1 && lastStopReason === 'end_turn'
})

describe('S-021-1 analyzer (OS lane, synthetic input)', () => {
  it('[S-021-1, ADR-021] the turn-end analyzer finds one terminal stop_reason per turn and names each turn that has none or more than one', () => {
    const result = claudeTurnEnds([...turn1, ...turn2, ...turn3, ...turn4])
    expect(result.turns).toBe(4)
    expect(result.turnsWithOneEnd).toBe(2)
    expect(result.reliable).toBe(false)
    expect(result.sidechainRecords).toBe(2)
    expect(result.perTurn).toEqual([
      row(2, 1, 1, 'end_turn', false, 0),
      row(1, 0, 1, 'end_turn', true, 2),
      row(1, 1, 0, 'tool_use', false, 0),
      row(2, 0, 2, 'end_turn', false, 0)
    ])
    expect(claudeTurnEnds([...turn1, ...turn2]).reliable, 'every turn has exactly one end').toBe(
      true
    )
    expect(claudeTurnEnds([]).reliable, 'no turn proves nothing').toBe(false)
  })
})
