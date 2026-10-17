// layer: L2
// L2 (17 §1.2): the invisible result handoff (16 §5.4 "Handoff (PO #19, INV-68)"; ADR-013 item 6;
// 07 S8.08; 11 F6 step 7) over the in-memory ticket and token stores, the FakeParentDeliverer, a
// fake clock and scheduler, a recording bus and a recording diagnostics log. The real
// `DelegationEndpointService` answers `subtask_result` in front of it, as the MCP adapter calls it;
// the adapter's flush report (`responseFlushed`) is called here as the adapter calls it after
// writing the response frame (its own case: adapters/mcp/McpDelegationServer.test.ts).
//
// TC-205-01 (sending → delivered, succeeded, no row), the turn-input path (never retried) and
// NFR-SEC-12 (the result text in no row and no log record). ISSUE-206 (TC-206-03, TC-206-04): a
// failed push settles the delegation `handoff-failed` while the parent is alive (S8.13), else
// `parent-gone` (S8.11).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, Instant, LaunchId } from '../../../kernel/domain/values'
import { handoffMarkOf } from '../../conversation'
import type { Delegation, DelegationHandoff, DelegationId } from '../domain/delegation'
import type { SubtaskText } from '../domain/subtaskText'
import type { DelegationToken } from '../ports/delegationStores'
import { FakeParentDeliverer } from '../ports/fakes/FakeParentDeliverer'
import { InMemoryDelegationTicketStore } from '../ports/fakes/InMemoryDelegationTicketStore'
import { InMemoryDelegationTokenStore } from '../ports/fakes/InMemoryDelegationTokenStore'
import { DelegationEndpointService, type DelegationEndpointEvent } from './delegationEndpoint'
import { ParentHandoffService, type HandoffEvent } from './handoff'

const T0: Instant = 1_750_000_000_000
const PARENT = '00000000-0000-7000-8000-0000000c2051' as DwarfId
const WORKER = '00000000-0000-7000-8000-0000000c2052' as DwarfId
const LAUNCH = '00000000-0000-7000-8000-0000000c2053' as LaunchId
const DELEGATION = '00000000-0000-7000-8000-0000000c2054' as DelegationId
const TICKET = 'ticket-205'
const TASK = 'Map the old shafts below the north seam' as SubtaskText
const RESULT = 'The shafts are mapped: two flood after rain, the third is dry.'

function running(): Delegation {
  return {
    id: DELEGATION,
    parentDwarfId: PARENT,
    workerDwarfId: WORKER,
    ticket: TICKET,
    task: TASK,
    state: 'running',
    createdAt: T0
  }
}

function turnEnd(change: Partial<TurnEnded> = {}): TurnEnded {
  return {
    dwarfId: WORKER,
    turnKey: 'worker-turn-1',
    kind: 'concluded',
    at: T0 + 5_000,
    reliability: 'reliable',
    cancelledFromApp: false,
    ...change
  }
}

/** The ticket store, keeping every handoff each `save` wrote, in order. */
class HandoffHistoryStore extends InMemoryDelegationTicketStore {
  readonly handoffs: (DelegationHandoff | undefined)[] = []

  override save(d: Delegation): void {
    super.save(d)
    this.handoffs.push(d.handoff)
  }
}

function setUp(via: DelegationHandoff['via'] = 'tool-result', parentAlive = true) {
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const tickets = new HandoffHistoryStore()
  const tokens = new InMemoryDelegationTokenStore()
  const token: DelegationToken = {
    launchId: LAUNCH,
    parentDwarfId: PARENT,
    mechanism: 'ticket-file',
    credentialHash: 'c'.repeat(64),
    issuedAt: T0
  }
  tokens.issue(token)
  const deliverer = new FakeParentDeliverer()
  const log = new RecordingDiagnosticsLog()
  const bus = new RecordingEventBus<HandoffEvent | DelegationEndpointEvent>()
  const handoff = new ParentHandoffService({
    tickets,
    deliverer,
    viaOf: () => via,
    parentAlive: (parent) => parent === PARENT && parentAlive,
    transactions: { inTransaction: (work) => work() },
    bus,
    clock,
    ids,
    hostEpoch: 'epoch-205',
    log,
    settled: (ticket) => endpoint.delegationSettled(ticket)
  })
  const endpoint = new DelegationEndpointService({
    tokens,
    tickets,
    launches: { gateOf: () => ({ launchedWithLetJevChoose: true, delegated: false }) },
    preferences: {
      get: () => ({
        subagentDelegationOn: true,
        routingProfile: 'balanced',
        systemNotificationsOn: true,
        openCodePermissionsOn: false
      })
    },
    transactions: { inTransaction: (work) => work() },
    bus,
    clock,
    ids,
    hostEpoch: 'epoch-205',
    scheduler,
    handoff
  })
  tickets.put(running())
  return { clock, scheduler, tickets, token, deliverer, log, bus, handoff, endpoint }
}

