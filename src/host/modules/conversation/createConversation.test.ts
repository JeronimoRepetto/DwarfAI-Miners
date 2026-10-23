// The module as wired by its composition over a template-database copy (17 §1.5): the real
// `messages` CHECK and UNIQUE keys behind `ingest`, read back from the rows.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { TurnEnded } from '../../kernel/domain/sharedContracts'
import type { DwarfId, LaunchId, MineId } from '../../kernel/domain/values'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import type { ConversationEntry } from '../suppliers'
import {
  createConversation,
  launchPromptEntry,
  type ConversationEvent,
  type SendEvent
} from './index'
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

  // GitHub #1430: a launch has no receipt, so the driver's echo of its prompt names no `echoOf`.
  it('[INV-60, US-LAUNCH-005.AC07] the driver echo of a launch prompt that comes after the launch merges into the prompt row', () => {
    const { conversation, bus, dwarf, count } = setUp()
    const launchId = '00000000-0000-7000-8000-000000001430' as LaunchId

    conversation.commands.ingest(
      dwarf,
      [launchPromptEntry(launchId, 'Survey the north seam')],
      'live-stream'
    )
    conversation.commands.ingest(
      dwarf,
      [entry(1, { role: 'person', text: 'Survey the north seam', providerTime: null })],
      'live-stream'
    )

    expect(count('messages')).toBe(1)
    expect(count('message_keys')).toBe(2)
    expect(bus.ofType('MessagesAppended').map((e) => e.payload.messages.length)).toEqual([1])
  })

  it('[INV-60, US-LAUNCH-005.AC07] a launch prompt whose driver echo came first keeps its key and adds no second row', () => {
    const { conversation, bus, dwarf, count } = setUp()
    const launchId = '00000000-0000-7000-8000-000000001430' as LaunchId

    conversation.commands.ingest(
      dwarf,
      [entry(1, { role: 'person', text: 'Survey the north seam', providerTime: null })],
      'live-stream'
    )
    conversation.commands.ingest(
      dwarf,
      [launchPromptEntry(launchId, 'Survey the north seam')],
      'live-stream'
    )

    expect(count('messages')).toBe(1)
    expect(count('message_keys')).toBe(2)
    expect(bus.ofType('MessagesAppended').map((e) => e.payload.messages.length)).toEqual([1])
  })

  // VQA-05: `claude -p` writes the prompt's transcript line as soon as it reads stdin, so the
  // transcript echo can land before or after the `dwarfai:launch:…:prompt` row. The driver's echo
  // carries the same key as the transcript line (the uuid DwarfAI wrote, 15 §4.1 Keys).
  const promptEcho = (): ConversationEntry => ({
    sourceKey: 'claude:claude:session-0:prompt-uuid',
    role: 'person',
    text: 'Survey the north seam',
    providerTime: T0
  })

  it('[INV-60, US-LAUNCH-005.AC07] a launch prompt whose transcript echo came first, then its driver echo, is stored once', () => {
    const { conversation, bus, dwarf, count } = setUp()
    const launchId = '00000000-0000-7000-8000-000000001430' as LaunchId

    conversation.commands.ingest(dwarf, [promptEcho()], 'transcript')
    conversation.commands.ingest(
      dwarf,
      [launchPromptEntry(launchId, 'Survey the north seam')],
      'live-stream'
    )
    conversation.commands.ingest(dwarf, [{ ...promptEcho(), providerTime: null }], 'live-stream')

    expect(count('messages')).toBe(1)
    expect(count('message_keys')).toBe(2)
    expect(bus.ofType('MessagesAppended').map((e) => e.payload.messages.length)).toEqual([1])
  })

  it('[INV-60, US-LAUNCH-005.AC07] a launch prompt written first, then its transcript echo, then its driver echo, is stored once', () => {
    const { conversation, bus, dwarf, count } = setUp()
    const launchId = '00000000-0000-7000-8000-000000001430' as LaunchId

    conversation.commands.ingest(
      dwarf,
      [launchPromptEntry(launchId, 'Survey the north seam')],
      'live-stream'
    )
    conversation.commands.ingest(dwarf, [promptEcho()], 'transcript')
    conversation.commands.ingest(dwarf, [{ ...promptEcho(), providerTime: null }], 'live-stream')

    expect(count('messages')).toBe(1)
    expect(count('message_keys')).toBe(2)
    expect(bus.ofType('MessagesAppended').map((e) => e.payload.messages.length)).toEqual([1])
  })

  it('[INV-60, US-LAUNCH-005.AC07] the person writing the launch prompt again keeps both rows, whichever echo came first', () => {
    const again: ConversationEntry = {
      ...promptEcho(),
      sourceKey: 'claude:claude:session-0:again-uuid',
      providerTime: T0 + 5_000
    }
    for (const order of ['echo-first', 'prompt-first'] as const) {
      const { conversation, dwarf, count } = setUp()
      const launchId = '00000000-0000-7000-8000-000000001430' as LaunchId
      const prompt = launchPromptEntry(launchId, 'Survey the north seam')

      if (order === 'echo-first') {
        conversation.commands.ingest(dwarf, [promptEcho()], 'transcript')
        conversation.commands.ingest(dwarf, [prompt], 'live-stream')
      } else {
        conversation.commands.ingest(dwarf, [prompt], 'live-stream')
        conversation.commands.ingest(dwarf, [promptEcho()], 'transcript')
      }
      conversation.commands.ingest(dwarf, [again], 'transcript')
      conversation.commands.ingest(dwarf, [{ ...again, providerTime: null }], 'live-stream')

      expect(count('messages'), order).toBe(2)
    }
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
              // Amended: crew's rank and provider (owner amendment F, 2026-10-07).
              {
                id: dwarf,
                displayName: 'Durin',
                rank: 'foreman' as const,
                providerId: 'claude',
                departed: false
              },
              {
                id: left,
                displayName: 'Thrór',
                rank: 'worker' as const,
                providerId: 'codex',
                departed: true
              }
            ]
          : []
    }

    const view = conversation.history({ crew }).mineHistory(MINE)

    expect(
      view.speakers.map((s) => [
        s.displayName,
        s.rank,
        s.providerId,
        s.departed,
        s.messages.map((m) => m.text)
      ])
    ).toEqual([
      ['Durin', 'foreman', 'claude', false, ['message 1', 'message 2']],
      ['Thrór', 'worker', 'codex', true, ['message 3']]
    ])
  })
})

