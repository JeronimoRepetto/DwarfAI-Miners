// L8 OS lane (17 §1.8; ADR-002 D5, D8; UC-026; 21 §2.1 item 3, the cut-0 exit cases): the upgrade
// handshake between two builds over this OS's real endpoint — a named pipe on Windows, a Unix socket
// elsewhere — with real processes. The running Host is the stub of fixtures/bin/fake-host (17 §1.8:
// processes under test are stubs) started by the launcher from one build's versioned copy, with
// `serveUpgrade` on so it serves `host.upgrade.request` and `host.shutdown` as the Host's seam does
// (the Host half itself is proven at L6, hostUpgradeRequest.contract.test.ts). The UI half is the
// production code: upgradeFlow over the Node link, the versioned copy and ensureHostRunning.
//
// A "build" here is an app version (its versioned copy's name) and a protocol version: the newer
// test UI is one protocol version above the running Host, the older one below it. Both copies are
// made once, of the Electron runtime this repository installs, in one temporary copy root shared by
// the two cases. Every Host started is ended in the `finally`, and each case checks none is left.
//
// TC-032-01 and TC-032-04 on this OS.
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type HostEndpoint } from '@dwarfai/contracts'
import { RecordingUiLog } from './fakes/RecordingUiLog'
import { buildManifest, serializeManifest } from './hostManifest'
import {
  createNodeHostLauncher,
  createNodeUpgradePorts,
  decideUpgrade,
  runUpgradeFlow,
  type NodeHostLauncherOptions,
  type UpgradeFlowState
} from './index'
import { IDENTITY_TOLERANCE_MS, createProcessStartReader } from './processStart'
import { osQueryRunner, thisPlatform } from './testing/osQueryRunner'
import { copySourceOf, type CopyPlatform } from './versionedCopy'

const WINDOWS = process.platform === 'win32'
const PLATFORM: CopyPlatform =
  process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const FAKE_HOST = path.join(REPO_ROOT, 'fixtures', 'bin', 'fake-host', 'fake-host.cjs')
/** The Electron binary of the installed `electron` package (its main export is the path). */
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string
const OLDER = { appVersion: '0.0.0-os032-older', protocolVersion: PROTOCOL_VERSION }
const NEWER = { appVersion: '0.0.0-os032-newer', protocolVersion: PROTOCOL_VERSION + 1 }
const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const CASE_TIMEOUT_MS = 240_000

interface FakeHostReport {
  pid: number
  execPath: string
  requests: string[]
}

/** The copy root and the build manifest both cases share (the copies are made once). */
const shared = { root: '', copyRoot: '', manifest: '' }

beforeAll(async () => {
  // On POSIX directly under /tmp, so the socket path fits sun_path on macOS.
  shared.root = WINDOWS
    ? mkdtempSync(path.join(tmpdir(), 'dwarfai-032-os-'))
    : mkdtempSync('/tmp/dw032-')
  shared.copyRoot = path.join(shared.root, 'DwarfAI', 'host')
  shared.manifest = path.join(shared.root, 'build', 'host-manifest.json')
  mkdirSync(path.dirname(shared.manifest), { recursive: true })
  const sourceDir = copySourceOf(ELECTRON, PLATFORM)
  writeFileSync(shared.manifest, serializeManifest(await buildManifest(sourceDir)))
}, CASE_TIMEOUT_MS)

afterAll(async () => {
  expect(await removeFolder(shared.root), 'the temporary folder is removed').toBe(true)
}, CASE_TIMEOUT_MS)

