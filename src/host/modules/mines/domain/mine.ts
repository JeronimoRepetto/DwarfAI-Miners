// The `Mine` aggregate (06 §4.1) and machine 3, its lifecycle (07 §3), as a pure transition
// function; INV-01…INV-09 (06 §4.2) hold for every result. No I/O and no clock read: ids are
// minted by the kernel `IdGenerator` and times are passed in by the use cases (ISSUE-066,
// ISSUE-080). Events and side effects (crew `arrive`/`endAllIn`, starting or aborting a walk) are
// the use cases' work, keyed by the transition id each step returns.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { Instant, MineId } from '../../../kernel/domain/values'
import type { MinePath } from './minePath'
import { tierFor, type SourceWeight, type Tier, type TierThresholds } from './tier'

/** The five stored states (07 §3). `removing` is a command in flight, never stored. */
export type MineState = 'unrecorded' | 'measuring' | 'active' | 'removed' | 'unenterable'

/** A mine's display name: the folder's base name, non-empty, trimmed, never person-edited. */
export type MineName = string & { readonly __brand: 'MineName' }

/** The marker's measured position on the map image, in percent (06 §4.1). */
export interface MapSite {
  readonly xPct: number
  readonly yPct: number
}

export interface Mine {
  readonly id: MineId
  /** The identity: unique across all mines, removed ones included (INV-02). */
  readonly path: MinePath
  readonly name: MineName
  readonly state: MineState
  /** Null until a measurement completes (INV-05); the Bronze placeholder is a display rule. */
  readonly tier: Tier | null
  /** The last measured weight, kept while re-measuring. */
  readonly sourceWeight: SourceWeight | null
  readonly hasBeenMeasured: boolean
  readonly measuredAt?: Instant
  /** Set iff `state = 'unenterable'` (INV-08). */
  readonly unenterableReason?: string
  /** Set iff `state = 'removed'`. */
  readonly removedAt?: Instant
  readonly createdAt: Instant
  /** Project recency: the last dwarf arrival (or launch, recorded by its use case). */
  readonly lastUsedAt: Instant
  readonly mapSite?: MapSite
}

/** What a new mine is born with: an id from the `IdGenerator`, its canonical path, its name. */
export interface MineBirth {
  readonly id: MineId
  readonly path: MinePath
  readonly name: MineName
}

/** The stable transition ids of machine 3 (07 §3). */
export type MineTransitionId =
  | 'S3.01'
  | 'S3.02'
  | 'S3.03'
  | 'S3.04'
  | 'S3.05'
  | 'S3.06'
  | 'S3.07'
  | 'S3.08'
  | 'S3.09'
  | 'S3.10'
  | 'S3.11'
  | 'S3.12'
  | 'S3.13'
  | 'S3.14'
  | 'S3.15'
  | 'S3.16'
  | 'S3.17'
  | 'S3.18'
  | 'S3.19'
  | 'S3.20'
  | 'S3.21'
  | 'S3.22'
  | 'S3.23'
  | 'S3.24'
  | 'S3.25'

/**
 * How a mine comes to exist (INV-04): the first message of an observed session in an unknown
 * folder (S3.01), or in a linked worktree whose main tree has no mine yet (S3.02, the mine is the
 * main tree's); "Add a mine" (S3.04), or its worktree dialog confirmed (S3.05). A refused or
 * cancelled declaration creates nothing (S3.07). A launch never creates a mine.
 */
export type MineOpening =
  | {
      readonly cause: 'first-message' | 'worktree-fold' | 'declared' | 'adopted-main-project'
      readonly birth: MineBirth
    }
  | {
      readonly cause: 'refused'
      readonly reason: 'cancelled' | 'no-main-project' | 'not-a-folder' | 'invalid-path'
    }

