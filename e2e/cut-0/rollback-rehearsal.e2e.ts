import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { PROTOCOL_VERSION } from '../../src/contracts/host-protocol/protocolVersion.ts'
import {
  chooseTrayItem,
  createIsolatedProfile,
  disposeProfile,
  homeIn,
  isProcessAlive,
  launchApp,
  profileHostPid,
  TRAY_ITEMS,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { openHostDatabaseReadOnly } from '../_harness/readOnlyHost.ts'

/**
 * L9, cut 0 (ISSUE-057; TC-057-02, TC-057-03; 21 §2.1 items 1 and 3; ADR-002 D8 items 2 and 5; UC-026): the cut-0
 * rollback rehearsed once with built apps, `docs/strangler/rollback.md` §1 and §3.
 *
 * Two builds of this tree meet one profile, as two installed builds meet one person's data:
 *
 * - the **faulty build** is the repository's own `pnpm build` (`out/`), with the real PROTOCOL_VERSION;
 * - the **rollback build** is made once for this file by `scripts/e2e/build-rehearsal-app.mjs`: one patch version above,
 *   and one `protocolVersion` above, as a rollback build must be (`rollback.md` §1: with an equal `protocolVersion` D8
 *   item 1 attaches normally and the running Host is never replaced). It is a folder of copies under `test-results/`,
 *   inside the repository so its bundles resolve their dependencies, removed after the file.
 *
 * Each case owns its profile (`createIsolatedProfile`), so the first build's Host is still running when the second
 * build starts, as it is after a person quits the app (OQ-63). `disposeProfile` ends whatever is left in the `finally`.
 * Every app runs under the harness's `-r` guard, so nothing opens a modal box.
 */

test.describe.configure({ timeout: 300_000 })

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FAULTY_VERSION = (
  JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
).version

/** The confirm button of the window's Stop everything and quit confirmation (ISSUE-317; the design's copy marker). */
const CONFIRM = /confirm button naming the count/

interface RehearsalBuild {
  appDir: string
  appVersion: string
  protocolVersion: number
}

let rollbackBuild: RehearsalBuild | undefined

test.beforeAll(() => {
  test.setTimeout(300_000)
  const parent = path.join(REPO_ROOT, 'test-results')
  mkdirSync(parent, { recursive: true })
  const appDir = mkdtempSync(path.join(parent, 'rehearsal-build-'))
  const out = execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'scripts', 'e2e', 'build-rehearsal-app.mjs'),
      '--out',
      appDir,
      '--protocol-version',
      String(PROTOCOL_VERSION + 1)
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 }
  )
  const lastLine = out.trim().split(/\r?\n/).at(-1) ?? ''
  rollbackBuild = JSON.parse(lastLine) as RehearsalBuild
})

test.afterAll(() => {
  if (rollbackBuild !== undefined) rmSync(rollbackBuild.appDir, { recursive: true, force: true })
})

function built(): RehearsalBuild {
  if (rollbackBuild === undefined) throw new Error('the rollback build was not made')
  return rollbackBuild
}

interface LogRecord {
  proc?: string
  event?: string
  causeClass?: string
}

/**
 * Every record of the profile's log folder with `event` written by `proc`, the UI (`ui`) or the Host (`host`), in the
 * order written: both builds' processes append to the one folder (19 §9.1).
 */
function logRecords(profile: IsolatedProfile, proc: 'ui' | 'host', event: string): LogRecord[] {
  const logs = path.join(profile.userDataDir, 'logs')
  if (!existsSync(logs)) return []
  const records: LogRecord[] = []
  for (const name of readdirSync(logs).filter((file) => file.endsWith('.jsonl'))) {
    for (const line of readFileSync(path.join(logs, name), 'utf8').split(/\r?\n/)) {
      if (!line.includes(`"${event}"`)) continue
      try {
        const record = JSON.parse(line) as LogRecord
        if (record.proc === proc && record.event === event) records.push(record)
      } catch {
        // A line being written: not a record yet.
      }
    }
  }
  return records
}

