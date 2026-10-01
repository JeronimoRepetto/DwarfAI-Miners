import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostFrameData, HostFrameName } from '@dwarfai/contracts'
import { FakeAppPaths } from '../../kernel/fakes/FakeAppPaths'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingShutdownCheckpoint } from '../../kernel/fakes/RecordingShutdownCheckpoint'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { ConnectionRegistry, type AttachedConnection } from '../../transport/connectionRegistry'
import { createUpgradeDrain } from '../../transport/lifecycle/drain'
import { HostStateHolder } from '../../transport/lifecycle/hostState'
import { createUpgradeTargetRule } from '../../transport/methods/hostUpgradeRequest'
import type { ChannelRole } from '../../transport/roles'
import { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { fixedSnapshotMeta } from '../../transport/testing/fixedSnapshotMeta'
import { runBoot } from '../boot'
import { createBootSteps } from '../bootSteps'
import { emptyDrainGate } from '../emptyDrainGate'
import { createHostDispatcher } from '../hostDispatcher'
import { composeHostLifecycle } from '../hostLifecycle'

// L2 flow (17 §1.2): the upgrade handshake's Host half on a booted cut-0 Host, through the
// production Dispatcher (createHostDispatcher), the cut-0 DrainGate binding (emptyDrainGate) and the
// composed lifecycle, with faked transport clients (UC-026; ADR-002 D8 item 2; 07 S12.13–S12.17).
// TC-032-01 (Host half): at cut 0 no session exists, so the drain is immediate.

const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const TARGET_VERSION = '0.21.0'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** A faked transport client: what the registry sent it, and whether it was ended. */
class FakeClient implements AttachedConnection {
  readonly frames: Array<{ name: HostFrameName; data: unknown }> = []
  ended = false

  constructor(
    readonly role: ChannelRole,
    readonly clientId: string,
    private readonly journal: string[]
  ) {}

  send<F extends HostFrameName>(name: F, data: HostFrameData[F]): void {
    this.frames.push({ name, data })
    this.journal.push(`${this.role}:${name}`)
  }

  end(): Promise<void> {
    this.ended = true
    this.journal.push(`${this.role}:end`)
    return Promise.resolve()
  }
}

/** A cut-0 Host booted to `ready`, serving the production Dispatcher as main.ts binds it. */
async function readyHost(journal: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-032-flow-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const copyRoot = join(root, 'DwarfAI', 'host')
  mkdirSync(join(copyRoot, TARGET_VERSION), { recursive: true })
  const log = new RecordingDiagnosticsLog()
  const clock = new FakeClock(1_790_000_000_000)
  const scheduler = new FakeScheduler(clock)
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  const stopAll = new RecordingStopAll({ journal })
  const exits: number[] = []
  const endpoint = {
    closed: false,
    bind: () => Promise.resolve('bound' as const),
    close() {
      this.closed = true
      journal.push('endpoint.close')
      return Promise.resolve()
    }
  }
  const lifecycle = composeHostLifecycle({
    checkpoint: new RecordingShutdownCheckpoint(journal),
    connections,
    endpoint,
    scheduler,
    log,
    sessionEnd: { onSessionEnd: () => {} },
    exit: (code) => {
      exits.push(code)
      journal.push(`exit:${code}`)
    }
  })
  const dispatcher = createHostDispatcher({
    log,
    clock,
    scheduler,
    state: () => state.current().state,
    stopAll,
    lifecycle,
    connections,
    epoch: 'epoch-0032',
    drain: createUpgradeDrain({ gate: emptyDrainGate, state, scheduler, lifecycle, log }),
    upgradeTarget: createUpgradeTargetRule({
      platform:
        process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux',
      root: copyRoot,
      realpath: (target) => realpathSync.native(target)
    }),
    // AMENDED for ISSUE-026 (was: no `ids`, `sections`, `snapshotMeta`): the Host dispatcher also
    // serves `session.snapshot`, which these upgrade cases never call.
    ids: new SequenceIdGenerator(),
    sections: new SectionRegistry(),
    snapshotMeta: fixedSnapshotMeta(() => state.current().state)
  })
  const outcome = await runBoot(
    (paths) =>
      createBootSteps({
        paths,
        clock,
        scheduler,
        ids: new SequenceIdGenerator(),
        fs: new FakeFs(),
        processControl: new FakeProcessControl(),
        log,
        endpoint,
        database: { open: () => Promise.resolve() }
      }),
    {
      log,
      clock,
      state,
      privilege: () =>
        Promise.resolve({ elevated: { ok: true, value: false }, inJob: 'not-applicable' }),
      paths: { ok: true, value: new FakeAppPaths() },
      runtime: { os: 'linux', arch: 'x64', node: '24.18.1' },
      exit: (code) => exits.push(code)
    }
  )
  expect(outcome).toEqual({ kind: 'ready' })
  const ui = new FakeClient('ui', 'window-1', journal)
  const notifier = new FakeClient('notifier', 'tray-1', journal)
  connections.attach(ui)
  connections.attach(notifier)
  return { log, state, exits, stopAll, dispatcher, ui, notifier, copyRoot }
}

describe('the upgrade handshake on a cut-0 Host (UC-026; ADR-002 D8 item 2)', () => {
  it('[ADR-002, S12.13, S12.14, S12.16] the production dispatcher serves host.upgrade.request: with no session the booted Host drains at once and closes with reason upgrade', async () => {
    const journal: string[] = []
    const host = await readyHost(journal)

    const res = await host.dispatcher.dispatch(
      {
        id: 'u1',
        method: 'host.upgrade.request',
        params: {
          targetVersion: TARGET_VERSION,
          targetDir: join(host.copyRoot, TARGET_VERSION),
          requestId: REQUEST_ID
        }
      },
      { role: 'ui', clientId: host.ui.clientId },
      () => journal.push('ui:res')
    )
    // The drain and the clean exit settle on later ticks.
    for (let i = 0; i < 20; i += 1) await Promise.resolve()

    expect(res).toEqual({ type: 'res', id: 'u1', ok: true, result: { state: 'upgrade-pending' } })
    expect(journal).toEqual([
      'ui:host.state',
      'ui:res',
      'checkpoint.flush',
      'checkpoint.markClean:upgrade',
      'ui:host.closing',
      'notifier:host.closing',
      'ui:end',
      'notifier:end',
      'endpoint.close',
      'exit:0'
    ])
    expect(host.ui.frames).toEqual([
      { name: 'host.state', data: { state: 'upgrade-pending', jobStatus: 'n/a' } },
      { name: 'host.closing', data: { reason: 'upgrade', clean: true } }
    ])
    expect(host.stopAll.calls).toEqual([])
    expect(host.exits).toEqual([0])
    expect(host.log.byEvent('host.upgrade').map((entry) => entry.causeClass)).toEqual([
      'upgrade-pending',
      'draining'
    ])
  })
})