/** What can happen to an existing mine. Nothing else is a mine transition (INV-09). */
export type MineInput =
  /** A session observed in the mine's folder, or in a linked worktree folded onto it. */
  | {
      readonly type: 'session-observed'
      readonly inLinkedWorktree: boolean
      /** The session's identity is in `EndedAgentLedger` (ended by the terminator, ADR-014 item 7). */
      readonly endedByTerminator: boolean
    }
  /** "Add a mine" of this mine's folder. */
  | { readonly type: 'declared' }
  /** The worktree dialog confirmed, and this is the main project's mine (PO #41). */
  | { readonly type: 'main-project-adopted' }
  /** The automatic scoring walk shortly after creation (`timer:`). */
  | { readonly type: 'measurement-due' }
  | {
      readonly type: 'measured'
      readonly sourceWeight: SourceWeight
      readonly thresholds: TierThresholds
    }
  /** `mines.remeasure`, or a scheduled re-measurement. */
  | { readonly type: 'remeasure-requested' }
  /** The walk ended because the folder is missing or unreadable. */
  | { readonly type: 'walk-found-unenterable'; readonly reason: string }
  /** `mines.checkFolder`'s finding. */
  | { readonly type: 'folder-checked'; readonly folder: 'present' }
  | { readonly type: 'folder-checked'; readonly folder: 'missing'; readonly reason: string }
  /** `mines.remove` confirmed: crew `endAllIn` starts; the stored state does not change. */
  | { readonly type: 'removal-requested' }
  /** crew `endAllIn`'s outcome: every dwarf ended, or one or more could not be. */
  | { readonly type: 'removal-settled'; readonly everyDwarfEnded: boolean }
  /** The Reset-metrics saga's `db` step (S13.01, ADR-023 item 3). */
  | { readonly type: 'metrics-reset'; readonly hasPresentDwarf: boolean }
  /** A Host boot found this mine. */
  | { readonly type: 'host-booted' }

/**
 * One step of machine 3: the mine afterwards (null = none exists, never created or deleted) and
 * the transition that applied (null = none; the mine is returned unchanged unless a dwarf's
 * arrival refreshed its recency). A self-loop id (S3.03, S3.06, S3.15, S3.22, S3.25) names the
 * rule that held the stored state.
 */
export interface MineStep {
  readonly mine: Mine | null
  readonly transition: MineTransitionId | null
}

