// The launcher built from its Node adapters: what UI main's composition root wires (later:
// ISSUE-056 switches it on; ISSUE-051's HostClient calls it). It resolves the endpoint by the
// ADR-002 D2 rule, probes it with `hello` over `node:net`, holds the spawn gate in
// `<hostDataDir>/run/spawn.gate`, and starts the Host with the per-OS spawner (windows.ts on
// Windows, with the launch helper loaded from `prebuildsDir`; posix.ts elsewhere). An endpoint that cannot be named (no SID, a socket path over the
// `sun_path` limit) is `spawn-failed` before anything is spawned. The Host starts from its versioned
// copy under the per-OS root of ADR-002 D5 (versionedCopy.ts), made from the directory holding the
// app executable and checked against the build's `host-manifest.json`; the old copies are collected
// right after (versionedCopyGc.ts).
//
// createNodeUpgradePorts gives the upgrade handshake (upgradeFlow.ts; ADR-002 D8) the same endpoint
// and copy root: a `ui` link to the running Host (hostLink.ts) and this UI's versioned copy, made or
// reused with the spawn gate held, as the `host.upgrade.request` target.
//
// createNodeHostConnection gives HostClient (ISSUE-051) the same endpoint: `connect` resolves it by
// the ADR-002 D2 rule on each call (the SID query runs here, the one UI path allowed to start a
// process, R17) and opens it over `node:net`; `readToken` reads `<hostDataDir>/run/ui.token` for one
// `hello` and keeps nothing.
//
// createNodeHungHostEnder is the hung-Host end of ADR-002 D9 steps 2 and 4 (hungHost.ts; ISSUE-052): it reads
// `<hostDataDir>/run/host.identity`, matches it by the ADR-014 item 2 rule with this machine's boot id (bootId.ts) and
// the pid's start time (processStart.ts), and ends that one process with `process.kill`.
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  HOST_IDENTITY_FILE,
  hostIdentityRecordSchema,
  PROTOCOL_VERSION,
  type HostEndpoint
} from '@dwarfai/contracts'
import type { UiLog } from '../diagnostics/uiLogger'
import { createBootIdReader } from './bootId'
import { createCopyPreparer } from './copyPreparer'
import { resolveUiEndpoint } from './endpointFacts'
import { NodeGateFiles } from './gateFiles'
import { createHelloProber } from './helloProber'
import { createHostLinkOpener } from './hostLink'
import { endHungHost, type HungHostEnd, type HungHostPorts } from './hungHost'
import { createHostLauncher, type HostLauncher } from './launcher'
import type { HostSpawner, ProcessStart } from './ports'
import { createPosixSpawner } from './posix'
import { createIdentityProbe, createProcessStartReader, type QueryRunner } from './processStart'
import { SpawnGate } from './spawnGate'
import { copySourceOf, ensureVersionedCopy, nodeCopyOps, versionedCopyRoot } from './versionedCopy'
import type { HostAttach, UpgradeFlowDeps } from './upgradeFlow'
import { loadWinLaunch } from './win-launch/nativeWinLaunch'
import { createWindowsSpawner } from './windows'

/** The Host's run folder and the files the launcher reads or writes there. */
export const RUN_DIR = 'run'
export const SPAWN_GATE_FILE = 'spawn.gate'
/** Written by the Host after its bind (ISSUE-023); read for the probe's hello. */
export const UI_TOKEN_FILE = 'ui.token'

/** How long one connect may take before the endpoint counts as unreachable. */
export const CONNECT_TIMEOUT_MS = 1_000

export interface NodeHostLauncherOptions {
  /** `<userData>/host` (ADR-002 D2). */
  hostDataDir: string
  /** The app executable; the Host runs the copy of it in its versioned copy (ADR-002 D5). */
  execPath: string
  /**
   * This build's `host-manifest.json` (ADR-002 D5), describing the directory the copy is made from:
   * written by scripts/build/write-host-manifest.mjs for development and test builds, by the
   * packaging job for packaged ones (later: ISSUE-270).
   */
  hostManifest: string
  /** The Host entry script (`out/host/main.js`). */
  hostEntry: string
  /**
   * Windows: the folder holding `win32-<arch>/dwarfai_win_launch.node`, the launch helper that
   * starts the Host with job breakaway (`winLaunchPrebuildsDir(appRoot)`). Unused elsewhere.
   */
  prebuildsDir: string
  log: UiLog
  /** This UI build, as `hello.client` describes it. */
  client: { appVersion: string; buildId: string }
  /** The UI's environment; default `process.env`. */
  uiEnv?: Readonly<Record<string, string | undefined>>
  /** The endpoint to use instead of the ADR-002 D2 rule (OS-lane tests bind a private one). */
  endpoint?: HostEndpoint
  /** The copy root to use instead of the ADR-002 D5 one (OS-lane tests use a temporary folder). */
  copyRoot?: string
  /**
   * The protocol version the upgrade handshake's hello carries instead of this build's (OS-lane
   * tests stand in for a newer or an older UI build, ISSUE-032).
   */
  protocolVersion?: number
}

