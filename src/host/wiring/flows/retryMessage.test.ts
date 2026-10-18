// L2 flow (17 §1.2; 12 UC-012; ADR-022 item 5; 07 machine 7 S7.06, S7.09, S7.12; INV-64; BR-17):
// `ConversationCommands.retry` over one copy of the template database (the real `SqliteMessageLog`,
// AMENDMENT-20 `resend`), a scripted `TurnSender` the test answers by hand and a `FakeClock`.
//
// TC-168-01: a `failed{channel-error}` message retried twice in a row answers `not-failed` on the
// second call while the first is `sending`, and exactly one row exists.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DwarfId, MessageId, MineId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import {
  createConversation,
  type ConversationEvent,
  type Delivery,
  type SendEvent,
  type TurnHandOver,
  type TurnSender,
  type TurnSendResult
} from '../../modules/conversation'
import type { TurnInput } from '../../modules/suppliers'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'

const T0 = 1_790_000_000_000
const MINE = '00000000-0000-7000-8000-0000000001f8' as MineId
const DWARF = '00000000-0000-7000-8000-0000000016d8' as DwarfId
const request = (n: number): string => `01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, '0')}`

const RECEIPT: TurnHandOver = {
  confidence: 'confirmed',
  heldUntilTurnEnd: false,
  correlation: 'c-168',
  reactionEvidence: 'none'
}

/** Lets every pending promise continuation run (no timers here). */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

/** A sender a test answers by hand, recording each turn it was handed. */
class ScriptedTurnSender implements TurnSender {
  readonly turns: TurnInput[] = []
  private pending: Array<(result: TurnSendResult) => void> = []

  send(_dwarfId: DwarfId, turn: TurnInput): Promise<TurnSendResult> {
    this.turns.push(turn)
    return new Promise((resolve) => this.pending.push(resolve))
  }

  answer(result: TurnSendResult): void {
    const next = this.pending.shift()
    if (next === undefined) throw new Error('no hand-over is waiting')
    next(result)
  }
}

const CHANNEL_ERROR: TurnSendResult = {
  ok: false,
  error: { kind: 'channel-error', reason: 'the pipe closed' }
}

/** Every unhandled rejection while a case runs: the Host would exit on one (wiring/uncaught.ts). */
const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
beforeEach(() => {
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
})
afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
})

function rowCount(db: SqliteDatabase): number {
  return Number(db.all('SELECT count(*) AS n FROM messages WHERE dwarf_id = ?', [DWARF])[0]?.['n'])
}

