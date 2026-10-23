/*
 * Owner ruling 2026-10-23 (VQA-13; `DS` valle.js `answer` → `focusInput`): after a needs-you jump, the counter's or an
 * entry's, the keyboard goes into the dwarf's chat rather than staying on what was pressed. The place is the one
 * `DS/docs/accessibility.md` (Focus) names: the question card's first option while the dwarf waits on you, else the
 * composer's field, else the chat's first control. A motion ghost's copy of the chat (`.dm-vghosts`) is never a target.
 */
import type { DwarfId } from '@dwarfai/contracts'

const FOCUSABLE =
  'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The dwarf's drawn chat in `root`, not a ghost's copy. */
function chatOf(root: ParentNode, dwarfId: DwarfId): HTMLElement | null {
  const chats = root.querySelectorAll<HTMLElement>(`[data-valle-chat="${dwarfId}"]`)
  return [...chats].find((chat) => chat.closest('.dm-vghosts') === null) ?? null
}

/** Hands the keyboard to the dwarf's chat; answers whether it was drawn, leaving the keyboard alone when not. */
export function focusChatIn(root: ParentNode, dwarfId: DwarfId): boolean {
  const chat = chatOf(root, dwarfId)
  if (chat === null) return false
  const target =
    chat.querySelector<HTMLElement>('.dm-qcard .dm-qopt') ??
    chat.querySelector<HTMLElement>('textarea:not([disabled])') ??
    chat.querySelector<HTMLElement>(FOCUSABLE) ??
    chat
  target.focus({ preventScroll: true })
  return true
}
