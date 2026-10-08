// `SqliteAskRepository` (16 §4.7; 05 §3.7): the persisted asks (09 §4.5 `asks`, `ask_answers`), in
// bound SQL through the kernel `SqliteDatabase` port (R11). Every write joins the caller's
// transaction (16 §2.2): outside one it throws `HostInvariantError` and writes nothing. A statement
// failure (a UNIQUE key, `asks_one_answering`, a CHECK, a foreign key) aborts the caller's command
// (16 §2.1).
//
// - `save` upserts by `id` (`ON CONFLICT (id) DO UPDATE`), never `INSERT OR REPLACE`: a replace
//   would delete the row first, cascading its `ask_answers` and attention keys away, and would
//   silently delete another row that holds the same `(dwarf_id, provider_request_id)` or the
//   dwarf's answering slot instead of refusing (INV-71, `asks_one_answering`). The identity columns
//   (`dwarf_id`, `kind`, `channel`, `provider_request_id`, `opened_at`) are written once.
// - `payload_json` holds only `ask.payload`, the text needed to redraw the card; the step reached
//   is `current_step`; no column holds picks (INV-75, OQ-03).
// - `settle` is the first-answer-wins decision (09 §8.2, INV-72): one `UPDATE … WHERE state =
//   'open'` moves the ask to `answering`; `changes === 1` means this settle won and its pending
//   `ask_answers` row (outcome NULL, `at` from the kernel `Clock`) is inserted; anything else is
//   `'already-settled'` with nothing written. There is no read before the decision, so no other
//   settle can land between a check and its write.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { AskId, DwarfId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { SqliteDatabase, SqliteRow } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { Ask, AskChannel, AskKind, AskState } from '../domain/ask'
import type { AskChannelRef, AskRepository, AskSettlement } from '../ports/askRepository'

export interface SqliteAskRepositoryDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
  /** Stamps `ask_answers.at`, the instant the submit won. */
  clock: Clock
}

const COLUMNS = `id, dwarf_id, kind, channel, provider_request_id, payload_json, current_step, state,
  reannounce, opened_at, closed_at`

// The `asks_live` index serves it (09 §4.11): the dwarf's oldest live ask, ties broken by id.
const OPEN_FOR = `SELECT ${COLUMNS} FROM asks
  WHERE dwarf_id = ? AND state IN ('open', 'answering')
  ORDER BY opened_at, id LIMIT 1`

const BY_PROVIDER_REQUEST = `SELECT ${COLUMNS} FROM asks
  WHERE dwarf_id = ? AND provider_request_id = ?`

const SAVE = `INSERT INTO asks (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    payload_json = excluded.payload_json,
    current_step = excluded.current_step,
    state = excluded.state,
    reannounce = excluded.reannounce,
    closed_at = excluded.closed_at`

const SETTLE = `UPDATE asks SET state = 'answering' WHERE id = ? AND state = 'open'`

const PENDING_ANSWER = `INSERT INTO ask_answers (request_id, ask_id, at) VALUES (?, ?, ?)`

export class SqliteAskRepository implements AskRepository {
  constructor(private readonly deps: SqliteAskRepositoryDeps) {}

  openFor(dwarfId: DwarfId): Ask | null {
    return firstAsk(this.deps.db.all(OPEN_FOR, [dwarfId]))
  }

  byProviderRequest(channel: AskChannelRef, providerRequestId: string): Ask | null {
    return firstAsk(this.deps.db.all(BY_PROVIDER_REQUEST, [channel.dwarfId, providerRequestId]))
  }

  save(ask: Ask): void {
    this.requireTransaction('save')
    this.deps.db.run(SAVE, [
      ask.id,
      ask.dwarfId,
      ask.kind,
      ask.channel,
      ask.providerRequestId,
      JSON.stringify(ask.payload),
      ask.currentStep,
      ask.state,
      ask.reannounce ? 1 : 0,
      ask.openedAt,
      ask.closedAt ?? null
    ])
  }

  settle(askId: AskId, outcome: AskSettlement): 'settled' | 'already-settled' {
    this.requireTransaction('settle')
    if (this.deps.db.run(SETTLE, [askId]).changes !== 1) return 'already-settled'
    this.deps.db.run(PENDING_ANSWER, [outcome.requestId, askId, this.deps.clock.now()])
    return 'settled'
  }

  private requireTransaction(method: string): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        `AskRepository.${method} runs inside the caller transaction (16 §2.2)`
      )
    }
  }
}

function firstAsk(rows: SqliteRow[]): Ask | null {
  const row = rows[0]
  return row === undefined ? null : toAsk(row)
}

function toAsk(row: SqliteRow): Ask {
  const ask: Ask = {
    id: String(row['id']),
    dwarfId: String(row['dwarf_id']),
    kind: row['kind'] as AskKind,
    channel: row['channel'] as AskChannel,
    providerRequestId: String(row['provider_request_id']),
    payload: JSON.parse(String(row['payload_json'])) as Ask['payload'],
    currentStep: Number(row['current_step']),
    state: row['state'] as AskState,
    reannounce: row['reannounce'] === 1,
    openedAt: Number(row['opened_at'])
  }
  if (row['closed_at'] !== null && row['closed_at'] !== undefined) {
    ask.closedAt = Number(row['closed_at'])
  }
  return ask
}
