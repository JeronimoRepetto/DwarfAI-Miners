// Migration 2 (owner amendment N (AMENDMENT-14, OQ-85), 2026-10-15; 09 §4.6, §6.3): rebuilds
// `delegation_tokens` so a token row can be written before its launch's dwarf exists
// (`parent_dwarf_id` nullable, A14-06) and so a `protocol` relay entry stores its credential hash
// like `ticket-file` (A14-05). The SQL runs as written inside the runner's one migration
// transaction; its checksum is recorded in `schema_migrations` and verified at every open, so it
// is never rewritten once an internal build has applied it (21 §5.1).
import sql from './0002-delegation-tokens-unbound-parent.sql?raw'
import { defineMigration, type Migration } from './types'

export const delegationTokensUnboundParentMigration: Migration = defineMigration({
  version: 2,
  name: '0002-delegation-tokens-unbound-parent',
  sql
})
