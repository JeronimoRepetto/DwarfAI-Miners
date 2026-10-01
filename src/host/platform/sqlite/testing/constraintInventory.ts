// Every constraint of a migrated schema as a tag (17 §1.5 "DDL probes become the schema contract
// suite"; ISSUE-036). `schema.coverage.test.ts` fails when a tag has no "stores" probe or no
// "rejected" probe in `schema.contract.test.ts`, and the probes check SQLite's error against the
// `rejection` given here, so a probe proves the constraint it names and not a neighbour.
//
// Read from the database, never from 09: `sqlite_schema` SQL for the CHECKs and the triggers,
// `pragma_index_list` / `pragma_index_xinfo` for the UNIQUEs, `pragma_foreign_key_list` for the
// FK actions. Tags:
//   - `table.column CHECK` for a column CHECK (`table.column CHECK (expr)` when a column has more
//     than one), `table CHECK (expr)` for a table CHECK, the expression whitespace-collapsed;
//   - `index name` for a `CREATE UNIQUE INDEX`, `table UNIQUE (col, …)` for a UNIQUE clause
//     (PRIMARY KEYs are not UNIQUE constraints and are not listed);
//   - `trigger name`;
//   - `fk table.column → parent`.
import type { SqliteDatabase, SqliteRow } from '../../../kernel/ports/sqliteDatabase'

export type ConstraintKind = 'check' | 'unique' | 'trigger' | 'fk'

export interface SchemaConstraint {
  readonly tag: string
  readonly kind: ConstraintKind
  readonly table: string
  /**
   * SQLite's message, whitespace-collapsed, when this constraint rejects a statement; `null` for
   * a trigger with no `RAISE`, which never rejects by itself (its probe names the error it meets).
   */
  readonly rejection: string | null
}

/** Collapse every whitespace run to one space, as the tags and the rejections are compared. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

type Queryable = Pick<SqliteDatabase, 'all'>

function text(row: SqliteRow, column: string): string {
  return String(row[column])
}

/** The SQL with its comments blanked out, string literals and quoted names left intact. */
function withoutComments(sql: string): string {
  let out = ''
  let index = 0
  while (index < sql.length) {
    const char = sql[index] ?? ''
    if (char === "'" || char === '"' || char === '`') {
      const end = sql.indexOf(char, index + 1)
      const stop = end === -1 ? sql.length : end + 1
      out += sql.slice(index, stop)
      index = stop
    } else if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index)
      index = end === -1 ? sql.length : end
      out += ' '
    } else if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2)
      index = end === -1 ? sql.length : end + 2
      out += ' '
    } else {
      out += char
      index += 1
    }
  }
  return out
}

/**
 * Walk `sql` from `start`, calling `visit(index, depth)` for every character outside string
 * literals and quoted names; `depth` is the parenthesis depth before the character.
 */
function scan(sql: string, start: number, visit: (index: number, depth: number) => boolean): void {
  let depth = 0
  let index = start
  while (index < sql.length) {
    const char = sql[index] ?? ''
    if (char === "'" || char === '"' || char === '`') {
      const end = sql.indexOf(char, index + 1)
      index = end === -1 ? sql.length : end + 1
      continue
    }
    if (visit(index, depth)) return
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    index += 1
  }
}

/** The text inside the parenthesis that opens at `open`. */
function parenthesised(sql: string, open: number): string {
  let close = sql.length
  scan(sql, open, (index, depth) => {
    if (sql[index] === ')' && depth === 1) {
      close = index
      return true
    }
    return false
  })
  return sql.slice(open + 1, close)
}

/** The comma-separated items of a CREATE TABLE body, split at depth 0. */
function bodyItems(body: string): string[] {
  const items: string[] = []
  let from = 0
  scan(body, 0, (index, depth) => {
    if (body[index] === ',' && depth === 0) {
      items.push(body.slice(from, index))
      from = index + 1
    }
    return false
  })
  items.push(body.slice(from))
  return items.map((item) => item.trim()).filter((item) => item !== '')
}