/** One case's Host data folder and private endpoint, under the shared temporary folder. */
function newWorld(name: string) {
  const hostDataDir = path.join(shared.root, name, 'userData', 'host')
  mkdirSync(hostDataDir, { recursive: true })
  const endpoint: HostEndpoint = WINDOWS
    ? {
        kind: 'named-pipe',
        path: `\\\\.\\pipe\\dwarfai-test-032-${randomBytes(8).toString('hex')}`
      }
    : {
        kind: 'unix-socket',
        dir: path.join(shared.root, name, 'run'),
        path: path.join(shared.root, name, 'run', 'host-0123456789ab.sock')
      }
  /** What the next Host started reads: its endpoint and the protocol version it reports. */
  const hostReports = (protocolVersion: number): void =>
    writeFileSync(
      path.join(hostDataDir, 'fake-host.json'),
      JSON.stringify({
        endpoint: endpoint.path,
        mode: 'ready',
        maxLifeMs: CASE_TIMEOUT_MS,
        protocolVersion,
        serveUpgrade: true
      })
    )
  const options = (
    build: { appVersion: string; protocolVersion: number },
    log: RecordingUiLog
  ): NodeHostLauncherOptions => ({
    hostDataDir,
    execPath: ELECTRON,
    hostEntry: FAKE_HOST,
    hostManifest: shared.manifest,
    log,
    client: { appVersion: build.appVersion, buildId: 'os-test' },
    endpoint,
    build: 'dev',
    copyRoot: shared.copyRoot,
    protocolVersion: build.protocolVersion,
    // AMENDED for the Windows launcher fix (#1120): the in-process breakaway helper loads from prebuilds/.
    prebuildsDir: path.join(REPO_ROOT, 'prebuilds')
  })
  return { hostDataDir, endpoint, hostReports, options }
}

/**
 * What a failed expectation shows: the UI log, and what each fake Host that failed wrote to
 * `fake-host-errors.log` (the launcher keeps no Host stdio, so its stderr never reaches the test).
 */
function failureContext(hostDataDir: string, log: RecordingUiLog): string {
  const errorsFile = path.join(hostDataDir, 'fake-host-errors.log')
  const errors = existsSync(errorsFile) ? readFileSync(errorsFile, 'utf8') : '(none)'
  return `${JSON.stringify(log.entries)}
fake-host-errors.log: ${errors}`
}

function reportsIn(hostDataDir: string): FakeHostReport[] {
  return readdirSync(hostDataDir)
    .filter((name) => /^fake-host-\d+\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(path.join(hostDataDir, name), 'utf8')) as FakeHostReport)
}

/** Each fake Host's pid and when its report was last written (it was running then). */
function hostRecords(hostDataDir: string): Array<{ pid: number; recordedAtMs: number }> {
  return readdirSync(hostDataDir)
    .filter((name) => /^fake-host-\d+\.json$/.test(name))
    .map((name) => {
      const file = path.join(hostDataDir, name)
      const report = JSON.parse(readFileSync(file, 'utf8')) as FakeHostReport
      return { pid: report.pid, recordedAtMs: statSync(file).mtimeMs }
    })
}

/** Real paths on both sides: on macOS `/var/folders/…` is a link to `/private/var/folders/…` (SP-03). */
function isInside(file: string, folder: string): boolean {
  const real = (target: string): string => {
    try {
      return realpathSync.native(target)
    } catch {
      return path.resolve(target)
    }
  }
  const normalize = (target: string): string => (WINDOWS ? target.toLowerCase() : target)
  const relative = path.relative(normalize(real(folder)), normalize(real(file)))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Waits up to `ms` for `pid` to exit on its own; true once it is gone. */
async function exitsWithin(pid: number, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms && isAlive(pid); waited += 100) await sleep(100)
  return !isAlive(pid)
}

const readStart = createProcessStartReader({ platform: thisPlatform(), runQuery: osQueryRunner() })

/**
 * Whether `pid` is still the process that was running when its record was written at
 * `recordedAtMs` (ADR-014: never a bare pid): it runs and started no later than that, within the
 * one tolerance. A pid that is gone or started later is another process or none.
 */
async function recordedState(
  pid: number,
  recordedAtMs: number
): Promise<'recorded' | 'other' | 'unknown'> {
  const start = await readStart(pid)
  if (start.kind === 'unknown') return 'unknown'
  return start.kind === 'started' && start.ms <= recordedAtMs + IDENTITY_TOLERANCE_MS
    ? 'recorded'
    : 'other'
}

/**
 * Ends `pid` only while it is the recorded process, and waits until it is gone; true when the
 * recorded process is not left running. A pid Windows or the kernel handed to another process is
 * never signalled, and neither is one whose start time cannot be read (that answers false).
 */
async function endProcess(pid: number, recordedAtMs: number): Promise<boolean> {
  const state = await recordedState(pid, recordedAtMs)
  if (state !== 'recorded') return state === 'other'
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
  for (let waited = 0; waited < 5_000 && isAlive(pid); waited += 100) await sleep(100)
  return !isAlive(pid) || (await recordedState(pid, recordedAtMs)) === 'other'
}

