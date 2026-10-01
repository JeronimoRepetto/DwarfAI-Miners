import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import { createHostDatabase, HOST_DB_FILE, type HostDatabase } from '../../wiring/hostDatabase'
import {
  ADMINISTRATORS_SID,
  createWindowsAclReader,
  SYSTEM_SID
} from '../endpoint/win-pipe/testing/windowsAcl'
import { fileURLToPath } from 'node:url'
import { createNativeOwnerOnlyDirectory } from '../endpoint/win-pipe/nativeOwnerOnlyDirectory'
import { VacuumIntoBackup } from './backup'
import { createHostFileProtection } from './fileProtection'
import { migrationsFor } from './migrations'
import { openHostDb } from './migrations/runner'
import { defineMigration, type Migration } from './migrations/types'

// L8 OS lane (17 §1.8): the real modes and ACLs of the Host's data at rest (09 §1, §9; ADR-017
// item 6; 18 C-24, T-36), over real files. The calls and the repair are fileProtection.test.ts's.

const T0 = 1_790_000_000_000
const PREBUILDS = fileURLToPath(new URL('../../../../prebuilds', import.meta.url))

/** A migration this build adds on top of the shipped ones, so a boot backs the file up first. */
const NEXT: Migration = defineMigration({
  version: 2,
  name: '0002-next',
  sql: 'CREATE TABLE next_step (id INTEGER NOT NULL PRIMARY KEY) STRICT;'
})

const mode = (path: string): number => statSync(path).mode & 0o777

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** One Host data directory and the step-2 database of each boot over it. */
function machine(parent: string) {
  const root = mkdtempSync(join(parent, 'dwarfai-041-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const dataDir = join(root, 'host')
  const clock = new FakeClock(T0)
  const ids = new SequenceIdGenerator()
  const processControl = new FakeProcessControl({ bootId: 'boot-one', clock })
  processControl.scriptBootIdentity({ bootTimeMs: T0 - 3_600_000, logonSessionId: 'logon-one' })
  const boot = async (extra: readonly Migration[] = []): Promise<HostDatabase> => {
    const database = createHostDatabase({
      path: join(dataDir, HOST_DB_FILE),
      epoch: ids.uuidv7(),
      clock,
      log: new RecordingDiagnosticsLog(),
      processControl,
      open: {
        buildKind: 'test',
        releaseDataDir: join(root, 'release-data'),
        appVersion: '0.0.0-test',
        migrations: [...migrationsFor({ clock, ids }), ...extra]
      },
      // The production protection, with the built native helper on Windows.
      protectFiles: createHostFileProtection({
        log: new RecordingDiagnosticsLog(),
        ownerOnlyDirectory: createNativeOwnerOnlyDirectory({ prebuildsDir: PREBUILDS })
      })
    })
    cleanups.push(() => database.close())
    await database.open({ reportMigrating: () => undefined })
    return database
  }
  return { root, dataDir, db: join(dataDir, HOST_DB_FILE), clock, boot }
}

describe.runIf(process.platform !== 'win32')(
  'POSIX file modes of the Host data (09 §1, §9)',
  () => {
    let umask: number

    beforeEach(() => {
      // The usual desktop umask: without the protection, new files would be 0644 and dirs 0755.
      umask = process.umask(0o022)
    })

    afterEach(() => {
      process.umask(umask)
    })

    it('[ADR-017] after boot hostDataDir is 0700 and dwarfai.db, its -wal, -shm and backups are 0600', async () => {
      const m = machine(tmpdir())
      const first = await m.boot()
      first.close()
      // Found looser (TC-041-02): another tool, a restore or an old build left them readable.
      chmodSync(m.dataDir, 0o755)
      chmodSync(m.db, 0o644)
      m.clock.advance(1_000)

      // The second boot backs the file up before the migration, and holds it open in WAL mode.
      const second = await m.boot([NEXT])

      const backups = readdirSync(m.dataDir).filter((name) =>
        name.startsWith(`${HOST_DB_FILE}.bak-`)
      )
      expect(backups).toHaveLength(1)
      expect(existsSync(`${m.db}-wal`)).toBe(true)
      expect(existsSync(`${m.db}-shm`)).toBe(true)
      expect(mode(m.dataDir)).toBe(0o700)
      expect({
        db: mode(m.db),
        wal: mode(`${m.db}-wal`),
        shm: mode(`${m.db}-shm`),
        backups: backups.map((name) => mode(join(m.dataDir, name)))
      }).toEqual({ db: 0o600, wal: 0o600, shm: 0o600, backups: [0o600] })
      second.close()
    })

    it('[ADR-017] a backup created by the migration runner is 0600 from its first byte', () => {
      const dir = mkdtempSync(join(tmpdir(), 'dwarfai-041-backup-'))
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const path = join(dir, HOST_DB_FILE)
      const clock = new FakeClock(T0)
      const log = new RecordingDiagnosticsLog()
      const T1 = defineMigration({
        version: 1,
        name: '0001-t1',
        sql: [
          'CREATE TABLE schema_migrations (',
          '  version INTEGER NOT NULL PRIMARY KEY CHECK (version >= 1),',
          '  name TEXT NOT NULL UNIQUE,',
          '  checksum TEXT NOT NULL CHECK (length(checksum) = 64),',
          '  applied_at INTEGER NOT NULL,',
          '  app_version TEXT NOT NULL',
          ') STRICT;',
          'CREATE TABLE t1 (id INTEGER NOT NULL PRIMARY KEY, label TEXT NOT NULL) STRICT;',
          'PRAGMA application_id = 1146569033;'
        ].join('\n')
      })
      const options = {
        buildKind: 'release' as const,
        releaseDataDir: join(dir, 'release'),
        appVersion: '0.0.0-test',
        clock,
        log
      }
      const first = openHostDb(path, { ...options, migrations: [T1] })
      if (!first.ok) throw new Error(first.error)
      first.value.db.run('INSERT INTO t1 (id, label) VALUES (?, ?)', [1, 'kept'])
      first.value.db.close()
      clock.advance(1_000)
      // The mode of the copy's file at the moment VACUUM INTO starts writing into it.
      const seen: Array<number | null> = []
      const real = new VacuumIntoBackup({ clock, log })
      const backup = {
        beforeMigrating: (input: { db: SqliteDatabase; path: string; fromVersion: number }) =>
          real.beforeMigrating({ ...input, db: observingVacuumInto(input.db, seen) })
      }

      const second = openHostDb(path, { ...options, migrations: [T1, NEXT], backup })
      if (!second.ok) throw new Error(second.error)
      second.value.db.close()

      const copies = readdirSync(dir).filter((name) => name.startsWith(`${HOST_DB_FILE}.bak-`))
      expect(seen).toEqual([0o600])
      expect(copies.map((name) => mode(join(dir, name)))).toEqual([0o600])
    })
  }
)

/** `db` with `exec` reporting the mode `<file>` has when `VACUUM INTO '<file>'` starts. */
function observingVacuumInto(db: SqliteDatabase, seen: Array<number | null>): SqliteDatabase {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'exec') {
        return (sql: string): void => {
          const match = /^VACUUM INTO '(.*)'$/s.exec(sql)
          if (match !== null) {
            const file = String(match[1]).replace(/''/g, "'")
            seen.push(existsSync(file) ? mode(file) : null)
          }
          target.exec(sql)
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    }
  })
}

