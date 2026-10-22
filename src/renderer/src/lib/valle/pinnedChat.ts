/*
 * A pinned chat's own life in Valle (07 machine 18; 06 §15 `PinnedChat`; US-VALLE-007; ISSUE-302). Pure.
 *
 * - S18.01: a pin starts `live`. S18.02: its dwarf departed for any cause but its mine's removal: it stays pinned,
 *   reads "gone" and its chat turns read-only. S18.03: its mine was removed: it closes outright with the mine.
 * - S18.04: the person unpins or closes it, `live` or `gone`; the dwarf's session is never touched by it.
 * - S18.05: restored at app start, `live` while its dwarf is alive, `gone` when it ended meanwhile; a dwarf whose row
 *   Reset metrics deleted is dropped. S18.06: Reset metrics clears every pin.
 * - Only the transitions 07 machine 18 lists are taken; anything else is refused and changes nothing (ADR-024).
 *
 * The set of pins, their order and focus, is machine 29's (`pins.ts`).
 */

/** `live` while its dwarf is present; `gone` (read-only) once its session ended. */
export type PinnedChatState = 'live' | 'gone'

export type PinnedChatInput =
  /** `UI:` pin (S18.01). */
  | { readonly kind: 'pin' }
  /** `DwarfDeparted`, `mineRemoved` for the cause `mine-removed` (S18.02, S18.03). */
  | { readonly kind: 'departed'; readonly mineRemoved: boolean }
  /** `UI:` unpin or close (S18.04). */
  | { readonly kind: 'unpin' }
  /** App start restores the pin (S18.05). */
  | { readonly kind: 'restore'; readonly dwarf: 'alive' | 'ended' | 'deleted' }
  /** Reset metrics (S18.06). */
  | { readonly kind: 'reset' }

export type PinnedChatStep =
  /** `closed`: the pin left the set (`[*]`). */
  | { readonly ok: true; readonly id: string; readonly state: PinnedChatState | 'closed' }
  | { readonly ok: false; readonly reason: 'not-listed' }

const REFUSED: PinnedChatStep = { ok: false, reason: 'not-listed' }

/** Steps one pin through 07 machine 18; `none` is the pin before it exists. */
export function stepPinnedChat(
  state: PinnedChatState | 'none',
  input: PinnedChatInput
): PinnedChatStep {
  if (state === 'none') {
    if (input.kind === 'pin') return { ok: true, id: 'S18.01', state: 'live' }
    if (input.kind === 'restore') {
      const restored = { alive: 'live', ended: 'gone', deleted: 'closed' } as const
      return { ok: true, id: 'S18.05', state: restored[input.dwarf] }
    }
    return REFUSED
  }
  switch (input.kind) {
    case 'departed':
      if (state !== 'live') return REFUSED
      return input.mineRemoved
        ? { ok: true, id: 'S18.03', state: 'closed' }
        : { ok: true, id: 'S18.02', state: 'gone' }
    case 'unpin':
      return { ok: true, id: 'S18.04', state: 'closed' }
    case 'reset':
      return { ok: true, id: 'S18.06', state: 'closed' }
    default:
      return REFUSED
  }
}

/** S18.02: a `gone` pin's chat is read-only; a `live` one takes messages. */
export function isChatReadOnly(state: PinnedChatState): boolean {
  return state === 'gone'
}
