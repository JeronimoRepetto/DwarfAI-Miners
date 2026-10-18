// layer: L3
// The SessionStarter bridge's delegation half (16 §5.3 as AMENDMENT-14 A14-02 gives it; ADR-013
// items 3-4; INV-80; ISSUE-209): before the driver starts, the bridge asks
// `DelegationLifecycle.issueFor` with the launch id, the driver's declared `mcpInjection` and the
// launch's "Let Jev choose" gate, and puts only a non-null entry in `DriverLaunchRequest.delegation`;
// a start that fails after an issue revokes it (`revokeLaunch`). The driver is the scripted one of
// the launching contract run, behind a registry that keeps every request it was handed.
import { describe, expect, it } from 'vitest'
import type { FolderPath, LaunchId, ProviderId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import type { DelegationLifecycle } from '../../modules/delegation'
import { EARLY_FAILURE_WINDOW_MS, type StartResult } from '../../modules/launching'
import { ScriptedDriver } from '../../modules/launching/testing/ScriptedDriver'
import type {
  DelegationInjection,
  DriverLaunchRequest,
  DriverRegistry,
  ProviderCapabilities
} from '../../modules/suppliers'
import { createSessionStarter } from './sessionStarter'

const PROVIDER = 'claude' as ProviderId
const LAUNCH = '01890a5d-ac96-774b-bcce-b30220900001' as LaunchId

const ENTRY: DelegationInjection = {
  mechanism: 'ticket-file',
  relay: { program: '/opt/dwarfai/DwarfAI-Miners', args: ['/opt/dwarfai/out/host/relay.js'] },
  credentialFilePath: `/data/run/mcp/${LAUNCH}.cred`
}

function request(): DriverLaunchRequest {
  return {
    launchId: LAUNCH,
    install: {
      providerId: PROVIDER,
      binaryPath: '/opt/tools/claude',
      version: '2.1.301',
      resolvedVia: 'path',
      statMtimeMs: 0
    },
    cwd: '/work/mine-one' as FolderPath,
    prompt: 'Survey the north seam',
    permissionMode: null,
    delegation: null,
    spawnTag: `v1:install-209:${LAUNCH}:epoch-209`,
    onSpawned: async () => undefined
  }
}

/** A `DelegationLifecycle` double: issues `ENTRY` only when both gates and the mechanism allow it. */
class RecordingLifecycle implements Pick<DelegationLifecycle, 'issueFor' | 'revokeLaunch'> {
  readonly asked: Array<Parameters<DelegationLifecycle['issueFor']>[0]> = []
  readonly revoked: LaunchId[] = []

  constructor(private readonly delegationOn: boolean) {}

  issueFor(
    launch: Parameters<DelegationLifecycle['issueFor']>[0]
  ): Promise<DelegationInjection | null> {
    this.asked.push(launch)
    const gated =
      this.delegationOn && launch.launchedWithLetJevChoose && launch.mechanism === 'ticket-file'
    return Promise.resolve(gated ? ENTRY : null)
  }

  revokeLaunch(launchId: LaunchId): Promise<void> {
    this.revoked.push(launchId)
    return Promise.resolve()
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

async function advance(clock: FakeClock, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 10) {
    clock.advance(Math.min(10, left))
    await flush()
  }
}

function arrange(options: {
  delegationOn: boolean
  mechanism?: ProviderCapabilities['mcpInjection']
}) {
  const clock = new FakeClock(1_790_000_000_000)
  const scheduler = new FakeScheduler(clock)
  const scripted = new ScriptedDriver({
    providerId: PROVIDER,
    label: 'Claude Code',
    clock,
    scheduler
  })
  const requests: DriverLaunchRequest[] = []
  const registry: DriverRegistry = {
    drivers: (id) =>
      scripted.registry.drivers(id).map((driver) => ({
        ...driver,
        launch: (req: DriverLaunchRequest) => {
          requests.push(req)
          return driver.launch(req)
        }
      }))
  }
  const lifecycle = new RecordingLifecycle(options.delegationOn)
  const starter = createSessionStarter({
    registry,
    sessions: scripted.sessions,
    clock,
    scheduler,
    delegation: {
      lifecycle,
      mechanismOf: () => options.mechanism ?? 'ticket-file'
    }
  })
  const start = (letJevChoose: boolean): (() => StartResult | undefined) => {
    let result: StartResult | undefined
    void starter
      .start(PROVIDER, request(), { launchedWithLetJevChoose: letJevChoose })
      .then((value) => {
        result = value
      })
    return () => result
  }
  return { clock, scripted, requests, lifecycle, start }
}

describe('the SessionStarter bridge and the delegation gates (ISSUE-209)', () => {
  it('[INV-80] the bridge asks issueFor with the launch gate and the driver mechanism, and starts with no entry when it answers none', async () => {
    const off = arrange({ delegationOn: false })
    off.start(true)
    const notJev = arrange({ delegationOn: true })
    notJev.start(false)
    const noInjection = arrange({ delegationOn: true, mechanism: 'none' })
    noInjection.start(true)
    for (const s of [off, notJev, noInjection]) await advance(s.clock, 100)

    // `issueFor` is asked every time, with the launch's own gate and the driver's mechanism ...
    expect(off.lifecycle.asked).toEqual([
      { launchId: LAUNCH, mechanism: 'ticket-file', launchedWithLetJevChoose: true }
    ])
    expect(notJev.lifecycle.asked).toEqual([
      { launchId: LAUNCH, mechanism: 'ticket-file', launchedWithLetJevChoose: false }
    ])
    expect(noInjection.lifecycle.asked).toEqual([
      { launchId: LAUNCH, mechanism: 'none', launchedWithLetJevChoose: true }
    ])
    // ... and its null reaches the driver as no entry at all.
    for (const s of [off, notJev, noInjection]) {
      expect(s.requests.map((req) => req.delegation)).toEqual([null])
    }
  })

  it('[ADR-013, INV-80] a gated launch is started with the entry issueFor gave, issued before the driver starts', async () => {
    const s = arrange({ delegationOn: true })
    const result = s.start(true)
    await advance(s.clock, EARLY_FAILURE_WINDOW_MS + 100)

    expect(s.requests.map((req) => req.delegation)).toEqual([ENTRY])
    expect(result()?.ok).toBe(true)
    expect(s.lifecycle.revoked).toEqual([])
  })

  it('[ADR-013, INV-83] a gated launch that fails to start has its relay entry revoked', async () => {
    const s = arrange({ delegationOn: true })
    s.scripted.arrange({ kind: 'rejects', cause: 'could-not-start' })
    const result = s.start(true)
    await advance(s.clock, 100)

    expect(result()).toMatchObject({ ok: false, error: { cause: 'could-not-start' } })
    expect(s.lifecycle.revoked).toEqual([LAUNCH])
  })

  it('[ADR-013] an ungated launch that fails to start revokes nothing: it was issued nothing', async () => {
    const s = arrange({ delegationOn: false })
    s.scripted.arrange({ kind: 'rejects', cause: 'could-not-start' })
    s.start(true)
    await advance(s.clock, 100)

    expect(s.lifecycle.revoked).toEqual([])
  })
})
