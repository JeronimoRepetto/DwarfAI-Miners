// layer: L2
// L2 flow (17 §1.2; 11 F6 steps 1-6; UC-017 main flow; ISSUE-204): an accepted delegation becomes a
// visible worker. The real delegation endpoint and subtask run, the real jev advisor behind the
// `SubtaskRouter` bridge, the real launching module behind the `WorkerLauncher` bridge and the
// in-memory crew; every driven port is a double (`delegationHost`). FakeClock and FakeScheduler: no
// real time, no process, no network.
//
// TC-204-01 (the worker through the launch pipeline, the delegation running), TC-204-03 (arrives,
// works and departs as any dwarf, ranked by depth, the parent untouched), TC-204-04 (S8.12).
//
// The worker's end once its result is handed back (S8.08: `DelegationSucceeded` →
// `CrewCommands.endDelegated`) is the handoff issue's (later: ISSUE-205). Here the worker's session
// closes through the crew command every ended session goes through, and its walk-out is compared
// with an ordinary dwarf's.
import { describe, expect, it } from 'vitest'
import type { DwarfId, LaunchId } from '../../kernel/domain/values'
import { rankForDepth } from '../../modules/crew'

import { MINE } from '../../modules/launching/testing/sqliteLaunchingDb'
import {
  delegationHost,
  SETTLE_MS,
  SIMULATED,
  type JevRouteAnswers
} from './testing/delegationHost'

const TASK = 'Map the old shafts below the north seam'
const CONTEXT = 'The north seam floods after rain.'

function picksSimulated(): JevRouteAnswers {
  return {
    kind: 'answers',
    provider: { choice: SIMULATED, confidence: 0.92 },
    tier: { choice: 'balanced', confidence: 0.9 },
    trivial: { probability: 0.05 },
    largeContext: { probability: 0.05 },
    effort: { score: 1.5 },
    usage: { inputTokens: 40 }
  }
}

type Host = ReturnType<typeof delegationHost>

/** A delegation accepted from the parent and routed until its worker's launch settled. */
async function delegated(h: Host) {
  const { parent, token } = h.arriveParent()
  const parentBefore = h.crew.queries.get(parent)
  const crewEventsBefore = h.crew.bus.published.length
  h.jevRouter.queueResponse(picksSimulated())
  const answer = await h.endpoint.delegate(token, { task: TASK, context: CONTEXT })
  if (!answer.ok) throw new Error(`the delegation was refused: ${answer.error}`)
  await h.run(SETTLE_MS)
  await Promise.all(h.routes)
  const delegation = h.database.tickets.byTicket(answer.value.ticket)
  // S8.03: running with its worker's id.
  expect(delegation).toMatchObject({ state: 'running', workerDwarfId: expect.any(String) })
  return {
    parent,
    parentBefore,
    crewEventsBefore,
    ticket: answer.value.ticket,
    delegation: delegation as NonNullable<typeof delegation>,
    worker: delegation?.workerDwarfId as DwarfId
  }
}

