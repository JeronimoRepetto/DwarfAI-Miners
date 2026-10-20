// L2 (17 §1.2): `ConversationSender` (application/send.ts) over the in-memory `MessageLog`, a
// scripted `TurnSender` and a `RecordingDiagnosticsLog`: the hand-over that runs with no caller
// never throws into the Host (wiring/uncaught.ts would end it), a held message follows 07 machine 7
// to the letter, and a turn end that arrives before the sender's receipt is not lost.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { TurnEnded, TurnEndKind } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, MessageId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { ConversationEntry, TurnInput } from '../../suppliers'
import type { Delivery } from '../domain/messages'
import type { MessageLog } from '../ports/messageLog'
import type { TurnHandOver, TurnSender, TurnSendResult } from '../ports/turnSender'
import { attachmentKindOf } from '../domain/attachments'
import { InMemoryMessageLog } from '../testing/InMemoryMessageLog'
import { ConversationRetry } from './retry'
import { ConversationSender, type SendEvent } from './send'
import { SentEchoes } from './sentEchoes'

const T0 = 1_790_000_000_000
const DWARF = '00000000-0000-7000-8000-0000000166d1' as DwarfId
const TEXT = 'a private line of text'
const request = (n: number): string => `01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, '0')}`

const RECEIPT: TurnHandOver = {
  confidence: 'confirmed',
  heldUntilTurnEnd: false,
  correlation: 'c-1',
  providerTurnId: 'own-turn',
  reactionEvidence: 'turn-id'
}

/** Lets every pending promise continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

/**
 * One macrotask turn, after which Node has reported any rejection left unhandled (no time passes:
 * the turn only lets the process emit `unhandledRejection`).
 */
async function rejectionsReported(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

/** A sender a test answers by hand. */
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

/** The sender over an in-memory log whose `settleDelivery` a case can make fail. */
function harness(disk: Map<string, number> = new Map()) {
  let open = false
  const scope = { isInTransaction: () => open }
  const clock = new FakeClock(T0)
  const memory = new InMemoryMessageLog({ scope, clock, ids: new SequenceIdGenerator() })
  let failSettle: (() => Error) | null = null
  const log: MessageLog = {
    append: (...args) => memory.append(...args),
    page: (...args) => memory.page(...args),
    trim: (...args) => memory.trim(...args),
    writeAnswersRecord: (...args) => memory.writeAnswersRecord(...args),
    writeSent: (...args) => memory.writeSent(...args),
    resend: (...args) => memory.resend(...args),
    settleDelivery: (...args) => {
      if (failSettle !== null) throw failSettle()
      memory.settleDelivery(...args)
    }
  }
  const transactions: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      if (open) return work()
      const before = memory.snapshot()
      open = true
      try {
        return work()
      } catch (error) {
        memory.restore(before)
        throw error
      } finally {
        open = false
      }
    }
  }
  const bus = new RecordingEventBus<SendEvent>({ transactionScope: scope })
  const diagnostics = new RecordingDiagnosticsLog()
  const turns = new ScriptedTurnSender()
  let turnEnded: (end: TurnEnded) => void = () => undefined
  const sender = new ConversationSender({
    log,
    // ISSUE-169: a path is a file only while the case's `disk` holds it (#1463); any other is refused.
    attachments: {
      describe: async (path: string) => {
        const bytes = disk.get(path)
        if (bytes === undefined) return { refused: 'unreadable' as const }
        const name = path.split('/').pop() as string
        return { path, attachment: { path, name, kind: attachmentKindOf(name), bytes } }
      }
    },
    transactions,
    bus,
    onTurnEnded: (handler) => {
      turnEnded = handler
    },
    turns,
    recipients: { canReceiveMessages: () => true },
    clock,
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-166',
    diagnostics,
    echoes: new SentEchoes()
  })
  return {
    sender,
    turns,
    bus,
    diagnostics,
    clock,
    /** Retry over the same log and sender (application/retry.ts, S7.09). */
    retry: new ConversationRetry({
      log,
      transactions,
      recipients: { canReceiveMessages: () => true },
      clock,
      sender
    }),
    failSettleWith(error: () => Error) {
      failSettle = error
    },
    stored(): Delivery | undefined {
      return memory.page(DWARF, {})[0]?.delivery
    },
    turnEnd(turnKey: string, kind: TurnEndKind = 'concluded'): void {
      turnEnded({
        dwarfId: DWARF,
        turnKey,
        kind,
        at: clock.now(),
        reliability: 'reliable',
        cancelledFromApp: false
      })
    },
    /** One ingested batch of the dwarf's entries, as the module's `ingest` hands it over. */
    ingest(
      entries: ConversationEntry[],
      origin: 'live-stream' | 'transcript' = 'transcript'
    ): void {
      sender.entriesIngested(DWARF, entries, origin)
    },
    async send(n: number, text = TEXT): Promise<MessageId> {
      const sent = await sender.send(DWARF, text, [], request(n))
      if (!sent.ok) throw new Error(`refused: ${sent.error}`)
      await settle()
      return sent.value
    }
  }
}

