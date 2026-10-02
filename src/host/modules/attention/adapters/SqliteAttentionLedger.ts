// `SqliteAttentionLedger` (16 §4.11; 05 §3.11): the claimed attention keys and the carry-over rows
// (09 §4.5 `attention_keys`, `attention_announced`), in bound SQL through the kernel
// `SqliteDatabase` port (R11). Every write joins the caller's transaction (16 §2.2): outside one it
// throws `HostInvariantError` and writes nothing. A statement failure (the primary key of a key
// claimed twice, a foreign key) aborts the caller's command (16 §2.1).
//
// - `emitted()` reads every stored key, suppressed and withdrawn ones included, so a key decided in
//   any earlier Host life is never decided again (INV-100, S17.07, S17.08). Nothing is cached: a
//   ledger opened at the next boot reads the same rows.
// - `markEmitted` / `markSuppressed` store the key with this boot's `host_epoch`, the decision
//   instant from the kernel `Clock` (`emitted_at`, 09 §5.1), and `suppressed`. The port passes no
//   ask id, so an ask key's `ask_id` is read from the key itself, `${dwarfId}:${kind}:${askId}`
//   (ADR-018 item 2); a key that does not start with its dwarf and kind is a code defect.
// - `carryOver()` maps `carryOverKey(dwarfId, kind)` to the pre-crash key; the rows are written by
//   the launching recovery pass (ADR-015 item 5; later: ISSUE-173). `consumeCarryOver` deletes the
//   row, so only the first matching re-raised ask finds it (07 S6.19).
// - Amendment of 2026-10-02 (ISSUE-110): `withdraw` sets `withdrawn_at` only where it is NULL, so a
//   key is withdrawn once and only the keys it changed are returned (ADR-018 item 4);
//   `sweepWithdrawn` deletes at most `limit` keys withdrawn strictly before `before` (09 §7.1);
//   `dropCarryOver` deletes a dwarf's carry-over rows (a person-initiated turn, its departure).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import { carryOverKey, type CarriedKind } from '../domain/carryOver'
import type { AttentionKind } from '../domain/decideLevel3'
import type { AttentionLedger } from '../ports/attentionLedger'

export interface SqliteAttentionLedgerDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
  /** Stamps `emitted_at`, the decision instant. */
  clock: Clock
  /** This boot's epoch (`attention_keys.host_epoch`). */
  hostEpoch: HostEpoch
}

const KEYS = 'SELECT key FROM attention_keys'

const CLAIM = `INSERT INTO attention_keys (key, dwarf_id, kind, ask_id, host_epoch, emitted_at, suppressed)
  VALUES (?, ?, ?, ?, ?, ?, ?)`

const CARRY_OVER = 'SELECT dwarf_id, kind, pre_crash_key FROM attention_announced'

const CONSUME = 'DELETE FROM attention_announced WHERE dwarf_id = ? AND kind = ?'

const WITHDRAW = 'UPDATE attention_keys SET withdrawn_at = ? WHERE key = ? AND withdrawn_at IS NULL'

// Bounded per statement (09 §7.1); the `attention_keys_withdrawn` index serves the inner select.
const SWEEP = `DELETE FROM attention_keys WHERE key IN (
  SELECT key FROM attention_keys WHERE withdrawn_at < ? ORDER BY withdrawn_at LIMIT ?)`

const DROP_CARRY_OVER = 'DELETE FROM attention_announced WHERE dwarf_id = ?'

export class SqliteAttentionLedger implements AttentionLedger {
  constructor(private readonly deps: SqliteAttentionLedgerDeps) {}

  emitted(): ReadonlySet<string> {
    return new Set(this.deps.db.all(KEYS).map((row) => String(row['key'])))
  }

  markEmitted(key: string, dwarfId: DwarfId, kind: AttentionKind): void {
    this.claim(key, dwarfId, kind, false)
  }

  markSuppressed(key: string, dwarfId: DwarfId, kind: AttentionKind): void {
    this.claim(key, dwarfId, kind, true)
  }

  carryOver(): ReadonlyMap<string, string> {
    return new Map(
      this.deps.db
        .all(CARRY_OVER)
        .map((row) => [
          carryOverKey(String(row['dwarf_id']) as DwarfId, row['kind'] as CarriedKind),
          String(row['pre_crash_key'])
        ])
    )
  }

  consumeCarryOver(dwarfKind: string): void {
    this.requireTransaction('consumeCarryOver')
    const split = dwarfKind.lastIndexOf(':')
    this.deps.db.run(CONSUME, [dwarfKind.slice(0, split), dwarfKind.slice(split + 1)])
  }

  withdraw(keys: readonly string[]): readonly string[] {
    this.requireTransaction('withdraw')
    const now = this.deps.clock.now()
    return keys.filter((key) => this.deps.db.run(WITHDRAW, [now, key]).changes === 1)
  }

  sweepWithdrawn(before: number, limit: number): number {
    this.requireTransaction('sweepWithdrawn')
    return this.deps.db.run(SWEEP, [before, limit]).changes
  }

  dropCarryOver(dwarfId: DwarfId): void {
    this.requireTransaction('dropCarryOver')
    this.deps.db.run(DROP_CARRY_OVER, [dwarfId])
  }

  private claim(key: string, dwarfId: DwarfId, kind: AttentionKind, suppressed: boolean): void {
    this.requireTransaction(suppressed ? 'markSuppressed' : 'markEmitted')
    this.deps.db.run(CLAIM, [
      key,
      dwarfId,
      kind,
      askIdOf(key, dwarfId, kind),
      this.deps.hostEpoch,
      this.deps.clock.now(),
      suppressed ? 1 : 0
    ])
  }

  private requireTransaction(method: string): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        `AttentionLedger.${method} runs inside the caller transaction (16 §2.2)`
      )
    }
  }
}

/** The ask an ask key names (`${dwarfId}:${kind}:${askId}`, ADR-018 item 2); none for a turn key. */
function askIdOf(key: string, dwarfId: DwarfId, kind: AttentionKind): string | null {
  const prefix = `${dwarfId}:${kind}:`
  if (!key.startsWith(prefix) || key.length === prefix.length) {
    throw new HostInvariantError('an attention key starts with its dwarf and kind (ADR-018 item 2)')
  }
  return kind === 'turn-finished' ? null : key.slice(prefix.length)
}
