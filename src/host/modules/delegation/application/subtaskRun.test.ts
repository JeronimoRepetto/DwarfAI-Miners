// layer: L2
// L2 (17 §1.2): the subtask run (16 §4.8 rows `SubtaskRouter` and `WorkerLauncher`, §5.4, §6.4;
// 07 S8.03-S8.07, S8.12; ADR-013 items 4-5; ADR-028 D2) over the in-memory ticket store, the
// FakeSubtaskRouter and FakeWorkerLauncher doubles, a fake clock and scheduler, and a recording bus.
// The C-26 cases put the real `DelegationEndpointService` in front of it, joined by the
// `SubtaskDelegated` route as the Host wiring joins them (later: ISSUE-209).
//
// TC-204-01 (S8.03), TC-204-02 (S8.04-S8.07, FM-123), TC-204-04 (S8.12).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { LaunchFailureCause } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, Instant, LaunchId } from '../../../kernel/domain/values'
import type { Delegation, DelegationId } from '../domain/delegation'
import type { SubtaskText } from '../domain/subtaskText'
import type { DelegationToken } from '../ports/delegationStores'
import { FakeSubtaskRouter } from '../ports/fakes/FakeSubtaskRouter'
import { FakeWorkerLauncher } from '../ports/fakes/FakeWorkerLauncher'
import { InMemoryDelegationTicketStore } from '../ports/fakes/InMemoryDelegationTicketStore'
import type { JevSuggestionView } from '../ports/subtaskRouting'
import { DelegationEndpointService, type DelegationEndpointEvent } from './delegationEndpoint'
import { SubtaskRunService, type SubtaskRunEvent } from './subtaskRun'

const T0: Instant = 1_750_000_000_000
const PARENT = '00000000-0000-7000-8000-0000000c2041' as DwarfId
const WORKER = '00000000-0000-7000-8000-0000000c2042' as DwarfId
const LAUNCH = '00000000-0000-7000-8000-0000000c2043' as LaunchId
const DELEGATION = '00000000-0000-7000-8000-0000000c2044' as DelegationId
const TICKET = 'ticket-204'
const TASK = 'Map the old shafts below the north seam' as SubtaskText
const CONTEXT = 'The north seam floods after rain.' as SubtaskText

const PICK: JevSuggestionView = {
  providerId: 'simulated' as JevSuggestionView['providerId'],
  model: 'sim-small',
  effort: 'low',
  confidence: { providerId: 0.9 },
  truncated: false,
  parts: { providerId: 'answered', model: 'answered', effort: 'answered' }
}

function attempted(change: Partial<Delegation> = {}): Delegation {
  return {
    id: DELEGATION,
    parentDwarfId: PARENT,
    ticket: TICKET,
    task: TASK,
    context: CONTEXT,
    state: 'attempted',
    createdAt: T0,
    ...change
  }
}

function setUp() {
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const tickets = new InMemoryDelegationTicketStore()
  const router = new FakeSubtaskRouter()
  const launcher = new FakeWorkerLauncher()
  const bus = new RecordingEventBus<SubtaskRunEvent>()
  const woken: string[] = []
  const run = new SubtaskRunService({
    tickets,
    router,
    launcher,
    transactions: { inTransaction: (work) => work() },
    bus,
    clock,
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-204',
    log: new RecordingDiagnosticsLog(),
    settled: (ticket) => woken.push(ticket)
  })
  return { clock, scheduler, tickets, router, launcher, bus, woken, run }
}