const ioError = (): Error => Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' })

describe('ConversationSender: the hand-over never throws into the Host', () => {
  it('[ADR-022, INV-63] a delivery row that went away while its hand-over was pending ends its tracking quietly', async () => {
    const h = harness()
    await h.send(1)
    h.failSettleWith(() => new HostInvariantError('no sending delivery of message'))

    h.turns.answer({ ok: true, value: RECEIPT })
    await settle()
    h.turnEnd('own-turn')
    await rejectionsReported()

    expect(unhandled).toEqual([])
    expect(h.diagnostics.entries).toEqual([])
    expect(h.bus.published.map((e) => e.type)).toEqual(['MessagesAppended', 'MessageSent'])
  })

  it('[ADR-022, ADR-026] a store error while recording the hand-over is logged with allowlisted fields only and the tracking is dropped', async () => {
    const h = harness()
    const messageId = await h.send(2)
    h.failSettleWith(ioError)

    h.turns.answer({ ok: true, value: RECEIPT })
    await settle()
    h.turnEnd('own-turn')
    await rejectionsReported()

    expect(unhandled).toEqual([])
    expect(h.diagnostics.entries).toEqual([
      {
        level: 'error',
        event: 'message.delivery.record-failed',
        subsystem: 'conversation',
        outcome: 'failed',
        errCode: 'SQLITE_IOERR',
        dwarfId: DWARF,
        messageId
      }
    ])
    expect(JSON.stringify(h.diagnostics.entries)).not.toContain(TEXT)
    expect(h.diagnostics.refused).toEqual([])
  })

  it('[ADR-022, S7.05] a store error while recording the reaction in the TurnEnded subscriber is logged, never thrown to the bus', async () => {
    const h = harness()
    const messageId = await h.send(3)
    h.turns.answer({ ok: true, value: RECEIPT })
    await settle()
    expect(h.stored()?.phase).toBe('delivered')
    h.failSettleWith(ioError)

    expect(() => h.turnEnd('own-turn')).not.toThrow()
    expect(h.diagnostics.entries).toEqual([
      {
        level: 'error',
        event: 'message.delivery.record-failed',
        subsystem: 'conversation',
        outcome: 'failed',
        errCode: 'SQLITE_IOERR',
        dwarfId: DWARF,
        messageId
      }
    ])
    expect(h.bus.ofType('MessageReactedTo')).toEqual([])
  })
})

