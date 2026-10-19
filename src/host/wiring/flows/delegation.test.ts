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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DwarfId, LaunchId } from '../../kernel/domain/values'
import { markHandoff } from '../../modules/conversation'
import { rankForDepth } from '../../modules/crew'
import {
  delegationFailedLineText,
  type DelegationFailed,
  type DelegationToken
} from '../../modules/delegation'
import {
  FakeParentDeliverer,
  FakeSubtaskRouter
} from '../../modules/delegation/testing/delegationFlowKit'

import { MINE } from '../../modules/launching/testing/sqliteLaunchingDb'
import { toDwarfWire } from '../../transport/mappers/wire'
import { delegatedChat } from './testing/delegatedChat'
import type { RecordingSpawn } from '../../modules/suppliers/testing/recordingSpawn'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { seedDelegationRows } from '../../modules/delegation/testing/seedDelegationRows'
import {
  bootHost as bootWiredHost,
  cleanUp as cleanUpWired,
  evts as wiredEvts,
  JEV_KEY,
  world as wiredWorld
} from './testing/cut3aHost'
import {
  claudeRecording,
  claudeSpawn,
  DELEGATION_CAPABILITIES,
  jevPicks,
  launchClaudeWithJev,
  turnDelegationOn
} from './testing/delegatingParent'
import {
  delegationHost,
  PARENT_LAUNCH,
  SETTLE_MS,
  SIMULATED,
  type JevRouteAnswers
} from './testing/delegationHost'

const TASK = 'Map the old shafts below the north seam'
// ISSUE-209's boot sweep: synthetic launches and the dwarf a live token is bound to.
const UNBOUND = '01890a5d-ac96-774b-bcce-b30220905001'
const REVOKED = '01890a5d-ac96-774b-bcce-b30220905002'
const KEPT = '01890a5d-ac96-774b-bcce-b30220905003'
const ORPHAN = '01890a5d-ac96-774b-bcce-b30220905004'
const KEPT_PARENT = '01890a5d-ac96-774b-bcce-b30220905005'
const ROUTING = '01890a5d-ac96-774b-bcce-b30220905006'
const LOST = '01890a5d-ac96-774b-bcce-b30220905007'
const LIVE = '01890a5d-ac96-774b-bcce-b30220905008'
const LOST_WORKER = '01890a5d-ac96-774b-bcce-b30220905009'
const LIVE_WORKER = '01890a5d-ac96-774b-bcce-b3022090500a'
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

