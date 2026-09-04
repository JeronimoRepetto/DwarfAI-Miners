import { MAX_DWARF_TEXT_CHARS, type DwarfProvider } from '../../types'

/**
 * The Add Panel's gates, as `screens/launch.md` states them (#86).
 *
 * The source writes the whole flow as a state model, and this is that model
 * rather than a translation of it: the phase names below are the document's
 * own words, so a rule can be read against the paragraph it came from without
 * a glossary in between. What the panel then DRAWS for each phase is the
 * component's business; what is enabled, what is refused, and what a refusal
 * did to the user's typing is decided here.
 *
 * The source marks several neighbouring questions **Unspecified** and warns
 * against inventing answers for them. Where one of those had to be settled to
 * have a working gate at all — editing a committed command, a prompt of pure
 * whitespace, what a provider switch keeps — the reading taken is the narrowest
 * one the stated rules already imply, and it is written down at the function
 * that takes it. Nothing else is added.
 */

/**
 * The always-present chip, which is not a provider: it stands for a launch
 * command the user supplies. Kept out of `DwarfProvider` deliberately — that
 * union is who OBSERVED a dwarf, and no observation ever comes back saying
 * 'other'.
 *
 * That rule is UNCHANGED by #194, which is why it is restated here rather than
 * quietly left alone. Other launches now: the command starts as a process the
 * panel holds over its stdio, and its dwarf is drawn from that. The observation
 * still never says 'other' — it says `PANEL_OBSERVER`, because what observed
 * the dwarf is the panel and not the chip somebody pressed. 'other' is a
 * CHOICE, 'panel' is an OBSERVER, and this constant belongs to the first.
 */
export const OTHER_CHOICE = 'other'
export type LaunchChoice = DwarfProvider | typeof OTHER_CHOICE

/**
 * The source's own state names, in the source's own order — plus one.
 *
 * `started-detached` is not in the source, and it is the only addition here.
 * The source's flow ends in `message-panel`, and that hand-over needs a session
 * the panel HOLDS: `launchedDwarfIn` recognises the launched dwarf by the first
 * message of its conversation, and `Dwarf.conversation` is documented as
 * held-sessions-only "because nothing else this app runs hands it a
 * conversation live". Codex has no held-session engine in this app (#168), so a
 * Codex launch leaves no such receipt and no dwarf can ever be matched to it.
 *
 * The alternative was to leave such a launch sitting in `submitted-spawning`,
 * which would be the panel claiming to look for something it knows cannot
 * arrive. So the flow gains an honest terminal state instead: the session
 * started, the panel is not watching it, and its dwarf turns up in the mine on
 * an ordinary poll like any other.
 */
export type LaunchPhase =
  | 'closed'
  | 'provider-selection'
  | 'known-provider-ready'
  | 'other-command-required'
  | 'other-command-committed'
  | 'prompt-ready'
  | 'submitted-spawning'
  | 'started-detached'
  | 'message-panel'

/** The three pieces of copy the source specifies for this panel, verbatim. */
export const COMPOSER_DISABLED_PLACEHOLDER = 'Select your Dwarf supplier'
export const COMPOSER_ENABLED_PLACEHOLDER = 'Write here...'
export const COMMAND_PLACEHOLDER = 'Say your command...'

export interface LaunchState {
  open: boolean
  choice: LaunchChoice | null
  /** What is in the custom-command box right now, exactly as typed. */
  command: string
  /** The command Enter committed, or '' while none is. */
  committedCommand: string
  /** The composer's text, exactly as typed — trimming happens on the way out. */
  prompt: string
  /** True from the moment Enter submits until a dwarf is adopted or main refuses. */
  submitting: boolean
  /**
   * True once a launch the panel cannot watch has started (#168) — see
   * `startedDetached`. Distinct from `launchedDwarfId` on purpose: this says a
   * session exists, and says nothing at all about which dwarf it becomes.
   */
  detached: boolean
  /** The dwarf the launched session turned out to be, once one is identified. */
  launchedDwarfId: string | null
  /** Main's reason for refusing the last launch, or null. */
  error: string | null
}

export function closedLaunch(): LaunchState {
  return {
    open: false,
    choice: null,
    command: '',
    committedCommand: '',
    prompt: '',
    submitting: false,
    detached: false,
    launchedDwarfId: null,
    error: null
  }
}

/** Opening is always a fresh panel: nothing about a past launch is carried in. */
export function openLaunch(_state: LaunchState): LaunchState {
  return { ...closedLaunch(), open: true }
}

/** And closing forgets it again, which is what makes the two symmetrical. */
export function closeLaunch(_state: LaunchState): LaunchState {
  return closedLaunch()
}

/**
 * Choose a chip.
 *
 * The prompt survives, because "provider-switch data retention" is Unspecified
 * and discarding somebody's typing is the one reading that costs them work.
 * The command does not: it belongs to Other, and a commit still standing behind
 * a known provider would be a gate passed by a choice nobody is on.
 */
export function chooseProvider(state: LaunchState, choice: LaunchChoice): LaunchState {
  return {
    ...state,
    choice,
    command: choice === OTHER_CHOICE ? state.command : '',
    committedCommand: choice === OTHER_CHOICE ? state.committedCommand : '',
    // The refusal was about the choice that has just changed, so it no longer
    // describes anything on screen.
    error: null
  }
}

/**
 * Type into the custom-command box.
 *
 * Editing takes the commit with it. "Whether the command can be edited after it
 * is committed" is Unspecified; the gate that IS stated — enabled needs a
 * non-empty command committed with `Enter` — reads most simply as a check on
 * what is in the box now, so an edit re-opens it until Enter closes it again.
 */
