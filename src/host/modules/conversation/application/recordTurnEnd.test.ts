// layer: L2
// L2 (17 §1.2): `ConversationCommands.recordTurnEnd` (16 §4.6, AMENDMENT-10) over the in-memory
// doubles — `InMemoryLifecycleFactLog`, `RecordingEventBus` (it refuses a publish inside a
// transaction, 16 §2.3) and `FakeClock`. Every reported end, from a driver `turn.ended` or an
// `ObservedTurnEnded`, records the kernel fact `turn:<dwarfId>:<turnKey>` in one transaction and
// publishes `TurnEnded` after the commit, only when the key is new (08 §4, §5.1).
//
// TC-100-01 (one fact, one TurnEnded per turn, whichever path and however often replayed).
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type { DwarfId } from '../../../kernel/domain/values'
import type { ProviderCapabilities } from '../../suppliers'
import type { TurnEndCapability } from '../domain/turnEnd'
import {
  CONVERSATION_DWARF,
  CONVERSATION_T0,
  inMemoryConversation
} from '../testing/inMemoryConversation'

const OTHER_DWARF = '00000000-0000-7000-8000-0000000000d2' as DwarfId

function end(overrides: Partial<TurnEnded> = {}): TurnEnded {
  return {
    dwarfId: CONVERSATION_DWARF,
    turnKey: 'claude:claude:session-1:msg-7',
    kind: 'concluded',
    at: CONVERSATION_T0 - 1_000,
    reliability: 'reliable',
    cancelledFromApp: false,
    ...overrides
  }
}

describe('recordTurnEnd (16 §4.6; 08 §2.6 TurnEnded)', () => {
  it('[ADR-021, ADR-006] the same turn end reported by the driver and by the transcript records one fact and publishes TurnEnded once', () => {
    const c = inMemoryConversation()
    const fromDriver = end()
    // The transcript path reports the same turn under the same turn key, a moment later.
    const fromTranscript = end({ at: fromDriver.at + 5 })

    c.commands.recordTurnEnd(fromDriver)
    c.clock.advance(1_000)
    c.commands.recordTurnEnd(fromTranscript)

    expect(c.facts.rows()).toEqual([
      {
        type: 'TurnEnded',
        dwarfId: CONVERSATION_DWARF,
        sourceKey: `turn:${CONVERSATION_DWARF}:claude:claude:session-1:msg-7`
      }
    ])
    const published = c.bus.ofType('TurnEnded')
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      type: 'TurnEnded',
      v: 1,
      at: CONVERSATION_T0,
      hostEpoch: 'epoch-0098',
      payload: { dwarfId: CONVERSATION_DWARF, end: fromDriver }
    })
    // One transaction per report, each of its own.
    expect(c.transactions()).toBe(2)
  })

  it('[ADR-021] a replay after a Host restart of an already recorded turnKey publishes nothing', () => {
    const c = inMemoryConversation()
    c.commands.recordTurnEnd(end())
    expect(c.bus.ofType('TurnEnded')).toHaveLength(1)

    // A new Host over the same stored facts replays the stream from its start.
    c.reboot()
    c.commands.recordTurnEnd(end())
    c.commands.recordTurnEnd(end({ reliability: 'inferred' }))

    expect(c.facts.rows()).toHaveLength(1)
    expect(c.bus.ofType('TurnEnded')).toHaveLength(1)
  })

  it('[ADR-021] two dwarfs ending turns under the same provider turn id record two facts and publish TurnEnded for each', () => {
    const c = inMemoryConversation()

    c.commands.recordTurnEnd(end({ turnKey: 'turn-1' }))
    c.commands.recordTurnEnd(end({ dwarfId: OTHER_DWARF, turnKey: 'turn-1' }))

    expect(c.facts.rows().map((row) => row.sourceKey)).toEqual([
      `turn:${CONVERSATION_DWARF}:turn-1`,
      `turn:${OTHER_DWARF}:turn-1`
    ])
    expect(c.bus.ofType('TurnEnded').map((e) => e.payload.dwarfId)).toEqual([
      CONVERSATION_DWARF,
      OTHER_DWARF
    ])
  })

  it('[ADR-021] a later inferred report of a turn recorded as reliable changes nothing: the one TurnEnded stays reliable', () => {
    const c = inMemoryConversation()

    c.commands.recordTurnEnd(end())
    c.commands.recordTurnEnd(end({ reliability: 'inferred', kind: 'interrupted' }))

    expect(c.facts.rows()).toHaveLength(1)
    expect(c.bus.ofType('TurnEnded').map((e) => e.payload.end.reliability)).toEqual(['reliable'])
  })

  it('[ADR-021] TurnEnded is published only after the commit: a joined record waits for the caller, and a rollback publishes nothing', () => {
    const c = inMemoryConversation()

    // Called inside a caller's transaction: it joins it and holds the event (16 §2.2, §2.3).
    c.runner.inTransaction(() => {
      c.commands.recordTurnEnd(end({ turnKey: 'turn-joined' }))
      expect(c.bus.ofType('TurnEnded')).toEqual([])
    })
    expect(c.bus.ofType('TurnEnded')).toEqual([])
    c.commands.publishJoined()
    expect(c.bus.ofType('TurnEnded').map((e) => e.payload.end.turnKey)).toEqual(['turn-joined'])

    // The caller's transaction rolls back: the fact is gone and its event is dropped.
    expect(() =>
      c.runner.inTransaction(() => {
        c.commands.recordTurnEnd(end({ turnKey: 'turn-rolled-back' }))
        throw new Error('the caller failed after the record')
      })
    ).toThrow('the caller failed after the record')
    c.commands.discardJoined()
    c.commands.publishJoined()
    expect(c.facts.rows().map((row) => row.sourceKey)).toEqual([
      `turn:${CONVERSATION_DWARF}:turn-joined`
    ])
    expect(c.bus.ofType('TurnEnded')).toHaveLength(1)

    // The rolled-back turn is new again when it is reported once more.
    c.commands.recordTurnEnd(end({ turnKey: 'turn-rolled-back' }))
    expect(c.bus.ofType('TurnEnded')).toHaveLength(2)
  })

  it('[ADR-009] the capability a turn end is downgraded by is ADR-009 D2 turnEnd', () => {
    expectTypeOf<TurnEndCapability>().toEqualTypeOf<ProviderCapabilities['turnEnd']>()
  })
})