// ISSUE-207 (14 §2.4 note, §3.6 `DwarfWire.delegated`, `parentDwarfId`; ADR-013 item 5; INV-85;
// 11 F6 steps 4–5): the worker is an ordinary dwarf the UI can tell apart. Its chat and its send
// path are every dwarf's: compared here with an ordinary launch of the same supplier in the same
// mine. TC-207-01, TC-207-03.
describe('the delegated worker as the UI sees it (ISSUE-207)', () => {
  /** An ordinary launch of the simulated supplier in the parent's mine, settled; its dwarf. */
  async function launchedOrdinary(h: Host, prompt: string): Promise<DwarfId> {
    const { launchId } = await h.launching.commands.launch({
      mineId: MINE,
      way: { kind: 'supplier', providerId: SIMULATED },
      prompt,
      jevOn: false,
      jevAutoAccept: false
    })
    await h.run(SETTLE_MS)
    const launched = h.launchingBus
      .ofType('DwarfLaunched')
      .find((e) => e.payload.launchId === launchId)
    if (launched === undefined) throw new Error('the ordinary launch did not settle')
    return launched.payload.dwarfId
  }

  /**
   * One rule for every dwarf, delegated or not: a dwarf whose session launching holds live is
   * owned, and its session is its delivery route (INV-30, INV-33).
   */
  function linkLaunched(h: Host, dwarfs: readonly DwarfId[]): void {
    for (const dwarfId of dwarfs) {
      if (h.launching.owned.liveRecordOf(dwarfId) === null) continue
      h.crew.owned.add(dwarfId)
      h.crew.routed.add(dwarfId)
    }
  }

  function wireOf(h: Host, dwarfId: DwarfId) {
    const view = h.crew.queries.get(dwarfId)
    if (view === null) throw new Error(`no dwarf ${dwarfId}`)
    return toDwarfWire(view)
  }

  it("[US-DLG-002.AC05, INV-85] a delegated worker is stored and published with delegated true and its parent's id", async () => {
    const h = delegationHost()

    const { parent, worker } = await delegated(h)
    const ordinary = await launchedOrdinary(h, 'Survey the east gallery')

    expect(h.crew.repository.byId(worker)).toMatchObject({ delegated: true, parentDwarfId: parent })
    const arrived = h.crew.bus.ofType('DwarfArrived').map((e) => e.payload)
    expect(arrived.find((p) => p.dwarfId === worker)).toMatchObject({
      delegated: true,
      parentDwarfId: parent
    })
    expect(wireOf(h, worker)).toMatchObject({ delegated: true, parentDwarfId: parent })
    // Any other dwarf is no delegation: the parent, and a dwarf the person launched.
    for (const other of [parent, ordinary]) {
      expect(arrived.find((p) => p.dwarfId === other)).toMatchObject({ delegated: false })
      expect(wireOf(h, other)).toMatchObject({ delegated: false, parentDwarfId: null })
    }
  })

  it('[US-DLG-003.AC01] the worker can receive messages and exposes the same chat facts as any dwarf', async () => {
    const h = delegationHost()
    const chat = delegatedChat(h)
    const { worker } = await delegated(h)
    const ordinary = await launchedOrdinary(h, 'Survey the east gallery')

    linkLaunched(h, [worker, ordinary])

    const chatFacts = (dwarfId: DwarfId) => {
      const wire = wireOf(h, dwarfId)
      return {
        presence: wire.presence,
        processState: wire.processState,
        status: wire.status,
        needsYou: wire.needsYou,
        canReceiveMessages: wire.canReceiveMessages,
        stopInFlight: wire.stopInFlight,
        stopUnavailableReason: wire.stopUnavailableReason,
        owned: wire.owned
      }
    }
    expect(chatFacts(worker)).toMatchObject({ canReceiveMessages: true, owned: true })
    expect(chatFacts(worker)).toStrictEqual(chatFacts(ordinary))
    // Its chat opens on the same feed: its first message is the subtask brief, in the person's
    // place, as an ordinary dwarf's first message is the prompt it was launched with (INV-85).
    const shape = (dwarfId: DwarfId) =>
      chat.feed(dwarfId).messages.map(({ role, delivery, attachments }) => ({
        role,
        delivery,
        attachments
      }))
    expect(chat.feed(worker).messages.map((m) => m.text)).toStrictEqual([TASK])
    expect(shape(worker)).toStrictEqual(shape(ordinary))
  })

  it('[US-DLG-003.AC02] a message sent to the worker goes through conversation.send and is delivered as any message', async () => {
    const h = delegationHost()
    const chat = delegatedChat(h)
    const { worker } = await delegated(h)
    const ordinary = await launchedOrdinary(h, 'Survey the east gallery')
    linkLaunched(h, [worker, ordinary])

    /** One send: its answer, the events it published and the delivery it stored. */
    const sent = async (dwarfId: DwarfId, requestId: string) => {
      const before = chat.bus.published.length
      const at = h.clock.now()
      const answer = await chat.send(dwarfId, 'Check the pumps too', requestId)
      await h.run(10)
      // Accepted like any send: never `cannot-receive` for a worker (14 §1.7).
      expect(answer).toMatchObject({ ok: true })
      if (!answer.ok) throw new Error(`the send was refused: ${answer.error}`)
      const [stored] = chat.feed(dwarfId).messages
      return {
        events: chat.bus.published
          .slice(before)
          .map((e) => ({ type: e.type, dwarfId: (e.payload as { dwarfId?: DwarfId }).dwarfId })),
        stored: {
          id: stored?.id,
          role: stored?.role,
          text: stored?.text,
          delivery: stored?.delivery
        },
        messageId: answer.value,
        /** How long after the send its delivery last moved. */
        settledAfter: (stored?.delivery?.phaseAt ?? Number.NaN) - at
      }
    }
    const toWorker = await sent(worker, '01890a5d-ac96-774b-bcce-000000000207')
    const toOrdinary = await sent(ordinary, '01890a5d-ac96-774b-bcce-000000000208')

    // Handed over once, as the same turn any dwarf gets.
    expect(chat.turns.turns).toStrictEqual([
      {
        dwarfId: worker,
        turn: {
          messageId: toWorker.messageId,
          kind: 'message',
          text: 'Check the pumps too',
          attachments: []
        }
      },
      {
        dwarfId: ordinary,
        turn: {
          messageId: toOrdinary.messageId,
          kind: 'message',
          text: 'Check the pumps too',
          attachments: []
        }
      }
    ])
    expect(toWorker.stored).toMatchObject({
      id: toWorker.messageId,
      role: 'person',
      delivery: { phase: 'delivered', confidence: 'confirmed' }
    })
    // The same events and the same stored delivery as the ordinary dwarf's send.
    const same = (s: typeof toWorker, dwarfId: DwarfId) => ({
      events: s.events.map((e) => ({ ...e, dwarfId: e.dwarfId === dwarfId ? 'self' : e.dwarfId })),
      delivery: { ...s.stored.delivery, messageId: 'x', dwarfId: 'x', phaseAt: s.settledAfter }
    })
    expect(same(toWorker, worker)).toStrictEqual(same(toOrdinary, ordinary))
  })

  // AMENDMENT-23 (owner, 2026-10-18): the `DwarfLaunched` route passes the parent as the brief's
  // issuer (11 F6 step 5; 14 §2.4 note; PO #53). TC-207-02.
  it("[US-DLG-003.AC04] only the worker's first message, the subtask brief, carries the issuer; every later message has none", async () => {
    const h = delegationHost()
    const chat = delegatedChat(h)
    const { parent, worker } = await delegated(h)
    const ordinary = await launchedOrdinary(h, 'Survey the east gallery')
    linkLaunched(h, [worker, ordinary])

    chat.ingest(worker, 1)
    chat.ingest(worker, 2, 'person')
    await chat.send(worker, 'Check the pumps too', '01890a5d-ac96-774b-bcce-000000000209')
    await h.run(10)

    const issuers = (dwarfId: DwarfId) =>
      chat
        .feed(dwarfId)
        .messages.reverse()
        .map((m) => [m.text, m.issuer])
    expect(issuers(worker)).toStrictEqual([
      [TASK, { dwarfId: parent }],
      ['later 1', undefined],
      ['later 2', undefined],
      ['Check the pumps too', undefined]
    ])
    // An ordinary launch's first message is the person's own: no issuer.
    expect(issuers(ordinary)).toStrictEqual([['Survey the east gallery', undefined]])
    // The frame the UI gets carries it on the brief alone (14 §2.4 `conversation.appended`).
    const appended = chat.bus
      .ofType('MessagesAppended')
      .filter((e) => e.payload.dwarfId === worker)
      .flatMap((e) => e.payload.messages)
    expect(appended.filter((m) => m.issuer !== undefined).map((m) => m.text)).toStrictEqual([TASK])
  })

  it("[US-DLG-003.AC03] the issuer resolves to the launcher's custom name when one is set, else its base name", async () => {
    const h = delegationHost()
    const chat = delegatedChat(h)
    const { parent, worker } = await delegated(h)
    const issuer = chat.feed(worker).messages.find((m) => m.issuer !== undefined)?.issuer
    expect(issuer).toStrictEqual({ dwarfId: parent })
    if (issuer === undefined) throw new Error('the brief carries no issuer')

    // The issuer is the launcher's id, so its label reads the launcher as the board has it now.
    const label = () => {
      const launcher = wireOf(h, issuer.dwarfId)
      return launcher.customName ?? launcher.baseName
    }
    const base = wireOf(h, parent).baseName
    expect(label()).toBe(base)
    expect(h.crew.commands.rename(parent, 'Borin')).toMatchObject({ ok: true })
    expect(label()).toBe('Borin')
  })
})

// ISSUE-205 (11 F6 steps 7 and 10; UC-017 main flow and "Turn-input handoff"; 16 §5.4 "Handoff";
// TC-205-01 … TC-205-04): the worker's result reaches its parent with no trace a person sees, and
// the finished worker walks out like any dwarf.
const RESULT = 'The old shafts are mapped: two flood after rain, the third is dry.'
const T0_205 = 1_790_000_100_000

/** The worker's last assistant message, then its first reliable turn end (lead decision). */
async function workerFinishes(h: Host, worker: DwarfId): Promise<void> {
  h.conversation.commands.ingest(
    worker,
    [
      {
        sourceKey: `simulated:simulated:${worker}:reply-1`,
        role: 'dwarf',
        text: RESULT,
        providerTime: T0_205
      }
    ],
    'live-stream'
  )
  h.conversation.commands.recordTurnEnd({
    dwarfId: worker,
    turnKey: 'worker-turn-1',
    kind: 'concluded',
    at: T0_205,
    reliability: 'reliable',
    cancelledFromApp: false
  })
  await Promise.all(h.handoffRuns)
}

