// The build's known migrations, in version order (ADR-005 item 4; 22 §5: one migration per PR).
// Append only: an entry is never edited, reordered or removed once the first internal build has
// shipped it (21 §5.1). Migration 1 is later: ISSUE-035.
import type { Migration } from './types'

export const knownMigrations: readonly Migration[] = []
