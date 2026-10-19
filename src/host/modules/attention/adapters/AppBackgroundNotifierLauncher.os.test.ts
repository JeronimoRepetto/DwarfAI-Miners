// L8 OS lane (17 §1.8): `AppBackgroundNotifierLauncher` over this OS's real `NodeProcessControl`
// and the real UI endpoint (a named pipe on Windows, a Unix socket elsewhere; ISSUE-022). It starts
// the app-background stub (fixtures/bin/app-background-stub, never the real app or a provider CLI)
// with `--background`; the stub attaches as `notifier` with the UI token, and the launcher learns it
// from the connection registry, as ISSUE-119 wires it. ADR-018 item 5; R17; 07 S12.C02–S12.C04.
// Runs only in `pnpm test:os`.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { NodeScheduler } from '../../../platform/clock/NodeScheduler'
import { createNativeOwnerOnlyPipe } from '../../../platform/endpoint/win-pipe/nativeOwnerOnlyPipe'
import { NodeProcessControl } from '../../../platform/process/NodeProcessControl'
import { HelloThrottle } from '../../../transport/auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../../../transport/auth/uiToken'
import { acceptConnection } from '../../../transport/connection'
import { ConnectionRegistry } from '../../../transport/connectionRegistry'
import { Dispatcher } from '../../../transport/dispatcher'
import { bindEndpoint } from '../../../transport/endpoint/server'
import { HostStateHolder } from '../../../transport/lifecycle/hostState'
import { decideBind } from '../../../wiring/singleInstance'
import { AppBackgroundNotifierLauncher } from './AppBackgroundNotifierLauncher'

const WINDOWS = process.platform === 'win32'
const STUB = fileURLToPath(
  new URL(
    '../../../../../fixtures/bin/app-background-stub/app-background-stub.cjs',
    import.meta.url
  )
)

// An adapter imports no contracts (R9), tests included: the endpoint type is the transport's, and the
// protocol version is the one this test hands the transport as the Host's identity.
type HostEndpoint = Parameters<typeof bindEndpoint>[0]
const PROTOCOL_VERSION = 1

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A fresh folder; on POSIX directly under /tmp so the socket path fits `sun_path` on macOS. */
function caseRoot(): string {
  const root = WINDOWS ? mkdtempSync(join(tmpdir(), 'dwarfai-115-os-')) : mkdtempSync('/tmp/dw115-')
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function endpointUnder(root: string): HostEndpoint {
  if (WINDOWS) {
    const suffix = `${process.pid}-${Math.random().toString(16).slice(2, 10)}`
    return { kind: 'named-pipe', path: `\\\\.\\pipe\\dwarfai-test-115-${suffix}` }
  }
  // `/tmp/dw115-XXXXXX/run/host-<12 hex>.sock`: well inside macOS's 104-byte `sun_path`.
  const dir = join(root, 'run')
  return { kind: 'unix-socket', dir, path: join(dir, 'host-0123456789ab.sock') }
}

const scheduler = (): NodeScheduler => new NodeScheduler({ onTaskError: () => {} })

/** Binds `endpoint` with the auth layer attaching each connection to `connections`. */
async function bind(endpoint: HostEndpoint, connections: ConnectionRegistry, runDir: string) {
  const clock = new FakeClock(1_000)
  const log = new RecordingDiagnosticsLog()
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: WINDOWS ? 'none' : 'n/a' })
  const token = new UiToken()
  const outcome = await bindEndpoint(endpoint, {
    log,
    scheduler: scheduler(),
    decide: decideBind,
    probeExisting: () => Promise.resolve('no-hello'),
    // A named pipe is created only by the native owner-only pipe helper (`pnpm build:native`).
    ownerOnlyPipe: createNativeOwnerOnlyPipe({
      prebuildsDir: fileURLToPath(new URL('../../../../../prebuilds', import.meta.url))
    }),
    accept: (connection) =>
      acceptConnection(connection, {
        token,
        ids: new SequenceIdGenerator(),
        identity: { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
        epoch: 'epoch-115',
        state: () => state.current(),
        capabilities: () => [],
        scheduler: scheduler(),
        clock,
        log,
        dispatcher: new Dispatcher({
          log,
          clock,
          scheduler: new FakeScheduler(clock),
          state: () => state.current().state
        }),
        connections,
        throttle: new HelloThrottle(clock)
      })
  })
  if (outcome.kind !== 'bound') throw new Error(`expected a bind, got ${outcome.kind}`)
  await token.issue(runDir)
  return { endpoint: outcome.endpoint, token: readFileSync(join(runDir, UI_TOKEN_FILE), 'utf8') }
}