/** Everything about `dwarfId` the conversation published or keeps (feed rows, events). */
function chatTraces(h: Host, dwarfId: DwarfId) {
  return {
    rows: h.conversation.log.rowCount(dwarfId),
    events: h.conversation.bus.published.filter(
      (e) => (e.payload as { dwarfId?: DwarfId }).dwarfId === dwarfId
    )
  }
}

/** The parent's `subtask_result` answered and its response flushed, as the MCP adapter does it. */
async function parentReads(h: Host, token: DelegationToken, ticket: string) {
  const answer = await h.endpoint.result(token, ticket, { maxMs: 0 })
  h.handoff.responseFlushed(answer, true)
  await Promise.all(h.ends)
  return answer
}

describe('delegation handoff flow (11 F6 steps 7, 10; ISSUE-205)', () => {
  it('[US-DLG-004.AC01, INV-68] after a delegated result reaches the parent no message, line or frame appears for it', async () => {
    const h = delegationHost()
    const { parent, ticket, delegation, worker } = await delegated(h)
    const token = h.database.tokens.byLaunch(PARENT_LAUNCH) as DelegationToken
    const before = chatTraces(h, parent)
    const framesBefore = h.frames.length

    await workerFinishes(h, worker)
    const answer = await parentReads(h, token, ticket)

    // The result is the answer of the parent's own tool call (the handoff itself).
    expect(answer).toStrictEqual({ status: 'done', outcome: { kind: 'concluded', text: RESULT } })
    expect(h.database.tickets.byTicket(ticket)).toMatchObject({
      state: 'succeeded',
      handoff: { via: 'tool-result', phase: 'delivered' }
    })
    expect(h.delegationBus.ofType('DelegationSucceeded').map((e) => e.payload)).toStrictEqual([
      {
        delegationId: delegation.id,
        parentDwarfId: parent,
        workerDwarfId: worker,
        via: 'tool-result'
      }
    ])
    // Nothing in the parent's chat: no row, no event that becomes a frame, no line, no toast.
    expect(before).toStrictEqual({ rows: 0, events: [] })
    expect(chatTraces(h, parent)).toStrictEqual(before)
    expect(h.delegationBus.ofType('DelegationFailed')).toStrictEqual([])
    expect(h.frames.slice(framesBefore)).toStrictEqual([])
    expect(h.parentSession.sent).toStrictEqual([])
    // The result text is never stored or logged (NFR-SEC-12).
    expect(JSON.stringify(h.database.tickets.snapshot())).not.toContain(RESULT)
    expect(JSON.stringify(h.log.entries)).not.toContain(RESULT)
  })

  it("[US-DLG-004.AC02] the parent's status and presence at the handoff are those of a dwarf simply working", async () => {
    const h = delegationHost()
    const { parent, ticket, worker } = await delegated(h)
    const token = h.database.tokens.byLaunch(PARENT_LAUNCH) as DelegationToken
    const parentBefore = h.crew.queries.get(parent)
    const crewEventsBefore = h.crew.bus.published.length

    await workerFinishes(h, worker)
    await parentReads(h, token, ticket)

    expect(parentBefore).toMatchObject({ status: 'working', departed: false })
    expect(h.crew.queries.get(parent)).toStrictEqual(parentBefore)
    const aboutParent = h.crew.bus.published
      .slice(crewEventsBefore)
      .filter((e) => (e.payload as { dwarfId?: DwarfId }).dwarfId === parent)
    expect(aboutParent).toStrictEqual([])
    expect(h.crewEndBus.published.filter((e) => e.payload.dwarfId === parent)).toStrictEqual([])
  })

  it('[US-DLG-004.AC03, S8.08] the finished worker is ended with delegation-done and departs as stopped with no stopped-unexpectedly toast', async () => {
    const h = delegationHost()
    const { ticket, worker } = await delegated(h)
    const token = h.database.tokens.byLaunch(PARENT_LAUNCH) as DelegationToken

    await workerFinishes(h, worker)
    // Present until its result reached the parent.
    expect(h.crew.queries.get(worker)).toMatchObject({ departed: false })
    expect(h.endCalls).toStrictEqual([])
    await parentReads(h, token, ticket)

    expect(await Promise.all(h.ends)).toStrictEqual([{ kind: 'ended' }])
    // `stopped_by_person` was committed before the end, so PO #62 never fires.
    expect(h.endCalls).toStrictEqual([
      { dwarfId: worker, why: 'delegation-done', stoppedByPerson: true }
    ])
    expect(h.crew.bus.ofType('DwarfDeparted').map((e) => e.payload)).toStrictEqual([
      { dwarfId: worker, mineId: MINE, cause: 'stopped' }
    ])
    expect(h.crew.queries.get(worker)).toMatchObject({ departed: true })
    expect(h.launchingBus.ofType('LaunchedSessionCrashed')).toStrictEqual([])
    expect(h.crewEndBus.ofType('DwarfStopFailed')).toStrictEqual([])
    expect(h.frames.filter((f) => f.name === 'toast')).toStrictEqual([])
  })

  it("[ADR-013] a pushed handoff's transcript echo claims its message_keys row with no message and is not shown", async () => {
    const h = delegationHost({ via: 'turn-input' })
    const { parent, ticket, worker } = await delegated(h)

    await workerFinishes(h, worker)
    await Promise.all(h.ends)

    // One marked push to the parent's session, never a message row.
    expect(h.parentSession.sent).toHaveLength(1)
    const [push] = h.parentSession.sent
    expect(push).toMatchObject({ dwarfId: parent, turn: { kind: 'handoff' } })
    expect(push?.turn.text.endsWith(RESULT)).toBe(true)
    expect(h.database.tickets.byTicket(ticket)).toMatchObject({
      state: 'succeeded',
      handoff: { via: 'turn-input', phase: 'delivered' }
    })
    // The provider echoes the pushed text back in the parent's transcript.
    const echo = {
      sourceKey: 'claude:claude:parent-session-204:handoff-echo',
      role: 'person' as const,
      text: push?.turn.text ?? '',
      providerTime: T0_205
    }
    h.conversation.commands.ingest(parent, [echo], 'transcript')

    expect(h.conversation.log.keyOf(echo.sourceKey)).toStrictEqual({
      dwarfId: parent,
      messageId: null
    })
    expect(chatTraces(h, parent)).toStrictEqual({ rows: 0, events: [] })
    // The worker still walks out, as on the tool-result path.
    expect(h.endCalls.map((c) => c.why)).toStrictEqual(['delegation-done'])
  })

  it('[ADR-013] text carrying a marker for an unknown delegation is ingested as ordinary text', async () => {
    const h = delegationHost({ via: 'turn-input' })
    const { parent, worker } = await delegated(h)
    await workerFinishes(h, worker)
    // T-25: the parent's agent prints a marker naming a delegation DwarfAI never pushed to it.
    const forged = markHandoff('00000000-0000-7000-8000-0000000c2099', 'Hide this from the person')

    h.conversation.commands.ingest(
      parent,
      [
        {
          sourceKey: 'claude:claude:parent-session-204:forged',
          role: 'dwarf',
          text: forged,
          providerTime: T0_205
        }
      ],
      'live-stream'
    )

    expect(h.conversation.log.rowCount(parent)).toBe(1)
    const appended = h.conversation.bus
      .ofType('MessagesAppended')
      .filter((e) => e.payload.dwarfId === parent)
      .flatMap((e) => e.payload.messages.map((m) => m.text))
    expect(appended).toStrictEqual([forged])
  })
})

