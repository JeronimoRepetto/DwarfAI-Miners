// The chat side of the F6 flow harness (11 F6 step 5; 11 F4; ISSUE-207): the real conversation
// module over one copy of the template database (the real `SqliteMessageLog`), fed by launching's
// real `DwarfLaunched` route (routes/launching.ts: the launch prompt ingested as the dwarf's first
// message) and sending through `ConversationCommands.send` (16 §4.6, AMENDMENT-16) to a recording
// `TurnSender` (16 §2.8) that accepts every turn alike. The recipients are crew's derived
// `canReceiveMessages` (INV-33), as host/wiring composes them. Call it inside a test, before the
// launches it should see: it subscribes to the host's launching bus.
//
// The Host has one database; here crew and launching keep theirs in memory, so a dwarf's row is
// written into the conversation's database the first time conversation is handed one of its
// messages (the `messages.dwarf_id` foreign key needs it). Nothing else is read from that row.
import type { HostFrameData, HostFrameName } from '@dwarfai/contracts'
import type { DwarfId } from '../../../kernel/domain/values'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import {
  createConversation,
  type ConversationEvent,
  type SendEvent,
  type TurnHandOver,
  type TurnSender,
  type TurnSendResult
} from '../../../modules/conversation'
import { seedDwarf, seedMine } from '../../../modules/launching/testing/sqliteLaunchingDb'
import type { TurnInput } from '../../../modules/suppliers'
import { SqliteLifecycleFactLog } from '../../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { routeLaunching } from '../../routes/launching'
import type { delegationHost } from './delegationHost'

/** What every hand-over answers: the session took the turn (15 §1.2 `SendReceipt`). */
export const ACCEPTED: TurnHandOver = {
  confidence: 'confirmed',
  heldUntilTurnEnd: false,
  correlation: 'c-207',
  reactionEvidence: 'turn-id'
}

/** A `TurnSender` that accepts every turn for every dwarf alike, recording each one. */
export class RecordingTurnSender implements TurnSender {
  readonly turns: { dwarfId: DwarfId; turn: TurnInput }[] = []

  send(dwarfId: DwarfId, turn: TurnInput): Promise<TurnSendResult> {
    this.turns.push({ dwarfId, turn })
    return Promise.resolve({ ok: true, value: ACCEPTED })
  }
}

export function delegatedChat(h: ReturnType<typeof delegationHost>) {
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const ids = new SequenceIdGenerator()
  seedMine(db, transactions)
  const rows = new Set<DwarfId>()
  const rowOf = (dwarfId: DwarfId): void => {
    if (rows.has(dwarfId)) return
    seedDwarf(db, transactions, dwarfId)
    rows.add(dwarfId)
  }
  const bus = new RecordingEventBus<ConversationEvent | SendEvent>({
    transactionScope: transactions
  })
  const conversation = createConversation({
    db,
    transactions,
    bus,
    lifecycleFacts: new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock: h.clock }),
    clock: h.clock,
    ids,
    hostEpoch: 'epoch-207'
  })
  const turns = new RecordingTurnSender()
  const { send } = conversation.sending({
    turns,
    recipients: {
      canReceiveMessages: (dwarfId) => h.crew.queries.get(dwarfId)?.canReceiveMessages ?? false
    },
    bus,
    diagnostics: new RecordingDiagnosticsLog()
  })
  const frames: { name: string; data: unknown }[] = []
  routeLaunching({
    events: h.launchingBus,
    launching: h.launching,
    conversation: {
      ingest: (dwarfId, entries, origin) => {
        rowOf(dwarfId)
        conversation.commands.ingest(dwarfId, entries, origin)
      }
    },
    frames: {
      publishFrame<F extends HostFrameName>(name: F, data: HostFrameData[F]): void {
        frames.push({ name, data })
      },
      connections: () => [{ role: 'ui' }]
    }
  })
  return {
    bus,
    turns,
    frames,
    /** `ConversationCommands.send` (16 §4.6), the one send path of every dwarf. */
    send(dwarfId: DwarfId, text: string, requestId: string) {
      rowOf(dwarfId)
      return send(dwarfId, text, [], requestId)
    },
    /** The dwarf's chat, newest first (`ConversationQueries.feed`, 14 §3.6 `FeedPage`). */
    feed: (dwarfId: DwarfId) => conversation.queries.feed(dwarfId, { limit: 50 })
  }
}
