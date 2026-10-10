// The AskRepository double (16 §4.7 `InMemoryAskRepository`). Never imported by production code
// (R14). It runs `runAskRepositoryContract` like `SqliteAskRepository`: its storage is an
// `InMemoryAskRows`, and a new repository over the same rows is what a Host restart opens. It keeps
// the schema's rules that the contract can see (09 §4.5): `id` and `(dwarfId, providerRequestId)`
// are unique, at most one ask per dwarf is `answering` (`asks_one_answering`), and only the
// `AskRecord` fields are stored, so nothing picked on an earlier step survives (INV-75, OQ-03).
// Owner amendment K (2026-10-09): `settlements` stands for `ask_answers` — `answerOf`, `recordOf`,
// `linkRecord` and `settleAnswer` (once) read and write it as the SQLite adapter does.
// Owner amendment L (2026-10-09): `live` lists every open or answering ask, oldest first.
import type { AskId, DwarfId, MessageId } from '../../../../kernel/domain/values'
import type { Ask } from '../../domain/ask'
import type {
  AskAnswer,
  AskChannelRef,
  AskRepository,
  AskSettlement,
  SettledAnswer
} from '../askRepository'

/** The double's "database": the `asks` rows by id and the settles (`ask_answers`, 09 §4.5). */
export class InMemoryAskRows {
  readonly asks = new Map<string, Ask>()
  /**
   * One entry per settle that won its ask, in order (`ask_answers`); owner amendment K: with the
   * record it linked and the outcome it settled to.
   */
  readonly settlements: {
    askId: AskId
    requestId: string
    messageId?: MessageId
    outcome?: SettledAnswer
  }[] = []
}

export class InMemoryAskRepository implements AskRepository {
  constructor(readonly rows: InMemoryAskRows = new InMemoryAskRows()) {}

  openFor(dwarfId: DwarfId): Ask | null {
    const live = [...this.rows.asks.values()]
      .filter((ask) => ask.dwarfId === dwarfId && isLive(ask))
      .sort((a, b) => a.openedAt - b.openedAt || compare(a.id, b.id))
    return live[0] === undefined ? null : stored(live[0])
  }

  byProviderRequest(channel: AskChannelRef, providerRequestId: string): Ask | null {
    const found = [...this.rows.asks.values()].find(
      (ask) => ask.dwarfId === channel.dwarfId && ask.providerRequestId === providerRequestId
    )
    return found === undefined ? null : stored(found)
  }

  save(ask: Ask): void {
    for (const other of this.rows.asks.values()) {
      if (other.id === ask.id) continue
      if (other.dwarfId === ask.dwarfId && other.providerRequestId === ask.providerRequestId) {
        throw new Error(`ask ${ask.id}: (dwarfId, providerRequestId) is taken by ${other.id}`)
      }
      if (
        other.dwarfId === ask.dwarfId &&
        other.state === 'answering' &&
        ask.state === 'answering'
      ) {
        throw new Error(`ask ${ask.id}: dwarf ${ask.dwarfId} already has an answering ask`)
      }
    }
    this.rows.asks.set(ask.id, stored(ask))
  }

  settle(askId: AskId, outcome: AskSettlement): 'settled' | 'already-settled' {
    const ask = this.rows.asks.get(askId)
    if (ask === undefined || ask.state !== 'open') return 'already-settled'
    this.save({ ...ask, state: 'answering' })
    this.rows.settlements.push({ askId, requestId: outcome.requestId })
    return 'settled'
  }

  byId(askId: AskId): Ask | null {
    const ask = this.rows.asks.get(askId)
    return ask === undefined ? null : stored(ask)
  }

  answerOf(requestId: string): AskAnswer | null {
    const row = this.settlementOf(requestId)
    if (row === undefined) return null
    return {
      askId: row.askId,
      outcome: row.outcome === undefined ? null : structuredClone(row.outcome),
      messageId: row.messageId ?? null
    }
  }

  recordOf(askId: AskId): MessageId | null {
    const linked = this.rows.settlements.filter(
      (row) => row.askId === askId && row.messageId !== undefined
    )
    return linked.at(-1)?.messageId ?? null
  }

  linkRecord(requestId: string, messageId: MessageId): void {
    const row = this.settlementOf(requestId)
    if (row === undefined) throw new Error(`no ask_answers row ${requestId} to link`)
    row.messageId = messageId
  }

  settleAnswer(requestId: string, result: SettledAnswer): void {
    const row = this.settlementOf(requestId)
    if (row === undefined || row.outcome !== undefined) {
      throw new Error(`no pending ask_answers row ${requestId} to settle`)
    }
    row.outcome = structuredClone(result)
  }

  live(): Ask[] {
    return [...this.rows.asks.values()]
      .filter(isLive)
      .sort((a, b) => a.openedAt - b.openedAt || compare(a.id, b.id))
      .map(stored)
  }

  private settlementOf(requestId: string) {
    return this.rows.settlements.find((row) => row.requestId === requestId)
  }
}

function isLive(ask: Ask): boolean {
  return ask.state === 'open' || ask.state === 'answering'
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A copy holding only the `AskRecord` fields, as a row of `asks` holds them. */
function stored(ask: Ask): Ask {
  const copy: Ask = {
    id: ask.id,
    dwarfId: ask.dwarfId,
    kind: ask.kind,
    channel: ask.channel,
    providerRequestId: ask.providerRequestId,
    payload: structuredClone(ask.payload),
    currentStep: ask.currentStep,
    state: ask.state,
    reannounce: ask.reannounce,
    openedAt: ask.openedAt
  }
  if (ask.closedAt !== undefined) copy.closedAt = ask.closedAt
  return copy
}