/** Lets promise jobs run (no time passes: the clock is fake). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

describe('parent handoff (16 §5.4; ADR-013 item 6; 07 S8.08)', () => {
  it('[S8.08, INV-68] a done result answered through subtask_result writes handoff sending then delivered, then succeeded', async () => {
    const s = setUp()

    await s.handoff.workerTurnEnded(turnEnd(), RESULT)
    const answer = await s.endpoint.result(s.token, TICKET, { maxMs: 0 })

    expect(answer).toStrictEqual({
      status: 'done',
      outcome: { kind: 'concluded', text: RESULT }
    })
    // Written before the response: still running, the handoff sending.
    expect(s.tickets.byTicket(TICKET)).toMatchObject({
      state: 'running',
      handoff: { via: 'tool-result', phase: 'sending', phaseAt: T0 }
    })
    expect(s.bus.ofType('DelegationSucceeded')).toStrictEqual([])

    s.clock.advance(20)
    s.handoff.responseFlushed(answer, true)

    expect(s.tickets.handoffs.map((h) => h?.phase)).toStrictEqual(['sending', 'delivered'])
    expect(s.tickets.byTicket(TICKET)).toMatchObject({
      state: 'succeeded',
      settledAt: T0 + 20,
      handoff: { via: 'tool-result', phase: 'delivered', phaseAt: T0 + 20 }
    })
    expect(s.bus.ofType('DelegationSucceeded').map((e) => e.payload)).toStrictEqual([
      { delegationId: DELEGATION, parentDwarfId: PARENT, workerDwarfId: WORKER, via: 'tool-result' }
    ])
    // Nothing left to hand over: the ticket has no result for a later call.
    const later = await s.endpoint.result(s.token, TICKET, { maxMs: 0 })
    expect(later).toMatchObject({ status: 'failed', failure: { kind: 'unknown-ticket' } })
    expect(s.deliverer.calls).toStrictEqual([])
  })

  it('[S8.08] a subtask_result already waiting is answered done as soon as the worker finishes', async () => {
    const s = setUp()

    const waiting = s.endpoint.result(s.token, TICKET, { maxMs: 50_000 })
    await settle()
    await s.handoff.workerTurnEnded(turnEnd(), RESULT)

    await expect(waiting).resolves.toStrictEqual({
      status: 'done',
      outcome: { kind: 'concluded', text: RESULT }
    })
  })

  it('[INV-68] a response whose flush fails leaves the delegation running with handoff sending, never succeeded', async () => {
    const s = setUp()
    await s.handoff.workerTurnEnded(turnEnd(), RESULT)
    const answer = await s.endpoint.result(s.token, TICKET, { maxMs: 0 })

    s.handoff.responseFlushed(answer, false)

    expect(s.tickets.byTicket(TICKET)).toMatchObject({
      state: 'running',
      handoff: { via: 'tool-result', phase: 'sending' }
    })
    expect(s.bus.ofType('DelegationSucceeded')).toStrictEqual([])
    // The result never reached the parent, so its next subtask_result is answered again.
    const again = await s.endpoint.result(s.token, TICKET, { maxMs: 0 })
    expect(again).toStrictEqual({ status: 'done', outcome: { kind: 'concluded', text: RESULT } })
    s.handoff.responseFlushed(again, true)
    expect(s.tickets.byTicket(TICKET)).toMatchObject({
      state: 'succeeded',
      handoff: { phase: 'delivered' }
    })
  })

  it('[S8.08] only the first reliable turn end of the worker is its result', async () => {
    const s = setUp()

    await s.handoff.workerTurnEnded(turnEnd({ reliability: 'inferred' }), 'An inferred end')
    expect(await s.endpoint.result(s.token, TICKET, { maxMs: 0 })).toStrictEqual({
      status: 'pending',
      ticket: TICKET
    })
    await s.handoff.workerTurnEnded(turnEnd(), RESULT)
    await s.handoff.workerTurnEnded(turnEnd({ turnKey: 'worker-turn-2' }), 'A later turn')

    expect(await s.endpoint.result(s.token, TICKET, { maxMs: 0 })).toStrictEqual({
      status: 'done',
      outcome: { kind: 'concluded', text: RESULT }
    })
  })

  it('[ADR-013] the turn-input path is used only for a driver that needs it and is never retried', async () => {
    // A driver that takes the result as a tool result: nothing is pushed.
    const tool = setUp('tool-result')
    await tool.handoff.workerTurnEnded(turnEnd(), RESULT)
    expect(tool.deliverer.calls).toStrictEqual([])

    // A driver that needs it as turn input: one marked push, delivered.
    const pushed = setUp('turn-input')
    pushed.deliverer.queue({ ok: true, value: 'delivered' })
    await pushed.handoff.workerTurnEnded(turnEnd(), RESULT)
    expect(pushed.deliverer.calls).toHaveLength(1)
    const [push] = pushed.deliverer.calls
    expect(push?.parent).toBe(PARENT)
    expect(handoffMarkOf(push?.text ?? '')).toBe(DELEGATION)
    expect(push?.text.endsWith(RESULT)).toBe(true)
    expect(pushed.tickets.handoffs.map((h) => h?.phase)).toStrictEqual(['sending', 'delivered'])
    expect(pushed.tickets.byTicket(TICKET)).toMatchObject({
      state: 'succeeded',
      handoff: { via: 'turn-input', phase: 'delivered' }
    })
    expect(pushed.bus.ofType('DelegationSucceeded').map((e) => e.payload.via)).toStrictEqual([
      'turn-input'
    ])

    // A push that fails is not retried, whatever happens next (ADR-013 O-13b).
    const failed = setUp('turn-input')
    failed.deliverer.queue({ ok: false, error: 'failed' })
    await failed.handoff.workerTurnEnded(turnEnd(), RESULT)
    await failed.handoff.workerTurnEnded(turnEnd({ turnKey: 'worker-turn-2' }), RESULT)
    failed.clock.advance(60_000)
    await settle()
    expect(failed.deliverer.calls).toHaveLength(1)
    expect(failed.bus.ofType('DelegationSucceeded')).toStrictEqual([])
    expect(failed.tickets.byTicket(TICKET)).not.toMatchObject({ state: 'succeeded' })
    // A pushed result is never answered through the tool as well.
    expect(await failed.endpoint.result(failed.token, TICKET, { maxMs: 0 })).not.toMatchObject({
      status: 'done'
    })
    // A rejected push is not retried either.
    const rejected = setUp('turn-input')
    rejected.deliverer.queue('reject')
    await rejected.handoff.workerTurnEnded(turnEnd(), RESULT)
    await rejected.handoff.workerTurnEnded(turnEnd({ turnKey: 'worker-turn-2' }), RESULT)
    expect(rejected.deliverer.calls).toHaveLength(1)
  })

  it('[NFR-SEC-12] the result text is never stored in a row and never reaches a log record', async () => {
    const tool = setUp('tool-result')
    await tool.handoff.workerTurnEnded(turnEnd(), RESULT)
    const answer = await tool.endpoint.result(tool.token, TICKET, { maxMs: 0 })
    tool.handoff.responseFlushed(answer, false)
    tool.handoff.responseFlushed(answer, true)

    const pushed = setUp('turn-input')
    pushed.deliverer.queue({ ok: false, error: 'failed' })
    await pushed.handoff.workerTurnEnded(turnEnd(), RESULT)
    const rejected = setUp('turn-input')
    rejected.deliverer.queue('reject')
    await rejected.handoff.workerTurnEnded(turnEnd(), RESULT)

    for (const s of [tool, pushed, rejected]) {
      expect(JSON.stringify(s.tickets.snapshot())).not.toContain(RESULT)
      expect(JSON.stringify(s.tickets.handoffs)).not.toContain(RESULT)
      expect(JSON.stringify(s.bus.published)).not.toContain(RESULT)
      expect(JSON.stringify(s.log.entries)).not.toContain(RESULT)
    }
    // The failed pushes were logged, by class only.
    expect(pushed.log.entries).toHaveLength(1)
    expect(rejected.log.entries).toHaveLength(1)
  })
})

describe('a failed turn-input push (07 S8.13, S8.11; ADR-013 O-13b; ISSUE-206)', () => {
  it('[S8.13] a failed push while the parent is alive settles the delegation handoff-failed once, never retried', async () => {
    for (const answer of [{ ok: false, error: 'failed' } as const, 'reject' as const]) {
      const s = setUp('turn-input')
      s.deliverer.queue(answer)

      await s.handoff.workerTurnEnded(turnEnd(), RESULT)
      await s.handoff.workerTurnEnded(turnEnd({ turnKey: 'worker-turn-2' }), RESULT)
      s.clock.advance(60_000)
      await settle()

      expect(s.deliverer.calls).toHaveLength(1)
      expect(s.tickets.handoffs.map((h) => h?.phase)).toStrictEqual(['sending', 'failed'])
      expect(s.tickets.byTicket(TICKET)).toMatchObject({
        state: 'failed',
        failure: 'handoff-failed',
        handoff: { via: 'turn-input', phase: 'failed' }
      })
      expect(s.bus.ofType('DelegationFailed').map((e) => e.payload)).toStrictEqual([
        { delegationId: DELEGATION, parentDwarfId: PARENT, failure: 'handoff-failed' }
      ])
      expect(s.bus.ofType('DelegationSucceeded')).toStrictEqual([])
    }
  })

  it('[S8.11] a failed push after the parent left settles the delegation parent-gone', async () => {
    const s = setUp('turn-input', false)
    s.deliverer.queue({ ok: false, error: 'cannot-receive' })

    await s.handoff.workerTurnEnded(turnEnd(), RESULT)

    expect(s.tickets.byTicket(TICKET)).toMatchObject({
      state: 'failed',
      failure: 'parent-gone',
      handoff: { via: 'turn-input', phase: 'failed' }
    })
    expect(s.bus.ofType('DelegationFailed').map((e) => e.payload.failure)).toStrictEqual([
      'parent-gone'
    ])
  })
})
