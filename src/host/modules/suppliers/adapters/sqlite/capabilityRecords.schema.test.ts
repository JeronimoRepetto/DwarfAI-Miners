import { describe, expect, it } from 'vitest'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'

// L5 (17 §1.5) on the template database, which migration 1 built: the `capability_records`
// constraints the store relies on (09 §4.3), probed with raw SQL, not through the port.
const INSERT = `INSERT INTO capability_records
    (id, provider_id, provider_version, capabilities_json, measured_at)
  VALUES (?, ?, ?, ?, ?)`

function insert(db: SqliteDatabase, n: number, version: string, json: string): void {
  db.run(INSERT, [
    `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`,
    'alpha',
    version,
    json,
    n
  ])
}

describe('capability_records on schema v1', () => {
  it('[ADR-005] capability_records rejects a non-JSON capabilities_json and a second row for the same provider version', () => {
    const { db } = openTemplateCopy()
    insert(db, 1, '1.0.0', '{"launch":true}')

    expect(() => insert(db, 2, '1.1.0', '{not json')).toThrow(/CHECK constraint failed/)
    expect(() => insert(db, 3, '1.0.0', '{"launch":false}')).toThrow(
      /UNIQUE constraint failed: capability_records\.provider_id, capability_records\.provider_version/
    )
    expect(db.all('SELECT provider_version, capabilities_json FROM capability_records')).toEqual([
      { provider_version: '1.0.0', capabilities_json: '{"launch":true}' }
    ])
  })
})
