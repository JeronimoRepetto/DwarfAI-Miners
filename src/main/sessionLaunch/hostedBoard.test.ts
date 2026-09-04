import { describe, expect, it } from 'vitest'
import { PANEL_OBSERVER, type Dwarf, type Mine, type MineTier } from '../domain/types'
import { stampHostedProcesses } from './hostedBoard'
import type { HostedProcessState } from './hostedProcesses'

const MINE_PATH = '/home/j/code/anvil'
const MINE_ID = 'mine:/home/j/code/anvil'

const tierOf = (): MineTier => 'bronze'

/**
 * Every call passes the platform explicitly, which is the house rule: paths are
 * normalized per OS (case-insensitively on Windows and macOS, case-SENSITIVELY
 * on Linux), so a POSIX fixture asserted against the host's own normalization
 * would pass on one machine and fail on another.
 */
function stamp(
  mines: Mine[],
  states: HostedProcessState[],
  tier: (path: string) => MineTier = tierOf
): Mine[] {
  return stampHostedProcesses(mines, states, tier, 'linux')
}

function mine(overrides: Partial<Mine> = {}): Mine {
  return {
    id: MINE_ID,
    path: MINE_PATH,
    name: 'anvil',
    tier: 'bronze',
    dwarfs: [],
    tokensObserved: 0,
    updatedAt: 5,
    ...overrides
  }
}

function claudeDwarf(): Dwarf {
  return {
    id: 'claude:abc',
    provider: 'claude',
    role: 'foreman',
    name: 'anvil-1',
    status: 'working',
    sessionId: 'abc'
  }
}

function hosted(overrides: Partial<HostedProcessState> = {}): HostedProcessState {
  return {
    hostedId: 'hosted:1',
    mineId: MINE_ID,
    minePath: MINE_PATH,
    program: 'my-agent',
    running: true,
    conversation: [
      { role: 'user', text: 'dig the east gallery', timestamp: '2026-09-04T00:00:00.000Z' }
    ],
    ...overrides
  }
}

describe('putting a hosted process on the board', () => {
  it('adds a dwarf to the mine the launch named', () => {
    const stamped = stamp([mine({ dwarfs: [claudeDwarf()] })], [hosted()])

    expect(stamped[0]?.dwarfs.map((dwarf) => dwarf.id)).toEqual(['claude:abc', 'hosted:1'])
  })

  /*
   * The observation axis, and the whole of the wire decision (#194): the panel
   * itself is what observed this dwarf. `DwarfProvider` stays exactly what its
   * own comment says it is — the stores that can be READ — so nothing is added
   * to it, and `launchState.ts`'s rule holds unchanged: no observation ever
   * comes back saying 'other'. This one comes back saying 'panel'.
   */
  it('names the panel as the observer, never a provider', () => {
    const stamped = stamp([mine()], [hosted()])

    expect(stamped[0]?.dwarfs[0]?.provider).toBe(PANEL_OBSERVER)
  })

  /*
   * Role is topology and this is a root by construction — the same reasoning
   * launch.ts states for a launched session: "a run with no parent is a root,
   * and role is topology". So the rank is not a transcript-derived fact and no
   * art has to be invented for it: a hosted dwarf draws with the foreman
   * sheets every other session root draws with.
   */
  it('is a foreman, because a process nobody spawned is a root', () => {
    const stamped = stamp([mine()], [hosted()])

    expect(stamped[0]?.dwarfs[0]?.role).toBe('foreman')
    expect(stamped[0]?.dwarfs[0]?.parentId).toBeUndefined()
  })

  it('is named after the program, which is all there is to name it after', () => {
    const stamped = stamp([mine()], [hosted({ program: 'my-agent' })])

    expect(stamped[0]?.dwarfs[0]?.name).toBe('my-agent')
  })

  /*
   * The receipt the panel adopts its own launch by (`launchedDwarfIn`): the
   * first message of the conversation is the prompt it sent. Nothing else on
   * the board carries one unless this panel is holding its stream, which is
   * what makes the match safe.
   */
  it('carries the exchange this panel watched, so the launch can be recognised', () => {
    const state = hosted()

    const stamped = stamp([mine()], [state])

    expect(stamped[0]?.dwarfs[0]?.conversation).toEqual(state.conversation)
  })

  /*
   * The honest limit the maintainer's decision names, asserted as an absence
   * rather than trusted to a comment: there is no transcript behind this dwarf,
   * so there is nothing that could ever report a model, a token count, a
   * silence, a blocked reason or an open question for it.
   */
  it('claims none of the facts a transcript would have supplied', () => {
    const dwarf = stamp([mine()], [hosted()])[0]!.dwarfs[0]!

    expect(dwarf.model).toBeUndefined()
    expect(dwarf.effort).toBeUndefined()
    expect(dwarf.tokensUsed).toBeUndefined()
    expect(dwarf.tokensObserved).toBeUndefined()
    expect(dwarf.silentForMs).toBeUndefined()
    expect(dwarf.transcriptUpdatedAt).toBeUndefined()
    expect(dwarf.waitingReason).toBeUndefined()
    expect(dwarf.pendingQuestion).toBeUndefined()
    expect(dwarf.mcpServers).toBeUndefined()
    expect(dwarf.totalCostUsd).toBeUndefined()
    expect(dwarf.attendance).toBeUndefined()
    expect(dwarf.pid).toBeUndefined()
  })

  /*
   * `working` here means one thing and says so: this panel is holding a process
   * that has not exited. Splitting it into busy and idle would mean reading
   * meaning out of rendered bytes, which is the heuristic #60 refused and
   * docs/console-hosting.md refused a pty over.
   */
  it('is working while the process is held, which is the only claim available', () => {
    const stamped = stamp([mine()], [hosted({ running: true })])

    expect(stamped[0]?.dwarfs[0]?.status).toBe('working')
  })

  /*
   * A gone process leaves the snapshot, exactly as an ended session does, and
   * the lifecycle tracker then gives its dwarf the same leaving grace and walks
   * it out to a spawn point. Marking it 'leaving' here would be this stamp
   * doing the tracker's job with a second rule.
   */
  it('stops reporting a process that has gone, leaving the lifecycle to walk it out', () => {
    const stamped = stamp([mine()], [hosted({ running: false })])

    expect(stamped[0]?.dwarfs).toEqual([])
  })
})

