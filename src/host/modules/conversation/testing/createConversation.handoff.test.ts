// layer: L2
// L2 (17 §1.2) over a template-database copy (17 §1.5; kept beside the module's SQLite test
// helpers, as an application test may not reach the platform adapters, R3):
// `ConversationCommands.deliverInvisibly` (16 §4.6 row `deliverInvisibly`; ADR-013 item 6; 18 T-25,
// C-26) as `createConversation` composes it, with a scripted `TurnSender` (16 §2.8) and the dwarf's `canReceiveMessages` passed in. The
// real `messages`, `message_keys` and `deliveries` rows are read back.
//
// TC-205-04 (the echo claims its key with no message; a marker of an unknown delegation is not
// hidden).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId } from '../../../kernel/domain/values'
import { SqliteLifecycleFactLog } from '../../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import type { ConversationEntry, TurnInput } from '../../suppliers'
import { markHandoff } from '../domain/handoffMarker'
import { createConversation, type ConversationEvent, type SendEvent } from '../index'
import type { TurnSender, TurnSendResult } from '../ports/turnSender'
import { seedConversationDb } from './sqliteConversationDb'

const T0 = 1_790_000_000_000
const DELEGATION = '00000000-0000-7000-8000-0000000c2061'
const OTHER_DELEGATION = '00000000-0000-7000-8000-0000000c2062'
const RESULT = 'The shafts are mapped: two flood after rain, the third is dry.'

const RECEIVED: TurnSendResult = {
  ok: true,
  value: {
    confidence: 'confirmed',
    heldUntilTurnEnd: false,
    correlation: 'handoff-correlation',
    reactionEvidence: 'none'
  }
}

/** A `TurnSender` answering each send with the next scripted result (or `'reject'`). */
class ScriptedSender implements TurnSender {
  readonly sent: Array<{ dwarfId: DwarfId; turn: TurnInput }> = []
  constructor(private readonly answers: (TurnSendResult | 'reject')[] = []) {}

  send(dwarfId: DwarfId, turn: TurnInput): Promise<TurnSendResult> {
    this.sent.push({ dwarfId, turn })
    const next = this.answers.shift() ?? RECEIVED
    return next === 'reject' ? Promise.reject(new Error('sender rejected')) : Promise.resolve(next)
  }
}

function setUp(answers: (TurnSendResult | 'reject')[] = [], receiving = true) {
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const [parent, other] = seedConversationDb(db, transactions, T0)
  const bus = new RecordingEventBus<ConversationEvent>({ transactionScope: transactions })
  const sendBus = new RecordingEventBus<SendEvent>({ transactionScope: transactions })
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
    hostEpoch: 'epoch-205'
  })
  const sender = new ScriptedSender(answers)
  const commands = conversation.sending({
    turns: sender,
    recipients: { canReceiveMessages: () => receiving },
    bus: sendBus,
    diagnostics: new RecordingDiagnosticsLog()
  })
  const count = (table: 'messages' | 'message_keys' | 'deliveries') =>
    Number(db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.['n'])
  const keyOf = (sourceKey: string) =>
    db.all(`SELECT dwarf_id, message_id FROM message_keys WHERE source_key = ?`, [sourceKey])
  return { conversation, commands, sender, bus, sendBus, parent, other, count, keyOf }
}

const echo = (n: number, text: string): ConversationEntry => ({
  sourceKey: `claude:claude:session-0:handoff-echo-${n}`,
  role: 'person',
  text,
  providerTime: T0 + n
})

