// layer: L2
// L2 (17 §1.2): activity runs through `ConversationCommands` (16 §4.6) over the in-memory doubles —
// `InMemoryMessageLog`, `InMemoryActivityLog`, `RecordingEventBus` (it refuses a publish inside a
// transaction, 16 §2.3) and `FakeClock`. `ingest` folds the tool steps of each new entry into the
// dwarf's open run in the batch transaction (07 §11; 09 §5.2 step 4), the dwarf speaking closes it,
// `recordTurnEnd` closes it with a new turn end, and `ActivityChanged` follows each commit, one per
// changed run with its final state (08 §2.6, §5.1).
//
// TC-101-02 (one ActivityChanged per changed run per commit, nothing before the commit).
import { describe, expect, it } from 'vitest'
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type { ActivityStep, ConversationEntry } from '../../suppliers'
import {
  CONVERSATION_DWARF,
  CONVERSATION_T0,
  inMemoryConversation
} from '../testing/inMemoryConversation'

const TURN = 'claude:claude:session-1:turn-1'

const step = (n: number, overrides: Partial<ActivityStep> = {}): ActivityStep => ({
  sourceKey: `claude:claude:session-1:tool-${n}`,
  turnKey: TURN,
  kind: 'tool',
  toolName: 'Bash',
  summary: `Ran step ${n}`,
  state: 'finished',
  at: CONVERSATION_T0 + n,
  ...overrides
})

