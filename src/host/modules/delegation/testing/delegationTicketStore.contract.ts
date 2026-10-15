// The DelegationTicketStore conformance suite (16 §4.8; 06 §11.1 `Delegation`; 09 §4.6; 17 §1.3):
// run on the in-memory double and on the SQLite adapter over the template database (schema v1).
// `put` records a new delegation, `byTicket` returns it field for field, `save` writes its next
// state along machine 8 (07 §8), `inFlight` lists the attempted and running ones. The 09 CHECKs are the store's rules on both: `succeeded` only
// with `handoff.phase = 'delivered'` (INV-68), the task and context only while in flight, `failure`
// exactly when `failed`, `settledAt` exactly when settled, the worker never the parent, one
// delegation per ticket. The store joins the caller's transaction, so a rollback undoes its write.
// Never imported by production code (R14).
import { afterEach, describe, expect, it } from 'vitest'
import type { DwarfId, Instant } from '../../../kernel/domain/values'
import { applyEvent, type Delegation, type DelegationId } from '../domain/delegation'
import type { SubtaskText } from '../domain/subtaskText'
import type { DelegationTicketStore } from '../ports/delegationStores'

/** The dwarfs every subject provides (the SQLite subject seeds their rows). */
export const TICKET_PARENT = '00000000-0000-7000-8000-0000000d2d01' as DwarfId
export const TICKET_WORKER = '00000000-0000-7000-8000-0000000d2d02' as DwarfId
export const TICKET_OTHER_WORKER = '00000000-0000-7000-8000-0000000d2d03' as DwarfId

export interface DelegationTicketStoreSubject {
  store: DelegationTicketStore
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
  /** Every stored delegation, by id. */
  rows(): Delegation[]
  /** Every value the subject stores, serialized, to prove what it no longer keeps. */
  storedText(): string
  dispose(): void | Promise<void>
}

class CallerFailure extends Error {}

const T0: Instant = 1_750_000_000_000
const T1: Instant = T0 + 60_000
const T2: Instant = T0 + 120_000

const TASK = 'Review the parser diff for off-by-one errors' as SubtaskText
const CONTEXT = 'The diff touches src/parse.ts only' as SubtaskText

function delegationId(n: number): DelegationId {
  return `00000000-0000-7000-8000-0000000d2e${n.toString(16).padStart(2, '0')}` as DelegationId
}

function attempted(n = 1): Delegation {
  return {
    id: delegationId(n),
    parentDwarfId: TICKET_PARENT,
    ticket: `ticket-${n}`,
    task: TASK,
    context: CONTEXT,
    state: 'attempted',
    createdAt: T0
  }
}

/** `d` without its task and context, as a settled delegation is stored. */
function noText(d: Delegation): Delegation {
  const kept = { ...d }
  delete (kept as { task?: SubtaskText }).task
  delete (kept as { context?: SubtaskText }).context
  return kept
}

function running(n = 1): Delegation {
  return { ...attempted(n), state: 'running', workerDwarfId: TICKET_WORKER }
}