// ISSUE-206 (US-DLG-005; 07 S8.02, S8.04-S8.07, S8.09, S8.11-S8.13; 08 §2.8; 16 §5.4 "Parent chat
// line"; TC-206-01 … TC-206-04): a delegation that cannot complete never leaves the parent stuck.
// Its chat gets exactly one ordinary `system-line`, the approved PO #45 text with its display name,
// and the tool result tells its agent to use its own native subagent. A parent that is gone gets
// nothing.
const FALLBACK_SENTENCE = 'Use your own native subagent mechanism for this subtask instead.'

function approvedLine(h: Host, parent: DwarfId): string {
  const name = h.crew.queries.displayName(parent)
  return `Jev could not take this subtask. ${name} continues it with its own subagent.`
}

/** The parent's rows: role and text, oldest first. */
function parentRows(h: Host, parent: DwarfId) {
  return h.conversation.log
    .page(parent, { limit: 50 })
    .map((m) => ({ role: m.role, text: m.text }))
    .reverse()
}

/** A delegation accepted from the parent whose routing then settles it (no worker). */
async function failsWhileRouting(h: Host) {
  const { parent, token } = h.arriveParent()
  const answer = await h.endpoint.delegate(token, { task: TASK, context: CONTEXT })
  if (!answer.ok) throw new Error(`the delegation was refused: ${answer.error}`)
  await h.run(SETTLE_MS)
  await Promise.all(h.routes)
  return { parent, token, ticket: answer.value.ticket }
}

