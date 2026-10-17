// The rows the delegation tables reference, for the SQLite half of the store contracts and the L5
// schema probes (09 §4.6: `delegations.parent_dwarf_id` / `worker_dwarf_id` → `dwarfs`,
// `delegation_tokens.launch_id` → `launches`, `parent_dwarf_id` → `dwarfs`). One mine, the given
// dwarfs in it and the given launches, each a plain supplier launch still routing. Synthetic,
// neutral values (17 §1.4). Never imported by production code (R14).
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'

const MINE = '00000000-0000-7000-8000-0000000d1e01'
const AT = 1_700_000_000_000

export function seedDelegationRows(
  db: SqliteDatabase,
  rows: { dwarfs: readonly string[]; launches: readonly string[] }
): void {
  db.run(
    `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
     VALUES (?, '/work/delegation-mine', 'delegation-mine', 'delegation-mine', 'active', ?, ?)`,
    [MINE, AT, AT]
  )
  rows.dwarfs.forEach((id, index) => {
    db.run(
      `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
         process_state, turn_state, arrived_at, last_activity_at)
       VALUES (?, ?, 'claude', ?, 'Durin', 'foreman', 'running', 'none-yet', ?, ?)`,
      [id, MINE, `session-d-${index}`, AT, AT]
    )
  })
  for (const id of rows.launches) {
    db.run(
      `INSERT INTO launches (id, mine_id, cwd, way_kind, provider_id, launched_with_let_jev_choose,
         state, delegated, host_epoch, requested_at)
       VALUES (?, ?, '/work/delegation-mine', 'supplier', 'claude', 1, 'routing', 0, 'epoch-1', ?)`,
      [id, MINE, AT]
    )
  }
}
