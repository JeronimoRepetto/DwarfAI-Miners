import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, release, tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Spike SP-16, L8 on each OS (testing strategy `17` §4; ADR-017 item 2; ADR-002 D1; spike register SP-16; ISSUE-322).
 *
 * Question: does `@napi-rs/keyring`, the library the `OsKeyringSecretStore` adapter drives, load and set, read, list
 * and delete an entry when the Host's runtime runs it, the Electron binary under `ELECTRON_RUN_AS_NODE=1` (ADR-002
 * D1), on Windows, macOS and Linux; and on Linux without a Secret Service, is an entry pinned to the Secret Service
 * refused (ADR-017 wants "unavailable", never the kernel keyring)?
 *
 * Each case runs `keyringProbe.cjs` in a child Electron process. The probe touches only entries under a service unique
 * to this run (`DwarfAI-Miners.sp16-<random>`), whose values are drawn at run time and never printed, and deletes them
 * before it ends. The person's own entries are never read.
 *
 * The Node half (the adapter's contract over the real store) is `OsKeyringSecretStore.os.test.ts` and its
 * no-Secret-Service sibling. Variables:
 * - `SPIKE_REPORT_DIR=<dir>`: writes `<dir>/SP-16-<platform>-<SP16_LEG or default>.json` (the record's raw output);
 * - `SP16_REQUIRE_SECRET_SERVICE=1` (Linux): fails when no Secret Service answers, for the leg that started one;
 * - `SP16_COPY=1`: also copies the Electron runtime to a temp folder and runs the probe from the copy, as the Host's
 *   versioned copy holds it (SP-03), and records whether an entry written by the original reads back from the copy
 *   (the macOS Keychain question across copies; recorded, not asserted).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const PROBE = path.join(HERE, 'keyringProbe.cjs')
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string
const SERVICE = `DwarfAI-Miners.sp16-${randomBytes(6).toString('hex')}`
const PROBE_TIMEOUT_MS = 60_000
const CROSS_COPY_TIMEOUT_MS = 30_000

interface ProbeReport {
  readonly mode: string
  readonly runAsNode: boolean
  readonly electron: string | null
  readonly node: string
  readonly modules: string
  readonly loadedFrom: string | null
  readonly available?: boolean
  readonly checks: Record<string, unknown>
}

interface ProbeRun {
  readonly label: string
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly ms: number
  readonly report: ProbeReport | null
  readonly stderr: string | null
}

const runs: ProbeRun[] = []
const cleanups: (() => void)[] = []

/** Replaces machine-specific values, also in their JSON-escaped spelling (privacy guard). */
function scrub(text: string): string {
  let out = text
  for (const [value, placeholder] of [
    [REPO, '<repo>'],
    [tmpdir(), '<tmp>'],
    [homedir(), '<home>'],
    [userInfo().username, '<user>']
  ] as const) {
    if (value.length < 3) continue
    for (const spelling of [JSON.stringify(value).slice(1, -1), value]) {
      out = out.split(spelling).join(placeholder)
    }
  }
  return out
}

function probe(
  label: string,
  exe: string,
  mode: string,
  extraEnv: Record<string, string> = {},
  timeout = PROBE_TIMEOUT_MS
): ProbeRun {
  const started = performance.now()
  const result = spawnSync(exe, [PROBE, mode, SERVICE, REPO], {
    env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout,
    windowsHide: true
  })
  let report: ProbeReport | null = null
  try {
    report = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() ?? '') as ProbeReport
  } catch {
    // kept as stderr below
  }
  const run: ProbeRun = {
    label,
    exitCode: result.status,
    timedOut: result.error !== undefined && /ETIMEDOUT/.test(String(result.error)),
    ms: Math.round(performance.now() - started),
    report,
    stderr: result.stderr?.trim().slice(0, 2000) || null
  }
  runs.push(run)
  return run
}

/** The checks every OS must pass for a round trip (the SP-16 record's pass values). */
const ROUND_TRIP_PASS = {
  load: 'ok',
  set: 'ok',
  readBackEqual: true,
  findCredentialsListsIt: true,
  unicodeRoundTrip: true,
  deleteReturnsTrue: true,
  readAfterDeleteIsNull: true,
  secondDeleteReturnsFalse: true,
  findCredentialsAfterDelete: false,
  leftoverEntries: 0
}

function expectRoundTrip(run: ProbeRun): void {
  expect(
    run.report,
    `${run.label}: the probe printed its report (stderr: ${run.stderr ?? 'none'})`
  ).not.toBeNull()
  expect(run.report?.runAsNode, `${run.label}: ran under ELECTRON_RUN_AS_NODE`).toBe(true)
  expect(run.report?.electron, `${run.label}: ran in the Electron binary`).toBeTypeOf('string')
  expect(run.report?.checks).toMatchObject(ROUND_TRIP_PASS)
}

const backendUp =
  process.platform !== 'linux' ||
  probe('available', ELECTRON, 'available').report?.available === true
const copyWanted = process.env['SP16_COPY'] === '1'

afterAll(() => {
  // Safety net: the probes delete their own entries; this removes any a failed probe left.
  probe('cleanup', ELECTRON, 'cleanup')
  for (const cleanup of cleanups.reverse()) cleanup()
  const dir = process.env['SPIKE_REPORT_DIR']
  if (!dir) return
  const file = path.resolve(
    dir,
    `SP-16-${process.platform}-${process.env['SP16_LEG'] ?? 'default'}.json`
  )
  mkdirSync(path.dirname(file), { recursive: true })
  const report = {
    spike: 'SP-16',
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    leg: process.env['SP16_LEG'] ?? 'default',
    secretServiceRequired: process.env['SP16_REQUIRE_SECRET_SERVICE'] === '1',
    backendUp,
    runs
  }
  writeFileSync(file, `${scrub(JSON.stringify(report, null, 2))}\n`)
}, PROBE_TIMEOUT_MS)

describe('SP-16: @napi-rs/keyring under ELECTRON_RUN_AS_NODE (ADR-017 item 2)', () => {
  it.runIf(process.platform === 'linux' && process.env['SP16_REQUIRE_SECRET_SERVICE'] === '1')(
    '[SP-16] the Secret Service this leg started answers',
    () => {
      expect(backendUp, 'a Secret Service answers on the session bus').toBe(true)
    }
  )

  it.runIf(backendUp)(
    '[SP-16, ADR-017] the library loads in the Electron binary and sets, reads, lists and deletes an entry',
    () => {
      expectRoundTrip(probe('electron', ELECTRON, 'roundtrip'))
    },
    PROBE_TIMEOUT_MS
  )

  it.runIf(process.platform === 'linux')(
    '[SP-16, ADR-017, FM-115] on Linux without a Secret Service an entry pinned to it is refused as unavailable',
    () => {
      const run = probe('electron-no-secret-service', ELECTRON, 'expect-unavailable', {
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(tmpdir(), 'dwarfai-sp16-no-such-bus')}`
      })
      expect(
        run.report,
        `the probe printed its report (stderr: ${run.stderr ?? 'none'})`
      ).not.toBeNull()
      expect(run.report?.runAsNode).toBe(true)
      expect(run.report?.checks).toMatchObject({
        pinnedSetRejected: true,
        pinnedErrorIsUnavailable: true,
        pinnedReadRejectedOrNull: true
      })
    },
    PROBE_TIMEOUT_MS
  )

  it.runIf(backendUp && copyWanted)(
    '[SP-16, SP-03] the library loads from a copy of the Electron runtime, as the Host versioned copy holds it',
    () => {
      const work = mkdtempSync(path.join(tmpdir(), 'dwarfai-sp16-copy-'))
      cleanups.push(() => rmSync(work, { recursive: true, force: true }))
      // macOS: the whole Electron.app bundle, symlinks kept; elsewhere the folder holding the executable.
      const source =
        process.platform === 'darwin'
          ? path.resolve(ELECTRON, '..', '..', '..')
          : path.dirname(ELECTRON)
      const target = path.join(work, path.basename(source))
      cpSync(source, target, { recursive: true, verbatimSymlinks: true })
      const copiedExe = path.join(target, path.relative(source, ELECTRON))

      expectRoundTrip(probe('electron-copy', copiedExe, 'roundtrip'))

      // Recorded, not asserted: an entry the original runtime wrote, read by the copy (a Keychain prompt on macOS
      // would show as a timeout or an error here), then removed by the original.
      const value = randomBytes(24).toString('base64url')
      probe('cross-copy-write', ELECTRON, 'write', { SP16_VALUE: value })
      probe('cross-copy-read', copiedExe, 'read', { SP16_VALUE: value }, CROSS_COPY_TIMEOUT_MS)
      probe('cross-copy-remove', ELECTRON, 'remove')
    },
    PROBE_TIMEOUT_MS * 5
  )
})