describe('subtask run (16 §4.8; 07 machine 8)', () => {
  it("[S8.03, INV-85] a pick launches the worker and moves the delegation to running with the worker's id", async () => {
    const s = setUp()
    s.tickets.put(attempted())
    s.router.queue({ ok: true, value: PICK })
    s.launcher.queue({ ok: true, value: WORKER })

    await s.run.run(DELEGATION)

    expect(s.router.calls).toStrictEqual([{ task: TASK, context: CONTEXT }])
    // Through the launch pipeline with Jev's pick as given and the task as its first message.
    expect(s.launcher.calls).toStrictEqual([
      { delegationId: DELEGATION, parent: PARENT, pick: PICK, task: TASK }
    ])
    expect(s.tickets.byTicket(TICKET)).toStrictEqual({
      ...attempted(),
      state: 'running',
      workerDwarfId: WORKER
    })
    expect(s.bus.published.map((e) => [e.type, e.payload])).toStrictEqual([
      ['DelegationWorkerLaunched', { delegationId: DELEGATION, workerDwarfId: WORKER }]
    ])
    expect(s.woken).toStrictEqual([TICKET])
  })

  it('[S8.04] jev-unreachable settles the delegation failed with jev-unreachable', async () => {
    const s = setUp()
    s.tickets.put(attempted())
    s.router.queue({ ok: false, error: 'jev-unreachable' })

    await s.run.run(DELEGATION)

    expectFailed(s, 'jev-unreachable')
    expect(s.launcher.calls).toStrictEqual([])
  })

  it('[S8.05, US-DLG-005.AC05, INV-86] an effort-ceiling routing fails the delegation as jev-could-not-choose', async () => {
    const s = setUp()
    s.tickets.put(attempted())
    // The bridge answers an effort-ceiling subtask as `jev-could-not-choose` (16 §6.4, ADR-028 D2).
    s.router.queue({ ok: false, error: 'jev-could-not-choose' })

    await s.run.run(DELEGATION)

    expectFailed(s, 'jev-could-not-choose')
    expect(s.launcher.calls).toStrictEqual([])
  })

  it('[S8.06] no launchable provider fails the delegation as no-provider', async () => {
    const s = setUp()
    s.tickets.put(attempted())
    // A pick that names no supplier leaves nothing a Host driver can launch (21 §2 cut 3).
    s.router.queue({
      ok: true,
      value: { confidence: {}, truncated: false, parts: {} }
    })

    await s.run.run(DELEGATION)

    expectFailed(s, 'no-provider')
    expect(s.launcher.calls).toStrictEqual([])
  })

  it('[S8.07] a worker launch that fails with any launch cause fails the delegation as worker-failed', async () => {
    const causes: LaunchFailureCause[] = [
      'not-installed',
      'exited-at-once',
      'could-not-start',
      'jev-unreachable',
      'jev-could-not-choose'
    ]
    for (const cause of causes) {
      const s = setUp()
      s.tickets.put(attempted())
      s.router.queue({ ok: true, value: PICK })
      s.launcher.queue({ ok: false, error: cause })

      await s.run.run(DELEGATION)

      expectFailed(s, 'worker-failed')
    }
  })

  it('[S8.07] a worker launch that rejects fails the delegation as worker-failed', async () => {
    const s = setUp()
    s.tickets.put(attempted())
    s.router.queue({ ok: true, value: PICK })
    s.launcher.queue('reject')

    await s.run.run(DELEGATION)

    expectFailed(s, 'worker-failed')
  })

  it('[S8.04] a routing call that rejects settles the delegation failed with jev-unreachable', async () => {
    const s = setUp()
    s.tickets.put(attempted())
    s.router.queue('reject')

    await s.run.run(DELEGATION)

    expectFailed(s, 'jev-unreachable')
  })

  it('[S8.11] a delegation settled while it was routed is left as it is and launches nothing', async () => {
    const s = setUp()
    s.tickets.put(attempted())
    let answer: (value: { ok: true; value: JevSuggestionView }) => void = () => undefined
    s.router.route = (task, context) => {
      s.router.calls.push(context === undefined ? { task } : { task, context })
      return new Promise((resolve) => {
        answer = resolve
      })
    }
    const running = s.run.run(DELEGATION)
    // The parent departed meanwhile (07 S8.11, `DelegationLifecycle.revokeFor`).
    s.tickets.save({
      id: DELEGATION,
      parentDwarfId: PARENT,
      ticket: TICKET,
      createdAt: T0,
      state: 'failed',
      failure: 'parent-gone',
      settledAt: T0
    })
    answer({ ok: true, value: PICK })
    await running

    expect(s.launcher.calls).toStrictEqual([])
    expect(s.tickets.byTicket(TICKET)).toMatchObject({ state: 'failed', failure: 'parent-gone' })
    expect(s.bus.published).toStrictEqual([])
  })

  it('[S8.01] a delegation that is not attempted is never routed', async () => {
    const s = setUp()
    s.tickets.put(attempted({ state: 'running', workerDwarfId: WORKER }))

    await s.run.run(DELEGATION)
    await s.run.run('00000000-0000-7000-8000-0000000c20ff' as DelegationId)

    expect(s.router.calls).toStrictEqual([])
    expect(s.launcher.calls).toStrictEqual([])
  })

  it('[S8.12, FM-021] a Host rebuilt while a delegation is routing fails it worker-lost at boot', () => {
    const s = setUp()
    s.tickets.put(attempted())
    s.tickets.put(
      attempted({
        id: '00000000-0000-7000-8000-0000000c2045' as DelegationId,
        ticket: 'ticket-running',
        state: 'running',
        workerDwarfId: WORKER
      })
    )
    s.clock.advance(1_000)

    expect(s.run.failRoutingOnBoot()).toBe(1)

    expect(s.tickets.byTicket(TICKET)).toStrictEqual({
      id: DELEGATION,
      parentDwarfId: PARENT,
      ticket: TICKET,
      state: 'failed',
      failure: 'worker-lost',
      createdAt: T0,
      settledAt: T0 + 1_000
    })
    // A running delegation is the INV-84 reconcile's (its worker may have survived), not S8.12.
    expect(s.tickets.byTicket('ticket-running')).toMatchObject({ state: 'running' })
    expect(s.bus.published.map((e) => [e.type, e.payload])).toStrictEqual([
      [
        'DelegationFailed',
        { delegationId: DELEGATION, parentDwarfId: PARENT, failure: 'worker-lost' }
      ]
    ])
    expect(s.router.calls).toStrictEqual([])
  })
})

