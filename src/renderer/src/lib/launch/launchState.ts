import { MAX_DWARF_TEXT_CHARS, type DwarfProvider, type HeldPermissionMode } from '../../types'

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
 * The source's flow ends in `message-panel`, and that hand-over needs a
 * receipt: `launchedDwarfIn` recognises the launched dwarf by the first
 * message of its conversation, and `Dwarf.conversation` is documented as
 * sessions-the-panel-HOLDS only, "because nothing else this app runs hands it
 * a conversation live". Codex has no held-session engine in this app (#168),
 * so a detached launch leaves no conversation and, for a while, no receipt of
 * any kind — the panel could not have looked for its dwarf without inventing
 * one by timing.
 *
 * So the flow gained a state where such a launch waits instead: the session
 * started, the panel is not holding it, and its dwarf turns up in the mine on
 * an ordinary poll like any other. #191 then gave that wait an end — main
 * proves the dwarf from the session's own opening prompt and stamps a receipt
 * on it — so this is no longer a terminal state, only the one before the
 * hand-over. It stays terminal for a launch main opened no receipt for.
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
  /**
   * The model/effort/permission row under the composer (#239), each null
   * until the user actually touches its select. Null is not "the first
   * option" — it is "say nothing", which is what keeps a launch nobody tuned
   * byte for byte what it was before this row existed: the select still
   * SHOWS its first option by ordinary `<select>` behaviour, but nothing here
   * claims a choice was made until one actually was.
   */
  model: string | null
  effort: string | null
  /** Held Claude only — see HeldSessionLaunchRequest.permissionMode. */
  permissionMode: HeldPermissionMode | null
  /** True from the moment Enter submits until a dwarf is adopted or main refuses. */
  submitting: boolean
  /**
   * True once a launch the panel does not HOLD has started (#168) — see
   * `startedDetached`. Distinct from `launchedDwarfId` on purpose: this says a
   * session exists, and says nothing at all about which dwarf it becomes.
   */
  detached: boolean
  /**
   * The receipt main opened for a detached launch (#191), or null.
   *
   * Names the LAUNCH and never a dwarf — see `Dwarf.launchId`. It is what the
   * panel waits to see come back on the board, and it is the only receipt a
   * detached launch has: a held or hosted one is recognised by the
   * conversation main seeded, and gets none of these.
   */
  launchId: string | null
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
    model: null,
    effort: null,
    permissionMode: null,
    submitting: false,
    detached: false,
    launchId: null,
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
 *
 * Model, effort and permission mode reset too (#239), for the same reason the
 * command does: they are a different provider's own vocabulary, and a choice
 * that survived a switch could ask Codex to launch on a Claude model id it
 * never offered.
 */
export function chooseProvider(state: LaunchState, choice: LaunchChoice): LaunchState {
  return {
    ...state,
    choice,
    command: choice === OTHER_CHOICE ? state.command : '',
    committedCommand: choice === OTHER_CHOICE ? state.committedCommand : '',
    model: null,
    effort: null,
    permissionMode: null,
    // The refusal was about the choice that has just changed, so it no longer
    // describes anything on screen.
    error: null
  }
}

/** Pick a model off the row under the composer (#239). */
export function chooseModel(state: LaunchState, model: string): LaunchState {
  return { ...state, model }
}

/** Pick an effort level off the same row. */
export function chooseEffort(state: LaunchState, effort: string): LaunchState {
  return { ...state, effort }
}

/** Pick a permission mode off the same row — held Claude only. */
export function choosePermissionMode(
  state: LaunchState,
  permissionMode: HeldPermissionMode
): LaunchState {
  return { ...state, permissionMode }
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
 * What the model/effort row asks the launch to carry (#239) — the same shape
 * both `launchAgent` and `launchHeldSession` take. Absent fields stay absent,
 * which is what keeps a launch nobody tuned identical to one from before this
 * row existed.
 */
export function launchTuning(state: LaunchState): { model?: string; effort?: string } {
  return {
    ...(state.model === null ? {} : { model: state.model }),
    ...(state.effort === null ? {} : { effort: state.effort })
  }
}

/**
 * The permission mode a HELD launch asks to carry, or undefined when the row
 * named none. Held-only, unlike `launchTuning` — see
 * `HeldSessionLaunchRequest.permissionMode`.
 */
export function launchPermissionMode(state: LaunchState): HeldPermissionMode | undefined {
  return state.permissionMode ?? undefined
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
 * A DETACHED launch started: main has answered, and the panel is not holding
 * the session (#168, #191).
 *
 * It used to be the honest END of such a launch. `adoptLaunchedDwarf` could
 * not be reached for one, because the only receipt that existed was a HELD
 * conversation opening with the prompt this panel sent, and a detached session
 * carries no conversation at all — so rather than wait in `submitted-spawning`
 * for something that could not arrive, the panel stopped and said what it knew.
 *
 * #191 gave it a receipt of its own. Main matches the session's own opening
 * prompt against the one it sent and stamps the dwarf it proves, so the panel
 * waits HERE for that verdict and then hands over exactly as a held launch
 * does. What has not changed is the rule underneath: still evidence, still
 * never timing. `launchId` is null when main opened no receipt, and then this
 * really is where the launch ends — the session started, and nothing can prove
 * which dwarf it became.
 *
 * Only ever while a launch is in flight, exactly as adoption is, so a panel
 * nobody submitted from cannot fall into this state.
 */
export function startedDetached(state: LaunchState, launchId: string | null): LaunchState {
  if (!state.submitting) return state
  return { ...state, submitting: false, detached: true, launchId, error: null }
}

/**
 * The arriving dwarf has been identified as this launch's own.
 *
 * Only ever while a launch is still this panel's own business — in flight, or
 * detached and waiting for its receipt to appear on the board (#191). Adopting
 * outside both would let an unrelated session that happened to start elsewhere
 * take over a panel nobody launched from.
 *
 * `detached` is deliberately left standing: it is a fact about the session,
 * not a phase, and the session is no less detached for having been recognised.
 * `launchPhase` reads `launchedDwarfId` first, so the panel moves on regardless.
 */
export function adoptLaunchedDwarf(state: LaunchState, dwarfId: string): LaunchState {
  if (!state.submitting && !state.detached) return state
  return { ...state, submitting: false, launchedDwarfId: dwarfId, error: null }
}
