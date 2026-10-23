/*
 * The Control room mosaic's membership and order (07 machine 32; US-VALLE-006, US-VALLE-009.AC03; UC-058; ADR-024 items
 * 1, 4; OQ-77 A; ISSUE-304): first computed, then the person's own. Pure: the caller hands each input with the facts its
 * guard reads, and carries out the effects (the A-N21 `valleMosaicOrder` write, the toast, A-30's folder flow, the
 * scroll).
 *
 * - The first order (S32.01): every mine with at least one dwarf, in the Host's data order, written at once. A stored
 *   order is restored as stored, an entry whose mine no longer exists dropped and the store never rewritten (S32.02).
 *   After the first visit a mine whose first dwarf arrives does not join by itself (OQ-77 A; 07 I-31): nothing here
 *   recomputes the order from the crews again.
 * - "Close this column" (S32.03) takes the mine out of the order with its toast, and nothing else: the mine, its dwarfs
 *   and their sessions are untouched, nothing goes to the Host (TC-304-02).
 * - The dashed "Add a mine here" slot (`slotMenu`): every mine not in the mosaic with its tier, or disabled and "not
 *   enterable", a rule, then "A new project…", the ordinary folder flow (A-30, A-31 for a worktree) whose mine joins the
 *   end of the mosaic; the Add panel never opens for it (S32.11).
 * - S32.15 (ISSUE-309): "Reset preset" in the Control room recomputes the order from every mine with a crew again, in
 *   the Host's data order, written at once; only at rest (`idle` → `idle`).
 * - Only the transitions 07 machine 32 lists are taken; anything else is refused and changes nothing (ADR-024).
 */
import type { MineId, Tier } from '@dwarfai/contracts'
import { designTierLabel } from '../presentation'
import { restoreMosaicOrder } from './restore'

/** Machine 32's states. */
export type MosaicState = 'idle' | 'slot-menu' | 'choosing-folder' | 'declaring'

/** The mosaic: its state and its columns' mines, in order. */
export interface Mosaic {
  readonly state: MosaicState
  readonly order: readonly MineId[]
}

/** A live mine as machine 32 reads it, in the Host's data order. */
export interface MosaicMine {
  readonly mineId: MineId
  readonly name: string
  /** `null`: never measured; it reads as Bronze, the tier a new mine starts at (US-MINES-004.AC01). */
  readonly tier: Tier | null
  readonly enterable: boolean
  /** How many dwarfs it has now (S32.01). */
  readonly crew: number
}

/** What a guard reads besides the mosaic. */
export interface MosaicFacts {
  /** The preset shown: S32.14 appends in the Control room only. */
  readonly preset: 'control' | 'front'
  /** Every live mine, in the Host's data order. */
  readonly mines: readonly MosaicMine[]
}

/** What the person did, or what happened to a mine. */
export type MosaicInput =
  /** "Close this column" (S31.09 → S32.03). */
  | { readonly kind: 'close'; readonly mineId: MineId }
  /** The add slot clicked (S32.04). */
  | { readonly kind: 'slot' }
  /** A mine picked in the slot's menu (S32.05, S32.06). */
  | { readonly kind: 'pick'; readonly mineId: MineId }
  /** Esc or an outside click with the slot's menu open (S32.07). */
  | { readonly kind: 'dismiss' }
  /** "A new project…" (S32.08). */
  | { readonly kind: 'new-project' }
  /** The OS folder picker cancelled (S32.09). */
  | { readonly kind: 'folder-cancelled' }
  /** A folder picked, `mines.declare` in flight (S32.10). */
  | { readonly kind: 'folder-picked' }
  /** The declare answered a mine: new, existing or reattached (S32.11). */
  | { readonly kind: 'declared'; readonly mineId: MineId }
  /** The declare refused the folder, or the Host could not be reached (S32.12). */
  | { readonly kind: 'declare-failed' }
  /** `MineRemoved` (S32.13). */
  | { readonly kind: 'mine-removed'; readonly mineId: MineId }
  /** A needs-you jump or entry, a reveal, a history request or a map marker for a mine (S32.14). */
  | { readonly kind: 'reveal'; readonly mineId: MineId }
  /** Reset metrics (S32.16; S39.10). */
  | { readonly kind: 'reset-metrics' }
  /** "Reset preset" in the Control room (S32.15; S37.03). */
  | { readonly kind: 'reset-preset' }

