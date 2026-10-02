import { describe, expect, it } from 'vitest'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import { applyPresence, arriveDwarf, causeOnExit, recordPendingEnd, type Dwarf } from './dwarf'
import {
  arrivedPresence,
  closeProcess,
  depart,
  departureCause,
  isGone,
  nextPresence,
  type DepartureCause,
  type DwarfPresence,
  type EndReason,
  type PresenceEvent,
  type PresenceState
} from './presence'
import { rankForDepth } from './rank'
import { classifyDwarfStatus } from './status'

// The diagram-conformance table of machine 2 (07 §2): every S2 id appears in exactly one title.
const T0 = 1_790_000_000_000
const SEC = 1_000
const YEAR = 365 * 24 * 3_600 * SEC

const ROOT = 'dwarf-root' as DwarfId
const CHILD = 'dwarf-child' as DwarfId
const GRANDCHILD = 'dwarf-grandchild' as DwarfId

/** The mine, identity and names an arrival binds (ISSUE-069); a subagent has its own agent id. */
const bound = (agentId?: string) => ({
  mineId: 'mine-1' as MineId,
  identity:
    agentId === undefined
      ? { providerId: 'claude', providerSessionId: 'session-1' }
      : { providerId: 'claude', providerSessionId: 'session-1', providerAgentId: agentId },
  baseName: `claude-${agentId ?? 'session-'}`,
  delegated: false
})

/** An observed root that arrived with no message yet, in a mine the app already knows. */
const root = (): Dwarf =>
  arriveDwarf({
    ...bound(),
    id: ROOT,
    parentDwarfId: null,
    rank: rankForDepth(0),
    status: 'idle',
    at: T0
  })

const present = (): PresenceState => arrivedPresence()

const closed = (cause: DepartureCause, at = T0 + SEC): PresenceEvent => ({
  type: 'session-closed',
  cause,
  at
})

/** The state a dwarf is in once it departed with `cause` at `at` (INV-26: process closed first). */
const departed = (cause: DepartureCause, at = T0 + SEC) => ({
  presence: 'walking-out',
  processState: 'closed',
  departedAt: at,
  departureCause: cause
})

/** A dwarf the Host recovery pass listed unrecovered (S2.08 → S2.10). */
const listedUnrecovered = (): Dwarf => {
  const resuming = applyPresence(root(), { type: 'resume-pending' })
  if (!resuming.ok) throw new Error(resuming.error)
  const listed = applyPresence(resuming.value, { type: 'listed-unrecovered' })
  if (!listed.ok) throw new Error(listed.error)
  return listed.value
}