/** One Host database with the dwarf's row, and conversation booted over it. */
function world() {
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const clock = new FakeClock(T0)
  const ids = new SequenceIdGenerator()
  transactions.inTransaction(() => {
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, '/work/mine-168', 'mine-168', 'mine-168', 'active', ?, ?)`,
      [MINE, T0, T0]
    )
    db.run(
      `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
         process_state, turn_state, arrived_at, last_activity_at)
       VALUES (?, ?, 'simulated', 'session-168', 'Durin', 'foreman', 'running', 'none-yet', ?, ?)`,
      [DWARF, MINE, T0, T0]
    )
  })
  const bus = new RecordingEventBus<ConversationEvent | SendEvent>({
    transactionScope: transactions
  })
  const conversation = createConversation({
    db,
    transactions,
    bus,
    lifecycleFacts: new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock }),
    clock,
    ids,
    hostEpoch: 'epoch-168'
  })
  const sender = new ScriptedTurnSender()
  let receives = true
  const { send, retry } = conversation.sending({
    turns: sender,
    recipients: { canReceiveMessages: (dwarfId) => dwarfId === DWARF && receives },
    bus,
    diagnostics: new RecordingDiagnosticsLog()
  })
  const row = (id: MessageId) =>
    conversation.queries.feed(DWARF, { limit: 50 }).messages.find((m) => m.id === id)
  return {
    db,
    clock,
    bus,
    sender,
    send,
    retry,
    row,
    delivery: (id: MessageId): Delivery | undefined => row(id)?.delivery,
    rowCount: () => rowCount(db),
    stopReceiving: () => {
      receives = false
    },
    /** A message sent at `T0` whose hand-over failed with a channel error (S7.06). */
    async failedMessage(text = 'dig the north seam', n = 1): Promise<MessageId> {
      const sent = await send(DWARF, text, [], request(n))
      if (!sent.ok) throw new Error('the send was refused')
      await settle()
      sender.answer(CHANNEL_ERROR)
      await settle()
      return sent.value
    },
    /** Rewrites a delivery's failure, as the boot reconcile (S7.16) or S7.07 leaves it. */
    setFailure(id: MessageId, kind: 'host-interrupted' | 'session-closed'): void {
      transactions.inTransaction(() =>
        db.run(
          `UPDATE deliveries SET failure_kind = ?, failure_reason = NULL WHERE message_id = ?`,
          [kind, id]
        )
      )
    },
    sentEvents: (id: MessageId) =>
      bus.published.filter((e) => e.type === 'MessageSent' && e.payload.messageId === id)
  }
}

describe('retry a failed message', () => {
  it('[US-MSG-003.AC02, S7.09, INV-64] retry re-sends the same text under the same messageId and walks the marks again, with no second message row', async () => {
    const w = world()
    const id = await w.failedMessage('dig the north seam')
    expect(w.delivery(id)?.phase).toBe('failed')

    const retried = await w.retry(id, request(100))
    const sending = w.delivery(id)
    await settle()

    expect(retried).toEqual({ ok: true, value: undefined })
    expect(sending).toMatchObject({ phase: 'sending', attempts: 2 })
    expect(sending?.failure).toBeUndefined()
    expect(w.sentEvents(id)).toHaveLength(2)
    expect(w.sender.turns).toHaveLength(2)
    expect(w.sender.turns[1]).toEqual({
      messageId: id,
      kind: 'message',
      text: 'dig the north seam',
      attachments: []
    })
    w.sender.answer({ ok: true, value: RECEIPT })
    await settle()
    expect(w.delivery(id)).toMatchObject({
      phase: 'delivered',
      confidence: 'confirmed',
      attempts: 2
    })
    expect(w.rowCount()).toBe(1)
    expect(unhandled).toEqual([])
  })

  it("[US-MSG-003.AC06, INV-64] a successful retry restamps the message with the retry's own time", async () => {
    const w = world()
    const id = await w.failedMessage()
    w.clock.advance(90_000)
    const retryAt = w.clock.now()

    expect(await w.retry(id, request(101))).toEqual({ ok: true, value: undefined })
    await settle()
    w.clock.advance(1_000)
    w.sender.answer({ ok: true, value: RECEIPT })
    await settle()

    expect(w.row(id)?.createdAt).toBe(retryAt)
    expect(w.delivery(id)).toMatchObject({ phase: 'delivered', phaseAt: retryAt + 1_000 })
  })

  it('[US-MSG-003.AC04] a retry that fails again leaves the message failed with its retryable failure kind', async () => {
    const w = world()
    const id = await w.failedMessage()

    expect(await w.retry(id, request(102))).toEqual({ ok: true, value: undefined })
    await settle()
    w.sender.answer(CHANNEL_ERROR)
    await settle()

    expect(w.delivery(id)).toMatchObject({
      phase: 'failed',
      failure: { kind: 'channel-error', reason: 'the pipe closed' },
      attempts: 2
    })
    expect(
      w.bus.published.filter((e) => e.type === 'MessageDeliveryFailed').map((e) => e.payload)
    ).toEqual([
      {
        messageId: id,
        dwarfId: DWARF,
        failure: { kind: 'channel-error', reason: 'the pipe closed' }
      },
      {
        messageId: id,
        dwarfId: DWARF,
        failure: { kind: 'channel-error', reason: 'the pipe closed' }
      }
    ])
    // Retry is offered again, exactly as before (07 S7.09 from the same failure).
    expect(await w.retry(id, request(103))).toEqual({ ok: true, value: undefined })
    expect(w.rowCount()).toBe(1)
  })

  it('[US-MSG-003.AC05, BR-17] a failed message stays failed however long the FakeClock advances', async () => {
    const w = world()
    const id = await w.failedMessage()
    const failed = w.delivery(id)

    for (let i = 0; i < 10; i++) {
      w.clock.advance(24 * 60 * 60 * 1_000)
      await settle()
    }

    expect(w.delivery(id)).toEqual(failed)
    expect(w.sender.turns).toHaveLength(1)
    expect(w.sentEvents(id)).toHaveLength(1)
    // Only the person moves it on: Retry is still offered after all that time.
    expect(await w.retry(id, request(111))).toEqual({ ok: true, value: undefined })
  })

  it('[US-MSG-003.AC01, S7.06] a channel-error or host-interrupted failure is retryable and reported with its kind', async () => {
    const w = world()
    const channel = await w.failedMessage('first', 1)
    const interrupted = await w.failedMessage('second', 2)
    w.setFailure(interrupted, 'host-interrupted')

    expect(w.delivery(channel)?.failure).toEqual({
      kind: 'channel-error',
      reason: 'the pipe closed'
    })
    expect(w.delivery(interrupted)?.failure).toEqual({ kind: 'host-interrupted' })
    expect(await w.retry(channel, request(104))).toEqual({ ok: true, value: undefined })
    expect(await w.retry(interrupted, request(105))).toEqual({ ok: true, value: undefined })
    expect(w.delivery(interrupted)).toMatchObject({ phase: 'sending', attempts: 2 })
  })

  it('[S7.12] a failed message of a dwarf that can no longer receive answers retry with cannot-receive', async () => {
    const w = world()
    const retryable = await w.failedMessage('retryable', 1)
    const closed = await w.failedMessage('closed', 2)
    w.setFailure(closed, 'session-closed')
    w.stopReceiving()
    const before = [w.row(retryable), w.row(closed)]

    expect(await w.retry(retryable, request(106))).toEqual({ ok: false, error: 'cannot-receive' })
    // S7.07: a session-closed failure offers Copy alone, never Retry.
    expect(await w.retry(closed, request(107))).toEqual({ ok: false, error: 'not-failed' })

    expect([w.row(retryable), w.row(closed)]).toEqual(before)
    expect(w.sender.turns).toHaveLength(2)
  })

  it('[ADR-022] a retry of a message already sending answers not-failed and changes nothing', async () => {
    const w = world()
    const id = await w.failedMessage()

    const first = await w.retry(id, request(108))
    const sending = w.row(id)
    w.clock.advance(5_000)
    const second = await w.retry(id, request(109))
    await settle()

    expect(first).toEqual({ ok: true, value: undefined })
    expect(second).toEqual({ ok: false, error: 'not-failed' })
    expect(w.row(id)).toEqual(sending)
    expect(w.sender.turns).toHaveLength(2)
    expect(w.sentEvents(id)).toHaveLength(2)
    expect(w.rowCount()).toBe(1)
  })

  it('[ADR-022] a retry of an unknown message answers not-failed and writes nothing', async () => {
    const w = world()

    expect(
      await w.retry('00000000-0000-7000-8000-00000000ffff' as MessageId, request(110))
    ).toEqual({ ok: false, error: 'not-failed' })
    expect(w.rowCount()).toBe(0)
  })
})
