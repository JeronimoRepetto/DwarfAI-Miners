import { describe, expect, it } from 'vitest'
import type { DwarfId, HostFrameData, HostFrameName } from '@dwarfai/contracts'
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
import type { ResponseFrame } from '../../transport/dispatcher'
import { createUpgradeDrain } from '../../transport/lifecycle/drain'
import { HostStateHolder } from '../../transport/lifecycle/hostState'
import { createUpgradeTargetRule } from '../../transport/methods/hostUpgradeRequest'
import type { ChannelRole } from '../../transport/roles'
import { runBoot } from '../boot'
import { createBootSteps } from '../bootSteps'
import { createHostDispatcher } from '../hostDispatcher'
import { emptyDrainGate } from '../emptyDrainGate'
import { composeHostLifecycle } from '../hostLifecycle'

// L2 flow (17 §1.2): Stop everything and quit on a booted Host, through the production Dispatcher
// (createHostDispatcher) and the composed lifecycle, with faked transport clients and every port
// faked (UC-023; ADR-002 D7 steps 3–4; 07 S12.11, S12.12, S12.21; 06 INV-120, INV-121).

const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const ENDED_DWARF = '01890a5d-ac96-774b-bcce-b302099a8061' as DwarfId
const FAILED_DWARF = '01890a5d-ac96-774b-bcce-b302099a8062' as DwarfId

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

/** A Host booted to `ready`, serving the production Dispatcher with `stopAll` bound. */
async function readyHost(stopAll: RecordingStopAll, journal: string[]) {
  const log = new RecordingDiagnosticsLog()
  const clock = new FakeClock(1_790_000_000_000)
  const scheduler = new FakeScheduler(clock)
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  const processControl = new FakeProcessControl()
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
  // AMENDED for ISSUE-025 (was: no `connections`, no `epoch`): the Host dispatcher also serves
  // `events.subscribe`, which reads the calling connection's frame delivery and the boot epoch.
  const dispatcher = createHostDispatcher({
    log,
    clock,
    scheduler,
    state: () => state.current().state,
    stopAll,
    lifecycle,
    connections,
    epoch: 'epoch-0029',
    // AMENDED for ISSUE-032 (was: stopAll and lifecycle only): main also binds the upgrade drain
    // and the targetDir rule, which these stop-all cases never reach.
    drain: createUpgradeDrain({ gate: emptyDrainGate, state, scheduler, lifecycle, log }),
    upgradeTarget: createUpgradeTargetRule({
      platform: 'linux',
      root: null,
      realpath: () => {
        throw new Error('no copy root in this case')
      }
    })
  })
  const outcome = await runBoot(
    (paths) =>
      createBootSteps({
        paths,
        clock,
        scheduler,
        ids: new SequenceIdGenerator(),
        fs: new FakeFs(),
        processControl,
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

  /** `host.shutdown {stop-all}` from a `ui` connection; the `res` is journaled as it is written. */
  const stopEverything = async (): Promise<ResponseFrame> => {
    const res = await dispatcher.dispatch(
      { id: 'r1', method: 'host.shutdown', params: { mode: 'stop-all', requestId: REQUEST_ID } },
      { role: 'ui', clientId: ui.clientId },
      () => journal.push('ui:res')
    )
    // The clean exit's remaining steps (endAll, endpoint close, exit) settle on later ticks.
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    return res
  }

  return { log, state, exits, endpoint, processControl, ui, notifier, stopEverything }
}

describe('Stop everything and quit (UC-023; ADR-002 D7)', () => {
  it('[S12.11, S12.12, INV-121] stop-all with no owned session answers ended [] and failed [], then closes cleanly with reason stop-all', async () => {
    const journal: string[] = []
    const host = await readyHost(new RecordingStopAll({ journal }), journal)

    const res = await host.stopEverything()

    expect(res).toEqual({
      type: 'res',
      id: 'r1',
      ok: true,
      result: { mode: 'stop-all', outcome: { ended: [], failed: [] } }
    })
    expect(journal).toEqual([
      `stopAll:${REQUEST_ID}`,
      'ui:res',
      'checkpoint.flush',
      'checkpoint.markClean:stop-all',
      'ui:host.closing',
      'notifier:host.closing',
      'ui:end',
      'notifier:end',
      'endpoint.close',
      'exit:0'
    ])
    const closing = { name: 'host.closing', data: { reason: 'stop-all', clean: true } }
    expect(host.ui.frames).toEqual([closing])
    expect(host.notifier.frames).toEqual([closing])
    expect(host.exits).toEqual([0])
    expect(host.log.byEvent('host.stop-all')).toEqual([
      expect.objectContaining({ level: 'info', subsystem: 'host', outcome: 'ok', count: 0 })
    ])
    expect(host.log.byEvent('host.exit')).toEqual([
      expect.objectContaining({ causeClass: 'stop-all' })
    ])
  })

  it('[S12.21, INV-121] with a StopAllPort fake that reports a failed dwarf, the Host answers the outcome and keeps running (no host.closing, still ready)', async () => {
    const journal: string[] = []
    const stopAll = new RecordingStopAll({
      owned: [ENDED_DWARF, FAILED_DWARF],
      failing: [FAILED_DWARF],
      journal
    })
    const host = await readyHost(stopAll, journal)

    const res = await host.stopEverything()

    expect(res).toEqual({
      type: 'res',
      id: 'r1',
      ok: true,
      result: { mode: 'stop-all', outcome: { ended: [ENDED_DWARF], failed: [FAILED_DWARF] } }
    })
    expect(journal).toEqual([`stopAll:${REQUEST_ID}`, 'ui:res'])
    expect(host.ui.frames).toEqual([])
    expect(host.notifier.frames).toEqual([])
    expect(host.ui.ended || host.notifier.ended).toBe(false)
    expect(host.endpoint.closed).toBe(false)
    expect(host.exits).toEqual([])
    expect(host.state.current()).toEqual({ state: 'ready', jobStatus: 'n/a' })
    // 19 §9.1: the counts, and each failed dwarfId (S12.21); never content.
    expect(host.log.byEvent('host.stop-all')).toEqual([
      expect.objectContaining({
        level: 'warn',
        outcome: 'failed',
        count: 1,
        requestId: REQUEST_ID
      }),
      expect.objectContaining({ level: 'warn', outcome: 'failed', dwarfId: FAILED_DWARF })
    ])
  })

  it('[INV-120] the Host never calls anything that signals an observed session during stop-all', async () => {
    const journal: string[] = []
    const stopAll = new RecordingStopAll({ owned: [ENDED_DWARF], journal })
    const host = await readyHost(stopAll, journal)

    await host.stopEverything()

    // The only end asked for is the StopAllPort's, which owns only owned sessions; the Host
    // itself signals no process and starts none.
    expect(stopAll.calls).toEqual([REQUEST_ID])
    expect(host.processControl.signals).toEqual([])
    expect(host.processControl.spawns).toEqual([])
    expect(host.exits).toEqual([0])
  })
})
