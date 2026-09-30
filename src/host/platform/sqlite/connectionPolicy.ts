// The 09 §8.1 connection policy (ADR-005 item 7), applied and read back at every open: a pragma
// that reads back a different value fails the open (a startup error, never a silent downgrade).
//
// | pragma         | value       | why (09 §8.1)                                                  |
// | foreign_keys   | ON (1)      | SQLite's default is off, and it is per connection              |
// | journal_mode   | WAL         | readers do not block the writer                                |
// | synchronous    | NORMAL (1)  | durable across a process crash                                 |
// | busy_timeout   | 5000 ms     | a reader or a checkpoint never fails a write at once (FM-106)  |
// | secure_delete  | FAST (2)    | deleted text is overwritten in b-tree pages                    |
// | trusted_schema | OFF (0)     | the schema can call only innocuous functions                   |
// | query_only     | ON, readers | an extra read connection can never write                       |
import type { DatabaseSync } from 'node:sqlite'

export type ConnectionRole = 'writer' | 'reader'

/** `memory` only for the in-memory test double, whose database cannot be put in WAL mode. */
export type JournalMode = 'wal' | 'memory'

export const BUSY_TIMEOUT_MS = 5000

/** A pragma read back a value other than the one the policy set. */
export class ConnectionPolicyError extends Error {
  constructor(
    readonly pragma: string,
    readonly expected: string | number,
    readonly actual: unknown
  ) {
    super(`PRAGMA ${pragma} reads back ${String(actual)}, expected ${String(expected)}`)
    this.name = 'ConnectionPolicyError'
  }
}

interface PragmaRule {
  name: string
  set: string
  expected: string | number
}

function rules(role: ConnectionRole, journalMode: JournalMode): PragmaRule[] {
  return [
    // busy_timeout first, so the other settings already wait for a lock instead of failing.
    { name: 'busy_timeout', set: String(BUSY_TIMEOUT_MS), expected: BUSY_TIMEOUT_MS },
    { name: 'foreign_keys', set: 'ON', expected: 1 },
    { name: 'journal_mode', set: journalMode.toUpperCase(), expected: journalMode },
    { name: 'synchronous', set: 'NORMAL', expected: 1 },
    { name: 'secure_delete', set: 'FAST', expected: 2 },
    { name: 'trusted_schema', set: 'OFF', expected: 0 },
    // query_only last: it would not stop a pragma above, but it states the reader's end state.
    {
      name: 'query_only',
      set: role === 'reader' ? 'ON' : 'OFF',
      expected: role === 'reader' ? 1 : 0
    }
  ]
}

function readPragma(db: DatabaseSync, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get()
  return row === undefined ? undefined : Object.values(row)[0]
}

/**
 * Set and verify every pragma of the policy on a freshly opened connection. Throws
 * `ConnectionPolicyError` for a wrong read-back; a failing statement throws the driver's error,
 * which the caller maps.
 */
export function applyConnectionPolicy(
  db: DatabaseSync,
  role: ConnectionRole,
  journalMode: JournalMode = 'wal'
): void {
  for (const rule of rules(role, journalMode)) {
    db.exec(`PRAGMA ${rule.name} = ${rule.set}`)
    const actual = readPragma(db, rule.name)
    if (actual !== rule.expected) throw new ConnectionPolicyError(rule.name, rule.expected, actual)
  }
}
