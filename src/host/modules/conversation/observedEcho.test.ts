// The module as wired by its composition over a template-database copy (17 §1.5): a message relayed
// into an observed terminal comes back in the transcript with no echo correlation (S-022-1), and
// ingest claims that row for the send it echoes, so the person sees one bubble (INV-60; GitHub
// #1463 with files, #1464 text only). The claim mirrors ISSUE-182's live-stream claim: the row keeps
// its source key and adds no message, and the send path still hears it for its ✓✓ (ADR-022).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { MessageId } from '../../kernel/domain/values'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import type { ConversationEntry } from '../suppliers'
import { createConversation, type ConversationEvent, type SendEvent } from './index'
import { seedConversationDb } from './testing/sqliteConversationDb'

const T0 = 1_790_000_000_000
const IMAGE = '/work/mine/red.png'

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

/** The module with `sending` over a relay that accepts every turn as `transcript-match`. */
function relayed() {
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
    hostEpoch: 'epoch-1464'
  })
  const sending = conversation.sending({
    turns: {
      send: () =>
        Promise.resolve({
          ok: true,
          value: {
            confidence: 'unconfirmed',
            heldUntilTurnEnd: false,
            correlation: 'relay',
            reactionEvidence: 'transcript-match'
          }
        })
    },
    recipients: { canReceiveMessages: () => true },
    bus: new RecordingEventBus<SendEvent>({ transactionScope: transactions }),
    diagnostics: new RecordingDiagnosticsLog(),
    attachments: {
      describe: async (path) =>
        path === IMAGE
          ? { path, attachment: { path, name: 'red.png', kind: 'image', bytes: 900 } }
          : { refused: 'unreadable' }
    }
  })
  let n = 0
  const send = async (text: string, files: string[] = []): Promise<MessageId> => {
    n += 1
    const result = await sending.send(
      dwarf,
      text,
      files,
      `01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, '0')}`
    )
    if (!result.ok) throw new Error(`refused: ${result.error}`)
    await settle()
    return result.value
  }
  let key = 0
  const typed = (text: string): ConversationEntry => ({
    sourceKey: `claude:session-0:user-${(key += 1)}`,
    role: 'person',
    text,
    providerTime: T0 + 5
  })
  const reply = (): ConversationEntry => ({
    sourceKey: `claude:session-0:assistant-${(key += 1)}`,
    role: 'dwarf',
    text: 'on it',
    providerTime: T0 + 9
  })
  const ingest = (entries: ConversationEntry[]) =>
    conversation.commands.ingest(dwarf, entries, 'transcript')
  const people = () => conversation.queries.feed(dwarf).messages.filter((m) => m.role === 'person')
  return { send, typed, reply, ingest, people, feed: () => conversation.queries.feed(dwarf) }
}

describe('an observed transcript echo of a relayed message (#1463, #1464)', () => {
  it('[US-MSG-002.AC03, INV-60] a relayed text-only message and its transcript echo show as one person bubble (#1464)', async () => {
    const w = relayed()
    const sent = await w.send('hi  there')

    w.ingest([w.typed('hi there'), w.reply()])

    expect(w.people().map((m) => [m.id, m.text])).toEqual([[sent, 'hi  there']])
    // The send path still heard the echo and the reply after it: ✓✓ (ADR-022 item 3).
    expect(w.people()[0]?.delivery?.phase).toBe('reacted')
  })

  it('[US-MSG-002.AC03, INV-62] a relayed message with files and its transcript echo show as one person bubble', async () => {
    const w = relayed()
    const sent = await w.send('look at this', [IMAGE])

    w.ingest([w.typed('[Image #1] look at this'), w.reply()])

    expect(w.people().map((m) => [m.id, m.text])).toEqual([[sent, 'look at this']])
    expect(w.people()[0]?.delivery?.phase).toBe('reacted')
    expect(JSON.stringify(w.feed())).not.toContain('/work/mine')
  })

  it('[INV-60] a person row typed in the terminal that matches no waiting send stays a new message', async () => {
    const w = relayed()
    const sent = await w.send('hi there')

    w.ingest([w.typed('something else')])
    w.ingest([w.typed('hi there')])
    // The send was claimed once: the same words typed again are the person's own message.
    w.ingest([w.typed('hi there')])

    expect(w.people().map((m) => m.text)).toEqual(['hi there', 'something else', 'hi there'])
    expect(w.people().filter((m) => m.id === sent)).toHaveLength(1)
  })
})