const entry = (n: number, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({
  sourceKey: `claude:claude:session-1:event-${n}`,
  role: 'dwarf',
  text: '',
  providerTime: CONVERSATION_T0 + n,
  ...extra
})

const turnEnd = (overrides: Partial<TurnEnded> = {}): TurnEnded => ({
  dwarfId: CONVERSATION_DWARF,
  turnKey: TURN,
  kind: 'concluded',
  at: CONVERSATION_T0 + 900,
  reliability: 'reliable',
  cancelledFromApp: false,
  ...overrides
})

describe('activity runs through ingest, recordTurnEnd and recordSessionEnd', () => {
  it('[US-MSG-004.AC03] a turn with one tool step yields one closed run with stepCount 1 and one summary', () => {
    const c = inMemoryConversation()

    c.commands.ingest(CONVERSATION_DWARF, [entry(1, { activity: [step(1)] })], 'live-stream')
    c.commands.recordTurnEnd(turnEnd())

    expect(c.activity.runs(CONVERSATION_DWARF)).toEqual([
      {
        id: expect.any(String),
        dwarfId: CONVERSATION_DWARF,
        turnKey: step(1).sourceKey,
        open: false,
        stepCount: 1,
        summaries: ['Ran step 1'],
        openedAt: CONVERSATION_T0 + 1,
        closedAt: CONVERSATION_T0 + 900
      }
    ])
  })

  it('[US-MSG-014.AC03] ActivityChanged is published after the commit with open false and the final stepCount', () => {
    const c = inMemoryConversation()

    // One batch: three steps, then the dwarf speaks. The run opened and closed inside the batch.
    c.commands.ingest(
      CONVERSATION_DWARF,
      [
        entry(1, { activity: [step(1), step(2)] }),
        entry(2, { activity: [step(3)] }),
        entry(3, { text: 'All tests pass.' })
      ],
      'live-stream'
    )

    const [run] = c.activity.runs(CONVERSATION_DWARF)
    expect(run).toMatchObject({ open: false, stepCount: 3, closedAt: CONVERSATION_T0 + 3 })
    // RecordingEventBus refuses a publish inside the transaction: this one came after the commit.
    expect(c.bus.ofType('ActivityChanged')).toEqual([
      {
        type: 'ActivityChanged',
        v: 1,
        id: expect.any(String),
        at: CONVERSATION_T0,
        hostEpoch: 'epoch-0098',
        payload: { dwarfId: CONVERSATION_DWARF, disclosureId: run!.id, open: false, stepCount: 3 }
      }
    ])
    // After the MessagesAppended of the same commit, one transaction in all; the outcome line the
    // batch changed follows (16 §4.6 ingest events; ISSUE-102).
    expect(c.bus.published.map((e) => e.type)).toEqual([
      'MessagesAppended',
      'ActivityChanged',
      'OutcomeLineChanged'
    ])
    expect(c.transactions()).toBe(1)
  })

  it('[S11.02, US-MSG-014.AC01, INV-66] a run grows across batches, one ActivityChanged per commit; the person speaking keeps it open', () => {
    const c = inMemoryConversation()

    c.commands.ingest(CONVERSATION_DWARF, [entry(1, { activity: [step(1)] })], 'live-stream')
    c.commands.ingest(
      CONVERSATION_DWARF,
      [entry(2, { role: 'person', text: 'also check the docs' })],
      'live-stream'
    )
    c.commands.ingest(
      CONVERSATION_DWARF,
      [entry(3, { activity: [step(2)] }), entry(4, { activity: [step(3)] })],
      'live-stream'
    )

    const runs = c.activity.runs(CONVERSATION_DWARF)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ open: true, stepCount: 3 })
    expect(
      c.bus.ofType('ActivityChanged').map((e) => [e.payload.open, e.payload.stepCount])
    ).toEqual([
      [true, 1],
      [true, 3]
    ])
  })

  it('[US-MSG-014.AC04, S11.03, S11.01] the dwarf speaking mid-turn closes the run and a later step of the same turn opens a new one', () => {
    const c = inMemoryConversation()

    c.commands.ingest(
      CONVERSATION_DWARF,
      [
        entry(1, { activity: [step(1)] }),
        // The dwarf speaks, then calls another tool, in the same turn.
        entry(2, { text: 'Now the linter.', activity: [step(2)] })
      ],
      'live-stream'
    )

    const runs = c.activity.runs(CONVERSATION_DWARF)
    expect(runs.map((r) => [r.open, r.stepCount, r.turnKey])).toEqual([
      [false, 1, step(1).sourceKey],
      [true, 1, step(2).sourceKey]
    ])
    expect(
      c.bus.ofType('ActivityChanged').map((e) => [e.payload.disclosureId, e.payload.open])
    ).toEqual([
      [runs[0]!.id, false],
      [runs[1]!.id, true]
    ])
  })

  it('[ADR-006, US-MSG-004.AC05] a re-parse of the same entries never grows the step count again', () => {
    const c = inMemoryConversation()
    const batch = [entry(1, { activity: [step(1), step(2)] }), entry(2, { activity: [step(3)] })]

    c.commands.ingest(CONVERSATION_DWARF, batch, 'live-stream')
    // The transcript reader, and a replay after a Host restart, deliver the same entries again.
    c.commands.ingest(CONVERSATION_DWARF, batch, 'transcript')
    c.reboot()
    c.commands.ingest(CONVERSATION_DWARF, batch, 'transcript')

    expect(c.activity.runs(CONVERSATION_DWARF).map((r) => r.stepCount)).toEqual([3])
    expect(c.bus.ofType('ActivityChanged')).toHaveLength(1)
  })

  it('[S11.04] a new turn end closes the open run in its transaction and ActivityChanged follows TurnEnded; a duplicate changes nothing', () => {
    const c = inMemoryConversation()
    c.commands.ingest(
      CONVERSATION_DWARF,
      [entry(1, { activity: [step(1), step(2)] })],
      'live-stream'
    )
    const before = c.transactions()

    c.commands.recordTurnEnd(turnEnd({ reliability: 'inferred', kind: 'interrupted' }))
    c.commands.recordTurnEnd(turnEnd())

    expect(c.transactions() - before).toBe(2)
    expect(c.activity.runs(CONVERSATION_DWARF)).toMatchObject([
      { open: false, stepCount: 2, closedAt: CONVERSATION_T0 + 900 }
    ])
    // After the ingest's MessagesAppended, ActivityChanged and OutcomeLineChanged; the new end's
    // outcome line follows its ActivityChanged (16 §4.6 recordTurnEnd events; ISSUE-102).
    expect(c.bus.published.slice(3).map((e) => e.type)).toEqual([
      'TurnEnded',
      'ActivityChanged',
      'OutcomeLineChanged'
    ])
    expect(c.bus.ofType('ActivityChanged').at(-1)?.payload).toMatchObject({
      open: false,
      stepCount: 2
    })
  })

  it('[S11.05, US-MSG-014.AC03] recordSessionEnd closes the open run once, publishes ActivityChanged after the commit, and is a no-op with no open run', () => {
    const c = inMemoryConversation()
    c.commands.ingest(CONVERSATION_DWARF, [entry(1, { activity: [step(1)] })], 'live-stream')

    c.commands.recordSessionEnd(CONVERSATION_DWARF, CONVERSATION_T0 + 500)
    c.commands.recordSessionEnd(CONVERSATION_DWARF, CONVERSATION_T0 + 600)

    expect(c.activity.runs(CONVERSATION_DWARF)).toMatchObject([
      { open: false, stepCount: 1, closedAt: CONVERSATION_T0 + 500 }
    ])
    expect(c.bus.ofType('ActivityChanged').map((e) => e.payload.open)).toEqual([true, false])
    // A dwarf that never had a run: nothing to close, nothing published.
    const other = '00000000-0000-7000-8000-0000000000d2' as typeof CONVERSATION_DWARF
    c.commands.recordSessionEnd(other, CONVERSATION_T0 + 700)
    expect(c.bus.ofType('ActivityChanged')).toHaveLength(2)
  })

  it('[S11.02, ADR-007] inside a caller transaction the change is held until it commits, and a rollback leaves the run as it was', () => {
    const c = inMemoryConversation()
    c.commands.ingest(CONVERSATION_DWARF, [entry(1, { activity: [step(1)] })], 'live-stream')

    expect(() =>
      c.runner.inTransaction(() => {
        c.commands.ingest(CONVERSATION_DWARF, [entry(2, { activity: [step(2)] })], 'transcript')
        throw new Error('the observed batch failed after the ingest')
      })
    ).toThrow('the observed batch failed after the ingest')
    c.commands.discardJoined()
    expect(c.activity.runs(CONVERSATION_DWARF)).toMatchObject([{ open: true, stepCount: 1 }])

    c.runner.inTransaction(() => {
      c.commands.ingest(CONVERSATION_DWARF, [entry(2, { activity: [step(2)] })], 'transcript')
      c.commands.recordSessionEnd(CONVERSATION_DWARF, CONVERSATION_T0 + 50)
    })
    expect(c.bus.ofType('ActivityChanged')).toHaveLength(1)
    c.commands.publishJoined()
    expect(
      c.bus.ofType('ActivityChanged').map((e) => [e.payload.open, e.payload.stepCount])
    ).toEqual([
      [true, 1],
      [true, 2],
      [false, 2]
    ])
  })
})