describe('a hosted process in a mine nobody was working', () => {
  /*
   * The freeze this issue reported, in its most ordinary shape. A mine with no
   * sessions in it is NOT on the board — its interior is not even mounted until
   * the first agent arrives (see MinesState.arrived) — and a launch into one is
   * exactly what Add is for. Every other launch mode gets its mine created by
   * aggregateMines from the provider snapshot's cwd; a hosted process has no
   * snapshot, so this stamp has to contribute the mine as well as the dwarf, or
   * the panel would wait forever for an arrival that has already happened.
   */
  it('creates the mine when the board has none, so the launch is visible at all', () => {
    const stamped = stamp([], [hosted()])

    expect(stamped).toHaveLength(1)
    expect(stamped[0]?.path).toBe(MINE_PATH)
    expect(stamped[0]?.name).toBe('anvil')
    expect(stamped[0]?.dwarfs.map((dwarf) => dwarf.id)).toEqual(['hosted:1'])
  })

  it('gives the created mine the id every other derivation would give it', () => {
    // One derivation, never a second scheme: mineIdForPath is what joins a mine
    // to the ledger and to the projects store (see aggregate.ts).
    const stamped = stamp([], [hosted()])

    expect(stamped[0]?.id).toBe(MINE_ID)
  })

  /*
   * The provisional-tier rule (#41): a mine nobody has walked is drawn as the
   * poorest thing it could be. This asks tierOf, which always answers, and
   * never knownTierOf — the placeholder is for DRAWING, and nothing here
   * records a decision.
   */
  it('asks the tier service for the created mine’s tier', () => {
    const stamped = stamp([], [hosted()], (path) => (path === MINE_PATH ? 'gold' : 'bronze'))

    expect(stamped[0]?.tier).toBe('gold')
  })

  it('creates one mine for two hosted processes started in the same folder', () => {
    const stamped = stampHostedProcesses([], [hosted(), hosted({ hostedId: 'hosted:2' })], tierOf)

    expect(stamped).toHaveLength(1)
    expect(stamped[0]?.dwarfs.map((dwarf) => dwarf.id)).toEqual(['hosted:1', 'hosted:2'])
  })

  it('creates no mine at all for a process that has already gone', () => {
    expect(stamp([], [hosted({ running: false })])).toEqual([])
  })

  it('matches an existing mine by PATH, not by the id the launch remembered', () => {
    // The launch names a mine id; the board is keyed by path through the same
    // normalization. A hosted process must land in the mine that is there
    // rather than beside a second copy of it.
    const stamped = stampHostedProcesses([mine({ id: 'mine:something-else' })], [hosted()], tierOf)

    expect(stamped).toHaveLength(1)
    expect(stamped[0]?.dwarfs.map((dwarf) => dwarf.id)).toEqual(['hosted:1'])
  })
})

describe('what the stamp leaves alone', () => {
  it('changes nothing when no process is held', () => {
    const board = [mine({ dwarfs: [claudeDwarf()] })]

    expect(stamp(board, [])).toEqual(board)
  })

  it('leaves a mine with no hosted process in it untouched', () => {
    const other = mine({ id: 'mine:/home/j/code/forge', path: '/home/j/code/forge', name: 'forge' })

    const stamped = stamp([other], [hosted()])

    expect(stamped.find((entry) => entry.path === '/home/j/code/forge')?.dwarfs).toEqual([])
  })

  it('never replaces the dwarfs a provider already observed', () => {
    const stamped = stamp([mine({ dwarfs: [claudeDwarf()] })], [hosted()])

    expect(stamped[0]?.dwarfs.filter((dwarf) => dwarf.provider === 'claude')).toHaveLength(1)
  })
})