/** The map's read model of a mine (06 §4.1): exists iff the mine is not removed. */
export interface MapMarker {
  readonly mineId: MineId
  readonly tier: Tier | null
  readonly site: MapSite | null
  readonly enterable: boolean
  readonly unenterableReason?: string
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A mine id from an `IdGenerator` UUIDv7; anything else (a path-derived id) is refused (INV-01). */
export function mineIdOf(raw: string): MineId {
  if (!UUID_V7.test(raw)) throw new HostInvariantError('a MineId is a UUIDv7 from the IdGenerator')
  return raw as MineId
}

/** A mine name: the folder's base name, trimmed and non-empty. */
export function mineNameOf(raw: string): MineName {
  const name = raw.trim()
  if (name === '') throw new HostInvariantError('a MineName is non-empty')
  return name as MineName
}

/** The `[*] →` transitions of machine 3: S3.01, S3.02, S3.04, S3.05, and S3.07 (nothing). */
export function openMine(opening: MineOpening, now: Instant): MineStep {
  if (opening.cause === 'refused') return { mine: null, transition: 'S3.07' }
  const observed = opening.cause === 'first-message' || opening.cause === 'worktree-fold'
  const mine: Mine = {
    ...opening.birth,
    state: observed ? 'unrecorded' : 'measuring',
    tier: null,
    sourceWeight: null,
    hasBeenMeasured: false,
    createdAt: now,
    lastUsedAt: now
  }
  return { mine, transition: OPENINGS[opening.cause] }
}

const OPENINGS = {
  'first-message': 'S3.01',
  'worktree-fold': 'S3.02',
  declared: 'S3.04',
  'adopted-main-project': 'S3.05'
} as const satisfies Record<string, MineTransitionId>

/** Machine 3 over an existing mine (07 §3). An input outside its source states is no transition. */
export function transition(mine: Mine, input: MineInput, now: Instant): MineStep {
  switch (input.type) {
    case 'session-observed':
      return sessionObserved(mine, input, now)
    case 'declared':
    case 'main-project-adopted':
      if (mine.state === 'removed') return reAdded(mine)
      return input.type === 'main-project-adopted' ? step(mine, 'S3.06') : none(mine)
    case 'measurement-due':
      return mine.state === 'unrecorded'
        ? step({ ...mine, state: 'measuring' }, 'S3.08')
        : none(mine)
    case 'measured':
      if (mine.state !== 'measuring') return none(mine)
      return step(
        {
          ...mine,
          state: 'active',
          tier: tierFor(input.sourceWeight, input.thresholds),
          sourceWeight: input.sourceWeight,
          hasBeenMeasured: true,
          measuredAt: now
        },
        'S3.09'
      )
    case 'remeasure-requested':
      return mine.state === 'active' ? step({ ...mine, state: 'measuring' }, 'S3.10') : none(mine)
    case 'walk-found-unenterable':
      if (mine.state !== 'measuring') return none(mine)
      return step({ ...mine, state: 'unenterable', unenterableReason: input.reason }, 'S3.11')
    case 'folder-checked':
      if (input.folder === 'missing') {
        if (mine.state !== 'unrecorded' && mine.state !== 'active') return none(mine)
        return step({ ...mine, state: 'unenterable', unenterableReason: input.reason }, 'S3.12')
      }
      if (mine.state !== 'unenterable') return none(mine)
      return mine.hasBeenMeasured
        ? step(withState(mine, 'active'), 'S3.13')
        : step(withState(mine, 'measuring'), 'S3.14')
    case 'removal-requested':
      return mine.state === 'removed' ? none(mine) : step(mine, 'S3.15')
    case 'removal-settled':
      if (mine.state === 'removed') return none(mine)
      // INV-06: removed only when every dwarf ended; otherwise the prior state stays.
      if (!input.everyDwarfEnded) return step(mine, 'S3.17')
      return step({ ...mine, state: 'removed', removedAt: now }, 'S3.16')
    case 'metrics-reset':
      if (!input.hasPresentDwarf) return { mine: null, transition: 'S3.23' }
      return step(recreated(mine, now), 'S3.24')
    case 'host-booted':
      return mine.state === 'measuring' ? step(mine, 'S3.25') : none(mine)
    default:
      // INV-09: a window close, a UI detach, any other Reset event is not a mine input.
      return none(mine)
  }
}

/** The map marker of a mine, or null for a removed one (PO #14, #37). */
export function mapMarkerOf(mine: Mine): MapMarker | null {
  if (mine.state === 'removed') return null
  const marker: MapMarker = {
    mineId: mine.id,
    tier: mine.tier,
    site: mine.mapSite ?? null,
    enterable: mine.state !== 'unenterable'
  }
  return mine.unenterableReason === undefined
    ? marker
    : { ...marker, unenterableReason: mine.unenterableReason }
}

function sessionObserved(
  mine: Mine,
  input: Extract<MineInput, { type: 'session-observed' }>,
  now: Instant
): MineStep {
  if (mine.state === 'removed') {
    // A session the terminator ended never rediscovers its mine (ADR-014 item 7).
    if (input.endedByTerminator) return step(mine, 'S3.22')
    const back = { ...withoutRemoval(mine), lastUsedAt: now }
    return mine.hasBeenMeasured
      ? step({ ...back, state: 'active' }, 'S3.20')
      : step({ ...back, state: 'unrecorded' }, 'S3.19')
  }
  if (input.endedByTerminator) return none(mine)
  // INV-02: an existing mine's folder only gains a dwarf, whose arrival refreshes recency.
  const arrived = { ...mine, lastUsedAt: now }
  return input.inLinkedWorktree ? step(arrived, 'S3.03') : { mine: arrived, transition: null }
}

/** A removed mine declared again (INV-07): same id, ledger reattached by its use case. */
function reAdded(mine: Mine): MineStep {
  const back = withoutRemoval(mine)
  return mine.hasBeenMeasured
    ? step({ ...back, state: 'active' }, 'S3.20')
    : step({ ...back, state: 'measuring' }, 'S3.21')
}

/**
 * The ADR-023 item 3 recreation: a fresh mine at the same exact path (no tier, no weight, never
 * measured, a walk queued). The id, name and map site stay, so its present dwarfs reattach as is.
 */
function recreated(mine: Mine, now: Instant): Mine {
  const fresh: Mine = {
    id: mine.id,
    path: mine.path,
    name: mine.name,
    state: 'measuring',
    tier: null,
    sourceWeight: null,
    hasBeenMeasured: false,
    createdAt: now,
    lastUsedAt: now
  }
  return mine.mapSite === undefined ? fresh : { ...fresh, mapSite: mine.mapSite }
}

/** A mine leaving `unenterable`, its reason dropped (INV-08). */
function withState(mine: Mine, state: 'active' | 'measuring'): Mine {
  const next: Draft = { ...mine, state }
  delete next.unenterableReason
  return next
}

function withoutRemoval(mine: Mine): Mine {
  const next: Draft = { ...mine }
  delete next.removedAt
  return next
}

/** A fresh copy of a mine, writable only inside this module while it is built. */
type Draft = { -readonly [K in keyof Mine]: Mine[K] }

function step(mine: Mine, id: MineTransitionId): MineStep {
  return { mine, transition: id }
}

function none(mine: Mine): MineStep {
  return { mine, transition: null }
}
