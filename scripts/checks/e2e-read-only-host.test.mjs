// layer: L7
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openHostDatabaseReadOnly } from '../../e2e/_harness/readOnlyHost.ts'

/**
 * L7 check of the E2E harness's read-only Host-state path (testing strategy `17` §1.9).
 *
 * An E2E case asserts Host state by opening the test profile's `dwarfai.db` read-only after the
 * Host exited, never by poking internal state. The database lives in `hostDataDir`, which is the
 * profile's `userData` + `/host` (`src/host/platform/paths/EnvAppPaths.ts`, `09` §1).
 */

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

function profileWithHostDb() {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'e2e-read-only-host-'))
  tempRoots.push(userDataDir)
  mkdirSync(path.join(userDataDir, 'host'))
  const db = new DatabaseSync(path.join(userDataDir, 'host', 'dwarfai.db'))
  db.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('written by the Host')")
  db.close()
  return { userDataDir }
}

describe('E2E read-only Host state (17 §1.9)', () => {
  it('[ADR-002] the harness opens the profile dwarfai.db read-only: it reads rows and refuses a write', () => {
    const db = openHostDatabaseReadOnly(profileWithHostDb())
    try {
      expect(db.prepare('SELECT value FROM probe').all()).toEqual([
        { value: 'written by the Host' }
      ])
      expect(() => db.exec("INSERT INTO probe VALUES ('from a test')")).toThrow(/readonly/i)
    } finally {
      db.close()
    }
  })

  it('[ADR-002] the harness refuses a profile whose Host wrote no database, with a clear message', () => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'e2e-read-only-host-'))
    tempRoots.push(userDataDir)

    expect(() => openHostDatabaseReadOnly({ userDataDir })).toThrow(
      /no Host database.*host[\\/]dwarfai\.db/
    )
  })
})