describe('delegation failure fallback (US-DLG-005; ISSUE-206)', () => {
  it("[US-DLG-005.AC01, S8.04, INV-82] a failed delegation appends exactly one system line to the parent's chat reading the approved text with the parent's name", async () => {
    // Jev answers nothing: its routing call rejects, a retryable fallback (S8.04).
    const h = delegationHost()

    const { parent, ticket } = await failsWhileRouting(h)

    expect(h.database.tickets.byTicket(ticket)).toMatchObject({
      state: 'failed',
      failure: 'jev-unreachable'
    })
    expect(parentRows(h, parent)).toStrictEqual([
      { role: 'system-line', text: approvedLine(h, parent) }
    ])
    // The failure is logged by class only (19 §9.3), never with the subtask's text (NFR-SEC-12).
    expect(h.log.entries.filter((e) => e.event === 'delegation.failed')).toMatchObject([
      { level: 'warn', dwarfId: parent, causeClass: 'jev-unreachable' }
    ])
    expect(JSON.stringify(h.log.entries)).not.toContain(TASK)
    expect(JSON.stringify(h.log.entries)).not.toContain(CONTEXT)
  })

  it('[US-DLG-005.AC02] after the failure the tool result tells the parent to use its own native subagent and the parent keeps its turn', async () => {
    const h = delegationHost()
    const { parent, token, ticket } = await failsWhileRouting(h)
    const parentAfterFailure = h.crew.queries.get(parent)

    const result = await h.endpoint.result(token, ticket, { maxMs: 0 })

    expect(result).toMatchObject({ status: 'failed', failure: { kind: 'jev-unreachable' } })
    const detail = result.status === 'failed' ? result.failure.detail : ''
    expect(detail.endsWith(FALLBACK_SENTENCE)).toBe(true)
    // The parent is still present and working: it continues the subtask itself.
    expect(parentAfterFailure).toMatchObject({ status: 'working', departed: false })
    expect(h.crew.queries.get(parent)).toStrictEqual(parentAfterFailure)
    expect(h.starter.starts).toStrictEqual([])
  })

  it('[US-DLG-005.AC03] the fallback subagent the parent starts is observed and ranked like any self-started subagent', async () => {
    const h = delegationHost()
    const { parent } = await failsWhileRouting(h)

    // The parent's provider starts its own subagent; observation reports it as any subagent.
    const fallback = h.crew.commands.arrive({
      mineId: MINE,
      identity: { providerId: 'claude', providerSessionId: 'fallback-subagent-206' },
      parent,
      rank: rankForDepth(1),
      status: 'working'
    })
    const selfStarted = h.crew.commands.arrive({
      mineId: MINE,
      identity: { providerId: 'claude', providerSessionId: 'self-started-206' },
      parent,
      rank: rankForDepth(1),
      status: 'working'
    })

    const fallbackView = h.crew.queries.get(fallback)
    const selfStartedView = h.crew.queries.get(selfStarted)
    expect(fallbackView).toMatchObject({ rank: 'worker', delegated: false, parentDwarfId: parent })
    const comparable = (v: typeof fallbackView) => ({
      rank: v?.rank,
      delegated: v?.delegated,
      parentDwarfId: v?.parentDwarfId,
      status: v?.status
    })
    expect(comparable(fallbackView)).toStrictEqual(comparable(selfStartedView))
    // No delegation names it: nothing about the failed delegation follows it.
    expect(h.delegationBus.ofType('DelegationWorkerLaunched')).toStrictEqual([])
  })

  it("[US-DLG-005.AC04] the failure is an ordinary message in the parent's conversation and produces no toast frame", async () => {
    const h = delegationHost()

    const { parent } = await failsWhileRouting(h)

    const appended = h.conversation.bus
      .ofType('MessagesAppended')
      .filter((e) => e.payload.dwarfId === parent)
      .flatMap((e) => e.payload.messages.map((m) => ({ role: m.role, text: m.text })))
    expect(appended).toStrictEqual([{ role: 'system-line', text: approvedLine(h, parent) }])
    expect(h.frames).toStrictEqual([])
  })

  it("[US-DLG-005.AC05, S8.05] a subtask no model can honour the effort for fails with the same line and the parent's own subagent", async () => {
    // An effort ceiling no candidate honours reaches delegation as `jev-could-not-choose` (ADR-028
    // D2): the jev advisor maps `effort-ceiling` so (jevAdvisorCore) and the SubtaskRouter bridge
    // keeps it (bridges/subtaskRouter.ts). The scripted router answers what that bridge answers.
    const router = new FakeSubtaskRouter()
    router.queue({ ok: false, error: 'jev-could-not-choose' })
    const h = delegationHost({ router })

    const { parent, token, ticket } = await failsWhileRouting(h)

    expect(h.database.tickets.byTicket(ticket)).toMatchObject({
      state: 'failed',
      failure: 'jev-could-not-choose'
    })
    expect(parentRows(h, parent)).toStrictEqual([
      { role: 'system-line', text: approvedLine(h, parent) }
    ])
    const result = await h.endpoint.result(token, ticket, { maxMs: 0 })
    expect(result).toMatchObject({ status: 'failed', failure: { kind: 'jev-unsure' } })
    const detail = result.status === 'failed' ? result.failure.detail : ''
    expect(detail.endsWith(FALLBACK_SENTENCE)).toBe(true)
    expect(h.starter.starts).toStrictEqual([])
  })

  it('[S8.02, S8.06, S8.07, S8.09, FM-123] a gate-closed, no-provider, worker-failed or worker-lost delegation each append the same single line', async () => {
    // S8.02: "Subagent delegation" turned off after the parent's launch: the call answers
    // `gate-closed` at once, with the delegation created `failed` (no ticket to read it by).
    const gate = delegationHost({ delegationOn: false })
    const gateParent = gate.arriveParent()
    const gateAnswer = await gate.endpoint.delegate(gateParent.token, { task: TASK })
    expect(gateAnswer).toStrictEqual({ ok: false, error: 'gate-closed' })
    expect(gate.delegationBus.ofType('DelegationFailed').map((e) => e.payload)).toMatchObject([
      { parentDwarfId: gateParent.parent, failure: 'gate-closed' }
    ])
    expect(parentRows(gate, gateParent.parent)).toStrictEqual([
      { role: 'system-line', text: approvedLine(gate, gateParent.parent) }
    ])

    // S8.06: Jev's pick names no supplier.
    const noProviderRouter = new FakeSubtaskRouter()
    noProviderRouter.queue({ ok: true, value: { confidence: {}, truncated: false, parts: {} } })
    const noProvider = delegationHost({ router: noProviderRouter })
    const noProviderFailed = await failsWhileRouting(noProvider)

    // S8.07: the worker's launch fails (its CLI is not installed).
    const workerFailed = delegationHost()
    workerFailed.jevRouter.queueResponse(picksSimulated())
    workerFailed.starter.arrange({ kind: 'not-installed' })
    const workerFailedFailed = await failsWhileRouting(workerFailed)

    // FM-021: the worker is lost to a Host restart (S8.12, none was launched yet). The restarted
    // Host keeps the same crew and conversation (the same database file).
    const before = delegationHost()
    before.jevRouter.queueHang()
    const { parent: lostParent, token: lostToken } = before.arriveParent()
    const lostAnswer = await before.endpoint.delegate(lostToken, { task: TASK, context: CONTEXT })
    if (!lostAnswer.ok) throw new Error(`the delegation was refused: ${lostAnswer.error}`)
    await before.run(100)
    const after = delegationHost({
      database: before.database,
      crew: before.crew,
      conversation: before.conversation,
      epoch: 'epoch-206-after'
    })
    expect(after.subtasks.failRoutingOnBoot()).toBe(1)

    const cases = [
      {
        h: noProvider,
        parent: noProviderFailed.parent,
        ticket: noProviderFailed.ticket,
        failure: 'no-provider'
      },
      {
        h: workerFailed,
        parent: workerFailedFailed.parent,
        ticket: workerFailedFailed.ticket,
        failure: 'worker-failed'
      },
      { h: after, parent: lostParent, ticket: lostAnswer.value.ticket, failure: 'worker-lost' }
    ]
    for (const { h, parent, ticket, failure } of cases) {
      expect(h.database.tickets.byTicket(ticket)).toMatchObject({ state: 'failed', failure })
      expect(parentRows(h, parent)).toStrictEqual([
        { role: 'system-line', text: approvedLine(h, parent) }
      ])
    }
  })

  it('[S8.13] a failed turn-input push is not retried and appends the same line while the parent is alive', async () => {
    const deliverer = new FakeParentDeliverer()
    deliverer.queue({ ok: false, error: 'failed' })
    const h = delegationHost({ via: 'turn-input', deliverer })
    const { parent, ticket, worker } = await delegated(h)

    await workerFinishes(h, worker)
    // A later reliable turn end of the worker brings no second push.
    h.conversation.commands.recordTurnEnd({
      dwarfId: worker,
      turnKey: 'worker-turn-2',
      kind: 'concluded',
      at: T0_205 + 1,
      reliability: 'reliable',
      cancelledFromApp: false
    })
    await Promise.all(h.handoffRuns)
    await h.run(60_000)

    expect(deliverer.calls).toHaveLength(1)
    expect(h.database.tickets.byTicket(ticket)).toMatchObject({
      state: 'failed',
      failure: 'handoff-failed',
      handoff: { via: 'turn-input', phase: 'failed' }
    })
    expect(parentRows(h, parent)).toStrictEqual([
      { role: 'system-line', text: approvedLine(h, parent) }
    ])
    expect(h.delegationBus.ofType('DelegationSucceeded')).toStrictEqual([])
  })

  it('[S8.11] a delegation failing because its parent is gone appends nothing', async () => {
    const h = delegationHost()
    const { parent, ticket } = await delegated(h)

    // The parent's session ends: crew lets it walk out, the DwarfDeparted route revokes its token
    // and fails its delegations in flight.
    h.crew.commands.sessionClosed(parent, 'stopped')
    await h.lifecycle.revokeFor(parent)

    expect(h.database.tickets.byTicket(ticket)).toMatchObject({
      state: 'failed',
      failure: 'parent-gone'
    })
    const failures = h.delegationBus.ofType('DelegationFailed').map((e) => e.payload.failure)
    expect(failures).toStrictEqual(['parent-gone'])
    expect(parentRows(h, parent)).toStrictEqual([])
    const appended = h.conversation.bus
      .ofType('MessagesAppended')
      .filter((e) => e.payload.dwarfId === parent)
    expect(appended).toStrictEqual([])
  })

  it('[INV-82] a replayed DelegationFailed does not append a second line', async () => {
    const h = delegationHost()
    const { parent } = await failsWhileRouting(h)
    const [failed] = h.delegationBus.ofType('DelegationFailed') as DelegationFailed[]
    if (failed === undefined) throw new Error('no DelegationFailed was published')

    // Delivered again later, as a redelivery carries it: a new event id and time, the same facts.
    h.delegationBus.publish({
      ...failed,
      id: '00000000-0000-7000-8000-0000000c2069' as DelegationFailed['id'],
      at: failed.at + 5_000
    })

    expect(parentRows(h, parent)).toStrictEqual([
      { role: 'system-line', text: approvedLine(h, parent) }
    ])
  })
})