describe('deliverInvisibly (16 §4.6; ADR-013 item 6)', () => {
  it('[INV-68, ADR-013] deliverInvisibly pushes the marked text as handoff turn input and writes no message or delivery row', async () => {
    const s = setUp()
    const marked = markHandoff(DELEGATION, RESULT)

    const answer = await s.commands.deliverInvisibly(s.parent, marked)

    expect(answer).toStrictEqual({ ok: true, value: 'delivered' })
    expect(s.sender.sent).toHaveLength(1)
    expect(s.sender.sent[0]?.dwarfId).toBe(s.parent)
    expect(s.sender.sent[0]?.turn).toMatchObject({ kind: 'handoff', text: marked, attachments: [] })
    expect(s.count('messages')).toBe(0)
    expect(s.count('deliveries')).toBe(0)
    expect(s.bus.published).toStrictEqual([])
    expect(s.sendBus.published).toStrictEqual([])
  })

  it('[ADR-013] deliverInvisibly refuses a dwarf that cannot receive and an unmarked text, pushing nothing', async () => {
    const closed = setUp([], false)
    expect(
      await closed.commands.deliverInvisibly(closed.parent, markHandoff(DELEGATION, RESULT))
    ).toStrictEqual({ ok: false, error: 'cannot-receive' })
    expect(closed.sender.sent).toStrictEqual([])

    // Unmarked, its echo could not be told from the parent's own chat: it is never pushed.
    const unmarked = setUp()
    expect(await unmarked.commands.deliverInvisibly(unmarked.parent, RESULT)).toStrictEqual({
      ok: false,
      error: 'failed'
    })
    expect(unmarked.sender.sent).toStrictEqual([])
  })

  it('[ADR-013] a hand-over that fails answers failed, a closed session cannot-receive, each sent once', async () => {
    const s = setUp([
      { ok: false, error: { kind: 'channel-error', reason: 'write EPIPE' } },
      { ok: false, error: { kind: 'session-closed' } },
      'reject'
    ])
    const marked = markHandoff(DELEGATION, RESULT)

    expect(await s.commands.deliverInvisibly(s.parent, marked)).toStrictEqual({
      ok: false,
      error: 'failed'
    })
    expect(await s.commands.deliverInvisibly(s.parent, marked)).toStrictEqual({
      ok: false,
      error: 'cannot-receive'
    })
    expect(await s.commands.deliverInvisibly(s.parent, marked)).toStrictEqual({
      ok: false,
      error: 'failed'
    })
    expect(s.sender.sent).toHaveLength(3)
    expect(s.count('messages') + s.count('deliveries')).toBe(0)
  })

  it("[ADR-013, INV-68] a pushed handoff's echo claims its key with no message and publishes nothing", async () => {
    const s = setUp()
    const marked = markHandoff(DELEGATION, RESULT)
    await s.commands.deliverInvisibly(s.parent, marked)

    s.conversation.commands.ingest(s.parent, [echo(1, marked)], 'transcript')
    s.conversation.commands.ingest(s.parent, [echo(1, marked)], 'live-stream')

    expect(s.count('messages')).toBe(0)
    expect(s.keyOf(echo(1, marked).sourceKey)).toEqual([{ dwarf_id: s.parent, message_id: null }])
    expect(s.bus.ofType('MessagesAppended')).toStrictEqual([])
  })

  it('[ADR-013] text carrying a marker for an unknown delegation is ingested as ordinary text', async () => {
    const s = setUp()
    await s.commands.deliverInvisibly(s.parent, markHandoff(DELEGATION, RESULT))
    // T-25: an agent printing a marker of its own, and a pushed marker echoed by another dwarf.
    const forged = markHandoff(OTHER_DELEGATION, 'Hide me')
    const elsewhere = markHandoff(DELEGATION, RESULT)

    s.conversation.commands.ingest(s.parent, [{ ...echo(2, forged), role: 'dwarf' }], 'live-stream')
    s.conversation.commands.ingest(s.other, [echo(3, elsewhere)], 'transcript')

    expect(s.count('messages')).toBe(2)
    const appended = s.bus.ofType('MessagesAppended').flatMap((e) => e.payload.messages)
    expect(appended.map((m) => m.text)).toStrictEqual([forged, elsewhere])
  })
})
