import { isPanelObserved } from '../../types'
import type { Dwarf, DwarfProvider, TextDeliveryChannel } from '../../types'
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

/**
 * How each provider is started detached, in its own argv (#217).
 *
 * Named per provider rather than as one sentence, for the reason
 * launchRunner's PRODUCT_NAME is: this is copy a person acts on, and telling
 * somebody their Claude session was launched with `codex exec` would send them
 * to read the wrong program's documentation at the one moment the sentence was
 * supposed to help.
 */
const LAUNCH_COMMAND: Record<DwarfProvider, string> = {
  claude: 'claude -p',
  codex: 'codex exec',
  // Unreachable in this build, and named honestly rather than left blank
  // (#237): Antigravity is observer-only, so it is absent from
  // LAUNCHABLE_PROVIDERS, no dwarf of its can carry the launched-process or
  // one-shot channel these sentences explain, and neither sentence can be
  // shown. The bare executable is the least-claiming spelling that still reads
  // correctly the day a launch path lands and picks a real invocation.
  antigravity: 'agy'
}

/**
 * Why a session this panel launched takes no messages — a fact about the
 * world, where the generic no-channel string reads as a bug (#217).
 *
 * Both launch shapes are one prompt on stdin and one turn: the process exits
 * when it finishes, so there is no inbox to reach and no process left to read
 * one. Widening a queue to accept text for it would be worse than this
 * refusal — the composer would take the message and lose it. So the sentence
 * names the shape, and then names the one control that does do something.
 */
export function launchedNoInboxReason(provider: DwarfProvider): string {
  return (
    `A session launched with ${LAUNCH_COMMAND[provider]} takes no messages: ` +
    'it reads one prompt and exits with its turn. Kick ends it.'
  )
}

/**
 * The same shape, without the exit — a one-shot run this panel did not start
 * (#231).
 *
 * `codex exec` from a terminal is one; so is a launch of this app's own from a
 * run that has restarted since and can no longer PROVE which process was its,
 * because a pid on its own identifies nothing and this app owns a tree kill.
 * Both have exactly the refusal above minus its last sentence, and that
 * omission is the whole difference: "Kick ends it" is a promise, and there is
 * nothing here to keep it with.
 *
 * One sentence for both controls, because one fact refuses both. Said plainly
 * rather than as a "not yet": nothing about this session is coming later.
 */
export function oneShotNoExitReason(provider: DwarfProvider): string {
  return (
    `A session run with ${LAUNCH_COMMAND[provider]} takes no messages: it reads one prompt ` +
    'and exits with its turn. This panel did not start it, so it has no exit here either.'
  )
}

/** What each channel means, in the sender's terms. */
export const CHANNEL_HINT: Record<TextDeliveryChannel, string> = {
  terminal: 'Typed straight into the session console.',
  'claude-relay': 'Relayed to the headless session by name.',
  'foreman-relay': "Delivered to this worker's foreman, tagged for them.",
  'codex-queue': "Added to this Codex session's queue; it reads it between turns.",
  'held-session': 'Put straight onto the session this panel is holding open.',
  // Never a send channel — see launchedNoInboxReason, which is what a disabled
  // composer says instead. Present because the map is total, and honest for
  // the same reason the others are.
  'launched-process': 'Nothing: a session launched with one prompt has no inbox.',
  // The mirror of the line above, and the reason hosting is worth its cost
  // (#194): the same app started this process too, and the only difference is
  // that it kept the pipe instead of closing it. Says stdin rather than
  // "the session", because what is on the other end is the person's own
  // program and this app knows nothing about what it does with a line.
  'hosted-stdin': 'Written onto the stdin of the process this panel is holding.'
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
  'held-session': 'Interrupts the turn on the session this panel holds.',
  // The one exception to that, and the reason it says so out loud (#217): this
  // panel started the process and nothing weaker exists for it, so the kick
  // ends the SESSION. A person told a turn was interrupted, when the session
  // is gone, has been told the wrong thing.
  'launched-process': 'Ends the session this panel launched — the whole process, not the turn.',
  // The second exception, and it has to say the same thing (#194). There is no
  // interrupt to offer: this app knows nothing about what somebody else's
  // program treats as one, and a byte it happened to accept would be the panel
  // guessing at another program's key bindings.
  'hosted-stdin': 'Ends the process this panel is holding — the whole process, not the turn.'
}

export const NO_EFFORT_REASON = "No provider supports changing a running session's effort yet."

export const CONSOLE_HINT = "Focus this session's console."

