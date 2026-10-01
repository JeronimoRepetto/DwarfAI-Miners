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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
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
    copyRoot: shared.copyRoot,
    protocolVersion: build.protocolVersion,
    // AMENDED for the Windows launcher fix (#1120): the in-process breakaway helper loads from prebuilds/.
    prebuildsDir: path.join(REPO_ROOT, 'prebuilds')
  })
  return { hostDataDir, endpoint, hostReports, options }
}

function reportsIn(hostDataDir: string): FakeHostReport[] {
  return readdirSync(hostDataDir)
    .filter((name) => /^fake-host-\d+\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(path.join(hostDataDir, name), 'utf8')) as FakeHostReport)
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

/** Ends `pid` and waits until it is gone; true when nothing is left. */
async function endProcess(pid: number): Promise<boolean> {
  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  return exitsWithin(pid, 5_000)
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
  for (const report of reportsIn(hostDataDir)) {
    if (!(await endProcess(report.pid))) survivors.push(report.pid)
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
        expect(await olderLauncher.ensureHostRunning(), JSON.stringify(olderLog.entries)).toBe(
          'spawned'
        )
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

        expect(result, JSON.stringify(log.entries)).toEqual({ kind: 'swapped', ensure: 'spawned' })
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
        expect(oldReport?.requests).toEqual(['host.upgrade.request'])
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
        expect(await newerLauncher.ensureHostRunning(), JSON.stringify(newerLog.entries)).toBe(
          'spawned'
        )
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
        const result = await runUpgradeFlow({
          build: { ...OLDER, endpointGeneration: 1 },
          attach: ports.attach,
          prepareTarget: ports.prepareTarget,
          ensureHostRunning: () => launcher.ensureHostRunning(),
          // The person confirms Stop everything and quit, the only action offered.
          confirm: (question) => {
            questions.push(question)
            return Promise.resolve(true)
          },
          report: (state) => states.push(state),
          newRequestId: () => REQUEST_ID,
          log
        })

        expect(result, JSON.stringify(log.entries)).toEqual({ kind: 'own-host', ensure: 'spawned' })
        expect(states).toEqual([
          { phase: 'incompatible', hostVersion: '0.0.0' },
          { phase: 'restarting', reason: 'stop-all' }
        ])
        expect(questions).toEqual(['stop-everything'])
        // The newer Host was never asked for an upgrade: only Stop everything and quit.
        expect(await exitsWithin(running.pid, 10_000), 'the newer Host exited').toBe(true)
        const newerReport = reportsIn(world.hostDataDir).find(
          (report) => report.pid === running.pid
        )
        expect(newerReport?.requests).toEqual(['host.shutdown'])
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
