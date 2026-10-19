// L7 static (17 §1.7): what conversation keeps at rest (06 INV-62; ADR-007 item 4; 09 §9; 18 C-25).
// The schema the Host migrates is read from `sqlite_schema` of the run's template database and
// compared with the columns 09 §4.4 gives the conversation tables. A column outside that list (a
// tool output, a file content, a raw provider payload, a hidden flag) fails here before it can
// hold anything.
import { describe, expect, it } from 'vitest'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'

/** 09 §4.4 "schema-v1 · 4.4 conversation", every column of every table, `sort_at` included. */
const CONVERSATION_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  messages: [
    'id',
    'dwarf_id',
    'source_key',
    'role',
    'text',
    'issuer_dwarf_id',
    'activity_json',
    'attachments_json',
    'origin',
    'pending_echo',
    'provider_time',
    'created_at',
    'ask_id',
    'request_id',
    'sort_at'
  ],
  message_keys: ['source_key', 'dwarf_id', 'message_id', 'first_seen_at'],
  deliveries: [
    'message_id',
    'dwarf_id',
    'kind',
    'phase',
    'confidence',
    'held_until_turn_end',
    'failure_kind',
    'failure_reason',
    'attempts',
    'sent_at',
    'phase_at'
  ],
  activity_disclosures: [
    'id',
    'dwarf_id',
    'turn_key',
    'open',
    'step_count',
    'summaries_json',
    'opened_at',
    'closed_at'
  ],
  outcome_lines: [
    'dwarf_id',
    'kind',
    'step_count',
    'parts_json',
    'detail',
    'closing_words',
    'reliability',
    'at'
  ]
}

/** Names that would store what INV-62 forbids, or a hidden row (INV-68). */
const FORBIDDEN = /tool|output|content|raw|payload|hidden|stdout|stderr|blob/

/**
 * Each conversation table's columns that 09 §4.4 does not list, and each listed column that is
 * missing, as `table.column` (`+` added, `-` missing).
 */
function columnsOffAllowlist(db: SqliteDatabase): string[] {
  const off: string[] = []
  for (const [table, allowed] of Object.entries(CONVERSATION_COLUMNS)) {
    const present = db.all("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?", [
      table
    ])
    if (present.length === 0) {
      off.push(`-${table}`)
      continue
    }
    // `table_xinfo` also lists generated columns (`messages.sort_at`).
    const columns = db
      .all('SELECT name FROM pragma_table_xinfo(?)', [table])
      .map((row) => String(row['name']))
    off.push(...columns.filter((c) => !allowed.includes(c)).map((c) => `+${table}.${c}`))
    off.push(...allowed.filter((c) => !columns.includes(c)).map((c) => `-${table}.${c}`))
  }
  return off.sort()
}

describe('conversation at rest', () => {
  it('[INV-62, ADR-007] no conversation table has a column for tool output, file content, raw provider payload or a hidden flag', () => {
    const { db } = openTemplateCopy()

    expect(columnsOffAllowlist(db)).toEqual([])
    expect(
      Object.entries(CONVERSATION_COLUMNS).flatMap(([table, columns]) =>
        columns.filter((c) => FORBIDDEN.test(c)).map((c) => `${table}.${c}`)
      )
    ).toEqual([])

    // The check bites: a column added by a later migration is reported by name.
    db.exec('ALTER TABLE messages ADD COLUMN raw_payload TEXT')
    db.exec('ALTER TABLE deliveries ADD COLUMN hidden INTEGER')
    expect(columnsOffAllowlist(db)).toEqual(['+deliveries.hidden', '+messages.raw_payload'])
  })
})