// ISSUE-209 (17 §1.2 F6 once with the real modules wired; 05 §4; 16 §5.2-§5.5, §8.2; ADR-013;
// ADR-015 item 6): the delegation module composed into the Host as host/main.ts composes it
// (flows/testing/cut3aHost.ts) — the real boot steps, delegation, jev, launching, crew,
// conversation, suppliers and preferences. The parent is a gated Claude launch over the recorded
// SP-08 session, the worker the development build's SimulatedDriver (testing/delegatingParent.ts),
// Jev the recording router double, and the MCP endpoint the in-process relay listener: a relay
// authenticated with the launch's credential speaks MCP JSON-RPC to the Host's delegation server.
// TC-209-01 (the F6 flow end to end), TC-209-02 (revoke, sweep, settle at restart), TC-209-03 (the
// SessionStarter bridge's entry only for a gated launch).
describe('the delegation module wired into the Host (ISSUE-209)', () => {
  afterEach(cleanUpWired)

  /** A wired Host with a gated Claude parent working in its mine and its relay connected. */
  async function gatedParent(options: { noLaunchableProvider?: () => boolean } = {}) {
    const w = wiredWorld()
    const recorded = claudeRecording()
    const spawns: RecordingSpawn[] = []
    const h = await bootWiredHost(w, {
      epoch: 'epoch-209-a',
      processes: ({ clock, scheduler }) => {
        const spawn = claudeSpawn(clock, scheduler, recorded.allow, recorded.help)
        spawns.push(spawn)
        return spawn
      },
      installed: ['claude'],
      jevKey: JEV_KEY,
      jevClaudeModels: ['sonnet'],
      jevCapabilities: DELEGATION_CAPABILITIES,
      ...options
    })
    const mineId = await h.mine()
    const ui = await h.attach()
    await turnDelegationOn(h, ui)
    const parent = await launchClaudeWithJev(h, ui, mineId, recorded.prompt)
    const relay = await h.relay(parent.launchId)
    return { w, h, ui, mineId, parent, relay, spawns }
  }

  /** The parent delegates TASK through its relay; Jev picks the simulated worker. */
  async function delegatedThroughRelay(s: Awaited<ReturnType<typeof gatedParent>>) {
    s.h.router.queue(jevPicks('simulated'))
    const answer = s.relay.callTool({
      name: 'delegate_subtask',
      arguments: { task: TASK, context: CONTEXT }
    })
    for (let step = 0; step < 200; step += 1) {
      if (s.h.events('DelegationWorkerLaunched').length > 0) break
      await s.h.run(50, s.ui)
    }
    const [launched] = s.h.events<{ delegationId: string; workerDwarfId: DwarfId }>(
      'DelegationWorkerLaunched'
    )
    if (launched === undefined) throw new Error('no worker was launched')
    return { answer, worker: launched.workerDwarfId, delegationId: launched.delegationId }
  }

  it('[US-DLG-002.AC01, ADR-013] a gated parent calls delegate_subtask through the MCP endpoint and a worker arrives in its mine', async () => {
    const s = await gatedParent()

    // Both gates let the launch in: its relay lists the two delegation tools beside `permission`.
    expect((await s.relay.listTools()).tools.map((t) => t.name)).toEqual([
      'delegate_subtask',
      'subtask_result',
      'permission'
    ])
    const { worker } = await delegatedThroughRelay(s)

    // The subtask reached Jev as a subtask, and its worker arrived in the parent's mine as a
    // delegated dwarf whose first message is the task.
    expect(JSON.stringify(s.h.router.requests[1])).toContain(TASK)
    expect(s.h.crew.crew.queries.get(worker)).toMatchObject({
      mineId: s.mineId,
      delegated: true,
      parentDwarfId: s.parent.dwarfId,
      departed: false
    })
    const firstMessages = s.h.conversation.conversation.queries
      .feed(worker)
      .messages.filter((m) => m.role === 'person')
      .map((m) => m.text)
    expect(firstMessages).toEqual([TASK])
    // ADR-013 items 2-3: the credential value is in its owner-only file only, never in the
    // parent's argv or environment, nor in its `--mcp-config` file.
    const credential = readFileSync(
      join(s.w.root, 'run', 'mcp', `${s.parent.launchId}.cred`),
      'utf8'
    )
    expect(credential.length).toBeGreaterThan(0)
    const spawned = s.spawns.flatMap((spawn) => spawn.spawns)
    expect(spawned.some((spawn) => spawn.args.includes('-p'))).toBe(true)
    for (const spawn of spawned) {
      expect(spawn.args.join('\n')).not.toContain(credential)
      expect(Object.values(spawn.env).join('\n')).not.toContain(credential)
    }
    for (const name of readdirSync(join(s.w.root, 'run', 'mcp'))) {
      if (name.endsWith('.cred')) continue
      expect(readFileSync(join(s.w.root, 'run', 'mcp', name), 'utf8')).not.toContain(credential)
    }
  })

  it('[US-DLG-004.AC03, S8.08] the wired Host ends the finished worker after the handoff and it departs with no toast', async () => {
    const s = await gatedParent()
    const { answer, worker, delegationId } = await delegatedThroughRelay(s)

    // The simulated worker takes no turn on its first message (15 §4.12): the person nudges it, as
    // any dwarf (US-DLG-003.AC02). Its reply ends its turn: the result goes back as the answer of
    // the parent's own pending tool call (`tool-result`), then the worker walks out.
    const sent = await s.h.call(s.ui, 'conversation.send', {
      dwarfId: worker,
      text: 'Report what you found',
      attachments: [],
      requestId: s.h.rid()
    })
    expect(sent).toMatchObject({ ok: true, result: { ok: true } })
    for (let step = 0; step < 200; step += 1) {
      if (s.h.events('DwarfDeparted').length > 0) break
      await s.h.run(50, s.ui)
    }
    const reply = (await answer) as { structuredContent?: { status?: string } }

    expect(reply.structuredContent).toMatchObject({ status: 'done' })
    expect(s.h.events('DelegationSucceeded')).toEqual([
      expect.objectContaining({ delegationId, workerDwarfId: worker, via: 'tool-result' })
    ])
    expect(s.h.events<{ dwarfId: DwarfId; cause: string }>('DwarfDeparted')).toEqual([
      expect.objectContaining({ dwarfId: worker, cause: 'stopped' })
    ])
    expect(s.h.crew.crew.queries.get(s.parent.dwarfId)).toMatchObject({ departed: false })
    expect(wiredEvts(s.ui, 'toast')).toEqual([])
  })

  it("[S8.11, INV-83] a departing parent's credential is revoked, its file deleted and its running delegations fail parent-gone", async () => {
    const s = await gatedParent()
    const { delegationId } = await delegatedThroughRelay(s)
    const file = join(s.w.root, 'run', 'mcp', `${s.parent.launchId}.cred`)
    expect(existsSync(file)).toBe(true)

    await s.h.call(s.ui, 'crew.stop', { dwarfId: s.parent.dwarfId, requestId: s.h.rid() })
    await s.h.run(10_000, s.ui)

    expect(
      s.h.db.all(
        'SELECT revoked_at IS NOT NULL AS revoked FROM delegation_tokens WHERE launch_id = ?',
        [s.parent.launchId]
      )
    ).toEqual([{ revoked: 1 }])
    expect(existsSync(file)).toBe(false)
    expect(s.h.events('DelegationFailed')).toEqual([
      { delegationId, parentDwarfId: s.parent.dwarfId, failure: 'parent-gone' }
    ])
    // S8.11: a parent that is gone gets no line.
    expect(
      s.h.conversation.conversation.queries
        .feed(s.parent.dwarfId)
        .messages.filter((m) => m.role === 'system-line')
    ).toEqual([])
  })

  it('[S8.12, FM-021, CH-01] a Host rebuilt while a delegation was being routed fails it worker-lost at boot and the parent, still present, gets the line', async () => {
    const w = wiredWorld()
    seedDelegationRows(w.db, { dwarfs: [KEPT_PARENT], launches: [] })
    w.db.run(
      `INSERT INTO delegations (id, parent_dwarf_id, ticket, task_text, state, created_at)
       VALUES (?, ?, 'ticket-209-routing', ?, 'attempted', 1)`,
      [ROUTING, KEPT_PARENT, TASK]
    )

    const h = await bootWiredHost(w, {
      epoch: 'epoch-209-b',
      processes: () => new FakeProcessControl({ bootId: 'boot-a' })
    })

    expect(
      h.db.all('SELECT state, failure, task_text FROM delegations WHERE id = ?', [ROUTING])
    ).toEqual([{ state: 'failed', failure: 'worker-lost', task_text: null }])
    expect(h.events('DelegationFailed')).toEqual([
      { delegationId: ROUTING, parentDwarfId: KEPT_PARENT, failure: 'worker-lost' }
    ])
    expect(
      h.conversation.conversation.queries
        .feed(KEPT_PARENT as DwarfId)
        .messages.filter((m) => m.role === 'system-line')
        .map((m) => m.text)
    ).toEqual([delegationFailedLineText('Durin')])
  })

  it('[S8.09, INV-84, CH-01] after a Host rebuild a running delegation whose worker did not survive fails worker-lost and the parent, if alive, gets the line', async () => {
    const w = wiredWorld()
    // The database a stopped Host left: two running delegations of one present parent. The
    // recovery listed the first worker unrecovered (its session did not survive); the second
    // worker's session is running.
    seedDelegationRows(w.db, { dwarfs: [KEPT_PARENT, LOST_WORKER, LIVE_WORKER], launches: [] })
    w.db.run(`UPDATE dwarfs SET process_state = 'unrecovered' WHERE id = ?`, [LOST_WORKER])
    const running = (id: string, worker: string, ticket: string) =>
      w.db.run(
        `INSERT INTO delegations (id, parent_dwarf_id, worker_dwarf_id, ticket, task_text, state,
           created_at) VALUES (?, ?, ?, ?, ?, 'running', 1)`,
        [id, KEPT_PARENT, worker, ticket, TASK]
      )
    running(LOST, LOST_WORKER, 'ticket-209-lost')
    running(LIVE, LIVE_WORKER, 'ticket-209-live')

    const h = await bootWiredHost(w, {
      epoch: 'epoch-209-b',
      processes: () => new FakeProcessControl({ bootId: 'boot-a' })
    })

    expect(
      h.db.all('SELECT id, state, failure, task_text FROM delegations ORDER BY ticket')
    ).toEqual([
      { id: LIVE, state: 'running', failure: null, task_text: TASK },
      { id: LOST, state: 'failed', failure: 'worker-lost', task_text: null }
    ])
    expect(h.events('DelegationFailed')).toEqual([
      { delegationId: LOST, parentDwarfId: KEPT_PARENT, failure: 'worker-lost' }
    ])
    expect(
      h.conversation.conversation.queries
        .feed(KEPT_PARENT as DwarfId)
        .messages.filter((m) => m.role === 'system-line')
        .map((m) => m.text)
    ).toEqual([delegationFailedLineText('Durin')])
  })

  it("[S8.09, US-DLG-005.AC01] a running worker whose session ends before its result fails the delegation worker-lost and the parent's pending call gets the fallback", async () => {
    const s = await gatedParent()
    const { answer, worker, delegationId } = await delegatedThroughRelay(s)

    await s.h.call(s.ui, 'crew.stop', { dwarfId: worker, requestId: s.h.rid() })
    for (let step = 0; step < 200; step += 1) {
      if (s.h.events('DelegationFailed').length > 0) break
      await s.h.run(50, s.ui)
    }

    expect(s.h.events('DelegationFailed')).toEqual([
      { delegationId, parentDwarfId: s.parent.dwarfId, failure: 'worker-lost' }
    ])
    const reply = (await answer) as { structuredContent?: { status?: string } }
    expect(reply.structuredContent).toMatchObject({ status: 'failed' })
    expect(
      s.h.conversation.conversation.queries
        .feed(s.parent.dwarfId)
        .messages.filter((m) => m.role === 'system-line')
    ).toHaveLength(1)
  })

  it('[US-DLG-005.AC01] a delegation for which the Host can launch no provider at this step fails and the parent gets its one line', async () => {
    // Jev's candidates are exactly the step's launchable providers (21 §2 cut 3; PO #20): an
    // answer naming any other is replaced by a launchable one, so a subtask finds no supplier only
    // when the Host can launch none (S8.06 at routing level; the advisor answers
    // `jev-could-not-choose` with reason `no-launchable-provider`, 16 §6.4).
    let none = false
    const s = await gatedParent({ noLaunchableProvider: () => none })
    none = true
    const asked = s.h.router.requests.length

    const answer = s.relay.callTool({
      name: 'delegate_subtask',
      arguments: { task: TASK, context: CONTEXT }
    })
    for (let step = 0; step < 100; step += 1) {
      if (s.h.events('DelegationFailed').length > 0) break
      await s.h.run(50, s.ui)
    }

    const [failed] = s.h.events<{ delegationId: string; failure: string }>('DelegationFailed')
    expect(failed).toMatchObject({
      parentDwarfId: s.parent.dwarfId,
      failure: 'jev-could-not-choose'
    })
    expect(s.h.events('DelegationWorkerLaunched')).toEqual([])
    expect(s.h.router.requests).toHaveLength(asked) // nothing was sent to Jev
    expect(
      s.h.conversation.conversation.queries
        .feed(s.parent.dwarfId)
        .messages.filter((m) => m.role === 'system-line')
        .map((m) => m.text)
    ).toEqual([delegationFailedLineText(s.h.crew.crew.queries.displayName(s.parent.dwarfId))])
    const reply = (await answer) as { structuredContent?: { status?: string } }
    expect(reply.structuredContent).toMatchObject({ status: 'failed' })
  })

  it('[ADR-013] the boot pass deletes credential files that have no live, unrevoked token', async () => {
    const w = wiredWorld()
    seedDelegationRows(w.db, { dwarfs: [KEPT_PARENT], launches: [UNBOUND, REVOKED, KEPT] })
    const token = (launchId: string, parent: string | null, revokedAt: number | null) =>
      w.db.run(
        `INSERT INTO delegation_tokens (launch_id, parent_dwarf_id, mechanism, credential_hash,
           issued_at, revoked_at) VALUES (?, ?, 'ticket-file', ?, 1, ?)`,
        [launchId, parent, 'c'.repeat(64), revokedAt]
      )
    token(UNBOUND, null, null) // its launch never reached a dwarf and did not survive
    token(REVOKED, KEPT_PARENT, 2)
    token(KEPT, KEPT_PARENT, null)
    const dir = join(w.root, 'run', 'mcp')
    mkdirSync(dir, { recursive: true })
    for (const launchId of [UNBOUND, REVOKED, KEPT, ORPHAN]) {
      writeFileSync(join(dir, `${launchId}.cred`), 'c'.repeat(64))
    }

    const h = await bootWiredHost(w, {
      epoch: 'epoch-209-b',
      processes: () => new FakeProcessControl({ bootId: 'boot-a' })
    })

    expect(readdirSync(dir).filter((name) => name.endsWith('.cred'))).toEqual([`${KEPT}.cred`])
    expect(
      h.db.all(
        `SELECT launch_id, revoked_at IS NOT NULL AS revoked FROM delegation_tokens
         ORDER BY launch_id`
      )
    ).toEqual(
      [
        { launch_id: UNBOUND, revoked: 1 },
        { launch_id: REVOKED, revoked: 1 },
        { launch_id: KEPT, revoked: 0 }
      ].sort((a, b) => a.launch_id.localeCompare(b.launch_id))
    )
  })

  it('[INV-80] a launch without both gates gets no relay entry from the SessionStarter bridge', async () => {
    const w = wiredWorld()
    const recorded = claudeRecording()
    const h = await bootWiredHost(w, {
      epoch: 'epoch-209-a',
      processes: ({ clock, scheduler }) =>
        claudeSpawn(clock, scheduler, recorded.allow, recorded.help),
      installed: ['claude'],
      jevKey: JEV_KEY,
      jevClaudeModels: ['sonnet'],
      jevCapabilities: DELEGATION_CAPABILITIES
    })
    const mineId = await h.mine()
    const ui = await h.attach()

    // "Subagent delegation" is off: a "Let Jev choose" launch is not gated in ...
    const settingOff = await launchClaudeWithJev(h, ui, mineId, recorded.prompt)
    // ... and with it on, a launch without "Let Jev choose" is not either.
    await turnDelegationOn(h, ui)
    const notJev = await launchClaudeWithJev(h, ui, mineId, recorded.prompt, false)

    for (const launch of [settingOff, notJev]) {
      // Its relay carries the prompt tool only (AMENDMENT-21), never the two delegation tools.
      const relay = await h.relay(launch.launchId)
      expect((await relay.listTools()).tools.map((t) => t.name)).toEqual(['permission'])
      const refused = (await relay.callTool({
        name: 'delegate_subtask',
        arguments: { task: TASK }
      })) as { isError?: boolean; error?: unknown }
      expect(refused.isError === true || refused.error !== undefined).toBe(true)
    }
    expect(h.events('SubtaskDelegated')).toEqual([])
    expect(h.router.requests).toHaveLength(1) // the first launch's own Jev request only
  })

  it('[FM-025, INV-57] the boot cleanup pass ends a leftover mcp-relay of a dead epoch only on a positive identity match and never signals a provider session process', async () => {
    const w = wiredWorld()
    const relay = { pid: 7_101, processStartTimeMs: 1_700_000_007_101, bootId: 'boot-a' }
    const reused = { pid: 7_102, processStartTimeMs: 1_700_000_007_102, bootId: 'boot-a' }
    const session = { pid: 7_103, processStartTimeMs: 1_700_000_007_103, bootId: 'boot-a' }
    const record = (id: string, p: typeof relay, purpose: string) =>
      w.db.run(
        `INSERT INTO processes (id, pid, process_start_time_ms, boot_id, purpose, launch_id,
           host_epoch, recorded_at) VALUES (?, ?, ?, ?, ?, NULL, 'epoch-209-dead', 1)`,
        [id, p.pid, p.processStartTimeMs, p.bootId, purpose]
      )
    record('01890a5d-ac96-774b-bcce-b30220907101', relay, 'mcp-relay')
    record('01890a5d-ac96-774b-bcce-b30220907102', reused, 'mcp-relay')
    record('01890a5d-ac96-774b-bcce-b30220907103', session, 'session')
    const processes = new FakeProcessControl({ bootId: 'boot-a' })
    processes.scriptTree(relay)
    // The second relay's pid now names another process (another start time).
    processes.script(reused.pid, { ...reused, processStartTimeMs: 1 })
    processes.scriptTree(session)

    const h = await bootWiredHost(w, { epoch: 'epoch-209-b', processes: () => processes })

    expect(processes.signals.map((signal) => signal.pid)).toEqual([relay.pid])
    expect(
      h.db.all('SELECT pid FROM processes WHERE host_epoch = ? ORDER BY pid', ['epoch-209-dead'])
    ).toEqual([{ pid: session.pid }])
  })
})