describe('machine 2, dwarf presence (07 §2; ADR-032 item 2)', () => {
  it('[US-OBS-002.AC01, S2.01] a session in an existing mine makes the dwarf present at once, before any message', () => {
    const dwarf = root()
    expect(dwarf).toMatchObject({
      presence: 'present',
      processState: 'running',
      departedAt: null,
      departureCause: null,
      arrivedAt: T0
    })
    expect(isGone(dwarf)).toBe(false)
    // No message has been sent: the dwarf is already there, idle (S1.02).
    expect(classifyDwarfStatus(dwarf.facts, T0)).toBe('idle')
  })

  it('[S2.02, S2.03] the Host holds no arriving value: the walk-in and a direct station both draw a dwarf that is already present', () => {
    const presences: readonly DwarfPresence[] = ['present', 'resuming', 'walking-out']
    expect(presences).toContain(arrivedPresence().presence)
    expect(arrivedPresence().presence).toBe('present')
    // @ts-expect-error `arriving` is a renderer animation, never a `DwarfPresence` (07 §2).
    const arriving: DwarfPresence = 'arriving'
    expect(presences).not.toContain(arriving)
  })

  it('[US-OBS-005.AC01, S2.16, BR-11] no amount of silence, window close or Quit moves a present dwarf', () => {
    const quiet = [
      'silence',
      'window-closed',
      'app-quit',
      'ui-reconnecting',
      'inferred-turn-end'
    ] as const
    for (const what of quiet) {
      expect(nextPresence(present(), { type: 'quiet', what })).toEqual({
        ok: true,
        value: present()
      })
    }
    // A year of silence: the status goes to sleep, the dwarf stays in its mine.
    const dwarf = root()
    expect(classifyDwarfStatus(dwarf.facts, T0 + YEAR)).toBe('asleep')
    expect(applyPresence(dwarf, { type: 'quiet', what: 'silence' })).toEqual({
      ok: true,
      value: dwarf
    })
  })

  it('[US-OBS-005.AC02, S2.04, S2.05, S2.06] a stop, a mine removal and an outside close all depart by the same sessionClosed path with their own cause', () => {
    const cases: { why: EndReason | null; owned: boolean; cause: DepartureCause }[] = [
      { why: 'stop-dwarf', owned: true, cause: 'stopped' },
      { why: 'remove-mine', owned: true, cause: 'mine-removed' },
      { why: null, owned: false, cause: 'closed-elsewhere' }
    ]
    for (const c of cases) {
      const ending = c.why === null ? root() : recordPendingEnd(root(), c.why)
      const cause = causeOnExit(ending, c.owned)
      expect(cause).toBe(c.cause)
      const after = applyPresence(ending, closed(c.cause))
      expect(after.ok && after.value).toMatchObject({
        ...departed(c.cause),
        facts: { processState: 'closed' }
      })
    }
  })

  it('[US-OBS-008.AC05] a subagent dwarf departs by the same rule as any dwarf', () => {
    const dwarfs = [
      root(),
      arriveDwarf({
        ...bound('agent-child'),
        id: CHILD,
        parentDwarfId: ROOT,
        rank: rankForDepth(1),
        status: 'idle',
        at: T0
      }),
      arriveDwarf({
        ...bound('agent-grandchild'),
        id: GRANDCHILD,
        parentDwarfId: CHILD,
        rank: rankForDepth(2),
        status: 'idle',
        at: T0
      })
    ]
    for (const dwarf of dwarfs) {
      expect(causeOnExit(dwarf, false)).toBe('closed-elsewhere')
      expect(causeOnExit(recordPendingEnd(dwarf, 'stop-dwarf'), true)).toBe('stopped')
      const after = applyPresence(dwarf, closed('closed-elsewhere'))
      expect(after).toEqual({
        ok: true,
        value: {
          ...dwarf,
          ...departed('closed-elsewhere'),
          facts: { ...dwarf.facts, processState: 'closed' }
        }
      })
      // The rank stays the one fixed at arrival.
      expect(after.ok && after.value.rank).toBe(dwarf.rank)
    }
  })

  it('[INV-26] a departure before the process state is closed is refused', () => {
    expect(depart(present(), 'stopped', T0)).toEqual({ ok: false, error: 'process-not-closed' })
    const unrecovered: PresenceState = { ...present(), processState: 'unrecovered' }
    expect(depart(unrecovered, 'recovery-dismissed', T0)).toEqual({
      ok: false,
      error: 'process-not-closed'
    })
    const gone = depart(closeProcess(present()), 'stopped', T0)
    expect(gone).toEqual({ ok: true, value: departed('stopped', T0) })
    // One departure per dwarf.
    expect(gone.ok && depart(gone.value, 'crashed', T0 + SEC)).toEqual({
      ok: false,
      error: 'already-departed'
    })
    expect(gone.ok && nextPresence(gone.value, closed('crashed'))).toEqual({
      ok: false,
      error: 'already-departed'
    })
  })

  it('[INV-26] every pending end maps to its departure cause and host-recovery departs nobody', () => {
    const table: [EndReason | null, boolean, DepartureCause | null][] = [
      ['stop-dwarf', true, 'stopped'],
      ['stop-all', true, 'stopped'],
      ['delegation-done', true, 'stopped'],
      ['remove-mine', true, 'mine-removed'],
      ['remove-mine', false, 'mine-removed'],
      ['stop-dwarf', false, 'stopped'],
      ['host-recovery', true, null],
      [null, true, 'crashed'],
      [null, false, 'closed-elsewhere']
    ]
    for (const [why, owned, cause] of table) {
      expect({ why, owned, cause: departureCause(why, owned) }).toEqual({ why, owned, cause })
    }
    const recovering = recordPendingEnd(root(), 'host-recovery')
    expect(causeOnExit(recovering, true)).toBeNull()
  })

  it('[S2.07] an owned session that exits with no pending end departs crashed; an observed one departs closed-elsewhere', () => {
    expect(causeOnExit(root(), true)).toBe('crashed')
    expect(causeOnExit(root(), false)).toBe('closed-elsewhere')
    const crashed = applyPresence(root(), closed('crashed'))
    expect(crashed.ok && crashed.value).toMatchObject(departed('crashed'))
  })

  it('[S2.08, S2.10] a resuming dwarf stays present and a listed unrecovered one stays with processState unrecovered', () => {
    const resuming = applyPresence(root(), { type: 'resume-pending' })
    expect(resuming.ok && resuming.value).toMatchObject({
      presence: 'resuming',
      processState: 'running',
      departedAt: null
    })
    expect(resuming.ok && isGone(resuming.value)).toBe(false)

    const listed = listedUnrecovered()
    expect(listed).toMatchObject({
      presence: 'present',
      processState: 'unrecovered',
      departedAt: null,
      departureCause: null
    })
    expect(isGone(listed)).toBe(false)
    // Drawn idle, then asleep (S1.19): the status machine still runs for it.
    expect(listed.facts.processState).toBe('running')
    expect(classifyDwarfStatus(listed.facts, T0 + YEAR)).toBe('asleep')
  })

  it('[S2.09] a resumed dwarf is present again, silently, with the same id and rank', () => {
    const resuming = applyPresence(root(), { type: 'resume-pending' })
    const resumed = resuming.ok && applyPresence(resuming.value, { type: 'resumed' })
    expect(resumed).toEqual({ ok: true, value: root() })
    expect(nextPresence(present(), { type: 'resumed' })).toEqual({
      ok: false,
      error: 'not-resuming'
    })
  })

  it('[S2.11] a listed dwarf whose retry resumes the same session is running again', () => {
    expect(applyPresence(listedUnrecovered(), { type: 'retry-succeeded' })).toEqual({
      ok: true,
      value: { ...listedUnrecovered(), processState: 'running' }
    })
    expect(nextPresence(present(), { type: 'retry-succeeded' })).toEqual({
      ok: false,
      error: 'not-unrecovered'
    })
  })

  it('[S2.12, S2.13] a failed retry or a dismissal closes a listed unrecovered dwarf and it departs recovery-failed or recovery-dismissed', () => {
    for (const cause of ['recovery-failed', 'recovery-dismissed'] as const) {
      const after = applyPresence(listedUnrecovered(), closed(cause))
      expect(after.ok && after.value).toMatchObject({
        ...departed(cause),
        facts: { processState: 'closed' }
      })
    }
  })

  it('[S2.19] a dismissal while the listed dwarf session still runs moves nothing', () => {
    // A turn-lost item whose session resumed (S2.09) is listed for information only.
    expect(nextPresence(present(), closed('recovery-dismissed'))).toEqual({
      ok: false,
      error: 'session-running'
    })
  })

  it('[S2.14] a resuming dwarf that is stopped or whose mine is removed departs by the ordinary path', () => {
    for (const cause of ['stopped', 'mine-removed'] as const) {
      const resuming = applyPresence(root(), { type: 'resume-pending' })
      const after = resuming.ok && applyPresence(resuming.value, closed(cause))
      expect(after && after.ok && after.value).toMatchObject(departed(cause))
    }
  })

  it('[S2.15] a failed stop keeps the dwarf present with its real status and forgets the pending end', () => {
    const stopping = recordPendingEnd(root(), 'stop-dwarf')
    const after = applyPresence(stopping, { type: 'stop-failed' })
    expect(after).toEqual({ ok: true, value: root() })
    // A later close the person did not ask for is then not read as their stop.
    expect(after.ok && causeOnExit(after.value, false)).toBe('closed-elsewhere')
  })

  it('[S2.17] a departed dwarf is out of the crew at once; the walk-out finishing is the renderer', () => {
    const after = applyPresence(root(), closed('stopped'))
    expect(after.ok && isGone(after.value)).toBe(true)
    expect(isGone(root())).toBe(false)
    expect(after.ok && nextPresence(after.value, { type: 'resume-pending' })).toEqual({
      ok: false,
      error: 'already-departed'
    })
  })

  it('[S2.18] a dwarf of a previous epoch ended by a reboot or logout departs closed-elsewhere at boot', () => {
    const boot = T0 + YEAR
    for (const before of [root(), listedUnrecovered()]) {
      const after = applyPresence(before, closed('closed-elsewhere', boot))
      expect(after.ok && after.value).toMatchObject(departed('closed-elsewhere', boot))
      expect(after.ok && isGone(after.value)).toBe(true)
    }
  })
})
