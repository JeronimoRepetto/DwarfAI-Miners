// The module as wired by its composition over a template-database copy (17 §1.5): the real
// `messages` CHECK and UNIQUE keys behind `ingest`, read back from the rows.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { TurnEnded } from '../../kernel/domain/sharedContracts'
import type { DwarfId, MineId } from '../../kernel/domain/values'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import type { ConversationEntry } from '../suppliers'
import { createConversation, type ConversationEvent } from './index'
import { seedConversationDb } from './testing/sqliteConversationDb'

const T0 = 1_790_000_000_000

function setUp() {
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const [dwarf] = seedConversationDb(db, transactions, T0)
  const bus = new RecordingEventBus<ConversationEvent>({ transactionScope: transactions })
  const clock = new FakeClock(T0)
  const ids = new SequenceIdGenerator()
  const lifecycleFacts = new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock })
  const boot = (hostEpoch: string) =>
    createConversation({ db, transactions, bus, lifecycleFacts, clock, ids, hostEpoch })
  const conversation = boot('epoch-0098')
  const count = (table: 'messages' | 'message_keys') =>
    Number(db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.['n'])
  const turnFacts = () =>
    db.all(
      `SELECT dwarf_id, source_key FROM dwarf_lifecycle_facts WHERE type = 'TurnEnded' ORDER BY rowid`
    )
  return { conversation, bus, dwarf, count, turnFacts, boot }
}

const entry = (n: number, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({
  sourceKey: `claude:claude:session-0:event-${n}`,
  role: 'dwarf',
  text: `message ${n}`,
  providerTime: T0 + n,
  ...extra
})

describe('createConversation', () => {
  it('[INV-60, ADR-006] the same message from the live stream and from the transcript is stored once and published once', () => {
    const { conversation, bus, dwarf, count } = setUp()

    conversation.commands.ingest(dwarf, [entry(1)], 'live-stream')
    conversation.commands.ingest(dwarf, [entry(1)], 'transcript')

    expect(count('messages')).toBe(1)
    expect(count('message_keys')).toBe(1)
    expect(bus.ofType('MessagesAppended').map((e) => e.payload.messages.length)).toEqual([1])
  })

  it('[INV-68] a control-plane record and a hand-off echo leave keys and no rows, and a replay stays a no-op', () => {
    const { conversation, bus, dwarf, count } = setUp()
    const dropped = [entry(1, { controlPlane: true }), entry(2, { handoffEcho: true })]

    conversation.commands.ingest(dwarf, dropped, 'transcript')
    conversation.commands.ingest(dwarf, [entry(1), entry(2)], 'live-stream')

    expect(count('messages')).toBe(0)
    expect(count('message_keys')).toBe(2)
    expect(bus.published).toEqual([])
  })

  it('[ADR-007] a 65 537-byte text fails the messages CHECK and rolls back the whole batch with nothing published', () => {
    const { conversation, bus, dwarf, count } = setUp()

    expect(() =>
      conversation.commands.ingest(
        dwarf,
        [entry(1), entry(2, { text: 'x'.repeat(65_537) })],
        'live-stream'
      )
    ).toThrow(/CHECK constraint failed/)

    expect(count('messages')).toBe(0)
    expect(count('message_keys')).toBe(0)
    expect(bus.published).toEqual([])
  })
})

describe('the wired conversation queries (16 §4.6 ConversationQueries)', () => {
  it('[ADR-007] the wired feed pages the stored rows of the Host database newest first by provider time, as MessageView', () => {
    const { conversation, dwarf } = setUp()
    // A catch-up read: the later batch carries the older provider times.
    conversation.commands.ingest(dwarf, [entry(3), entry(4)], 'live-stream')
    conversation.commands.ingest(dwarf, [entry(1), entry(2)], 'transcript')

    const newest = conversation.queries.feed(dwarf, { limit: 3 })
    expect(newest.messages.map((m) => [m.text, m.providerTime])).toEqual([
      ['message 4', T0 + 4],
      ['message 3', T0 + 3],
      ['message 2', T0 + 2]
    ])
    expect(newest.reachedStart).toBe(false)
    expect(newest.messages.every((m) => !('sourceKey' in m) && !('origin' in m))).toBe(true)
    const rest = conversation.queries.feed(dwarf, { before: newest.messages[2]?.id })
    expect(rest.messages.map((m) => m.text)).toEqual(['message 1'])
    expect(rest.reachedStart).toBe(true)
  })
})

describe('the wired mine history (16 §4.6 ConversationQueries.mineHistory)', () => {
  it('[US-MINE-006.AC01] the wired mineHistory reads each dwarf crew lists from the Host database, oldest first, departed dwarfs included', () => {
    const { conversation, dwarf } = setUp()
    const MINE = '00000000-0000-7000-8000-0000000000f1' as MineId
    const left = '00000000-0000-7000-8000-0000000000d2' as DwarfId
    conversation.commands.ingest(dwarf, [entry(2), entry(1)], 'live-stream')
    conversation.commands.ingest(
      left,
      [entry(3, { sourceKey: 'claude:claude:session-1:event-3' })],
      'transcript'
    )
    const crew = {
      crewOf: (mineId: MineId, opts: { includeDeparted: true }) =>
        mineId === MINE && opts.includeDeparted
          ? [
              { id: dwarf, displayName: 'Durin', departed: false },
              { id: left, displayName: 'Thrór', departed: true }
            ]
          : []
    }

    const view = conversation.history({ crew }).mineHistory(MINE)

    expect(
      view.speakers.map((s) => [s.displayName, s.departed, s.messages.map((m) => m.text)])
    ).toEqual([
      ['Durin', false, ['message 1', 'message 2']],
      ['Thrór', true, ['message 3']]
    ])
  })
})

describe('the wired recordTurnEnd (16 §4.6; 09 §5.6)', () => {
  const end = (dwarfId: TurnEnded['dwarfId'], extra: Partial<TurnEnded> = {}): TurnEnded => ({
    dwarfId,
    turnKey: 'codex:codex:session-0:turn-1',
    kind: 'concluded',
    at: T0 - 1_000,
    reliability: 'reliable',
    cancelledFromApp: false,
    ...extra
  })

  it('[ADR-021, ADR-006] a turn end reported twice and replayed after a restart is one dwarf_lifecycle_facts row keyed turn:<dwarfId>:<turnKey>, published once', () => {
    const { conversation, bus, dwarf, turnFacts, boot } = setUp()

    conversation.commands.recordTurnEnd(end(dwarf))
    conversation.commands.recordTurnEnd(end(dwarf, { reliability: 'inferred', at: T0 }))
    boot('epoch-0100').commands.recordTurnEnd(end(dwarf))

    expect(turnFacts()).toEqual([
      { dwarf_id: dwarf, source_key: `turn:${dwarf}:codex:codex:session-0:turn-1` }
    ])
    expect(bus.ofType('TurnEnded').map((e) => e.payload)).toEqual([
      { dwarfId: dwarf, end: end(dwarf) }
    ])
  })
})