describe('subtask text reaches Jev only through the delegation path (C-26, INV-88)', () => {
  function withEndpoint(delegationOn: boolean) {
    const s = setUp()
    const token: DelegationToken = {
      launchId: LAUNCH,
      parentDwarfId: PARENT,
      mechanism: 'ticket-file',
      credentialHash: 'a'.repeat(64),
      issuedAt: T0
    }
    const endpointBus = new RecordingEventBus<DelegationEndpointEvent>()
    const endpoint = new DelegationEndpointService({
      tokens: { byLaunch: (id) => (id === LAUNCH ? token : null) },
      tickets: s.tickets,
      launches: { gateOf: () => ({ launchedWithLetJevChoose: true, delegated: false }) },
      preferences: {
        get: () => ({
          subagentDelegationOn: delegationOn,
          routingProfile: 'balanced',
          systemNotificationsOn: true,
          openCodePermissionsOn: false
        })
      },
      transactions: { inTransaction: (work) => work() },
      bus: endpointBus,
      clock: s.clock,
      ids: new SequenceIdGenerator(),
      hostEpoch: 'epoch-204',
      scheduler: s.scheduler
    })
    // The `SubtaskDelegated` route, off the tool call (later: ISSUE-209 composes it).
    const routes: Promise<void>[] = []
    endpointBus.subscribe('SubtaskDelegated', (e) => {
      routes.push(s.run.run(e.payload.delegationId))
    })
    return { ...s, token, endpoint, routes }
  }

  it('[C-26, INV-88] the subtask text and context are sent to Jev only through the delegation path while the setting is on', async () => {
    const on = withEndpoint(true)
    on.router.queue({ ok: true, value: PICK })
    on.launcher.queue({ ok: true, value: WORKER })

    const delegated = await on.endpoint.delegate(on.token, { task: TASK, context: CONTEXT })
    // `delegate` answers the ticket before anything was routed (16 §4.8: returns at once).
    expect(delegated.ok).toBe(true)
    await Promise.all(on.routes)

    expect(on.router.calls).toStrictEqual([{ task: TASK, context: CONTEXT }])

    const off = withEndpoint(false)
    const refused = await off.endpoint.delegate(off.token, { task: TASK, context: CONTEXT })
    await Promise.all(off.routes)

    expect(refused).toStrictEqual({ ok: false, error: 'gate-closed' })
    // Nothing is routed, so nothing reaches TypeSafe (ADR-013 item 4).
    expect(off.router.calls).toStrictEqual([])
    expect(off.launcher.calls).toStrictEqual([])
  })
})

function expectFailed(s: ReturnType<typeof setUp>, failure: Delegation['failure']): void {
  expect(s.tickets.byTicket(TICKET)).toStrictEqual({
    id: DELEGATION,
    parentDwarfId: PARENT,
    ticket: TICKET,
    state: 'failed',
    failure,
    createdAt: T0,
    settledAt: T0
  })
  expect(s.bus.published.map((e) => [e.type, e.payload])).toStrictEqual([
    ['DelegationFailed', { delegationId: DELEGATION, parentDwarfId: PARENT, failure }]
  ])
  expect(s.woken).toStrictEqual([TICKET])
}