export function runDelegationTicketStoreContract(
  makeSubject: () => DelegationTicketStoreSubject | Promise<DelegationTicketStoreSubject>
): void {
  describe('DelegationTicketStore contract', () => {
    let subject: DelegationTicketStoreSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async (): Promise<DelegationTicketStoreSubject> => {
      subject = await makeSubject()
      return subject
    }

    const put = (s: DelegationTicketStoreSubject, d: Delegation): void =>
      s.inTransaction(() => s.store.put(d))
    const save = (s: DelegationTicketStoreSubject, d: Delegation): void =>
      s.inTransaction(() => s.store.save(d))

    it('[ADR-013] put stores a delegation and byTicket returns it field for field; an unknown ticket is null', async () => {
      const s = await setUp()
      const inFlight = attempted(1)
      const gateClosed: Delegation = {
        id: delegationId(2),
        parentDwarfId: TICKET_PARENT,
        ticket: 'ticket-2',
        state: 'failed',
        failure: 'gate-closed',
        createdAt: T1,
        settledAt: T1
      }
      const noContext: Delegation = { ...noText(attempted(3)), task: TASK }

      put(s, inFlight)
      put(s, gateClosed)
      put(s, noContext)

      expect(s.store.byTicket('ticket-1')).toStrictEqual(inFlight)
      expect(s.store.byTicket('ticket-2')).toStrictEqual(gateClosed)
      expect(s.store.byTicket('ticket-3')).toStrictEqual(noContext)
      expect(s.store.byTicket('ticket-unknown')).toBeNull()
    })

    it('[ADR-013] save moves a delegation along machine 8: the worker, the handoff and the settlement are stored', async () => {
      const s = await setUp()
      put(s, attempted())
      save(s, running())
      const sending: Delegation = {
        ...running(),
        handoff: { via: 'turn-input', phase: 'sending', phaseAt: T1 }
      }
      save(s, sending)
      expect(s.store.byTicket('ticket-1')).toStrictEqual(sending)

      const delivered = applyEvent(sending, { type: 'handoff-delivered' }, T2)
      if (!delivered.ok) throw new Error('the domain refused handoff-delivered')
      save(s, delivered.value.delegation)

      expect(s.store.byTicket('ticket-1')).toStrictEqual({
        id: delegationId(1),
        parentDwarfId: TICKET_PARENT,
        workerDwarfId: TICKET_WORKER,
        ticket: 'ticket-1',
        state: 'succeeded',
        handoff: { via: 'turn-input', phase: 'delivered', phaseAt: T2 },
        createdAt: T0,
        settledAt: T2
      })
    })

    it('[INV-68] saving a succeeded delegation without handoff phase delivered is rejected', async () => {
      const s = await setUp()
      put(s, attempted())
      save(s, running())
      const settled = { state: 'succeeded', settledAt: T2 } as const

      expect(() => save(s, noText({ ...running(), ...settled }))).toThrow()
      expect(() =>
        save(
          s,
          noText({
            ...running(),
            ...settled,
            handoff: { via: 'tool-result', phase: 'sending', phaseAt: T1 }
          })
        )
      ).toThrow()
      expect(() => put(s, noText({ ...running(2), ...settled }))).toThrow()

      expect(s.rows()).toStrictEqual([running()])
    })

    it('[ADR-013] a settled delegation keeps no task or context text', async () => {
      const s = await setUp()
      put(s, attempted())
      const gone = applyEvent(attempted(), { type: 'parent-session-ended' }, T1)
      if (!gone.ok) throw new Error('the domain refused parent-session-ended')

      expect(() => save(s, { ...gone.value.delegation, task: TASK, context: CONTEXT })).toThrow()
      expect(() => save(s, { ...gone.value.delegation, task: TASK })).toThrow()
      expect(s.store.byTicket('ticket-1')).toStrictEqual(attempted())

      save(s, gone.value.delegation)

      expect(s.store.byTicket('ticket-1')).toStrictEqual({
        id: delegationId(1),
        parentDwarfId: TICKET_PARENT,
        ticket: 'ticket-1',
        state: 'failed',
        failure: 'parent-gone',
        createdAt: T0,
        settledAt: T1
      })
      const stored = s.storedText()
      expect(stored).not.toContain(TASK)
      expect(stored).not.toContain(CONTEXT)
    })

    it('[ADR-013] failure is stored exactly with failed, settledAt exactly when settled, and a worker is never the parent', async () => {
      const s = await setUp()
      expect(() => put(s, { ...attempted(), failure: 'no-provider' })).toThrow()
      expect(() => put(s, noText({ ...attempted(), state: 'failed', settledAt: T1 }))).toThrow()
      expect(() => put(s, { ...attempted(), settledAt: T1 })).toThrow()
      expect(() => put(s, { ...running(), workerDwarfId: TICKET_PARENT })).toThrow()
      expect(s.rows()).toStrictEqual([])
    })

    it('[ADR-013] a ticket and an id are stored once, a worker serves one delegation, and save changes only a delegation that exists', async () => {
      const s = await setUp()
      put(s, running(1))

      expect(() => put(s, { ...attempted(2), ticket: 'ticket-1' })).toThrow()
      expect(() => put(s, { ...attempted(1), ticket: 'ticket-9' })).toThrow()
      expect(() => put(s, running(2))).toThrow()
      expect(() => save(s, running(3))).toThrow()
      put(s, { ...running(2), workerDwarfId: TICKET_OTHER_WORKER })

      expect(s.rows()).toStrictEqual([
        running(1),
        { ...running(2), workerDwarfId: TICKET_OTHER_WORKER }
      ])
    })

    it('[ADR-013] a rolled-back caller transaction leaves the delegation as it was', async () => {
      const s = await setUp()
      put(s, attempted(1))

      expect(() =>
        s.inTransaction(() => {
          s.store.save(running(1))
          s.store.put(attempted(2))
          throw new CallerFailure('the caller failed after the writes')
        })
      ).toThrow(CallerFailure)

      expect(s.rows()).toStrictEqual([attempted(1)])
      expect(s.store.byTicket('ticket-2')).toBeNull()
    })

    // Owner amendment N (AMENDMENT-14, OQ-85), 2026-10-15 (A14-03): `revokeFor` and the INV-84
    // boot reconcile read the delegations still in flight.
    it('[S8.11, INV-84] inFlight lists the attempted and running delegations by id, never a settled one', async () => {
      const s = await setUp()
      const settled = applyEvent(attempted(3), { type: 'parent-session-ended' }, T1)
      if (!settled.ok) throw new Error('S8.11 settles an attempted delegation')

      expect(s.store.inFlight()).toStrictEqual([])
      put(s, running(2))
      put(s, attempted(1))
      put(s, settled.value.delegation)

      expect(s.store.inFlight()).toStrictEqual([attempted(1), running(2)])
    })
  })
}
