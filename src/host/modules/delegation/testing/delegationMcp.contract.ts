// `runDelegationMcpContract` (16 §5.7; ADR-013 items 1, 3–4; 07 S8.01, S8.02): the two delegation
// tools as a relay of a delegating session calls them, over the real `DelegationEndpoint`
// application service, in-memory stores, a fake clock and scheduler, a recording bus and log.
// Every `DelegationServer` runs it: the real `McpDelegationServer` (through an MCP client over a
// frame pair) and `FakeDelegationServer` (the handler called directly).
//
// "The router" of the gate cases is what routes an `attempted` delegation: the subscriber of
// `SubtaskDelegated` (the routing route, later: ISSUE-204). Its recorded calls are Jev requests.
// Test-only (R14).
import { describe, expect, it } from 'vitest'
import { CANARY_CORPUS } from '../../../../contracts/logging/testing/canaryCorpus'
import type { DwarfId, Instant, LaunchId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import {
  DelegationEndpointService,
  type DelegationEndpointEvent
} from '../application/delegationEndpoint'
import { applyEvent, type Delegation } from '../domain/delegation'
import { MAX_DELEGATIONS_PER_PARENT } from '../domain/limits'
import { NATIVE_SUBAGENT_FALLBACK_SENTENCE } from '../domain/toolFailure'
import type { DelegationToken } from '../ports/delegationStores'
import {
  DELEGATION_WAIT_MS,
  type DelegationEndpoint,
  type SubtaskResultView
} from '../ports/delegationServer'
import { InMemoryDelegationTicketStore } from '../ports/fakes/InMemoryDelegationTicketStore'
import { InMemoryDelegationTokenStore } from '../ports/fakes/InMemoryDelegationTokenStore'
import { drawCredential, hashOf } from './drawCredential'

/** One tool answer as the relay reads it. */
export interface ToolAnswer {
  view: SubtaskResultView
  /** MCP `isError`; never set for a delegation failure (16 §5.4). */
  isError: boolean
}

/** The two tools as the relay of the bound launch calls them. */
export interface DelegationToolCaller {
  delegateSubtask(args: { task: string; context?: string }): Promise<ToolAnswer>
  subtaskResult(args: { ticket: string }): Promise<ToolAnswer>
}

/** Starts the server under test on `handler`, connected as the relay of `token`'s launch. */
export type DelegationServerUnderTest = (
  handler: DelegationEndpoint,
  token: DelegationToken
) => Promise<{ caller: DelegationToolCaller; dispose(): Promise<void> }>

const T0: Instant = 1_750_000_000_000
const PARENT = '01890a5d-ac96-774b-bcce-b302099a8d01' as DwarfId
const OTHER_PARENT = '01890a5d-ac96-774b-bcce-b302099a8d02' as DwarfId
const WORKER = '01890a5d-ac96-774b-bcce-b302099a8d03' as DwarfId
const LAUNCH = '01890a5d-ac96-774b-bcce-b302099a8a01' as LaunchId
const TASK = 'Summarise the failing test in the parser module'
const CONTEXT = 'The parser lives in src/parser and its tests in src/parser/tests'

/** Lets pending promise callbacks and stream events run (no timer). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

interface Options {
  delegationOn?: boolean
  delegated?: boolean
  launchedWithLetJevChoose?: boolean
  parent?: DwarfId | null
}

export function runDelegationMcpContract(name: string, serve: DelegationServerUnderTest): void {
  async function setUp(options: Options = {}) {
    const clock = new FakeClock(T0)
    const scheduler = new FakeScheduler(clock)
    const log = new RecordingDiagnosticsLog()
    const bus = new RecordingEventBus<DelegationEndpointEvent>()
    const tokens = new InMemoryDelegationTokenStore()
    const tickets = new InMemoryDelegationTicketStore()
    const prefs = { subagentDelegationOn: options.delegationOn ?? true }
    const routed: Array<{ delegationId: string }> = []
    bus.subscribe('SubtaskDelegated', (e) => routed.push({ delegationId: e.payload.delegationId }))
    tokens.issue({
      launchId: LAUNCH,
      parentDwarfId: options.parent === undefined ? PARENT : options.parent,
      mechanism: 'ticket-file',
      credentialHash: hashOf(drawCredential()),
      issuedAt: T0
    })
    const endpoint = new DelegationEndpointService({
      tokens,
      tickets,
      launches: {
        gateOf: (launchId) =>
          launchId === LAUNCH
            ? {
                launchedWithLetJevChoose: options.launchedWithLetJevChoose ?? true,
                delegated: options.delegated ?? false
              }
            : null
      },
      preferences: {
        get: () => ({
          subagentDelegationOn: prefs.subagentDelegationOn,
          routingProfile: 'balanced',
          systemNotificationsOn: true,
          openCodePermissionsOn: false
        })
      },
      transactions: { inTransaction: (work) => work() },
      bus,
      clock,
      ids: new SequenceIdGenerator(),
      hostEpoch: 'epoch-1',
      scheduler
    })
    // The handle the transport binds: the row without its hash.
    const handle: DelegationToken = {
      launchId: LAUNCH,
      parentDwarfId: options.parent === undefined ? PARENT : options.parent,
      mechanism: 'ticket-file',
      issuedAt: T0
    }
    const server = await serve(endpoint, handle)
    return { clock, log, bus, tokens, tickets, prefs, routed, endpoint, ...server }
  }

  type Setup = Awaited<ReturnType<typeof setUp>>

  /** `delegate_subtask` run until it answers, the clock driven past the wait. */
  async function delegateFully(s: Setup, args = { task: TASK, context: CONTEXT }) {
    const answer = s.caller.delegateSubtask(args)
    await flush()
    s.clock.advance(DELEGATION_WAIT_MS)
    await flush()
    return answer
  }

  function failedDetail(answer: ToolAnswer): string {
    if (answer.view.status !== 'failed')
      throw new Error(`expected failed, got ${answer.view.status}`)
    return answer.view.failure.detail
  }

  describe(`runDelegationMcpContract: ${name}`, () => {
    it('[US-DLG-001.AC03, S8.02] with the setting off delegate_subtask answers failed with kind disabled and the router records zero calls', async () => {
      const s = await setUp()
      // Turned off after the launch was gated in: the call is re-checked (INV-80).
      s.prefs.subagentDelegationOn = false

      const answer = await delegateFully(s)

      expect(answer.isError).toBe(false)
      expect(answer.view).toMatchObject({ status: 'failed', failure: { kind: 'disabled' } })
      expect(s.routed).toEqual([])
      // S8.02: one failed delegation, no task kept, and the failure event (one parent line).
      const failed = s.bus.ofType('DelegationFailed')
      expect(failed.map((e) => e.payload)).toEqual([
        expect.objectContaining({ parentDwarfId: PARENT, failure: 'gate-closed' })
      ])
      expect(s.tickets.snapshot()).toEqual([
        expect.objectContaining({ state: 'failed', failure: 'gate-closed', parentDwarfId: PARENT })
      ])
      expect(s.tickets.snapshot()[0]?.task).toBeUndefined()
      await s.dispose()
    })

    it('[S8.01] with both gates open delegate_subtask records an attempted delegation with its ticket', async () => {
      const s = await setUp()

      const answer = await delegateFully(s)

      const rows = s.tickets.snapshot()
      expect(rows).toEqual([
        expect.objectContaining({
          state: 'attempted',
          parentDwarfId: PARENT,
          task: TASK,
          context: CONTEXT
        })
      ])
      expect(answer).toEqual({
        view: { status: 'pending', ticket: rows[0]?.ticket },
        isError: false
      })
      expect(s.routed).toEqual([{ delegationId: rows[0]?.id }])
      expect(s.bus.ofType('SubtaskDelegated').map((e) => e.payload)).toEqual([
        { delegationId: rows[0]?.id, parentDwarfId: PARENT }
      ])
      await s.dispose()
    })

    it('[ADR-013] a call above the limits or from a delegated worker answers concurrency-limit or depth-exceeded and creates no delegation', async () => {
      const full = await setUp()
      for (let i = 0; i < MAX_DELEGATIONS_PER_PARENT; i += 1) await delegateFully(full)
      const before = full.tickets.snapshot()

      const above = await delegateFully(full)

      expect(above.view).toMatchObject({ status: 'failed', failure: { kind: 'concurrency-limit' } })
      expect(full.tickets.snapshot()).toEqual(before)
      await full.dispose()

      const worker = await setUp({ delegated: true, launchedWithLetJevChoose: false })
      const deep = await delegateFully(worker)
      expect(deep.view).toMatchObject({ status: 'failed', failure: { kind: 'depth-exceeded' } })
      expect(worker.tickets.snapshot()).toEqual([])
      expect(worker.routed).toEqual([])
      expect(worker.bus.published).toEqual([])
      await worker.dispose()
    })

    it('[ADR-013] every failed tool result ends with the fallback sentence and never sets isError', async () => {
      const s = await setUp()
      // An in-flight delegation that settles failed while subtask_result waits on it.
      const first = await delegateFully(s)
      if (first.view.status !== 'pending') throw new Error('expected pending')
      const ticket = first.view.ticket
      const waiting = s.caller.subtaskResult({ ticket })
      await flush()
      const row = s.tickets.byTicket(ticket) as Delegation
      const settled = applyEvent(row, { type: 'jev-unreachable' }, T0 + 1)
      if (!settled.ok) throw new Error('expected a transition')
      s.tickets.save(settled.value.delegation)
      s.endpoint.delegationSettled(ticket)
      await flush()
      const jev = await waiting
      expect(jev.view).toMatchObject({ status: 'failed', failure: { kind: 'jev-unreachable' } })

      const unknown = await s.caller.subtaskResult({ ticket: 'no-such-ticket' })
      const second = await delegateFully(s)
      s.prefs.subagentDelegationOn = false
      const disabled = await delegateFully(s)
      s.prefs.subagentDelegationOn = true
      const third = await delegateFully(s)
      // Two in flight for this parent now (the settled one freed its slot): the cap refuses.
      const limit = await delegateFully(s)
      const answers = [jev, unknown, disabled, limit]

      expect([second.view.status, third.view.status]).toEqual(['pending', 'pending'])
      expect(answers.map((a) => (a.view.status === 'failed' ? a.view.failure.kind : ''))).toEqual([
        'jev-unreachable',
        'unknown-ticket',
        'disabled',
        'concurrency-limit'
      ])
      for (const answer of answers) {
        expect(answer.isError).toBe(false)
        expect(failedDetail(answer).endsWith(NATIVE_SUBAGENT_FALLBACK_SENTENCE)).toBe(true)
      }
      await s.dispose()
    })

    it('[ADR-013] subtask_result waits up to DELEGATION_WAIT_MS and answers pending with the ticket when nothing settled', async () => {
      const s = await setUp()
      const first = await delegateFully(s)
      if (first.view.status !== 'pending') throw new Error('expected pending')
      const { ticket } = first.view
      let answered: ToolAnswer | undefined
      const waiting = s.caller.subtaskResult({ ticket }).then((a) => (answered = a))
      await flush()

      s.clock.advance(DELEGATION_WAIT_MS - 1)
      await flush()
      expect(answered).toBeUndefined()

      s.clock.advance(1)
      await flush()
      await waiting
      expect(answered).toEqual({ view: { status: 'pending', ticket }, isError: false })
      await s.dispose()
    })

    it('[16 §5.2, AMENDMENT-14] a delegate call before the parent is bound waits until bindParent releases it', async () => {
      const s = await setUp({ parent: null })
      let answered = false
      const answer = s.caller.delegateSubtask({ task: TASK }).then((a) => {
        answered = true
        return a
      })
      await flush()
      s.clock.advance(DELEGATION_WAIT_MS)
      await flush()
      expect(answered).toBe(false)
      expect(s.tickets.snapshot()).toEqual([])

      s.tokens.bindParent(LAUNCH, PARENT)
      s.endpoint.parentBound(LAUNCH)
      await flush()
      s.clock.advance(DELEGATION_WAIT_MS)
      await flush()

      expect((await answer).view.status).toBe('pending')
      expect(s.tickets.snapshot()).toEqual([expect.objectContaining({ parentDwarfId: PARENT })])
      await s.dispose()
    })

    it('[ADR-013] a ticket of another parent is unknown to this relay', async () => {
      const s = await setUp()
      s.tickets.put({
        id: 'd-other' as Delegation['id'],
        ticket: 'ticket-of-another-parent',
        parentDwarfId: OTHER_PARENT,
        workerDwarfId: WORKER,
        state: 'running',
        createdAt: T0
      })

      const answer = s.caller.subtaskResult({ ticket: 'ticket-of-another-parent' })
      await flush()

      expect((await answer).view).toMatchObject({
        status: 'failed',
        failure: { kind: 'unknown-ticket' }
      })
      await s.dispose()
    })

    it('[NFR-SEC-12] no task, context or result text reaches a log record', async () => {
      const s = await setUp()
      const [task, context] = CANARY_CORPUS.filter((c) => c.class === 'content').map((c) => c.value)
      await delegateFully(s, { task: task ?? TASK, context: context ?? CONTEXT })
      s.prefs.subagentDelegationOn = false
      await delegateFully(s, { task: task ?? TASK, context: context ?? CONTEXT })

      const logged = JSON.stringify([s.log.entries, s.log.refused, s.bus.published])
      expect(logged).not.toContain(task)
      expect(logged).not.toContain(context)
      await s.dispose()
    })
  })
}
