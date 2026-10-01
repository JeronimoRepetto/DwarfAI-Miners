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
import { createQueryRunner } from '../process/NodeProcessControl'
import {
  POWERSHELL_DROPPED_ENV,
  windowsPowerShell,
  windowsSystemTool
} from '../process/probe/types'
import { VacuumIntoBackup } from './backup'
import { migrationsFor } from './migrations'
import { openHostDb } from './migrations/runner'
import { defineMigration, type Migration } from './migrations/types'

// L8 OS lane (17 §1.8): the real modes and ACLs of the Host's data at rest (09 §1, §9; ADR-017
// item 6; 18 C-24, T-36), over real files. The calls and the repair are fileProtection.test.ts's.

const T0 = 1_790_000_000_000

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
      }
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

// --- Windows: the inherited per-user profile ACL (09 §1, §9; TC-041-03) ---------------------------

/** Everyone, Anonymous, Authenticated Users, Interactive, Users and Guests: never granted. */
const BROAD_SIDS = new Set([
  'S-1-1-0',
  'S-1-5-7',
  'S-1-5-11',
  'S-1-5-4',
  'S-1-5-32-545',
  'S-1-5-32-546'
])
const ADMINISTRATORS = 'S-1-5-32-544'
/** The integrity label of an elevated token (privilege.ts reads the same SID). */
const HIGH_INTEGRITY = 'S-1-16-12288'
/** The Host's own OS query runner: execFile with an argv array, never a shell (R17). */
const query = createQueryRunner()
const QUERY_TIMEOUT_MS = 30_000

interface AclView {
  owner: string
  rules: Array<{ sid: string; type: 'Allow' | 'Deny'; inherited: boolean }>
}

/**
 * The owner and the DACL entries of each of `paths`, every principal as its full SID (never an SDDL
 * alias or a localized name, SP-05 finding 7). icacls cannot report the owner, so Windows
 * PowerShell 5.1's Get-Acl is read by its System32 path, once for every path, with the paths in
 * the environment (no shell, no quoting).
 */
async function aclsOf(paths: readonly string[]): Promise<AclView[]> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$sid = [System.Security.Principal.SecurityIdentifier]',
    '$views = @($env:DWARFAI_ACL_PATHS -split "`n" | ForEach-Object {',
    '  $acl = Get-Acl -LiteralPath $_',
    '  $rules = @($acl.GetAccessRules($true, $true, $sid) | ForEach-Object {',
    '    [pscustomobject]@{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); inherited = $_.IsInherited }',
    '  })',
    '  [pscustomobject]@{ owner = $acl.GetOwner($sid).Value; rules = $rules }',
    '})',
    'ConvertTo-Json -InputObject $views -Compress -Depth 4'
  ].join('\n')
  const out = await query(
    windowsPowerShell(),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      timeoutMs: QUERY_TIMEOUT_MS,
      env: { DWARFAI_ACL_PATHS: paths.join('\n') },
      dropEnv: POWERSHELL_DROPPED_ENV
    }
  )
  if (!out.ok) throw new Error(`Get-Acl ${out.cause}`)
  return JSON.parse(out.stdout) as AclView[]
}

/** The current user's SID and whether this process runs elevated, from whoami of System32. */
async function currentToken(): Promise<{ user: string; elevated: boolean }> {
  const whoami = windowsSystemTool('whoami.exe')
  const user = await query(whoami, ['/user', '/fo', 'csv', '/nh'], { timeoutMs: QUERY_TIMEOUT_MS })
  const groups = await query(whoami, ['/groups', '/fo', 'csv', '/nh'], {
    timeoutMs: QUERY_TIMEOUT_MS
  })
  if (!user.ok || !groups.ok) throw new Error('whoami could not be read')
  const sid = /"(S-1-[\d-]+)"/.exec(user.stdout)?.[1]
  if (sid === undefined) throw new Error('whoami /user printed no SID')
  return { user: sid, elevated: groups.stdout.includes(`"${HIGH_INTEGRITY}"`) }
}

describe.runIf(process.platform === 'win32')('Windows ACL of the Host data (09 §1, §9)', () => {
  it('[ADR-017] the database files inherit the per-user profile ACL: the owner is the current user and no Everyone or Users allow entry exists', async () => {
    const appData = process.env['APPDATA']
    if (appData === undefined) throw new Error('APPDATA is not set: no per-user profile to test in')
    mkdirSync(appData, { recursive: true })
    const m = machine(appData)
    const first = await m.boot()
    first.close()
    m.clock.advance(1_000)
    const second = await m.boot([NEXT])
    const token = await currentToken()
    // An elevated administrator's new objects are owned by Administrators, by Windows default
    // ("Default owner for objects created by members of the Administrators group").
    const owners = token.elevated ? [token.user, ADMINISTRATORS] : [token.user]
    const backup = readdirSync(m.dataDir).find((name) => name.startsWith(`${HOST_DB_FILE}.bak-`))
    expect(backup).toBeDefined()
    const paths = [m.dataDir, m.db, `${m.db}-wal`, `${m.db}-shm`, join(m.dataDir, String(backup))]

    const acls = await aclsOf(paths)

    expect(acls).toHaveLength(paths.length)
    for (const [index, acl] of acls.entries()) {
      const path = paths[index]
      expect(owners, path).toContain(acl.owner)
      // Nothing of its own: every entry comes from the per-user profile tree.
      expect(
        acl.rules.filter((rule) => !rule.inherited),
        path
      ).toEqual([])
      expect(
        acl.rules.filter((rule) => rule.type === 'Allow' && BROAD_SIDS.has(rule.sid)),
        path
      ).toEqual([])
      // The owner can use its own data.
      expect(
        acl.rules.some((rule) => rule.type === 'Allow' && owners.includes(rule.sid)),
        path
      ).toBe(true)
    }
    second.close()
  }, 60_000)
})
