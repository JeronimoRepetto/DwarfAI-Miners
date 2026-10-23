/*
 * The current mine in Valle, and what is heard (07 machine 35 `CurrentMineState`; US-VALLE-013, US-VALLE-016; UC-060;
 * BR-13, INV-115; ISSUE-307). Pure: the caller hands each input with the facts machine 35 reads and carries the result.
 *
 * - `set`: a mine the person made current, by a chat opened or focused (S35.01), a single click on its painting or
 *   header (S35.02), or a dive, a Work front swap or a list pick (S35.03). `fallback`: nothing made current, so the mine
 *   of the chat in focus when it is a mosaic column, else the first mosaic column (S35.06, after a restart included:
 *   the current mine is never persisted, ADR-024 items 1, 4).
 * - Only a mine on screen is current: in the Work front the one mine shown, whatever the state (US-VALLE-013.AC05;
 *   a tab of another mine's dwarf changes nothing, S35.04); in the Control room a mosaic column, so a set mine whose
 *   column went is replaced by the fallback until S35.05 is taken.
 * - What is heard reads the same value (US-VALLE-013.AC08, BR-13): the current mine's room tone, bed and crew, silenced
 *   by its own mute (S31.08). Attention cues and a selected dwarf's voice never read it (S35.07), and a hidden window
 *   plays nothing while the current mine is kept for its next show (S35.08); both gates are the sound engine's.
 * - Only the transitions 07 machine 35 lists are taken; anything else is refused and changes nothing (ADR-024).
 */
import type { MineId, UiSessionPatch } from '@dwarfai/contracts'

export type CurrentMineState =
  { readonly kind: 'fallback' } | { readonly kind: 'set'; readonly mineId: MineId }

/** S35.06: Valle opens with nothing made current. */
export const CURRENT_MINE_START: CurrentMineState = { kind: 'fallback' }

/** What machine 35 reads. */
export interface CurrentMineFacts {
  readonly preset: 'control' | 'front'
  /** The Control room's columns, in order. */
  readonly mosaic: readonly MineId[]
  /** The Work front's one mine. */
  readonly frontMine: MineId | null
  /** The mine of the chat in focus, or `null` with none. */
  readonly focusMine: MineId | null
}

export type CurrentMineInput =
  /** S35.01: a dwarf's chat opened or focused (its portrait, sprite, stack line, queue entry or the counter). */
  | { readonly kind: 'chat'; readonly mineId: MineId }
  /** S35.02: a single click on a mine's painting or header, no dwarf touched. */
  | { readonly kind: 'painting'; readonly mineId: MineId }
  /** S35.03: a dive, a Work front swap or a list pick. */
  | { readonly kind: 'dive'; readonly mineId: MineId }
  /** S35.04: a Work front tab of another mine's dwarf selected. */
  | { readonly kind: 'front-tab'; readonly mineId: MineId }
  /** S35.05: the mine's column closed, the mine removed, or a climb out to a mosaic that lacks it. */
  | { readonly kind: 'gone'; readonly mineId: MineId }
  /** S35.07: an attention cue from any mine, or a dwarf selected. */
  | { readonly kind: 'cue' }
  /** S35.08: Valle hidden or another mode shown. */
  | { readonly kind: 'hidden' }

export type CurrentMineStep =
  | { readonly ok: true; readonly id: string; readonly state: CurrentMineState }
  | { readonly ok: false; readonly reason: 'not-listed' }

const REFUSED: CurrentMineStep = { ok: false, reason: 'not-listed' }

const onScreen = (mineId: MineId, facts: CurrentMineFacts): boolean =>
  facts.preset === 'front' ? mineId === facts.frontMine : facts.mosaic.includes(mineId)

export function stepCurrentMine(
  state: CurrentMineState,
  input: CurrentMineInput,
  facts: CurrentMineFacts
): CurrentMineStep {
  const to = (id: string, next: CurrentMineState): CurrentMineStep => ({
    ok: true,
    id,
    state: next
  })
  switch (input.kind) {
    case 'chat':
      // In the Work front only the mine on screen is current: a chat of another mine's dwarf is S35.04.
      if (facts.preset === 'front') return to('S35.04', state)
      return facts.mosaic.includes(input.mineId)
        ? to('S35.01', { kind: 'set', mineId: input.mineId })
        : REFUSED
    case 'painting':
      return onScreen(input.mineId, facts)
        ? to('S35.02', { kind: 'set', mineId: input.mineId })
        : REFUSED
    case 'dive':
      return to('S35.03', { kind: 'set', mineId: input.mineId })
    case 'front-tab':
      return facts.preset === 'front' ? to('S35.04', state) : REFUSED
    case 'gone':
      return state.kind === 'set' && state.mineId === input.mineId
        ? to('S35.05', CURRENT_MINE_START)
        : REFUSED
    case 'cue':
      return to('S35.07', state)
    case 'hidden':
      return to('S35.08', state)
  }
}

/** The fallback: the chat in focus's mine when it is a column, else the first column (S35.06). */
function fallbackMine(facts: CurrentMineFacts): MineId | null {
  if (facts.focusMine !== null && facts.mosaic.includes(facts.focusMine)) return facts.focusMine
  return facts.mosaic[0] ?? null
}

/** The one current mine the marks show and the sound engine plays, or `null` with no mine on screen. */
export function currentMineOf(state: CurrentMineState, facts: CurrentMineFacts): MineId | null {
  if (facts.preset === 'front') return facts.frontMine
  if (state.kind === 'set' && facts.mosaic.includes(state.mineId)) return state.mineId
  return fallbackMine(facts)
}

/** A-N18 for the Valle host: one value per host, never a global field (BR-13, INV-115). */
export function currentMinePatch(mineId: MineId | null): UiSessionPatch {
  return { kind: 'current-mine', host: 'valle', mineId }
}

/** What the sound engine is told: the mine whose room tone, bed and crew may play, and whether its own mute is on. */
export interface MineSound {
  readonly mineId: MineId | null
  readonly muted: boolean
}

export function mineSound(current: MineId | null, muted: readonly MineId[]): MineSound {
  return { mineId: current, muted: current !== null && muted.includes(current) }
}

/** Where the current mine is marked, each with its own bracket size (decision log, Selected mine mark). */
export type CurrentMarkSize = 'zone' | 'card' | 'list'

/**
 * The brackets' thickness, arm and inset in px: around a Valle zone's art well 4/20, inside the Panel's open mine card
 * 4/16 two pixels in, inside the Work front list line of the mine shown 2/8 four pixels in (`DS` foundations.md,
 * organisms/mine-zone, molecules/mine-card, organisms/mine-rows).
 */
export const CURRENT_MARK: Readonly<
  Record<
    CurrentMarkSize,
    { readonly thickness: number; readonly arm: number; readonly inset: number }
  >
> = {
  zone: { thickness: 4, arm: 20, inset: 0 },
  card: { thickness: 4, arm: 16, inset: 2 },
  list: { thickness: 2, arm: 8, inset: 4 }
}