describe('the wired ConversationQueries.outcomeOf (owner amendment E, 2026-10-06)', () => {
  it('[INV-67] outcomeOf reads the stored outcome line outside any transaction, and null for a dwarf without one', () => {
    const { conversation, dwarf } = setUp()
    expect(conversation.queries.outcomeOf(dwarf)).toBeNull()

    conversation.commands.recordTurnEnd({
      dwarfId: dwarf,
      turnKey: 'claude:claude:session-0:turn-9',
      kind: 'concluded',
      at: T0 - 500,
      reliability: 'reliable',
      cancelledFromApp: false
    })

    expect(conversation.queries.outcomeOf(dwarf)).toMatchObject({
      dwarfId: dwarf,
      kind: 'concluded',
      reliability: 'reliable',
      at: T0 - 500
    })
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

describe('the wired transcript-match evidence (S-022-1; ADR-022 item 3)', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) await Promise.resolve()
  }
  /** The module with `sending` built over a sender that accepts every turn as `transcript-match`. */
  function sendingSetUp() {
    const { db } = openTemplateCopy()
    const transactions = new SqliteTransactionRunner(db)
    const [dwarf] = seedConversationDb(db, transactions, T0)
    const bus = new RecordingEventBus<ConversationEvent>({ transactionScope: transactions })
    const clock = new FakeClock(T0)
    const ids = new SequenceIdGenerator()
    const lifecycleFacts = new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock })
    const conversation = createConversation({
      db,
      transactions,
      bus,
      lifecycleFacts,
      clock,
      ids,
      hostEpoch: 'epoch-0166'
    })
    const sendBus = new RecordingEventBus<SendEvent>({ transactionScope: transactions })
    const sending = conversation.sending({
      turns: {
        send: () =>
          Promise.resolve({
            ok: true,
            value: {
              confidence: 'confirmed',
              heldUntilTurnEnd: false,
              correlation: 'echo-1',
              reactionEvidence: 'transcript-match'
            }
          })
      },
      recipients: { canReceiveMessages: () => true },
      bus: sendBus,
      diagnostics: new RecordingDiagnosticsLog()
    })
    let sent: string | undefined
    const send = async (requestId: string) => {
      const result = await sending.send(dwarf, 'hi', [], requestId)
      if (result.ok) sent = result.value
      await settle()
    }
    const phase = () =>
      conversation.queries.feed(dwarf).messages.find((m) => m.id === sent)?.delivery?.phase
    return { conversation, send, transactions, dwarf, phase }
  }
  const evidence = (): ConversationEntry[] => [
    {
      sourceKey: 'claude:session-0:user-1',
      role: 'person',
      text: 'hi',
      providerTime: T0 + 5,
      echoOf: 'echo-1'
    },
    {
      sourceKey: 'claude:session-0:assistant-1',
      role: 'dwarf',
      text: 'on it',
      providerTime: T0 + 9
    }
  ]

  it('[US-MSG-001.AC04, S7.05, S-022-1] an ingested echo followed by a dwarf record makes the sent message reacted', async () => {
    const { conversation, send, dwarf, phase } = sendingSetUp()
    await send('01890a5d-ac96-774b-bcce-000000000166')
    expect(phase()).toBe('delivered')

    conversation.commands.ingest(dwarf, evidence(), 'transcript')

    expect(phase()).toBe('reacted')
  })

  it('[S7.05, S-022-1, ADR-006] evidence ingested inside a caller transaction counts only after that caller commits', async () => {
    const { conversation, send, transactions, dwarf, phase } = sendingSetUp()
    await send('01890a5d-ac96-774b-bcce-000000000167')

    // The observed batch rolled back: its entries never happened.
    transactions.inTransaction(() => conversation.commands.ingest(dwarf, evidence(), 'transcript'))
    conversation.joinedEvents.discard()
    conversation.joinedEvents.publish()
    expect(phase()).toBe('delivered')

    // The same batch, committed by its caller: the evidence counts after the commit.
    const [echo, reply] = evidence()
    const again = [
      { ...(echo as ConversationEntry), sourceKey: 'claude:session-0:user-2' },
      { ...(reply as ConversationEntry), sourceKey: 'claude:session-0:assistant-2' }
    ]
    transactions.inTransaction(() => {
      conversation.commands.ingest(dwarf, again, 'transcript')
      expect(phase()).toBe('delivered')
    })
    conversation.joinedEvents.publish()
    expect(phase()).toBe('reacted')
  })
})