describe('ConversationSender: a held message follows machine 7', () => {
  it('[US-OBS-005.AC04, US-MSG-013.AC01, S7.07] a session that ends while a message is held fails it session-closed', async () => {
    const h = harness()
    const messageId = await h.send(4)
    h.turns.answer({ ok: true, value: { ...RECEIPT, heldUntilTurnEnd: true } })
    await settle()
    expect(h.stored()).toMatchObject({ phase: 'sending', heldUntilTurnEnd: true })

    h.sender.sessionEnded(DWARF)

    expect(h.stored()).toMatchObject({ phase: 'failed', failure: { kind: 'session-closed' } })
    expect(h.bus.ofType('MessageDeliveryFailed').map((e) => e.payload)).toEqual([
      { messageId, dwarfId: DWARF, failure: { kind: 'session-closed' } }
    ])
    // The session is gone: a later turn end of the dwarf changes nothing.
    h.turnEnd('next-turn')
    expect(h.stored()?.phase).toBe('failed')
  })

  it('[S7.07] a session that ends while the hand-over is in flight fails a message the driver then reports held', async () => {
    const h = harness()
    await h.send(5)
    h.sender.sessionEnded(DWARF)
    h.turns.answer({ ok: true, value: { ...RECEIPT, heldUntilTurnEnd: true } })
    await settle()

    expect(h.stored()).toMatchObject({ phase: 'failed', failure: { kind: 'session-closed' } })
  })

  it('[S7.03, S7.04, NFR-TIM-05] a held message is handed over only when the blocking turn ends concluded or capped; an errored or interrupted turn leaves it held', async () => {
    const h = harness()
    await h.send(6)
    h.turns.answer({ ok: true, value: { ...RECEIPT, heldUntilTurnEnd: true } })
    await settle()

    // 07 machine 7 lists no transition out of `sending` for a turn that errored or was
    // interrupted: the row stays held (S7.03), never ✓ without evidence it was written.
    for (const kind of ['errored', 'interrupted'] as const) {
      h.turnEnd(`blocking-${kind}`, kind)
      expect(h.stored()).toMatchObject({ phase: 'sending', heldUntilTurnEnd: true })
    }
    expect(h.bus.ofType('MessageHandedOver')).toEqual([])

    h.turnEnd('blocking-capped', 'capped')
    expect(h.stored()).toMatchObject({ phase: 'delivered', confidence: 'confirmed' })
  })
})

describe('ConversationSender: a turn end before the receipt is not lost', () => {
  it('[US-MSG-001.AC04, S7.05] the turn that consumed the message ending before the receipt still makes it reacted', async () => {
    const h = harness()
    const messageId = await h.send(7)
    h.turnEnd('own-turn')
    h.turns.answer({ ok: true, value: RECEIPT })
    await settle()

    expect(h.stored()).toMatchObject({ phase: 'reacted', confidence: 'confirmed' })
    expect(h.bus.ofType('MessageReactedTo').map((e) => e.payload)).toEqual([
      { messageId, dwarfId: DWARF }
    ])
  })

  it('[S7.03, S7.04] the blocking turn ending before the held receipt hands the message over', async () => {
    const h = harness()
    await h.send(8)
    h.turnEnd('blocking-turn')
    h.turns.answer({ ok: true, value: { ...RECEIPT, heldUntilTurnEnd: true } })
    await settle()

    expect(h.stored()).toMatchObject({ phase: 'delivered', confidence: 'confirmed' })
    expect(h.bus.ofType('MessageReactedTo')).toEqual([])
  })

  it('[S7.03] an errored blocking turn ending before the held receipt leaves it held', async () => {
    const h = harness()
    await h.send(9)
    h.turnEnd('blocking-turn', 'errored')
    h.turns.answer({ ok: true, value: { ...RECEIPT, heldUntilTurnEnd: true } })
    await settle()

    expect(h.stored()).toMatchObject({ phase: 'sending', heldUntilTurnEnd: true })
  })
})

/** S-022-1 (ISSUE-325, passed): a `transcript-match` session's receipt, with its echo correlation. */
const TRANSCRIPT_RECEIPT: TurnHandOver = {
  confidence: 'confirmed',
  heldUntilTurnEnd: false,
  correlation: 'echo-1',
  reactionEvidence: 'transcript-match'
}

let entryN = 0
const person = (text: string, at: number | null, extra: Partial<ConversationEntry> = {}) =>
  ({
    sourceKey: `claude:session-0:user-${(entryN += 1)}`,
    role: 'person',
    text,
    providerTime: at,
    ...extra
  }) satisfies ConversationEntry
