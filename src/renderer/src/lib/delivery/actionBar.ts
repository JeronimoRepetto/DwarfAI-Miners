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
  'foreman-relay': "Delivered to this worker's foreman, tagged for them."
}

export const NO_KICK_REASON = "This session type can't be canceled yet."

/**
 * What kicking that channel actually does, in honest terms: a terminal gets a
 * real interrupt keystroke, but a relay tier is a semantic ask — the session
 * decides how (or whether) to stop.
 */
export const KICK_HINT: Record<TextDeliveryChannel, string> = {
  terminal: 'Sends an interrupt keystroke to the session console.',
  'claude-relay': 'Asks the agent to stop — it decides how.',
  'foreman-relay': "Asks this worker's foreman to stop it — it decides how."
}

export const NO_EFFORT_REASON = "No provider supports changing a running session's effort yet."

export const CONSOLE_HINT = "Focus this session's console."

function kickAction(dwarf: Dwarf, state: ActionTransientState): ActionBarEntry {
  const channel = dwarf.capabilities?.cancel ?? null
  const hint = channel === null ? NO_KICK_REASON : KICK_HINT[channel]
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