describe('delegation flow (11 F6; UC-017)', () => {
  it("[US-DLG-002.AC01] an accepted delegation makes a new worker dwarf arrive in the parent's mine", async () => {
    const h = delegationHost()

    const { parent, delegation, worker } = await delegated(h)

    expect(h.delegationBus.ofType('DelegationFailed')).toStrictEqual([])
    expect(delegation).toMatchObject({ state: 'running', parentDwarfId: parent })
    expect(h.delegationBus.ofType('DelegationWorkerLaunched').map((e) => e.payload)).toStrictEqual([
      { delegationId: delegation.id, workerDwarfId: worker }
    ])
    // Jev was asked once, for the subtask.
    expect(h.jevRouter.requests).toHaveLength(1)
    const arrived = h.crew.bus.ofType('DwarfArrived').map((e) => e.payload)
    expect(arrived.at(-1)).toMatchObject({
      dwarfId: worker,
      mineId: MINE,
      parentDwarfId: parent,
      delegated: true
    })
    expect(h.crew.repository.byId(worker)).toMatchObject({ mineId: MINE, delegated: true })
    // Through the ordinary launch pipeline with Jev's pick and the task as its first message
    // (INV-85): one delegated launch of the picked supplier.
    expect(h.launchingBus.ofType('DwarfLaunched').map((e) => e.payload)).toMatchObject([
      { dwarfId: worker, parentDwarfId: parent, delegated: true, prompt: TASK }
    ])
    expect(h.starter.starts.map((s) => s.providerId)).toStrictEqual([SIMULATED])
  })

  it('[US-DLG-002.AC02] the worker working on its subtask has the ordinary working status', async () => {
    const h = delegationHost()

    const { parent, worker } = await delegated(h)

    // The same status any working dwarf shows, the parent included (machine 1).
    expect(h.crew.queries.get(worker)?.status).toBe('working')
    expect(h.crew.queries.get(worker)?.status).toBe(h.crew.queries.get(parent)?.status)
  })

  it('[US-DLG-002.AC03] when the worker finishes and its result is delivered it departs like any dwarf', async () => {
    const h = delegationHost()
    const { parent, worker } = await delegated(h)
    // An ordinary dwarf of the same mine, ended the same way.
    const ordinary = h.crew.commands.arrive({
      mineId: MINE,
      identity: { providerId: 'claude', providerSessionId: 'ordinary-session-204' },
      parent,
      rank: rankForDepth(1),
      status: 'working'
    })

    h.crew.commands.sessionClosed(worker, 'stopped')
    h.crew.commands.sessionClosed(ordinary, 'stopped')

    const departed = h.crew.bus.ofType('DwarfDeparted').map((e) => e.payload)
    expect(departed.map((p) => p.dwarfId)).toStrictEqual([worker, ordinary])
    const [workerLeft, ordinaryLeft] = departed
    expect({ ...workerLeft, dwarfId: 'x' }).toStrictEqual({ ...ordinaryLeft, dwarfId: 'x' })
    expect(h.crew.queries.get(worker)).toMatchObject({ departed: true })
  })

  it("[US-DLG-002.AC04, US-OBS-008.AC06] the worker's rank follows its depth below the mine's root session exactly as a self-started subagent", async () => {
    const h = delegationHost()

    const { parent, worker } = await delegated(h)

    // The parent is the mine's root session (a foreman, depth 0); its subagents are one level below.
    expect(h.crew.queries.get(parent)?.rank).toBe(rankForDepth(0))
    const selfStarted = h.crew.commands.arrive({
      mineId: MINE,
      identity: { providerId: 'claude', providerSessionId: 'own-subagent-204' },
      parent,
      rank: rankForDepth(1),
      status: 'working'
    })
    expect(h.crew.queries.get(worker)?.rank).toBe('worker')
    expect(h.crew.queries.get(worker)?.rank).toBe(h.crew.queries.get(selfStarted)?.rank)
  })

  it("[US-DLG-002.AC06] the parent's status does not change while the worker is launched and works", async () => {
    const h = delegationHost()

    const { parent, parentBefore, crewEventsBefore } = await delegated(h)

    expect(h.crew.queries.get(parent)).toStrictEqual(parentBefore)
    // No crew event about the parent since it delegated: not paused, not changed.
    const aboutParent = h.crew.bus.published
      .slice(crewEventsBefore)
      .filter((e) => (e.payload as { dwarfId?: DwarfId }).dwarfId === parent)
    expect(aboutParent).toStrictEqual([])
  })

  it('[INV-81, ADR-013] the worker is launched without Let Jev choose, so it gets no delegation entry and cannot delegate (depth 1)', async () => {
    const h = delegationHost()

    await delegated(h)

    const [start] = h.starter.starts
    expect(start?.gate).toStrictEqual({ launchedWithLetJevChoose: false })
    const [launched] = h.launchingBus.ofType('DwarfLaunched')
    const workerLaunch = launched?.payload.launchId as LaunchId
    // What the SessionStarter bridge asks for the worker's launch: no token, no credential file.
    const injection = await h.lifecycle.issueFor({
      launchId: workerLaunch,
      mechanism: 'ticket-file',
      launchedWithLetJevChoose: start?.gate.launchedWithLetJevChoose ?? true
    })
    expect(injection).toBeNull()
    expect(h.database.tokens.byLaunch(workerLaunch)).toBeNull()
  })

  it('[S8.12, FM-021] a Host rebuilt while a delegation is routing settles it failed worker-lost', async () => {
    const before = delegationHost()
    const { parent, token } = before.arriveParent()
    // Jev never answers: the Host stops while the subtask is being routed.
    before.jevRouter.queueHang()
    const answer = await before.endpoint.delegate(token, { task: TASK, context: CONTEXT })
    if (!answer.ok) throw new Error(`the delegation was refused: ${answer.error}`)
    await before.run(100)
    expect(before.database.tickets.byTicket(answer.value.ticket)).toMatchObject({
      state: 'attempted'
    })

    // CH-01: the composition is dropped and rebuilt over the same database.
    const after = delegationHost({ database: before.database, epoch: 'epoch-204-after' })
    expect(after.subtasks.failRoutingOnBoot()).toBe(1)

    expect(after.database.tickets.byTicket(answer.value.ticket)).toMatchObject({
      state: 'failed',
      failure: 'worker-lost'
    })
    expect(after.database.tickets.byTicket(answer.value.ticket)).not.toHaveProperty('task')
    expect(after.delegationBus.ofType('DelegationFailed').map((e) => e.payload)).toStrictEqual([
      { delegationId: expect.any(String), parentDwarfId: parent, failure: 'worker-lost' }
    ])
    // No worker was launched for it, before or after the restart.
    expect([...before.starter.starts, ...after.starter.starts]).toStrictEqual([])
    expect(after.jevRouter.requests).toStrictEqual([])
  })
})