const dwarf = (extra: Partial<ConversationEntry> = {}) =>
  ({
    sourceKey: `claude:session-0:assistant-${(entryN += 1)}`,
    role: 'dwarf',
    text: 'on it',
    providerTime: null,
    ...extra
  }) satisfies ConversationEntry

describe('ConversationSender: transcript-match correlation (S-022-1)', () => {
  it('[US-MSG-001.AC04, S7.05, S-022-1] a transcript-match message becomes reacted only when its echo is followed by a dwarf record, never on a turn end', async () => {
    const h = harness()
    const messageId = await h.send(10)
    h.turns.answer({ ok: true, value: TRANSCRIPT_RECEIPT })
    await settle()
    expect(h.stored()).toMatchObject({ phase: 'delivered', confidence: 'confirmed' })

    // A turn end, or the dwarf speaking before the echo, is no evidence for this channel.
    h.turnEnd('some-turn')
    h.ingest([dwarf()])
    expect(h.stored()?.phase).toBe('delivered')
    // The echo alone is delivery, not reaction.
    h.ingest([person(TEXT, T0 + 5, { echoOf: 'echo-1' })])
    expect(h.stored()?.phase).toBe('delivered')

    h.ingest([dwarf()])
    expect(h.stored()).toMatchObject({ phase: 'reacted', confidence: 'confirmed' })
    expect(h.bus.ofType('MessageReactedTo').map((e) => e.payload)).toEqual([
      { messageId, dwarfId: DWARF }
    ])
  })

  it('[US-MSG-001.AC05, NFR-TIM-05, S-022-1] a transcript-match message whose echo never comes stays delivered however long the clock advances', async () => {
    const h = harness()
    await h.send(11)
    h.turns.answer({ ok: true, value: TRANSCRIPT_RECEIPT })
    await settle()

    for (const ms of [60_000, 3_600_000, 86_400_000 * 30]) {
      h.clock.advance(ms)
      h.turnEnd(`turn-${ms}`)
      h.ingest([
        person('another line', h.clock.now()),
        person(TEXT, h.clock.now(), { echoOf: 'echo-of-another-send' }),
        dwarf()
      ])
      await settle()
      expect(h.stored()).toMatchObject({ phase: 'delivered', confidence: 'confirmed' })
    }
    expect(h.bus.ofType('MessageReactedTo')).toEqual([])
  })

  it('[S7.05, S-022-1] an uncorrelated echo matches the text as sent or as the console relay typed it, at or after sentAt, and claims one message only', async () => {
    const h = harness()
    const padded = 'two  spaces	and a tab'
    const first = await h.send(12, padded)
    h.turns.answer({ ok: true, value: { ...TRANSCRIPT_RECEIPT, correlation: 'echo-a' } })
    await settle()
    const second = await h.send(13, padded)
    h.turns.answer({ ok: true, value: { ...TRANSCRIPT_RECEIPT, correlation: 'echo-b' } })
    await settle()

    // An earlier record of the same text, a copy folded further than the relay folds, or a
    // live-stream line is no echo. (S-022-1: the relay's own normalization IS an echo, below.)
    h.ingest([person(padded, T0 - 1), person('two spaces and a  tab', T0 + 5), dwarf()])
    h.ingest([person(padded, T0 + 5), dwarf()], 'live-stream')
    expect(h.bus.ofType('MessageReactedTo')).toEqual([])

    // One exact echo at or after sentAt, then a dwarf record: the oldest message only.
    h.ingest([person(padded, T0), dwarf()])
    expect(h.bus.ofType('MessageReactedTo').map((e) => e.payload.messageId)).toEqual([first])
    // The second echo, then the reply, reaches the second one.
    h.ingest([person(padded, T0 + 9), dwarf()])
    expect(h.bus.ofType('MessageReactedTo').map((e) => e.payload.messageId)).toEqual([
      first,
      second
    ])
  })

  it('[S7.05, S-022-1] a multi-line message relayed into an observed terminal gets its ✓✓ on the echo of its relay text', async () => {
    const h = harness()
    const multiLine = 'dig  the north\r\ntunnel\n\tthen rest '
    const messageId = await h.send(15, multiLine)
    h.turns.answer({
      ok: true,
      value: { ...TRANSCRIPT_RECEIPT, confidence: 'unconfirmed', correlation: 'relay-1' }
    })
    await settle()
    expect(h.stored()).toMatchObject({ phase: 'delivered', confidence: 'unconfirmed' })

    h.ingest([person('dig the north tunnel then rest', T0 + 300), dwarf()])
    expect(h.stored()).toMatchObject({ phase: 'reacted', confidence: 'unconfirmed' })
    expect(h.bus.ofType('MessageReactedTo').map((e) => e.payload.messageId)).toEqual([messageId])
  })

  it('[S7.05, S-022-1] a subagent record is not the reply: only a record of the main conversation follows the echo', async () => {
    const h = harness()
    await h.send(14)
    h.turns.answer({ ok: true, value: TRANSCRIPT_RECEIPT })
    await settle()

    h.ingest([person(TEXT, T0 + 5, { echoOf: 'echo-1' }), dwarf({ providerAgentId: 'agent-7' })])
    expect(h.stored()?.phase).toBe('delivered')
    h.ingest([dwarf()])
    expect(h.stored()?.phase).toBe('reacted')
  })

  it('[S7.05, S-022-1] an echo and the reply ingested before the receipt still make the message reacted', async () => {
    const h = harness()
    const messageId = await h.send(15)
    h.ingest([person(TEXT, T0 + 5, { echoOf: 'echo-1' }), dwarf()])
    h.turns.answer({ ok: true, value: TRANSCRIPT_RECEIPT })
    await settle()

    expect(h.stored()).toMatchObject({ phase: 'reacted', confidence: 'confirmed' })
    expect(h.bus.ofType('MessageReactedTo').map((e) => e.payload)).toEqual([
      { messageId, dwarfId: DWARF }
    ])
  })

  it('[S7.05, S-022-1] a turn-id session ignores transcript evidence, and a none session never reaches reacted', async () => {
    for (const reactionEvidence of ['turn-id', 'none'] as const) {
      const h = harness()
      await h.send(16)
      h.turns.answer({
        ok: true,
        value: { ...TRANSCRIPT_RECEIPT, reactionEvidence, providerTurnId: 'own-turn' }
      })
      await settle()
      h.ingest([person(TEXT, T0 + 5, { echoOf: 'echo-1' }), dwarf()])
      expect(h.stored()?.phase).toBe('delivered')
    }
  })
})