// --- Windows: the protected owner-only DACL of the data directory (TC-041-03) -------------------
//
// Owner-approved amendment (2026-10-01, ISSUE-041): protected owner-only DACL on the Windows data
// directory (SP-05 run\ row), replacing 09 §9's inherited profile ACL.

describe.runIf(process.platform === 'win32')('Windows ACL of the Host data (09 §1, §9)', () => {
  it('[ADR-017] the data directory has a protected DACL and it and the database files grant no principal but the user and SYSTEM', async () => {
    const appData = process.env['APPDATA']
    if (appData === undefined) throw new Error('APPDATA is not set: no per-user profile to test in')
    mkdirSync(appData, { recursive: true })
    const m = machine(appData)
    const first = await m.boot()
    first.close()
    m.clock.advance(1_000)
    const second = await m.boot([NEXT])
    const reader = await createWindowsAclReader()
    cleanups.push(() => reader.dispose())
    const token = { user: reader.user, elevated: reader.elevated }
    // An elevated administrator's new objects are owned by Administrators, by Windows default
    // ("Default owner for objects created by members of the Administrators group").
    const owners = token.elevated ? [token.user, ADMINISTRATORS_SID] : [token.user]
    const backup = readdirSync(m.dataDir).find((name) => name.startsWith(`${HOST_DB_FILE}.bak-`))
    expect(backup).toBeDefined()
    const paths = [m.dataDir, m.db, `${m.db}-wal`, `${m.db}-shm`, join(m.dataDir, String(backup))]

    const acls = await reader.read(paths)

    expect(acls).toHaveLength(paths.length)
    // The data directory inherits nothing from %APPDATA%: its own two entries only.
    expect(acls[0]?.protected, m.dataDir).toBe(true)
    for (const [index, acl] of acls.entries()) {
      const path = paths[index]
      expect(owners, path).toContain(acl.owner)
      expect(acl.rules.map((rule) => `${rule.type} ${rule.sid}`).sort(), path).toEqual(
        [`Allow ${SYSTEM_SID}`, `Allow ${token.user}`].sort()
      )
    }
    second.close()
  }, 180_000)
})