/** What the caller carries out after a transition. */
export type MosaicEffect =
  /** A-N21 `setUiPreference(valleMosaicOrder)`, at once. */
  | { readonly kind: 'write-order'; readonly order: readonly MineId[] }
  /** The window's one toast (BR-23). */
  | { readonly kind: 'toast'; readonly text: string }
  /** A-30 `declareMine`: UI main opens the OS folder picker over the Valle window (`FolderPicker.pick`). */
  | { readonly kind: 'pick-folder' }
  /** The column scrolled into view (a jump under reduced motion). */
  | { readonly kind: 'scroll-to'; readonly mineId: MineId }

export type MosaicStep =
  | {
      readonly ok: true
      /** The 07 machine 32 transition taken. */
      readonly id: string
      /** The mosaic after it; `null` = the order "never written" (S32.16), the next open being S32.01. */
      readonly mosaic: Mosaic | null
      readonly effects: readonly MosaicEffect[]
    }
  | { readonly ok: false; readonly reason: 'not-listed' }

/** One line of the add slot's menu. */
export type SlotEntry =
  | {
      readonly kind: 'mine'
      readonly mineId: MineId
      readonly name: string
      /** Its tier, or "not enterable". */
      readonly note: string
      readonly disabled: boolean
    }
  | { readonly kind: 'rule' }
  | { readonly kind: 'new-project'; readonly label: string }

/** The slot's last item (`DS/docs/copy.md`, Valle). */
export const NEW_PROJECT = 'A new project…'

/** A disabled mine's note in the slot's menu (`DS/docs/copy.md`, semantic pills). */
export const NOT_ENTERABLE = 'not enterable'

/** The toast "Close this column" raises (US-VALLE-009.AC03; `DS/docs/copy.md`, Valle). */
export function closedToast(name: string): string {
  return `${name} left the Control room · its dwarfs keep working`
}

const REFUSED: MosaicStep = { ok: false, reason: 'not-listed' }

function taken(
  id: string,
  mosaic: Mosaic | null,
  effects: readonly MosaicEffect[] = []
): MosaicStep {
  return { ok: true, id, mosaic, effects }
}

const idle = (order: readonly MineId[]): Mosaic => ({ state: 'idle', order })

/** The order with `mineId` at its end, written at once. */
function appended(id: string, mosaic: Mosaic, mineId: MineId): MosaicStep {
  const order = [...mosaic.order, mineId]
  return taken(id, idle(order), [{ kind: 'write-order', order }])
}

/** S32.01: every mine with at least one dwarf, in the Host's data order. */
export function firstMosaicOrder(facts: MosaicFacts): MineId[] {
  return facts.mines.filter((mine) => mine.crew > 0).map((mine) => mine.mineId)
}

/**
 * Valle opens the mosaic: S32.01 with no stored order (`null`, never written), computed and written; S32.02 with one,
 * restored as stored, an entry whose mine no longer exists dropped without rewriting the store. `[]` is an emptied
 * mosaic, the person's own, and stays empty.
 */
export function openMosaic(stored: readonly MineId[] | null, facts: MosaicFacts): MosaicStep {
  if (stored === null) {
    const order = firstMosaicOrder(facts)
    return taken('S32.01', idle(order), [{ kind: 'write-order', order }])
  }
  const exists = (mineId: MineId): boolean => facts.mines.some((mine) => mine.mineId === mineId)
  return taken('S32.02', idle(restoreMosaicOrder([...stored], exists) ?? []))
}