export function createNodeHostLauncher(options: NodeHostLauncherOptions): HostLauncher {
  const platform = thisPlatform()
  const uiEnv = options.uiEnv ?? process.env
  const runQuery = createQueryRunner()
  const runDir = join(options.hostDataDir, RUN_DIR)
  const readStart = createProcessStartReader({ platform, runQuery, env: uiEnv })
  const spawner: HostSpawner =
    platform === 'win32'
      ? createWindowsSpawner({
          loadHelper: () => loadWinLaunch({ prebuildsDir: options.prebuildsDir })
        })
      : createPosixSpawner()
  const prepareCopy = createCopyPreparer({
    execPath: options.execPath,
    hostManifest: options.hostManifest,
    appVersion: options.client.appVersion,
    platform,
    uiEnv,
    ...(options.copyRoot === undefined ? {} : { copyRoot: options.copyRoot }),
    log: options.log
  })
  const resolveEndpoint = async () =>
    options.endpoint === undefined
      ? resolveUiEndpoint({ platform, hostDataDir: options.hostDataDir, env: uiEnv, runQuery })
      : { ok: true as const, value: options.endpoint }

  return {
    async ensureHostRunning() {
      const endpoint = await resolveEndpoint()
      if (!endpoint.ok) {
        options.log.record({
          level: 'error',
          event: 'host.spawn',
          subsystem: 'host-launcher',
          outcome: 'failed',
          causeClass: 'spawn-failed',
          errCode: `ENDPOINT_${endpoint.error.kind}`
        })
        return { unavailable: 'spawn-failed' }
      }
      const path = endpoint.value.path
      const launcher = createHostLauncher({
        probe: createHelloProber({
          connect: () => connectTo(path),
          tokenFile: join(runDir, UI_TOKEN_FILE),
          protocolVersion: PROTOCOL_VERSION,
          client: { ...options.client, pid: process.pid }
        }),
        gate: spawnGateIn(runDir, readStart),
        spawner,
        prepareCopy,
        host: {
          execPath: options.execPath,
          hostEntry: options.hostEntry,
          hostDataDir: options.hostDataDir,
          uiEnv
        },
        clock: { now: Date.now },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        log: options.log
      })
      return launcher.ensureHostRunning()
    }
  }
}

/** HostClient's connection to the launcher's endpoint (ADR-002 D2; ADR-003 items 1, 3). */
export interface NodeHostConnection {
  /** Opens one connection to the Host's UI endpoint; rejects when nothing listens. */
  connect(): Promise<import('node:net').Socket>
  /** The uiToken of `<hostDataDir>/run/ui.token`, read for one `hello`. */
  readToken(): Promise<string>
}

export function createNodeHostConnection(
  options: Pick<NodeHostLauncherOptions, 'hostDataDir' | 'uiEnv' | 'endpoint'> & {
    /** The user's home folder the macOS endpoint is named under; default `os.homedir()`. */
    home?: string
  }
): NodeHostConnection {
  const platform = thisPlatform()
  const uiEnv = options.uiEnv ?? process.env
  const runQuery = createQueryRunner()
  return {
    async connect() {
      const endpoint =
        options.endpoint === undefined
          ? await resolveUiEndpoint({
              platform,
              hostDataDir: options.hostDataDir,
              env: uiEnv,
              runQuery,
              ...(options.home === undefined ? {} : { home: options.home })
            })
          : { ok: true as const, value: options.endpoint }
      if (!endpoint.ok) throw new Error(`no endpoint: ${endpoint.error.kind}`)
      return connectTo(endpoint.value.path)
    },
    readToken: () => readFile(join(options.hostDataDir, RUN_DIR, UI_TOKEN_FILE), 'utf8')
  }
}

/** The upgrade handshake's two Node ports (upgradeFlow.ts), on the launcher's endpoint and copy root. */
export interface NodeUpgradePorts {
  attach: UpgradeFlowDeps['attach']
  prepareTarget: UpgradeFlowDeps['prepareTarget']
}

