// layer: L2
// L2 (17 §1.2): the tray notifier supervisor — machine 12C (07 §12C) driven by the UI clients that
// attach and detach (fed by the transport connection registry; wired by ISSUE-119), the 2 s wait on
// the kernel Scheduler, and the starts through `NotifierLauncher` (16 §4.11). FakeClock,
// FakeScheduler, FakeNotifierLauncher, RecordingDiagnosticsLog; the real policy behind S12.C03's
// "pending notifications drawn" with RecordingLevel3Sink. ADR-018 item 5; ADR-002 D7 (OQ-63).
import { describe, expect, it } from 'vitest'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { AttentionFact } from '../domain/decideLevel3'
import type { AttentionEvent } from '../domain/events'
import { RESPAWN_WINDOW_MS, TRAY_RESPAWN_DELAY_MS } from '../domain/notifierPresence'
import { FakeAttentionSettings } from '../ports/fakes/FakeAttentionSettings'
import { FakeNotifierLauncher } from '../ports/fakes/FakeNotifierLauncher'
import { InMemoryAttentionLedger } from '../ports/fakes/InMemoryAttentionLedger'
import { RecordingLevel3Sink } from '../ports/fakes/RecordingLevel3Sink'
import { AttentionPolicy } from './attentionPolicy'
import { NotifierSupervisor } from './notifierSupervisor'

const T0 = 1_790_000_000_000
const DWARF = 'dwarf-0001' as DwarfId
const MINE = 'mine-0001' as MineId

const UI = { clientId: 'c-ui', role: 'ui' } as const
const NOTIFIER = { clientId: 'c-notifier', role: 'notifier' } as const
const RESPAWNED = { clientId: 'c-respawned', role: 'notifier' } as const

/** Lets the launcher's settled promise reach the supervisor. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

function world() {
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const launcher = new FakeNotifierLauncher(clock)
  const log = new RecordingDiagnosticsLog()
  const sink = new RecordingLevel3Sink(false)
  const attention = new AttentionPolicy({
    settings: new FakeAttentionSettings(),
    ledger: new InMemoryAttentionLedger(),
    transactions: { inTransaction: (work) => work() },
    bus: new RecordingEventBus<AttentionEvent>(),
    sink,
    clock,
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-0115',
    titles: (kind, name) => `title(${kind}, ${name})`
  })
  const supervisor = new NotifierSupervisor({
    launcher,
    scheduler,
    clock,
    log,
    drawPending: () => attention.notifierAttached()
  })
  // The UI process that started the Host: one window (`ui`) and its tray connection (`notifier`).
  supervisor.clientAttached(UI)
  supervisor.clientAttached(NOTIFIER)
  return { clock, scheduler, launcher, log, sink, attention, supervisor }
}

/** The UI process dies: both of its connections close without a Host exit. */
function uiProcessDies(supervisor: NotifierSupervisor): void {
  supervisor.clientDetached(UI)
  supervisor.clientDetached(NOTIFIER)
}

