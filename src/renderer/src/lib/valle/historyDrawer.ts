/*
 * The mine's history as a drawer in Valle's Work front (07 machine 36; US-VALLE-011; UC-061; ISSUE-308). Pure.
 *
 * - "Mine history" in the Work front's mine toolbar, the deck's History bar, or a mine-history request from a chat in
 *   the deck opens it under the chat tabs and panes (S36.01): it rises from 16 px below with a fade over `--dur-panel`,
 *   then is open once the motion is done or its watchdog fires (S36.02). The chats above it never move.
 * - Its own close control sinks it 16 px with a fade over `--dur-fast` (S36.03).
 * - A climb out, leaving Valle or Valle hidden closes it at once, with no fade (S36.04); so does its mine removed
 *   (S36.06). A Work front swap keeps it open on the new mine's history (S36.05; 07 §24 I-33).
 * - Session-only (S36.07; ADR-024 item 1): it starts closed, and its one record is `valle.historyOpen` in the UI main
 *   session store (A-N18), never a stored preference.
 *
 * What it shows is the Panel's own history panel (US-MINE-006), never anything of its own (AC04).
 */
import type { MineId, UiSessionPatch } from '@dwarfai/contracts'
import { VALLE_MOTION } from './flip'

export type HistoryDrawerState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'opening' | 'open' | 'closing'; readonly mineId: MineId }

export const HISTORY_DRAWER_START: HistoryDrawerState = { kind: 'closed' }

export type HistoryDrawerInput =
  /** S36.01: "Mine history", the History bar, or a chat's mine-history request; the preset is machine 36's guard. */
  | { readonly kind: 'open'; readonly mineId: MineId; readonly preset: 'control' | 'front' }
  /** S36.02: the rise is done, or its watchdog fired. */
  | { readonly kind: 'risen' }
  /** S36.03: its own close control. */
  | { readonly kind: 'close' }
  /** S36.03: the sink is done, or its watchdog fired. */
  | { readonly kind: 'sunk' }
  /** S36.04: a climb out (S28.11), leaving Valle (S28.21), Valle hidden. */
  | { readonly kind: 'climb-out' }
  | { readonly kind: 'leave' }
  | { readonly kind: 'hidden' }
  /** S36.05: a Work front swap (S28.15). */
  | { readonly kind: 'swap'; readonly mineId: MineId }
  /** S36.06: `MineRemoved`. */
  | { readonly kind: 'mine-removed'; readonly mineId: MineId }

export type HistoryDrawerEffect =
  /** Play the rise, then send `risen`. */
  | { readonly kind: 'rise' }
  /** Play the sink, then send `sunk`. */
  | { readonly kind: 'sink' }
  /** End any motion at once. */
  | { readonly kind: 'stop-motion' }
  /** A-N18 `valle.historyOpen`. */
  | { readonly kind: 'write-session'; readonly open: boolean }

export type HistoryDrawerStep =
  | {
      readonly ok: true
      readonly id: string
      readonly state: HistoryDrawerState
      readonly effects: readonly HistoryDrawerEffect[]
    }
  | { readonly ok: false }

const REFUSED: HistoryDrawerStep = { ok: false }

function to(
  id: string,
  state: HistoryDrawerState,
  effects: readonly HistoryDrawerEffect[] = []
): HistoryDrawerStep {
  return { ok: true, id, state, effects }
}

const CLOSED: HistoryDrawerEffect = { kind: 'write-session', open: false }
/** Closed at once, no fade (S36.04, S36.06). */
const AT_ONCE: readonly HistoryDrawerEffect[] = [{ kind: 'stop-motion' }, CLOSED]

export function stepHistoryDrawer(
  state: HistoryDrawerState,
  input: HistoryDrawerInput
): HistoryDrawerStep {
  if (state.kind === 'closed') {
    return input.kind === 'open' && input.preset === 'front'
      ? to('S36.01', { kind: 'opening', mineId: input.mineId }, [
          { kind: 'write-session', open: true },
          { kind: 'rise' }
        ])
      : REFUSED
  }
  if (state.kind === 'closing') {
    return input.kind === 'sunk' ? to('S36.03', HISTORY_DRAWER_START, [CLOSED]) : REFUSED
  }
  switch (input.kind) {
    case 'risen':
      return state.kind === 'opening'
        ? to('S36.02', { kind: 'open', mineId: state.mineId })
        : REFUSED
    case 'close':
      return state.kind === 'open'
        ? to('S36.03', { kind: 'closing', mineId: state.mineId }, [{ kind: 'sink' }])
        : REFUSED
    case 'climb-out':
    case 'leave':
    case 'hidden':
      return to('S36.04', HISTORY_DRAWER_START, AT_ONCE)
    case 'swap':
      return state.kind === 'open' && input.mineId !== state.mineId
        ? to('S36.05', { kind: 'open', mineId: input.mineId })
        : REFUSED
    case 'mine-removed':
      return state.kind === 'open' && input.mineId === state.mineId
        ? to('S36.06', HISTORY_DRAWER_START, AT_ONCE)
        : REFUSED
    default:
      return REFUSED
  }
}

/** One motion of the drawer, as the motion table gives it (`DS/docs/motion.md`, the Work front history drawer). */
export interface HistoryDrawerMotion {
  readonly frames: readonly Keyframe[]
  readonly duration: number
  readonly easing: string
  /** The rise fills backwards (unseen until it starts); the sink holds its last frame until the drawer goes. */
  readonly fill: FillMode
}

/** How far below its place the drawer rises from and sinks to. */
export const HISTORY_DRAWER_RISE = 16
/** `--dur-panel` and `--dur-fast`. */
const RISE_MS = 180
const SINK_MS = 90

const AT_REST: Keyframe = { opacity: 1, transform: 'none' }
const BELOW: Keyframe = { opacity: 0, transform: `translateY(${HISTORY_DRAWER_RISE}px)` }

/** The rise or the sink; under reduced motion every duration token reads 0 ms (NFR-TIM-02). */
export function historyDrawerMotion(kind: 'rise' | 'sink', reduced: boolean): HistoryDrawerMotion {
  return kind === 'rise'
    ? {
        frames: [BELOW, AT_REST],
        duration: reduced ? 0 : RISE_MS,
        easing: VALLE_MOTION.easeOut,
        fill: 'backwards'
      }
    : {
        frames: [AT_REST, BELOW],
        duration: reduced ? 0 : SINK_MS,
        easing: VALLE_MOTION.easeIn,
        fill: 'forwards'
      }
}

/** A-N18: the drawer's one record, in the session store (S36.07). */
export function historyDrawerPatch(open: boolean): UiSessionPatch {
  return { kind: 'valle', patch: { historyOpen: open } }
}