export function typeCommand(state: LaunchState, text: string): LaunchState {
  return { ...state, command: text, committedCommand: '' }
}

/** Enter in the command box. A box with nothing in it commits nothing. */
export function commitCommand(state: LaunchState): LaunchState {
  const command = state.command.trim()
  if (command === '') return state
  return { ...state, committedCommand: command, error: null }
}

export function typePrompt(state: LaunchState, text: string): LaunchState {
  return { ...state, prompt: text }
}

/**
 * The prompt as it will reach the session: trimmed and capped exactly as
 * `prepareHeldPrompt` and `prepareLaunchPrompt` do it in main.
 *
 * Reproduced rather than approximated, because this string has a second job.
 * The held registry seeds the new session's conversation with it, so it is also
 * how the panel recognises which arriving dwarf is the one it just started —
 * see the adoption rule in useAgentLaunch. A near-copy would identify nobody.
 */
export function launchPrompt(state: LaunchState): string {
  return state.prompt.trim().slice(0, MAX_DWARF_TEXT_CHARS)
}

/** The custom command as it would be run: trimmed, for the same reason. */
export function launchCommand(state: LaunchState): string {
  return state.committedCommand
}

/**
 * Whether the gate the composer is behind is open.
 *
 * Two ways through, and the source draws them as two: a known provider opens it
 * outright, Other opens it only once a command is committed.
 */
export function composerEnabled(state: LaunchState): boolean {
  if (!state.open || state.choice === null) return false
  if (state.choice === OTHER_CHOICE) return state.committedCommand !== ''
  return true
}

/**
 * Where the panel is, in the source's own vocabulary.
 *
 * Derived rather than stored: every phase is a reading of the fields above, and
 * a phase kept alongside them would be a second copy of the same truth to hold
 * in step. The order of the tests is the order the model moves in.
 */
export function launchPhase(state: LaunchState): LaunchPhase {
  if (!state.open) return 'closed'
  if (state.launchedDwarfId !== null) return 'message-panel'
  // Ahead of `submitting`, which `startedDetached` has already cleared, and
  // ahead of every Add state, because this launch really did happen: dropping
  // back to a composer would invite a second one.
  if (state.detached) return 'started-detached'
  if (state.submitting) return 'submitted-spawning'
  if (state.choice === null) return 'provider-selection'
  if (!composerEnabled(state)) return 'other-command-required'
  // A prompt of pure whitespace is not a prompt. Unspecified in the source, but
  // main has already answered it for itself: both launch paths trim before
  // testing for empty and refuse with "Type a prompt first." Offering an Enter
  // that main will refuse would be the panel disagreeing with its own engine.
  if (launchPrompt(state) !== '') return 'prompt-ready'
  return state.choice === OTHER_CHOICE ? 'other-command-committed' : 'known-provider-ready'
}

export function composerPlaceholder(state: LaunchState): string {
  return composerEnabled(state) ? COMPOSER_ENABLED_PLACEHOLDER : COMPOSER_DISABLED_PLACEHOLDER
}

/** Enter in the composer, and the only door into a launch. */
export function canSubmit(state: LaunchState): boolean {
  return launchPhase(state) === 'prompt-ready'
}

/**
 * The launch has been asked for.
 *
 * The prompt is deliberately left standing rather than cleared: it is what the
 * panel shows as the conversation's first message while the session starts, and
 * it is what a refusal hands back for a retry.
 */
export function submitStarted(state: LaunchState): LaunchState {
  if (!canSubmit(state)) return state
  return { ...state, submitting: true, error: null }
}

/**
 * Main refused, and said why.
 *
 * Back to the Add state it submitted from, with everything the user typed still
 * there. #86 asks a failed launch for a reason rather than a silent no-op, and
 * a panel that also swallowed the prompt would be charging them for main's
 * answer twice.
 */
export function submitRefused(state: LaunchState, reason: string): LaunchState {
  return { ...state, submitting: false, error: reason }
}

/**
 * A launch started that this panel cannot watch (#168).
 *
 * The honest end of a DETACHED launch. `adoptLaunchedDwarf` cannot ever be
 * reached for one: it needs a dwarf whose first conversation message is the
 * prompt this panel sent, and only a HELD session carries a conversation at
 * all. So rather than wait in `submitted-spawning` for a receipt that does not
 * exist, the panel stops and says what it actually knows — a session started,
 * and its dwarf will appear in the mine on an ordinary poll.
 *
 * No dwarf id is invented and none is guessed at by timing. That is the same
 * refusal `launchedDwarfIn` is built on: "the dwarf that was not here a moment
 * ago" would adopt whatever happened to start next.
 *
 * Only ever while a launch is in flight, exactly as adoption is, so a panel
 * nobody submitted from cannot fall into this state.
 */
export function startedDetached(state: LaunchState): LaunchState {
  if (!state.submitting) return state
  return { ...state, submitting: false, detached: true, error: null }
}

/**
 * The arriving dwarf has been identified as this launch's own.
 *
 * Only ever while a launch is in flight: adopting outside one would let an
 * unrelated session that happened to start elsewhere take over a panel nobody
 * launched from.
 */
export function adoptLaunchedDwarf(state: LaunchState, dwarfId: string): LaunchState {
  if (!state.submitting) return state
  return { ...state, submitting: false, launchedDwarfId: dwarfId, error: null }
}