/** The causes of the records `proc` wrote with `event`. */
function causes(
  profile: IsolatedProfile,
  proc: 'ui' | 'host',
  event: string
): (string | undefined)[] {
  return logRecords(profile, proc, event).map((record) => record.causeClass)
}

async function hostConnection(window: Page): Promise<Record<string, unknown>> {
  return (await window.evaluate('window.api.getHostConnection()')) as Record<string, unknown>
}

/** The environment of every app here: the per-user folders in the profile, so no person's data is read. */
function appEnv(profile: IsolatedProfile): Record<string, string> {
  return homeIn(profile)
}

test.describe('cut 0: the rollback rehearsal (ISSUE-057)', () => {
  test('[ADR-002] a rollback build with a higher version attaches in compat mode and replaces the running Host through the D8 handshake, keeping dwarfai.db', async () => {
    const rollback = built()
    const profile = createIsolatedProfile()
    let faulty: LaunchedApp | undefined
    let rolledBack: LaunchedApp | undefined
    try {
      // The faulty build runs, with its Host, and is quit: its Host keeps running (OQ-63).
      faulty = await launchApp({
        profile,
        env: appEnv,
        tracePath: test.info().outputPath('faulty-trace.zip')
      })
      const faultyHost = await waitForHostAttached(profile)
      expect(await hostConnection(faulty.window)).toMatchObject({
        state: 'connected',
        hostVersion: FAULTY_VERSION,
        compat: false
      })
      // One build's UI and Host speak one protocolVersion (D8 item 1).
      expect(causes(profile, 'ui', 'host.upgrade')).toEqual(['attach'])
      await faulty.teardown()
      faulty = undefined
      expect(isProcessAlive(faultyHost), 'the faulty build Host outlives its app').toBe(true)

      // The rollback build starts and meets that Host.
      rolledBack = await launchApp({
        profile,
        appDir: rollback.appDir,
        env: appEnv,
        tracePath: test.info().outputPath('rollback-trace.zip')
      })
      const window = rolledBack.window
      await expect
        .poll(() => hostConnection(window), {
          timeout: 120_000,
          message: 'the rollback build attaches to its own Host after the swap'
        })
        .toMatchObject({ state: 'connected', hostVersion: rollback.appVersion, compat: false })

      // D8 item 2: compat mode and host.upgrade.request; the faulty Host went upgrade-pending, drained and exited for
      // the upgrade, and the rollback build then started its own Host.
      expect(causes(profile, 'ui', 'host.upgrade').slice(0, 2)).toEqual([
        'attach',
        'attach-compat-and-request-upgrade'
      ])
      expect(causes(profile, 'host', 'host.upgrade')).toContain('upgrade-pending')
      expect(causes(profile, 'host', 'host.exit')).toEqual(['upgrade'])
      expect(isProcessAlive(faultyHost), 'the faulty build Host is gone').toBe(false)
      const rollbackHost = profileHostPid(profile.userDataDir)
      expect(rollbackHost).not.toBeNull()
      expect(rollbackHost).not.toBe(faultyHost)
      expect(isProcessAlive(rollbackHost ?? -1)).toBe(true)
      // DwarfAI's own stop, never a lost Host: no unavailable state was entered (PO #62).
      expect(
        causes(profile, 'ui', 'host.connection').filter((cause) => cause?.startsWith('unavailable'))
      ).toEqual([])
      // The rollback Host opened the database it found and migrated nothing (one migration, the faulty Host's).
      expect(causes(profile, 'host', 'db.migration')).toHaveLength(1)

      await rolledBack.teardown({ stopEverything: true })
      rolledBack = undefined

      // dwarfai.db is kept: the rollback Host opened the file the faulty build's Host migrated (forward-only, 21 §5.1),
      // so every migration row still names the faulty build's version, never the rollback build's.
      const db = openHostDatabaseReadOnly(profile)
      try {
        const rows = db.prepare('SELECT app_version FROM schema_migrations').all() as {
          app_version: string
        }[]
        expect(rows.length).toBeGreaterThan(0)
        expect(new Set(rows.map((row) => row.app_version))).toEqual(new Set([FAULTY_VERSION]))
      } finally {
        db.close()
      }
    } finally {
      await faulty?.teardown().catch(() => undefined)
      await rolledBack?.teardown().catch(() => undefined)
      await disposeProfile(profile)
    }
  })

  test('[ADR-002] a UI with a lower protocolVersion shows the Host as incompatible, never sends host.upgrade.request and offers only Stop everything and quit', async () => {
    const newer = built()
    const profile = createIsolatedProfile()
    let newerApp: LaunchedApp | undefined
    let olderApp: LaunchedApp | undefined
    try {
      // The newer build's Host runs (the older-artifact path with its stop-all skipped, 21 §2.1 item 3).
      newerApp = await launchApp({
        profile,
        appDir: newer.appDir,
        env: appEnv,
        tracePath: test.info().outputPath('newer-trace.zip')
      })
      const newerHost = await waitForHostAttached(profile)
      expect(await hostConnection(newerApp.window)).toMatchObject({
        state: 'connected',
        hostVersion: newer.appVersion
      })
      await newerApp.teardown()
      newerApp = undefined

      // The older UI, this tree's own build, meets it.
      olderApp = await launchApp({
        profile,
        trayProbe: true,
        env: appEnv,
        tracePath: test.info().outputPath('older-trace.zip')
      })
      const { app, window } = olderApp
      await expect
        .poll(() => hostConnection(window), { timeout: 90_000 })
        .toEqual({ state: 'unavailable', reason: 'incompatible' })
      await chooseTrayItem(app, TRAY_ITEMS.open)
      const message = window.locator('.dm-host-state[data-variant="incompatible"]')
      await expect(message).toHaveCount(1, { timeout: 30_000 })
      // Only Stop everything and quit: the dialog's one action.
      const dialog = window.getByRole('dialog').filter({ has: message })
      await expect(dialog.getByRole('button')).toHaveCount(1)

      // Never host.upgrade.request: the older UI decided D8 item 5, never asked for a target or sent the request, and
      // the newer Host, which would drain at once with nothing open, still runs and never exited for an upgrade.
      expect(causes(profile, 'ui', 'host.upgrade')).toEqual([
        'attach',
        'incompatible-offer-stop-all'
      ])
      expect(causes(profile, 'host', 'host.upgrade')).toEqual([])
      expect(causes(profile, 'host', 'host.exit')).toEqual([])
      expect(profileHostPid(profile.userDataDir)).toBe(newerHost)
      expect(isProcessAlive(newerHost)).toBe(true)

      // The offered action stops the newer Host; the older UI then starts its own Host and stays open.
      await dialog.getByRole('button').click()
      await window.getByRole('button', { name: CONFIRM }).click({ timeout: 30_000 })
      await expect
        .poll(() => isProcessAlive(newerHost), { timeout: 60_000, message: 'the newer Host stops' })
        .toBe(false)
      expect(causes(profile, 'host', 'host.exit')).toEqual(['stop-all'])
      await expect
        .poll(() => hostConnection(window), {
          timeout: 120_000,
          message: 'the older UI attaches to its own Host'
        })
        .toMatchObject({ state: 'connected', hostVersion: FAULTY_VERSION, compat: false })
      expect(app.process().exitCode, 'the older app keeps running').toBeNull()
      expect(causes(profile, 'ui', 'host.upgrade')).not.toContain(
        'attach-compat-and-request-upgrade'
      )
      expect(causes(profile, 'host', 'host.upgrade')).toEqual([])

      await olderApp.teardown({ stopEverything: true })
      olderApp = undefined
    } finally {
      await newerApp?.teardown().catch(() => undefined)
      await olderApp?.teardown().catch(() => undefined)
      await disposeProfile(profile)
    }
  })
})
