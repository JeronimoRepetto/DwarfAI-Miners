// layer: L2
// L2 (17 §1.2): the turn outcome line recomputed at every turn change (16 §4.6 amendment B) through
// `ConversationCommands` over the in-memory doubles. Each command reads the previous line
// (`outcomeOf`), derives the new one (`deriveOutcomeLine`), saves it in the same transaction and
// publishes `OutcomeLineChanged` after the commit, only when the line changed (08 §0, §5.1). The
// status comes from the trigger and the previous line, never from crew.
//
// TC-102-02 (a line change inside an ingest or turn-end batch: the new line stored, one
// OutcomeLineChanged after the commit).
import { describe, expect, it } from 'vitest'
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type { AskId } from '../../../kernel/domain/values'
import type { ActivityStep, ConversationEntry } from '../../suppliers'
import {
  CONVERSATION_DWARF,
  CONVERSATION_T0,
  inMemoryConversation
} from '../testing/inMemoryConversation'

const DWARF = CONVERSATION_DWARF
const TURN = 'claude:claude:session-1:turn-1'
const ASK = '00000000-0000-7000-8000-00000000a5c1' as AskId
let keys = 0

const steps = (count: number): ActivityStep[] =>
  Array.from({ length: count }, () => {
    keys += 1
    return {
      sourceKey: `claude:claude:session-1:tool-${keys}`,
      turnKey: TURN,
      kind: 'tool' as const,
      toolName: 'Bash',
      summary: `Ran step ${keys}`,
      state: 'finished' as const,
      at: CONVERSATION_T0 + keys
    }
  })

const entry = (extra: Partial<ConversationEntry> = {}): ConversationEntry => {
  keys += 1
  return {
    sourceKey: `claude:claude:session-1:event-${keys}`,
    role: 'dwarf',
    text: '',
    providerTime: CONVERSATION_T0 + keys,
    ...extra
  }
}

const turnEnd = (overrides: Partial<TurnEnded> = {}): TurnEnded => ({
  dwarfId: DWARF,
  turnKey: `${TURN}-${(keys += 1)}`,
  kind: 'concluded',
  at: CONVERSATION_T0 + 900,
  reliability: 'reliable',
  cancelledFromApp: false,
  ...overrides
})

