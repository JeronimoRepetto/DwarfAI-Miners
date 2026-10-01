import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderSchemaSnapshot, SCHEMA_QUERY } from './schemaSnapshot'
import { openTemplateCopy } from './templateDb'

// L5 test infrastructure (17 §1.5 "Speed"; 09 §6.5 "Template DB"; 17 §5.3): the template is
// migrated once per `vitest` run by `templateDb.globalSetup.ts`, and every test works on its own
// copy in its own temp directory. The two "copy" tests share one written value through the file
// scope: the second must not see what the first wrote.

const SNAPSHOT = readFileSync(new URL('../schema.snapshot.sql', import.meta.url), 'utf8').replace(
  /\r\n?/g,
  '\n'
)
const MINE = '00000000-0000-7000-8000-0000000000f1'

let firstCopyPath: string | null = null

describe('the template database (09 §6.5 "Template DB")', () => {
  it("[ADR-005] two tests' copies of the template are independent: a write in one is invisible in the other (first copy writes)", () => {
    const copy = openTemplateCopy()
    copy.db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, '/work/mine-one', 'mine-one', 'mine-one', 'active', 0, 0)`,
      [MINE]
    )
    firstCopyPath = copy.path

    expect(copy.db.all('SELECT id FROM mines')).toEqual([{ id: MINE }])
  })

  it("[ADR-005] two tests' copies of the template are independent: a write in one is invisible in the other", () => {
    const copy = openTemplateCopy()

    expect(copy.path).not.toBe(firstCopyPath)
    expect(copy.db.all('SELECT id FROM mines')).toEqual([])
  })

  it('[ADR-005] the template equals a fresh migration of an empty file', () => {
    const copy = openTemplateCopy()

    expect(renderSchemaSnapshot(copy.db.all(SCHEMA_QUERY))).toBe(SNAPSHOT)
    expect(copy.db.all('SELECT version, name FROM schema_migrations')).toEqual([
      { version: 1, name: '0001-initial' }
    ])
  })
})