/** Removes `dir`, retrying while Windows still holds a just-ended process's files for up to 10 s. */
async function removeFolder(dir: string): Promise<boolean> {
  if (dir === '') return true
  for (let waited = 0; waited <= 10_000; waited += 250) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      await sleep(250)
    }
  }
  return false
}

/** Ends every Host the case started; the case fails if one cannot be ended. */
async function endHosts(hostDataDir: string): Promise<number[]> {
  const survivors: number[] = []
  for (const host of hostRecords(hostDataDir)) {
    if (!(await endProcess(host.pid, host.recordedAtMs))) survivors.push(host.pid)
  }
  return survivors
}

describe('the upgrade handshake between two builds (ADR-002 D8; 21 §2.1 item 3)', () => {
  it(
    '[ADR-002] a higher-version test UI meeting the running cut-0 Host attaches in compat mode, requests the upgrade, the Host drains and the UI starts the new Host from its versioned copy, with no stopped-unexpectedly toast',
    async () => {
      const world = newWorld('newer-ui')
      try {
        // The running Host, started by the older build from its own versioned copy.
        world.hostReports(OLDER.protocolVersion)
        const olderLog = new RecordingUiLog()
        const olderLauncher = createNodeHostLauncher(world.options(OLDER, olderLog))
        expect(
          await olderLauncher.ensureHostRunning(),
          failureContext(world.hostDataDir, olderLog)
        ).toBe('spawned')
        const [running] = reportsIn(world.hostDataDir)
        if (running === undefined) throw new Error('the running Host wrote no report')

        // The newer build attaches; the Host it starts from its copy reports its protocol version.
        world.hostReports(NEWER.protocolVersion)
        const log = new RecordingUiLog()
        const options = world.options(NEWER, log)
        const ports = createNodeUpgradePorts(options)
        const launcher = createNodeHostLauncher(options)
        const states: UpgradeFlowState[] = []
        const questions: string[] = []
        const result = await runUpgradeFlow({
          build: { ...NEWER, endpointGeneration: 1 },
          attach: ports.attach,
          prepareTarget: ports.prepareTarget,
          ensureHostRunning: () => launcher.ensureHostRunning(),
          confirm: (question) => {
            questions.push(question)
            return Promise.resolve(false)
          },
          report: (state) => states.push(state),
          newRequestId: () => REQUEST_ID,
          log
        })

        expect(result, failureContext(world.hostDataDir, log)).toEqual({
          kind: 'swapped',
          ensure: 'spawned'
        })
        // Compat mode, then DwarfAI's own restart: never a lost connection, so nothing that would
        // raise the PO #62 "stopped unexpectedly" toast, and nothing asked of the person.
        expect(states).toEqual([
          { phase: 'compat', hostVersion: '0.0.0' },
          { phase: 'restarting', reason: 'upgrade' }
        ])
        expect(questions).toEqual([])
        // The old Host was asked for the upgrade only, drained and exited on its own.
        expect(await exitsWithin(running.pid, 10_000), 'the drained Host exited').toBe(true)
        const oldReport = reportsIn(world.hostDataDir).find((report) => report.pid === running.pid)
        // AMENDED for ISSUE-051: the link keeps ADR-003 item 9's liveness, so a `ping` may join the methods it
        // sends while it waits; the check is on the handshake's own methods, which are unchanged.
        expect(oldReport?.requests.filter((method) => method !== 'ping')).toEqual([
          'host.upgrade.request'
        ])
        // The new Host runs from the newer build's versioned copy.
        const started = reportsIn(world.hostDataDir).filter((report) => report.pid !== running.pid)
        expect(started).toHaveLength(1)
        expect(
          isInside(started[0]?.execPath ?? '', path.join(shared.copyRoot, NEWER.appVersion)),
          'the new Host runs from host/<newer>/'
        ).toBe(true)
        // And the newer UI now attaches to it normally (no compat mode).
        const again = await ports.attach('current')
        expect(again.kind).toBe('attached')
        if (again.kind === 'attached') {
          expect(
            decideUpgrade(
              { ...NEWER, endpointGeneration: 1 },
              {
                kind: 'hello-ok',
                protocolVersion: again.link.helloOk.protocolVersion,
                endpointGeneration: again.link.helloOk.endpointGeneration,
                hostVersion: again.link.helloOk.hostVersion
              }
            )
          ).toBe('attach')
          again.link.close()
        }
      } finally {
        expect(await endHosts(world.hostDataDir), 'no Host process is left running').toEqual([])
      }
    },
    CASE_TIMEOUT_MS
  )

  it(
    '[ADR-002] an older test UI meeting a newer Host offers only stop-all and then starts its own Host',
    async () => {
      const world = newWorld('older-ui')
      try {
        // The running Host, started by the newer build.
        world.hostReports(NEWER.protocolVersion)
        const newerLog = new RecordingUiLog()
        const newerLauncher = createNodeHostLauncher(world.options(NEWER, newerLog))
        expect(
          await newerLauncher.ensureHostRunning(),
          failureContext(world.hostDataDir, newerLog)
        ).toBe('spawned')
        const [running] = reportsIn(world.hostDataDir)
        if (running === undefined) throw new Error('the running Host wrote no report')

        // The older build (a rollback) attaches; its own Host reports its protocol version.
        world.hostReports(OLDER.protocolVersion)
        const log = new RecordingUiLog()
        const options = world.options(OLDER, log)
        const ports = createNodeUpgradePorts(options)
        const launcher = createNodeHostLauncher(options)
        const states: UpgradeFlowState[] = []
        const questions: string[] = []
        let offered: () => void = () => {}
        const incompatible = new Promise<void>((resolve) => (offered = resolve))
        const flow = runUpgradeFlow({
          build: { ...OLDER, endpointGeneration: 1 },
          attach: ports.attach,
          prepareTarget: ports.prepareTarget,
          ensureHostRunning: () => launcher.ensureHostRunning(),
          confirm: (question) => {
            questions.push(question)
            return Promise.resolve(true)
          },
          report: (state) => {
            states.push(state)
            if (state.phase === 'incompatible') offered()
          },
          newRequestId: () => REQUEST_ID,
          log
        })
        // AMENDED (fix/compose-d8-upgrade, D8 composed into the app): the flow only offers Stop everything and quit;
        // the app's own flow sends it (A-N34 → A-N26 through LegacyEndFirstAdapter, 21 §3; UC-026). The person
        // confirms it: this stand-in sends `host.shutdown {stop-all}` on its own `ui` connection, as that flow does.
        await incompatible
        const stopper = await ports.attach('current')
        if (stopper.kind !== 'attached') throw new Error('the stand-in could not attach')
        const stopped = await stopper.link.call('host.shutdown', {
          mode: 'stop-all',
          requestId: REQUEST_ID
        })
        expect(stopped.ok).toBe(true)
        const result = await flow
        stopper.link.close()

        expect(result, failureContext(world.hostDataDir, log)).toEqual({
          kind: 'own-host',
          ensure: 'spawned'
        })
        expect(states).toEqual([
          { phase: 'incompatible', hostVersion: '0.0.0' },
          { phase: 'restarting', reason: 'stop-all' }
        ])
        expect(questions).toEqual([])
        // The newer Host was never asked for an upgrade: only Stop everything and quit (the stand-in's).
        expect(await exitsWithin(running.pid, 10_000), 'the newer Host exited').toBe(true)
        const newerReport = reportsIn(world.hostDataDir).find(
          (report) => report.pid === running.pid
        )
        // AMENDED for ISSUE-051: the link keeps ADR-003 item 9's liveness, so a `ping` may join the methods it
        // sends while it waits; the check is on the handshake's own methods, which are unchanged.
        expect(newerReport?.requests.filter((method) => method !== 'ping')).toEqual([
          'host.shutdown'
        ])
        // The older UI's own Host runs from the older build's versioned copy.
        const started = reportsIn(world.hostDataDir).filter((report) => report.pid !== running.pid)
        expect(started).toHaveLength(1)
        expect(
          isInside(started[0]?.execPath ?? '', path.join(shared.copyRoot, OLDER.appVersion)),
          'its own Host runs from host/<older>/'
        ).toBe(true)
      } finally {
        expect(await endHosts(world.hostDataDir), 'no Host process is left running').toEqual([])
      }
    },
    CASE_TIMEOUT_MS
  )
})