export function createNodeUpgradePorts(options: NodeHostLauncherOptions): NodeUpgradePorts {
  const platform = thisPlatform()
  const uiEnv = options.uiEnv ?? process.env
  const runQuery = createQueryRunner()
  const runDir = join(options.hostDataDir, RUN_DIR)
  const readStart = createProcessStartReader({ platform, runQuery, env: uiEnv })
  return {
    async attach(generation): Promise<HostAttach> {
      const endpoint =
        options.endpoint === undefined
          ? await resolveUiEndpoint({
              platform,
              hostDataDir: options.hostDataDir,
              env: uiEnv,
              runQuery
            })
          : { ok: true as const, value: options.endpoint }
      if (!endpoint.ok) return { kind: 'unreachable' }
      const path = endpoint.value.path
      return createHostLinkOpener({
        connect: () => connectTo(path),
        tokenFile: join(runDir, UI_TOKEN_FILE),
        protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
        client: { ...options.client, pid: process.pid }
      })(generation)
    },
    // No other launcher copies while the gate is held (versionedCopy.ts); the running Host keeps
    // its own copy, which is never collected here.
    async prepareTarget() {
      const root =
        options.copyRoot === undefined
          ? versionedCopyRoot({ platform, env: uiEnv, homeDir: homedir() })
          : { ok: true as const, value: options.copyRoot }
      if (!root.ok) return root
      const gate = spawnGateIn(runDir, readStart)
      if ((await gate.take()) === 'held') return { ok: false, errCode: 'SPAWN_GATE_HELD' }
      try {
        const copy = await ensureVersionedCopy({
          version: options.client.appVersion,
          sourceDir: copySourceOf(options.execPath, platform),
          manifestPath: options.hostManifest,
          root: root.value,
          platform,
          pid: process.pid,
          ops: nodeCopyOps,
          log: options.log,
          clock: { now: Date.now }
        })
        if (!copy.ok) return copy
        return { ok: true, targetVersion: options.client.appVersion, targetDir: copy.copyDir }
      } finally {
        await gate.release()
      }
    }
  }
}

/** The spawn gate `<hostDataDir>/run/spawn.gate` (ADR-002 D3), held by this UI process. */
function spawnGateIn(
  runDir: string,
  readStart: ReturnType<typeof createProcessStartReader>
): SpawnGate {
  const self = async (): Promise<ProcessStart> => {
    const start = await readStart(process.pid)
    return {
      pid: process.pid,
      processStartTimeMs: start.kind === 'started' ? start.ms : Math.round(performance.timeOrigin)
    }
  }
  return new SpawnGate({
    files: new NodeGateFiles(join(runDir, SPAWN_GATE_FILE)),
    probe: createIdentityProbe(readStart),
    clock: { now: Date.now },
    self
  })
}

function connectTo(path: string): Promise<import('node:net').Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('connect timed out'))
    }, CONNECT_TIMEOUT_MS)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.off('error', onError)
      resolve(socket)
    })
    const onError = (error: Error): void => {
      clearTimeout(timer)
      reject(error)
    }
    socket.once('error', onError)
  })
}

/** The hung-Host end of ADR-002 D9 steps 2 and 4 over the Host's identity file (hungHost.ts). */
export interface NodeHungHostEnder {
  endHungHost(): Promise<HungHostEnd>
}

export function createNodeHungHostEnder(
  options: Pick<NodeHostLauncherOptions, 'hostDataDir' | 'uiEnv'>
): NodeHungHostEnder {
  const platform = thisPlatform()
  const uiEnv = options.uiEnv ?? process.env
  const runQuery = createQueryRunner()
  const identityFile = join(options.hostDataDir, RUN_DIR, HOST_IDENTITY_FILE)
  const ports: HungHostPorts = {
    platform,
    async readIdentity() {
      try {
        const parsed = hostIdentityRecordSchema.safeParse(
          JSON.parse(await readFile(identityFile, 'utf8'))
        )
        return parsed.success ? parsed.data : null
      } catch {
        return null
      }
    },
    currentBootId: createBootIdReader({ platform, runQuery, env: uiEnv }),
    readStart: createProcessStartReader({ platform, runQuery, env: uiEnv }),
    // That one pid (the schema allows only a positive one, so never a process group); on Windows `process.kill` is
    // TerminateProcess whatever the signal.
    signal(pid, signal) {
      try {
        process.kill(pid, signal)
        return 'sent'
      } catch (error) {
        const code = (error as { code?: unknown }).code
        return code === 'ESRCH' ? 'gone' : code === 'EPERM' ? 'access-denied' : 'failed'
      }
    },
    isAlive(pid) {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return (error as { code?: unknown }).code === 'EPERM'
      }
    },
    clock: { now: Date.now },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
  return { endHungHost: () => endHungHost(ports) }
}

/** One OS query as an argv array, never through a shell, killed at its timeout. */
function createQueryRunner(): QueryRunner {
  return (file, args, { timeoutMs, env }) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        {
          timeout: timeoutMs,
          windowsHide: true,
          shell: false,
          encoding: 'utf8',
          ...(env === undefined ? {} : { env: { ...process.env, ...env } })
        },
        (error, stdout) => {
          if (error === null) resolve({ ok: true, stdout })
          else if (error.killed === true)
            resolve({ ok: false, cause: `timed out after ${timeoutMs} ms` })
          else if (typeof error.code === 'number')
            resolve({
              ok: false,
              cause: `exited with code ${error.code}`,
              code: error.code,
              stdout
            })
          else resolve({ ok: false, cause: `could not start (${String(error.code)})` })
        }
      )
    })
}

function thisPlatform(): 'win32' | 'darwin' | 'linux' {
  return process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'
}
