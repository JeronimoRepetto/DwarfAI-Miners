import type { Dwarf, TextDeliveryChannel } from '../../types'
import { describeEffort } from './effort'

/**
 * The action model behind the dwarf icon bar (see #27): four fixed slots —
 * kick, boost, chat, console — each resolved from the dwarf's capability
 * matrix into an enabled/disabled entry with an honest hint. The bar renders
 * every action unconditionally and disables the unavailable ones with their
 * reason, instead of hiding them — the same honesty rule the old text menu
 * followed (see DwarfCapabilities in shared/contracts.ts).
 */

export type ActionId = 'kick' | 'boost' | 'chat' | 'console'

export interface ActionBarEntry {
  id: ActionId
  /**
   * The short name the hover tooltip and aria-label carry. Kick's name doubles
   * as its state label ("Confirm kick?", "Kicking...") because an icon has no
   * button text to change.
   */
  name: string
  enabled: boolean
  /** What the action does through its current channel — or why it is unavailable. */
  hint: string
}

/**
 * Per-click state the bar owns but the model must reflect: an armed kick
 * confirmation and an in-flight kick. Send state is deliberately absent — a
 * pending send locks the composer's Send button, never the chat icon.
 */
export interface ActionTransientState {
  kicking: boolean
  kickArmed: boolean
}

export const NO_CHANNEL_REASON = "This session type can't receive messages yet."

/** What each channel means, in the sender's terms. */
export const CHANNEL_HINT: Record<TextDeliveryChannel, string> = {
  terminal: 'Typed straight into the session console.',
  'claude-relay': 'Relayed to the headless session by name.',
  'foreman-relay': "Delivered to this worker's foreman, tagged for them.",
  'codex-queue': "Added to this Codex session's queue; it reads it between turns.",
  'held-session': 'Put straight onto the session this panel is holding open.'
}

export const NO_KICK_REASON = "This session type can't be canceled yet."

/**
 * What kicking that channel actually does, in honest terms — or, where a
 * channel cannot kick at all, why not: a terminal gets a real interrupt
 * keystroke, a relay tier is a semantic ask the session may decline, a held
 * session gets a genuine interrupt of the turn it is in (#210), and the
 * Codex queue cannot cut a turn short at all, because the only thing it is
 * proven to do is drain between turns (#97).
 */
export const KICK_HINT: Record<TextDeliveryChannel, string> = {
  terminal: 'Sends an interrupt keystroke to the session console.',
  'claude-relay': 'Asks the agent to stop — it decides how.',
  'foreman-relay': "Asks this worker's foreman to stop it — it decides how.",
  'codex-queue':
    "The queue only drains between turns, so it can't interrupt one — a kick still has to come from the session console.",
  // The only tier that stops the turn itself rather than asking: the panel is
  // holding this session's stream, so the interrupt is a control request to it.
  // It ends the turn, never the session — that is Kick's meaning everywhere.
  'held-session': 'Interrupts the turn on the session this panel holds.'
}

export const NO_EFFORT_REASON = "No provider supports changing a running session's effort yet."

export const CONSOLE_HINT = "Focus this session's console."

/**
 * A 'leaving' dwarf's agent has already finished (#192): its pid is stale and
 * its session name no longer resolves, which is why main refuses to write to
 * one. The channel it HAD is still on the dwarf — the grace window freezes the
 * last real snapshot — so the bar has to read the status, not the channel, or
 * it offers a way in that main is about to refuse.
 */
export const SESSION_ENDED_REASON = 'This session has ended.'

function hasEnded(dwarf: Dwarf): boolean {
  return dwarf.status === 'leaving'
}

function kickAction(dwarf: Dwarf, state: ActionTransientState): ActionBarEntry {
  if (hasEnded(dwarf))
    return { id: 'kick', name: 'Kick', enabled: false, hint: SESSION_ENDED_REASON }
  const channel = dwarf.capabilities?.cancel ?? null
  // A session reachable for text but not for a kick (the Codex queue, #97) is
  // told apart from one with no way in at all: the generic reason would deny a
  // channel the chat action next to it has just offered, so the send channel
  // supplies the refusal in its own terms. Read off the SAME matrix as `cancel`
  // rather than off textDelivery, so the two halves of one refusal can never
  // come from two different facts.
  const sendChannel = dwarf.capabilities?.sendText ?? undefined
  const hint =
    channel !== null
      ? KICK_HINT[channel]
      : sendChannel === undefined
        ? NO_KICK_REASON
        : KICK_HINT[sendChannel]
  if (state.kicking) return { id: 'kick', name: 'Kicking...', enabled: false, hint }
  if (channel === null) return { id: 'kick', name: 'Kick', enabled: false, hint }
  return {
    id: 'kick',
    // First click arms the confirmation, second click fires — the name is the
    // only place an icon can surface that state, so it carries the question.
    name: state.kickArmed ? 'Confirm kick?' : 'Kick',
    enabled: true,
    hint
  }
}

function boostAction(dwarf: Dwarf): ActionBarEntry {
  return {
    id: 'boost',
    name: 'Boost',
    enabled: false,
    // Normalized per provider — see lib/effort.ts — so the disabled reason
    // still names a real value.
    hint: `${NO_EFFORT_REASON} Currently: ${describeEffort(dwarf.provider, dwarf.effort)}.`
  }
}

function chatAction(dwarf: Dwarf): ActionBarEntry {
  if (hasEnded(dwarf))
    return { id: 'chat', name: 'Chat', enabled: false, hint: SESSION_ENDED_REASON }
  const channel = dwarf.textDelivery
  if (channel === undefined) {
    return { id: 'chat', name: 'Chat', enabled: false, hint: NO_CHANNEL_REASON }
  }
  return { id: 'chat', name: 'Chat', enabled: true, hint: CHANNEL_HINT[channel] }
}

/**
 * The four bar entries in their fixed left-to-right order. Pure: the component
 * re-derives this on every relevant change instead of mutating entries.
 */
export function buildActionBar(dwarf: Dwarf, state: ActionTransientState): ActionBarEntry[] {
  return [
    kickAction(dwarf, state),
    boostAction(dwarf),
    chatAction(dwarf),
    { id: 'console', name: 'Console', enabled: true, hint: CONSOLE_HINT }
  ]
}