describe('the tray notifier supervisor (machine 12C; 16 §4.11 NotifierLauncher)', () => {
  it('[ADR-018] a notifier attaching while spawning makes the state attached and pending notifications are sent', async () => {
    const { clock, launcher, sink, attention, supervisor } = world()
    uiProcessDies(supervisor)
    // A question raised while no tray process is attached: decided, not delivered.
    const fact: AttentionFact = {
      key: `${DWARF}:question:ask-1`,
      kind: 'question',
      dwarfId: DWARF,
      mineId: MINE,
      at: T0,
      reannounce: true
    }
    attention.onFact(fact, { displayName: 'Gimli', mineName: 'Moria' })
    expect(sink.calls).toMatchObject([{ call: 'notify', outcome: 'no-ui' }])

    clock.advance(TRAY_RESPAWN_DELAY_MS)
    expect(supervisor.state()).toBe('spawning')

    sink.attached = true
    supervisor.clientAttached(RESPAWNED)
    launcher.settle('attached')
    await flush()

    expect(supervisor.state()).toBe('attached')
    expect(sink.notifiedKeys()).toStrictEqual([fact.key, fact.key])
    expect(sink.calls.at(-1)).toMatchObject({ call: 'notify', outcome: 'delivered' })
  })

  it('[ADR-002, FM-042] giving up logs one warning and the Host keeps running with its sessions', async () => {
    const { clock, launcher, log, supervisor } = world()
    uiProcessDies(supervisor)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      clock.advance(TRAY_RESPAWN_DELAY_MS)
      expect(launcher.unsettled).toBe(1)
      launcher.settle('spawn-failed')
      await flush()
    }

    expect(supervisor.state()).toBe('gave-up')
    expect(launcher.starts).toStrictEqual([
      T0 + TRAY_RESPAWN_DELAY_MS,
      T0 + 2 * TRAY_RESPAWN_DELAY_MS,
      T0 + 3 * TRAY_RESPAWN_DELAY_MS
    ])
    const warnings = log.entries.filter((entry) => entry.level === 'warn')
    expect(warnings).toStrictEqual([
      {
        level: 'warn',
        event: 'notifier.respawn',
        subsystem: 'attention',
        outcome: 'failed',
        causeClass: 'gave-up',
        count: 3
      }
    ])

    // Nothing more is started, however long the Host runs, and nothing is logged as an error.
    clock.advance(2 * RESPAWN_WINDOW_MS)
    expect(launcher.starts).toHaveLength(3)
    expect(log.entries.filter((entry) => entry.level === 'error')).toStrictEqual([])

    // The Host is still serving: a UI launched by the person attaches, and the next death of its
    // process is answered with a start again (S12.C08).
    supervisor.clientAttached(UI)
    expect(supervisor.state()).toBe('attached')
    supervisor.clientDetached(UI)
    clock.advance(TRAY_RESPAWN_DELAY_MS)
    expect(launcher.starts).toHaveLength(4)
  })

  it('[ADR-018] a ui client staying attached (window open, tray process alive) never triggers a start', () => {
    const { clock, launcher, supervisor } = world()
    // The tray connection drops and comes back, a second window client comes and goes: a `ui`
    // client stays attached throughout, so no start is ever due.
    supervisor.clientDetached(NOTIFIER)
    supervisor.clientAttached({ clientId: 'c-ui-2', role: 'ui' })
    supervisor.clientDetached({ clientId: 'c-ui-2', role: 'ui' })
    // Viewer and MCP clients are not UI clients: their coming and going changes nothing.
    supervisor.clientAttached({ clientId: 'c-viewer', role: 'viewer' })
    supervisor.clientDetached({ clientId: 'c-viewer', role: 'viewer' })
    clock.advance(RESPAWN_WINDOW_MS)

    expect(launcher.starts).toStrictEqual([])
    expect(supervisor.state()).toBe('attached')
  })

  it('[FM-041, S12.C01, S12.C02] when the UI process dies without a clean close the app is started with --background 2 s later and every session keeps running', async () => {
    const { clock, launcher, log, supervisor } = world()
    uiProcessDies(supervisor)
    expect(supervisor.state()).toBe('waiting')

    clock.advance(TRAY_RESPAWN_DELAY_MS - 1)
    expect(launcher.starts).toStrictEqual([])
    clock.advance(1)
    // One start through NotifierLauncher, whose adapter starts the app `--background`
    // (AppBackgroundNotifierLauncher.test.ts): exactly 2 s after the last client detached.
    expect(launcher.starts).toStrictEqual([T0 + TRAY_RESPAWN_DELAY_MS])
    expect(supervisor.state()).toBe('spawning')
    expect(log.byEvent('notifier.respawn')).toStrictEqual([
      { level: 'info', event: 'notifier.respawn', subsystem: 'attention', count: 1 }
    ])

    // The respawned tray process attaches; the supervisor holds no way to end a process or the
    // Host, so every session keeps running.
    supervisor.clientAttached(RESPAWNED)
    launcher.settle('attached')
    await flush()
    clock.advance(RESPAWN_WINDOW_MS)
    expect(supervisor.state()).toBe('attached')
    expect(launcher.starts).toHaveLength(1)
  })
})