describe('the outcome line recomputed at every turn change', () => {
  it('[US-MSG-011.AC01, US-MSG-011.AC14, INV-67] an ingest batch with steps stores a working line with the open run steps so far and publishes one OutcomeLineChanged after the commit', () => {
    const c = inMemoryConversation()

    c.commands.ingest(DWARF, [entry({ activity: steps(1) })], 'live-stream')

    const line = c.activity.outcome(DWARF)
    expect(line).toEqual({
      dwarfId: DWARF,
      kind: 'working',
      stepCount: 1,
      parts: [{ kind: 'steps-so-far', n: 1 }],
      reliability: 'reliable',
      at: CONVERSATION_T0
    })
    const changed = c.bus.ofType('OutcomeLineChanged')
    expect(changed).toHaveLength(1)
    expect(changed[0]?.payload).toEqual({ dwarfId: DWARF, outcome: line })
    // The line follows the batch's other events.
    expect(c.bus.published.map((e) => e.type)).toEqual([
      'MessagesAppended',
      'ActivityChanged',
      'OutcomeLineChanged'
    ])
  })

  it('[INV-67] a recompute that leaves the line as it was saves nothing new and publishes nothing', () => {
    const c = inMemoryConversation()
    const batch = [entry({ activity: steps(2) })]
    c.commands.ingest(DWARF, batch, 'live-stream')
    c.commands.noteAsk(DWARF, { askId: ASK, state: 'opened', kind: 'permission', questionCount: 0 })
    const stored = c.activity.outcome(DWARF)
    const published = c.bus.ofType('OutcomeLineChanged').length

    // The same ask opened again, a replayed batch and a text with nothing to fold change nothing.
    c.clock.advance(5_000)
    c.commands.noteAsk(DWARF, { askId: ASK, state: 'opened', kind: 'permission', questionCount: 0 })
    c.commands.ingest(DWARF, batch, 'transcript')

    expect(c.activity.outcome(DWARF)).toEqual(stored)
    expect(c.bus.ofType('OutcomeLineChanged')).toHaveLength(published)
  })

  it("[US-MSG-011.AC11] the finished line counts every run since the person's last message, and the person's next message starts the count again", () => {
    const c = inMemoryConversation()
    c.commands.ingest(DWARF, [entry({ role: 'person', text: 'Fix the parser' })], 'live-stream')
    c.commands.ingest(DWARF, [entry({ activity: steps(2) })], 'live-stream')
    // The dwarf speaks mid-turn (its run closes, S11.03), then a second run of three steps.
    c.commands.ingest(DWARF, [entry({ text: 'Looking at the tests next.' })], 'live-stream')
    c.commands.ingest(DWARF, [entry({ activity: steps(3) })], 'live-stream')
    expect(c.activity.outcome(DWARF)?.parts).toEqual([{ kind: 'steps-so-far', n: 3 }])

    const first = turnEnd()
    c.commands.recordTurnEnd(first)
    expect(c.activity.outcome(DWARF)).toEqual({
      dwarfId: DWARF,
      kind: 'concluded',
      stepCount: 5,
      parts: [
        { kind: 'steps', n: 5 },
        { kind: 'idle-since', at: first.at }
      ],
      reliability: 'reliable',
      at: first.at
    })

    // The person's next message resets the count; one step and a capped end follow.
    c.commands.ingest(
      DWARF,
      [entry({ role: 'person', text: 'Now the docs' }), entry({ activity: steps(1) })],
      'live-stream'
    )
    const second = turnEnd({ kind: 'capped', at: CONVERSATION_T0 + 2_000, detail: 'max_turns' })
    c.commands.recordTurnEnd(second)
    expect(c.activity.outcome(DWARF)).toMatchObject({
      kind: 'capped',
      stepCount: 1,
      parts: [
        { kind: 'steps', n: 1 },
        { kind: 'idle-since', at: second.at }
      ],
      detail: 'max_turns'
    })
  })

  it('[US-MSG-011.AC02] an ask turns the line to waiting on you with the question count or permission, and its close returns it to working while a run is open', () => {
    const c = inMemoryConversation()
    c.commands.ingest(DWARF, [entry({ activity: steps(2) })], 'live-stream')

    c.commands.noteAsk(DWARF, { askId: ASK, state: 'opened', kind: 'question', questionCount: 3 })
    expect(c.activity.outcome(DWARF)).toMatchObject({
      kind: 'waiting-on-you',
      stepCount: 2,
      parts: [{ kind: 'waiting-questions', n: 3 }]
    })
    // A step while asking keeps the dwarf asking (the trusted ask first, ADR-032 item 2).
    c.commands.ingest(DWARF, [entry({ activity: steps(1) })], 'live-stream')
    expect(c.activity.outcome(DWARF)).toMatchObject({ kind: 'waiting-on-you', stepCount: 3 })

    c.commands.noteAsk(DWARF, { askId: ASK, state: 'closed' })
    expect(c.activity.outcome(DWARF)).toMatchObject({
      kind: 'working',
      reliability: 'reliable',
      stepCount: 3,
      parts: [{ kind: 'steps-so-far', n: 3 }]
    })
    // The same close again changes nothing.
    const published = c.bus.ofType('OutcomeLineChanged').length
    c.commands.noteAsk(DWARF, { askId: ASK, state: 'closed' })
    expect(c.bus.ofType('OutcomeLineChanged')).toHaveLength(published)
  })

  it('[US-MSG-011.AC02] a permission asked after a finished turn, then closed with no run open, leaves the dwarf idle', () => {
    const c = inMemoryConversation()
    c.commands.ingest(DWARF, [entry({ activity: steps(1) })], 'live-stream')
    c.commands.recordTurnEnd(turnEnd())

    c.commands.noteAsk(DWARF, { askId: ASK, state: 'opened', kind: 'permission', questionCount: 0 })
    expect(c.activity.outcome(DWARF)).toMatchObject({
      kind: 'waiting-on-you',
      parts: [{ kind: 'waiting-permission' }]
    })
    c.commands.noteAsk(DWARF, { askId: ASK, state: 'closed' })
    // Idle (ADR-032: ask closed, no active turn): never "Working", and no end wording the line
    // no longer has a reliable end for.
    expect(c.activity.outcome(DWARF)).toMatchObject({
      kind: 'working',
      reliability: 'inferred',
      stepCount: 1,
      parts: [{ kind: 'steps', n: 1 }]
    })
  })

  it('[ADR-021, INV-67] an inferred turn end stores a line with no end wording and no idle part', () => {
    const c = inMemoryConversation()
    c.commands.ingest(DWARF, [entry({ activity: steps(4) })], 'live-stream')

    c.commands.recordTurnEnd(turnEnd({ reliability: 'inferred', at: CONVERSATION_T0 + 600 }))

    expect(c.activity.outcome(DWARF)).toEqual({
      dwarfId: DWARF,
      kind: 'working',
      stepCount: 4,
      parts: [{ kind: 'steps', n: 4 }],
      reliability: 'inferred',
      at: CONVERSATION_T0 + 600
    })
  })

  it('[INV-67] a duplicate turn end changes nothing, and a session end that closes the run updates the line once', () => {
    const c = inMemoryConversation()
    c.commands.ingest(DWARF, [entry({ activity: steps(2) })], 'live-stream')
    const end = turnEnd()
    c.commands.recordTurnEnd(end)
    const published = c.bus.ofType('OutcomeLineChanged').length
    c.commands.recordTurnEnd(end)
    expect(c.bus.ofType('OutcomeLineChanged')).toHaveLength(published)

    c.commands.ingest(DWARF, [entry({ activity: steps(1) })], 'live-stream')
    expect(c.activity.outcome(DWARF)?.parts).toEqual([{ kind: 'steps-so-far', n: 1 }])
    const before = c.bus.ofType('OutcomeLineChanged').length
    c.commands.recordSessionEnd(DWARF, CONVERSATION_T0 + 5_000)
    expect(c.activity.outcome(DWARF)?.parts).toEqual([])
    expect(c.bus.ofType('OutcomeLineChanged')).toHaveLength(before + 1)
  })
})