/*
 * APPENDED for #1463: a message's files (UC-035; 11 F4 step 2). The turn carries the Host-revalidated
 * paths, the bubble the Host publishes carries `AttachmentMeta` (name and size, never the path or
 * the bytes, INV-62), and Retry hands the same files over again, revalidated again, as the same
 * message (S7.09, US-MSG-003.AC02).
 */
describe('ConversationSender: a message with files (#1463)', () => {
  const PNG = '/work/mine/red.png'
  const NOTES = '/work/mine/notes.txt'
  const files = () =>
    new Map([
      [PNG, 900],
      [NOTES, 120]
    ])

  it('[US-MSG-002.AC03, INV-62] the turn carries the revalidated paths, and the appended message only their names and sizes', async () => {
    const h = harness(files())
    const sent = await h.sender.send(DWARF, TEXT, [PNG, NOTES], request(30))
    expect(sent.ok).toBe(true)
    await settle()
    expect(h.turns.turns.map((turn) => turn.attachments)).toEqual([
      [
        { path: PNG, name: 'red.png', bytes: 900 },
        { path: NOTES, name: 'notes.txt', bytes: 120 }
      ]
    ])
    const appended = h.bus.ofType('MessagesAppended').map((e) => e.payload.messages[0])
    expect(appended.map((view) => view?.attachments)).toEqual([
      [
        { name: 'red.png', bytes: 900 },
        { name: 'notes.txt', bytes: 120 }
      ]
    ])
    expect(JSON.stringify(h.bus.ofType('MessagesAppended'))).not.toContain('/work/mine')
  })

  it('[US-MSG-003.AC02, US-MSG-002.AC03, S7.09] Retry hands the same files over again, as the same message', async () => {
    const h = harness(files())
    const sent = await h.sender.send(DWARF, TEXT, [PNG, NOTES], request(31))
    if (!sent.ok) throw new Error('refused')
    await settle()
    h.turns.answer({ ok: false, error: { kind: 'channel-error', reason: 'the write failed' } })
    await settle()
    expect(h.stored()?.phase).toBe('failed')

    expect(await h.retry.retry(sent.value, request(32))).toEqual({ ok: true, value: undefined })
    await settle()
    expect(h.turns.turns).toHaveLength(2)
    expect(h.turns.turns[1]).toEqual({ ...h.turns.turns[0], messageId: sent.value })
    expect(h.turns.turns[1]?.attachments.map((file) => file.path)).toEqual([PNG, NOTES])
  })

  it('[US-MSG-003.AC04, US-MSG-002.AC03] a file gone since the send fails the retry as a channel error, and nothing is handed over', async () => {
    const disk = files()
    const h = harness(disk)
    const sent = await h.sender.send(DWARF, TEXT, [PNG, NOTES], request(33))
    if (!sent.ok) throw new Error('refused')
    await settle()
    h.turns.answer({ ok: false, error: { kind: 'channel-error', reason: 'the write failed' } })
    await settle()

    disk.delete(NOTES)
    expect((await h.retry.retry(sent.value, request(34))).ok).toBe(true)
    await settle()
    expect(h.turns.turns).toHaveLength(1)
    expect(h.stored()).toMatchObject({
      phase: 'failed',
      failure: { kind: 'channel-error', reason: expect.stringContaining('attached file') }
    })
  })

  it('[US-MSG-002.AC03, INV-62] an observed Claude row carrying [Image #1] and the typed words confirms the send with files', async () => {
    const h = harness(files())
    const sent = await h.sender.send(DWARF, TEXT, [PNG], request(37))
    if (!sent.ok) throw new Error('refused')
    await settle()
    h.turns.answer({ ok: true, value: TRANSCRIPT_RECEIPT })
    await settle()

    h.ingest([person(`[Image #1] ${TEXT}`, T0 + 5), dwarf()])
    expect(h.stored()).toMatchObject({ phase: 'reacted' })
    expect(h.bus.ofType('MessageReactedTo').map((e) => e.payload.messageId)).toEqual([sent.value])
  })

  it('[US-MSG-002.AC03] a row with the files’ tokens but different words does not confirm the send', async () => {
    const h = harness(files())
    const sent = await h.sender.send(DWARF, TEXT, [PNG, NOTES], request(38))
    if (!sent.ok) throw new Error('refused')
    await settle()
    h.turns.answer({ ok: true, value: TRANSCRIPT_RECEIPT })
    await settle()

    h.ingest([person(`${NOTES}[Image #1] another line entirely`, T0 + 5), dwarf()])
    h.ingest([person(TEXT, T0 + 6), dwarf()])
    expect(h.stored()?.phase).toBe('delivered')
    expect(h.bus.ofType('MessageReactedTo')).toEqual([])
  })

  it('[US-MSG-003.AC02, S7.09] a retried message that carried no file is handed over with none', async () => {
    const h = harness()
    const messageId = await h.send(35)
    h.turns.answer({ ok: false, error: { kind: 'channel-error', reason: 'the write failed' } })
    await settle()
    expect((await h.retry.retry(messageId, request(36))).ok).toBe(true)
    await settle()
    expect(h.turns.turns[1]?.attachments).toEqual([])
  })
})