interface StubReport {
  argv: string[]
  ppid: number
  electronRunAsNode: boolean
  hostDataDir: boolean
}

/** A launcher over the real ProcessControl that starts the stub with `config` and a Host env. */
async function launch(config: Record<string, unknown>) {
  const root = caseRoot()
  const endpoint = endpointUnder(root)
  const connections = new ConnectionRegistry()
  const bound = await bind(endpoint, connections, join(root, 'run'))
  cleanups.push(() => bound.endpoint.close())
  const report = join(root, 'stub-report.json')
  const configFile = join(root, 'stub-config.json')
  writeFileSync(
    configFile,
    JSON.stringify({
      endpoint: endpoint.path,
      token: bound.token,
      protocolVersion: PROTOCOL_VERSION,
      report,
      maxLifeMs: 60_000,
      ...config
    })
  )
  const notifiers: string[] = []
  connections.onAttach((connection) => {
    if (connection.role === 'notifier') notifiers.push(connection.clientId)
  })
  const launcher = new AppBackgroundNotifierLauncher({
    processes: new NodeProcessControl(),
    // The stub is run by this Node, as a development build's Electron runs the app folder.
    paths: { execPath: process.execPath },
    appArgs: [STUB],
    env: {
      ...process.env,
      APP_BACKGROUND_STUB_CONFIG: configFile,
      // What the Host's own environment holds; neither may reach the app.
      ELECTRON_RUN_AS_NODE: '1',
      DWARFAI_HOST_DATA_DIR: join(root, 'host')
    },
    scheduler: scheduler(),
    onNotifierAttach: (listener) =>
      connections.onAttach((connection) => {
        if (connection.role === 'notifier') listener()
      })
  })
  return {
    launcher,
    notifiers,
    report: () => JSON.parse(readFileSync(report, 'utf8')) as StubReport
  }
}

function launcherCases(): void {
  it('[ADR-018] the launcher starts the stub executable with --background and no shell, and the stub attaches as notifier', async () => {
    const { launcher, notifiers, report } = await launch({ mode: 'attach' })

    expect(await launcher.ensureNotifier()).toBe('attached')

    expect(notifiers).toHaveLength(1)
    const seen = report()
    expect(seen.argv).toStrictEqual(['--background'])
    // No shell in between: the stub's parent is this process itself.
    expect(seen.ppid).toBe(process.pid)
    expect(seen.electronRunAsNode).toBe(false)
    expect(seen.hostDataDir).toBe(false)
    // Closing the endpoint (cleanup) closes the stub's connection, and the stub exits.
  })

  it('[ADR-018, S12.C04] a stub that exits before attaching is a failed start', async () => {
    const { launcher, notifiers, report } = await launch({ mode: 'exit', exitCode: 3 })

    expect(await launcher.ensureNotifier()).toBe('spawn-failed')
    expect(notifiers).toStrictEqual([])
    expect(report().argv).toStrictEqual(['--background'])
  })
}

describe.runIf(WINDOWS)('AppBackgroundNotifierLauncher on Windows', launcherCases)
describe.runIf(process.platform === 'darwin')(
  'AppBackgroundNotifierLauncher on macOS',
  launcherCases
)
describe.runIf(process.platform === 'linux')(
  'AppBackgroundNotifierLauncher on Linux',
  launcherCases
)