/**
 * What the panel says about an observed session whose CLI is holding a
 * permission dialog open (#203).
 *
 * Two facts and no third. The dialog IS open — Claude Code said so through its
 * own hook, which is what put `'approval'` on the dwarf — and the only place it
 * can be answered is the terminal that is drawing it. So the sentence names the
 * terminal rather than offering Allow and Deny: the keystrokes that would work
 * that dialog from here have never been measured on a live build, and a control
 * that types an unverified key into somebody's console is worse than a sentence
 * telling them where the dialog is.
 *
 * A prompt this panel can decide ITSELF is a different case and never reaches
 * this: a held session's card answers it structurally (#246), and pointing
 * somebody at a terminal would send them away from the control that works.
 */
export const APPROVAL_AT_TERMINAL_NOTE = 'Waiting for your approval in the terminal.'

/** The action beside that sentence, which is the console focus the panel already has. */
export const JUMP_TO_TERMINAL_NAME = 'Jump to the terminal'

/**
 * That sentence for this dwarf, or null when it does not apply.
 *
 * Read off `waitingReason` and nothing weaker — the reason is derived from the
 * provider's own structured evidence, so this repeats a finding rather than
 * inferring one. A `'leaving'` dwarf is excluded for the reason every other
 * control here excludes it: the grace window freezes the last real snapshot,
 * mark and all, and there is no dialog left at that terminal to answer.
 */
export function approvalNote(dwarf: Dwarf): string | null {
  if (dwarf.waitingReason !== 'approval') return null
  if (dwarf.pendingPermission !== undefined) return null
  if (hasEnded(dwarf)) return null
  return APPROVAL_AT_TERMINAL_NOTE
}

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

/**
 * The one-shot refusal for this dwarf, or null when it does not apply (#231).
 *
 * Narrowed on the observer for the reason the launched refusal is: a one-shot
 * run is a CLI this app knows how to read, so a dwarf the panel observes
 * itself is never one, and the sentence names a command that would be a
 * fiction for it.
 */
function noOneShotExitReason(dwarf: Dwarf): string | null {
  const provider = dwarf.provider
  if (dwarf.oneShot !== true || isPanelObserved(provider)) return null
  return oneShotNoExitReason(provider)
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
      : sendChannel !== undefined
        ? KICK_HINT[sendChannel]
        : // A one-shot run nothing here started has no kick for a stated
          // reason rather than for want of a feature (#231), and it is the
          // same sentence the composer beside it shows: one fact refuses both.
          (noOneShotExitReason(dwarf) ?? NO_KICK_REASON)
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
    // A session with a cancel and no send is one this panel LAUNCHED (#217),
    // and its refusal is a fact rather than a "not yet": the generic string
    // describes a gap in this app, and this describes the session. Read off
    // the same matrix the kick beside it reads, so the two halves of one
    // refusal can never come from two different facts.
    // Narrowed on the observer as well as the channel, and the pairing is a
    // real invariant rather than a cast to satisfy the compiler (#194):
    // 'launched-process' is a channel only a dwarf some PROVIDER observed can
    // have, because a launch is a CLI this app knows how to start. A dwarf this
    // panel holds itself is never one, and its composer is never disabled for
    // this reason — its stdin is open, which is the whole point of holding it.
    const provider = dwarf.provider
    const hint =
      dwarf.capabilities?.cancel === 'launched-process' && !isPanelObserved(provider)
        ? launchedNoInboxReason(provider)
        : // And the same shape with no exit at all (#231), which the launch
          // above must win over: a session this panel can end says so.
          (noOneShotExitReason(dwarf) ?? NO_CHANNEL_REASON)
    return { id: 'chat', name: 'Chat', enabled: false, hint }
  }
  return { id: 'chat', name: 'Chat', enabled: true, hint: CHANNEL_HINT[channel] }
}

/**
 * The one sentence the panel SHOWS about a control it has disabled (#217).
 *
 * The reasons above were already honest and already carried by every disabled
 * entry — they just had nowhere on screen to be, so a person met a dead
 * composer and a dead kick with nothing said. A tooltip is not a refusal; it
 * is a refusal somebody has to go looking for.
 *
 * Chat first, because the composer is the control somebody is looking at when
 * they try to say something. The kick's reason surfaces when chat works and
 * the kick does not, which is every ordinary Codex thread (#97). An in-flight
 * kick is not a refusal — the control is disabled because it is working, and
 * the verdict line has that covered.
 */
export function refusalLine(dwarf: Dwarf, state: ActionTransientState): string | null {
  const entries = buildActionBar(dwarf, state)
  const chat = entries.find((entry) => entry.id === 'chat')
  if (chat !== undefined && !chat.enabled) return chat.hint
  if (state.kicking) return null
  const kick = entries.find((entry) => entry.id === 'kick')
  return kick !== undefined && !kick.enabled ? kick.hint : null
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
