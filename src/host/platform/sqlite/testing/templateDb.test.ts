import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderSchemaSnapshot, SCHEMA_QUERY } from './schemaSnapshot'
import { disposeTemplateCopy, openTemplateCopy } from './templateDb'

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
    // AMENDED for owner amendment N (AMENDMENT-14): migration 0002 is applied too.
    expect(copy.db.all('SELECT version, name FROM schema_migrations')).toEqual([
      { version: 1, name: '0001-initial' },
      { version: 2, name: '0002-delegation-tokens-unbound-parent' }
    ])
  })

  it('[ADR-005] disposing a copy the test already closed does not throw and removes its directory', () => {
    const copy = openTemplateCopy()
    const dir = dirname(copy.path)
    copy.db.close()

    expect(() => disposeTemplateCopy(copy.db, dir)).not.toThrow()
    expect(existsSync(dir)).toBe(false)
  })

  it('[ADR-005] disposing an open copy closes it and removes its directory', () => {
    const copy = openTemplateCopy()
    const dir = dirname(copy.path)

    disposeTemplateCopy(copy.db, dir)

    expect(existsSync(dir)).toBe(false)
    expect(() => copy.db.all('SELECT 1')).toThrow()
  })

  it('[ADR-005] disposing with no connection still removes the directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwarfai-db-'))

    disposeTemplateCopy(null, dir)

    expect(existsSync(dir)).toBe(false)
  })
})