/** The expressions of every `CHECK (…)` at depth 0 of one body item. */
function checkExpressions(item: string): string[] {
  const found: string[] = []
  scan(item, 0, (index, depth) => {
    if (depth !== 0 || !/^CHECK\b/i.test(item.slice(index))) return false
    if (index > 0 && /[\w$]/.test(item[index - 1] ?? '')) return false
    const open = item.indexOf('(', index)
    if (open !== -1) found.push(parenthesised(item, open))
    return false
  })
  return found
}

function unquote(name: string): string {
  return /^["`[]/.test(name) ? name.slice(1, -1) : name
}

function tableChecks(table: string, sql: string): SchemaConstraint[] {
  const clean = withoutComments(sql)
  const body = parenthesised(clean, clean.indexOf('('))
  const constraints: SchemaConstraint[] = []
  for (const item of bodyItems(body)) {
    const expressions = checkExpressions(item)
    if (expressions.length === 0) continue
    const tableLevel = /^(CONSTRAINT\s+\S+\s+)?CHECK\b/i.test(item)
    const column = unquote(item.split(/\s+/)[0] ?? '')
    for (const expression of expressions) {
      const expr = collapseWhitespace(expression)
      const tag = tableLevel
        ? `${table} CHECK (${expr})`
        : expressions.length === 1
          ? `${table}.${column} CHECK`
          : `${table}.${column} CHECK (${expr})`
      constraints.push({
        tag,
        kind: 'check',
        table,
        rejection: `CHECK constraint failed: ${expr}`
      })
    }
  }
  return constraints
}

function tableUniques(db: Queryable, table: string): SchemaConstraint[] {
  return db
    .all(
      `SELECT name, origin FROM pragma_index_list(?) WHERE "unique" = 1 AND origin IN ('u', 'c') ORDER BY name`,
      [table]
    )
    .map((index) => {
      const name = text(index, 'name')
      const columns = db.all(
        'SELECT cid, name FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno',
        [name]
      )
      const onExpression = columns.some((column) => column['cid'] === -2)
      const columnNames = columns.map((column) => text(column, 'name'))
      return {
        tag:
          text(index, 'origin') === 'c'
            ? `index ${name}`
            : `${table} UNIQUE (${columnNames.join(', ')})`,
        kind: 'unique' as const,
        table,
        rejection: onExpression
          ? `UNIQUE constraint failed: index '${name}'`
          : `UNIQUE constraint failed: ${columnNames.map((column) => `${table}.${column}`).join(', ')}`
      }
    })
}

function tableForeignKeys(db: Queryable, table: string): SchemaConstraint[] {
  const rows = db.all(
    'SELECT id, seq, "table" AS parent, "from" AS child FROM pragma_foreign_key_list(?) ORDER BY id, seq',
    [table]
  )
  const byId = new Map<number, { parent: string; columns: string[] }>()
  for (const row of rows) {
    const id = Number(row['id'])
    const entry = byId.get(id) ?? { parent: text(row, 'parent'), columns: [] }
    entry.columns.push(text(row, 'child'))
    byId.set(id, entry)
  }
  return [...byId.values()].map(({ parent, columns }) => ({
    tag: `fk ${table}.${columns.join(', ')} → ${parent}`,
    kind: 'fk' as const,
    table,
    rejection: 'FOREIGN KEY constraint failed'
  }))
}

function trigger(row: SqliteRow): SchemaConstraint {
  const raised = /RAISE\s*\(\s*(?:ABORT|FAIL|ROLLBACK)\s*,\s*'((?:[^']|'')*)'\s*\)/i.exec(
    text(row, 'sql')
  )
  return {
    tag: `trigger ${text(row, 'name')}`,
    kind: 'trigger',
    table: text(row, 'tbl_name'),
    rejection: raised === null ? null : collapseWhitespace((raised[1] ?? '').replace(/''/g, "'"))
  }
}

/** Every CHECK, UNIQUE, trigger and FK action of the schema `db` holds, in a stable order. */
export function constraintInventory(db: Queryable): SchemaConstraint[] {
  const tables = db.all(
    "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )
  const triggers = db.all(
    "SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name"
  )
  return [
    ...tables.flatMap((row) => {
      const table = text(row, 'name')
      return [
        ...tableChecks(table, text(row, 'sql')),
        ...tableUniques(db, table),
        ...tableForeignKeys(db, table)
      ]
    }),
    ...triggers.map(trigger)
  ]
}
