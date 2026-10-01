// The data-contract checks the fixture ladder runs on each rung after it is migrated to head
// (17 §1.5 "From every previous version"; 09 §6.5 "Fixture ladder"; ADR-005 item 6). Never
// imported by production code (R14).
//
// - `PRAGMA foreign_key_check` reports no row;
// - `PRAGMA integrity_check` reads `ok`;
// - every `material_totals` row equals `SUM(ledger_entries)` of its mine and material, and every
//   (mine, material) with credits has its totals row (09 §6.5 "Invariant triggers"; ADR-006 item 9);
// - every table of `sqlite_schema` can be read in full.
//
// It returns one line per problem (an empty list is a pass), so a failing ladder names them all.
import type { SqliteDatabase, SqliteRow } from '../../../kernel/ports/sqliteDatabase'

type Queryable = Pick<SqliteDatabase, 'all'>

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function foreignKeyProblems(db: Queryable): string[] {
  return db
    .all('PRAGMA foreign_key_check')
    .map(
      (row) =>
        `foreign_key_check: ${String(row['table'])} row ${String(row['rowid'])} → ${String(row['parent'])}`
    )
}

function integrityProblems(db: Queryable): string[] {
  const lines = db.all('PRAGMA integrity_check').map((row) => String(Object.values(row)[0]))
  return lines.length === 1 && lines[0] === 'ok'
    ? []
    : lines.map((line) => `integrity_check: ${line}`)
}

/** Totals rows against the credits, in both directions (a missing side counts as zero). */
const TOTALS_MISMATCH = `
  WITH sums AS (
    SELECT mine_id, material, SUM(tokens) AS tokens, SUM(units) AS units
      FROM ledger_entries GROUP BY mine_id, material
  ),
  keys AS (
    SELECT mine_id, material FROM sums UNION SELECT mine_id, material FROM material_totals
  )
  SELECT k.mine_id, k.material,
         t.tokens AS total_tokens, t.units AS total_units,
         coalesce(s.tokens, 0) AS sum_tokens, coalesce(s.units, 0) AS sum_units
    FROM keys k
    LEFT JOIN material_totals t ON t.mine_id = k.mine_id AND t.material = k.material
    LEFT JOIN sums s ON s.mine_id = k.mine_id AND s.material = k.material
   WHERE t.mine_id IS NULL
      OR t.tokens <> coalesce(s.tokens, 0)
      OR t.units <> coalesce(s.units, 0)
   ORDER BY k.mine_id, k.material`

function totalsProblems(db: Queryable): string[] {
  return db.all(TOTALS_MISMATCH).map((row: SqliteRow) => {
    const key = `(${String(row['mine_id'])}, ${String(row['material'])})`
    const sum = `SUM(ledger_entries) is ${String(row['sum_tokens'])} tokens and ${String(row['sum_units'])} units`
    return row['total_tokens'] === null
      ? `material_totals ${key} has no row; ${sum}`
      : `material_totals ${key} holds ${String(row['total_tokens'])} tokens and ${String(row['total_units'])} units; ${sum}`
  })
}

function unreadableTables(db: Queryable): string[] {
  const tables = db
    .all(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .map((row) => String(row['name']))
  const problems: string[] = []
  for (const table of tables) {
    try {
      db.all(`SELECT * FROM ${quoteIdentifier(table)}`)
    } catch (error) {
      problems.push(
        `${table} is not readable: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return problems
}

/** Every data-contract problem of the database behind `db`; empty when it passes. */
export function checkDataContract(db: Queryable): string[] {
  return [
    ...foreignKeyProblems(db),
    ...integrityProblems(db),
    ...totalsProblems(db),
    ...unreadableTables(db)
  ]
}