/** The add slot's menu: every mine not in the mosaic, in data order, a rule, then "A new project…" (S32.04). */
export function slotMenu(mosaic: Mosaic, facts: MosaicFacts): SlotEntry[] {
  const mines: SlotEntry[] = facts.mines
    .filter((mine) => !mosaic.order.includes(mine.mineId))
    .map((mine) => ({
      kind: 'mine',
      mineId: mine.mineId,
      name: mine.name,
      note: mine.enterable ? designTierLabel(mine.tier ?? 'bronze') : NOT_ENTERABLE,
      disabled: !mine.enterable
    }))
  return [...mines, { kind: 'rule' }, { kind: 'new-project', label: NEW_PROJECT }]
}

function stepIdle(mosaic: Mosaic, input: MosaicInput, facts: MosaicFacts): MosaicStep {
  switch (input.kind) {
    case 'close': {
      if (!mosaic.order.includes(input.mineId)) return REFUSED
      const order = mosaic.order.filter((mineId) => mineId !== input.mineId)
      const name = facts.mines.find((mine) => mine.mineId === input.mineId)?.name ?? ''
      return taken('S32.03', idle(order), [
        { kind: 'write-order', order },
        { kind: 'toast', text: closedToast(name) }
      ])
    }
    case 'slot':
      return taken('S32.04', { ...mosaic, state: 'slot-menu' })
    case 'mine-removed': {
      if (!mosaic.order.includes(input.mineId)) return REFUSED
      const order = mosaic.order.filter((mineId) => mineId !== input.mineId)
      return taken('S32.13', idle(order), [{ kind: 'write-order', order }])
    }
    case 'reveal': {
      if (facts.preset !== 'control' || mosaic.order.includes(input.mineId)) return REFUSED
      const step = appended('S32.14', mosaic, input.mineId)
      return step.ok
        ? { ...step, effects: [...step.effects, { kind: 'scroll-to', mineId: input.mineId }] }
        : step
    }
    case 'reset-preset': {
      // S32.15: the Control room's own; the order is every mine with a crew again, not the person's arrangement.
      if (facts.preset !== 'control') return REFUSED
      const order = firstMosaicOrder(facts)
      return taken('S32.15', idle(order), [{ kind: 'write-order', order }])
    }
    default:
      return REFUSED
  }
}

function stepSlotMenu(mosaic: Mosaic, input: MosaicInput, facts: MosaicFacts): MosaicStep {
  switch (input.kind) {
    case 'pick': {
      // Only a mine the menu offers: one not in the mosaic.
      const offered = facts.mines.find(
        (mine) => mine.mineId === input.mineId && !mosaic.order.includes(mine.mineId)
      )
      if (offered === undefined) return REFUSED
      if (!offered.enterable) return taken('S32.06', mosaic)
      return appended('S32.05', mosaic, input.mineId)
    }
    case 'dismiss':
      return taken('S32.07', idle(mosaic.order))
    case 'new-project':
      return taken('S32.08', { ...mosaic, state: 'choosing-folder' }, [{ kind: 'pick-folder' }])
    default:
      return REFUSED
  }
}

export function stepMosaic(mosaic: Mosaic, input: MosaicInput, facts: MosaicFacts): MosaicStep {
  // Any state: Reset metrics (S32.16). UI main rewrote the store to "never written": nothing is written back.
  if (input.kind === 'reset-metrics') return taken('S32.16', null)
  switch (mosaic.state) {
    case 'idle':
      return stepIdle(mosaic, input, facts)
    case 'slot-menu':
      return stepSlotMenu(mosaic, input, facts)
    case 'choosing-folder':
      if (input.kind === 'folder-cancelled') return taken('S32.09', idle(mosaic.order))
      if (input.kind === 'folder-picked') return taken('S32.10', { ...mosaic, state: 'declaring' })
      return REFUSED
    case 'declaring':
      if (input.kind === 'declare-failed') return taken('S32.12', idle(mosaic.order))
      if (input.kind !== 'declared') return REFUSED
      // An existing mine already shown keeps its column; the Add panel never opens for it (S32.11, US-VALLE-006.AC07).
      if (mosaic.order.includes(input.mineId)) return taken('S32.11', idle(mosaic.order))
      return appended('S32.11', mosaic, input.mineId)
  }
}
