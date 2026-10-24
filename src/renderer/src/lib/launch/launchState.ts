import type {
  IpcResult,
  JevSuggestParams,
  JevSuggestResult,
  JevSuggestionView,
  LaunchCustomParams,
  LaunchFailure as HostLaunchFailure,
  LaunchParams,
  MineId,
  ProviderId
} from '@dwarfai/contracts'
import type { HostLaunch } from '../readModel/launches'
import {
  isCodexPermissionMode,
  isDwarfProvider,
  isHeldPermissionMode,
  type CodexPermissionMode,
  type DwarfProvider,
  type HeldPermissionMode,
  type JevFallbackReason,
  type JevLaunchDefault,
  type JevRouteLaunchResult,
  type JevSettings,
  type JevUnavailableReason,
  type LaunchFailedPush,
  type LaunchFailureCause
} from '../../types'

/**
 * A mode the row's Permissions select can hold: one of the chosen supplier's entry's offered mode ids (14 §3.6
 * `offeredModes`; ADR-011 item 1), as A-35 carries it (`LaunchParams.permissionMode`). AMENDED for ISSUE-228 (was:
 * held Claude's or Codex's own modes, #635): every launch is the Host's since 4b, and the Host takes only an offered id.
 */
export type LaunchPermissionMode = string

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
  /**
   * Held Claude's mode (HeldSessionLaunchRequest.permissionMode) or, since #635, a detached Codex
   * launch's (AgentLaunchRequest.permissionMode) — one field, because a switch of supplier resets
   * it and so it only ever holds the chosen supplier's own vocabulary.
   */
  permissionMode: LaunchPermissionMode | null
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
  /**
   * Why the last launch failed, when it failed for one of the five causes the Add panel's
   * notice names (#635), or null. Kept apart from `error`, which stays the words of a failure no
   * cause was named for — a refusal, the demo, a throw nobody classified — so neither can pass
   * for the other.
   */
  failure: LaunchFailure | null
  /**
   * The correlation id a held launch's verdict carried (#635, MESSAGE-QUESTIONS 16), or null.
   *
   * Deliberately NOT `launchId`. That one is the board receipt `launchedDwarfIn` adopts a
   * detached dwarf by; a held launch is adopted by the conversation main seeded, and main stamps
   * no dwarf with this id, so putting it there would make the panel wait for a receipt that never
   * comes. Its only use is to tell which `LaunchFailedPush` is about this launch.
   */
  heldLaunchId: string | null
  /** The Add Panel's Jev option (#509) — see JevState's own comment. */
  jev: JevState
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
    error: null,
    failure: null,
    heldLaunchId: null,
    jev: closedJevState()
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

/** Pick a permission mode off the same row — held Claude's, or Codex's (#635). */
export function choosePermissionMode(
  state: LaunchState,
  permissionMode: LaunchPermissionMode
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
 * The prompt as it will reach the session: trimmed exactly as
 * `prepareHeldPrompt` and `prepareLaunchPrompt` do it in main.
 *
 * Reproduced rather than approximated, because this string has a second job.
 * The held registry seeds the new session's conversation with it, so it is also
 * how the panel recognises which arriving dwarf is the one it just started —
 * see the adoption rule in useAgentLaunch. A near-copy would identify nobody.
 *
 * AMENDED for #431 (was: `.trim().slice(0, MAX_DWARF_TEXT_CHARS)`, "trimmed
 * and capped"). Both of main’s own helpers lost that slice the same day, and
 * the sentence above is exactly why this one had to go with them: a launch
 * prompt travels on the child's stdin or straight onto a held stream, so no
 * command line ever bounded it, and a copy that still cut would have stopped
 * identifying the very dwarf it started.
 */
export function launchPrompt(state: LaunchState): string {
  return state.prompt.trim()
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
  return isHeldPermissionMode(state.permissionMode) ? state.permissionMode : undefined
}

/**
 * The permission mode a DETACHED Codex launch asks to carry (#635), or undefined when the row
 * named none or the supplier is not Codex — see `AgentLaunchRequest.permissionMode`. Codex only,
 * because main refuses a mode on any other detached provider rather than dropping it.
 */
export function launchCodexPermissionMode(state: LaunchState): CodexPermissionMode | undefined {
  return state.choice === 'codex' && isCodexPermissionMode(state.permissionMode)
    ? state.permissionMode
    : undefined
}

/**
 * Whether a Jev toggle left on stands in for a provider chip (#523) — the one
 * reading of "Jev exists to choose the provider" that needs no new phase: the
 * option is pressable, the person pressed it, and what it chooses is exactly
 * what a chip would have been. Availability is checked here rather than
 * trusted from `enabled` alone because the two are forced in step by
 * `setJevSettings`, and a gate that reads both says so rather than inheriting.
 */
function jevStandsForAChoice(state: LaunchState): boolean {
  return state.jev.availability === 'ready' && state.jev.enabled
}

/**
 * Whether the gate the composer is behind is open.
 *
 * Two ways through, and the source draws them as two: a known provider opens it
 * outright, Other opens it only once a command is committed.
 *
 * AMENDED for #523: with no chip at all, a Jev toggle left on opens it too.
 * With a chip chosen the gate stays the chip's own — including Other's commit
 * check, which the toggle does not unlock — so every path that had a chip is
 * untouched, and with the toggle off this reads exactly as it did.
 */
export function composerEnabled(state: LaunchState): boolean {
  if (!state.open) return false
  if (state.choice === null) return jevStandsForAChoice(state)
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
  // AMENDED for #523. This used to read `choice === null` outright, because a
  // panel with no chip was a panel with a locked composer; now Jev can stand
  // in for the chip, so what separates `provider-selection` from the rest is
  // the gate itself, and a no-chip panel only keeps selecting its supplier
  // while that gate is shut. An OPEN no-chip panel is the chip-chose-it
  // reading carried forward: it falls through to the same phases a chosen
  // known provider reaches, because as far as the gate model is concerned
  // one has been.
  if (!composerEnabled(state)) {
    return state.choice === null ? 'provider-selection' : 'other-command-required'
  }
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
  // A new launch takes the last one's notice with it (#635): nothing retries on its own, so a
  // launch going out again is always a press, and the notice was about the one before it.
  return { ...state, submitting: true, error: null, failure: null }
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
  return { ...state, submitting: false, error: reason, failure: null }
}

/**
 * Main said the launch failed, and named the cause (#635): the notice, rather than a line of
 * prose. The supplier is the one the launch went out on — the chip, or Jev's pick in it — kept
 * here, at the moment of failure, so a chip clicked afterwards cannot rename what failed.
 */
export function submitFailed(state: LaunchState, cause: LaunchFailureCause): LaunchState {
  return {
    ...state,
    submitting: false,
    error: null,
    failure: { cause, choice: state.choice }
  }
}

/**
 * A HELD launch started, and its verdict carried the id a later `LaunchFailedPush` about it will
 * name (#635, MESSAGE-QUESTIONS 16). The launch stays in flight — its dwarf is still adopted by
 * the conversation main seeded — so only the correlation id is recorded; see `heldLaunchId`.
 */
export function heldStarted(state: LaunchState, heldLaunchId: string): LaunchState {
  if (!state.submitting) return state
  return { ...state, heldLaunchId }
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

/*
 * Issue #263. `started-detached` used to be a dead end with no failure
 * channel behind it at all: a `codex exec` that started and died at once —
 * a concurrent instance already holding its lock, a flag it does not
 * recognise, an auth prompt with nothing attached to answer it — read as
 * `launched: true`, and the panel parked on "the session started" with no
 * timeout and no way back to the composer. These two transitions are that
 * way back, for the two failure modes that leave it stranded: main learning
 * the CLI actually died (`launchFailed`), and main never learning anything
 * at all within a generous bound (`detachedTimedOut`).
 */

/**
 * The sentence a launch failure becomes on screen (#263).
 *
 * The CLI's own words when it left any — nothing this app could invent
 * explains a refusal better than the refusal itself, and it is exactly what
 * running the same command by hand in the mine's folder would have shown.
 * The fallback is for the common case where it wrote nothing before a
 * signal ended it: naming the provider and the code (when there is one) is
 * still more than "nothing happened", which is the failure this issue
 * exists to fix.
 */
export function launchFailureMessage(failure: LaunchFailedPush): string {
  const stderr = failure.stderrTail.trim()
  if (stderr !== '') return stderr
  const withCode = failure.exitCode === null ? '' : ` with code ${failure.exitCode}`
  return `${failure.provider} exited${withCode} before it started.`
}

/**
 * Main learned that a detached launch died almost at once (#263) — a PUSH,
 * arriving well after `startedDetached` already parked the panel here.
 *
 * Guarded exactly as `adoptLaunchedDwarf` is, and for the same reason a stray
 * one must not be allowed to take over a panel that moved on: `launchId`
 * ties the push to the ONE launch it is about, so a push arriving late for a
 * launch this panel has since closed or retried is silently ignored, and
 * `launchedDwarfId` being set already means this launch's dwarf was proved
 * BEFORE the failure arrived — a session that genuinely started is not made
 * to un-happen by a stale exit report.
 *
 * Drops back to `detached: false` with the typed prompt still standing, so
 * `launchPhase` reads straight back to `prompt-ready` (or `known-provider-
 * ready` for an emptied composer) and a retry costs one Enter.
 */
export function launchFailed(state: LaunchState, failure: LaunchFailedPush): LaunchState {
  if (state.launchedDwarfId !== null) return state
  // AMENDED for #635 (MESSAGE-QUESTIONS 14/16/17; was: the error line set to
  // `launchFailureMessage`). The push always names its cause now, and a caused failure is the
  // notice. And a HELD launch can be the one it is about: still in flight, correlated by its own
  // `heldLaunchId` rather than the board receipt a detached launch is.
  // AMENDED for #635 (MESSAGE-QUESTIONS 23): the CLI's own lines ride along when it left any,
  // for the notice title's tooltip rather than as the notice's text.
  const failed: LaunchFailure = {
    cause: failure.cause,
    choice: state.choice,
    ...(failure.stderrTail.trim() === '' ? {} : { output: failure.stderrTail })
  }
  if (state.detached && state.launchId === failure.launchId) {
    return { ...state, detached: false, launchId: null, error: null, failure: failed }
  }
  if (state.submitting && state.heldLaunchId !== null && state.heldLaunchId === failure.launchId) {
    return { ...state, submitting: false, heldLaunchId: null, error: null, failure: failed }
  }
  // AMENDED for ISSUE-001: from 3a a launch of a provider not yet moved is still in flight under the `LaunchId` A-35
  // answered, which `PerProviderShapeAdapter` minted and today's A-P3 now names (legacySettlementJoin.ts).
  if (state.submitting && state.launchId !== null && state.launchId === failure.launchId) {
    return { ...state, submitting: false, error: null, failure: failed }
  }
  return state
}

/**
 * How long `started-detached` waits with neither a receipt nor a failure
 * before it gives up and hands the composer back (#263).
 *
 * Generous on purpose, past both of the ordinary paths out of this state: a
 * receipt normally proves a dwarf within a poll or two of it appearing (see
 * the console-hosting research on `#191`), and a genuine failure reports itself
 * within `EARLY_FAILURE_WINDOW_MS` (3s, main-side). Sixty seconds is
 * comfortably beyond either, so reaching it means something this app cannot
 * name went wrong — a hung CLI, a stalled poll — and the honest answer is a
 * neutral sentence and the composer back, never an indefinite wait with no
 * way out, which is the exact trap the diagnosis behind this issue named.
 */
export const DETACHED_TIMEOUT_MS = 60_000

export const DETACHED_TIMEOUT_MESSAGE =
  'This is taking longer than usual. The session may still start — check the mine, or try again.'

/** Same guard as `launchFailed`, same shape of exit, a fixed neutral sentence instead of main's own words. */
export function detachedTimedOut(state: LaunchState, launchId: string | null): LaunchState {
  if (!state.detached || state.launchedDwarfId !== null) return state
  if (state.launchId !== launchId) return state
  return { ...state, detached: false, launchId: null, error: DETACHED_TIMEOUT_MESSAGE }
}

/* --- Jev launch routing: the Add Panel's own state (#509) — one block, appended --- */

/**
 * Whether the Jev option belongs on screen at all, and how (#509's own
 * acceptance criteria): `hidden` while no key is configured — the option
 * does not exist yet, and there is nothing to explain — `unavailable` once
 * main names a reason it cannot be turned on (today only
 * `encryption-unavailable`), shown with that reason rather than hidden, and
 * `ready` once a key is configured. Derived from `JevSettings` rather than
 * stored twice, the same reason `launchPhase` is derived rather than held.
 */
export type JevAvailability = 'hidden' | 'unavailable' | 'ready'

function jevAvailability(settings: JevSettings): JevAvailability {
  if (settings.unavailableReason !== undefined) return 'unavailable'
  return settings.configured ? 'ready' : 'hidden'
}

/** The decision arm of `JevRouteLaunchResult` — the one Jev answer this panel ever APPLIES to its pickers. */
export type JevDecision = Extract<JevRouteLaunchResult, { kind: 'decision' }>

/**
 * Where a Jev ask is, in the source's own promise (#509): the decision is
 * SHOWN before it is acted on and can be OVERRIDDEN. `idle` is both before
 * any ask and after one's card has been dismissed or invalidated by an
 * edited prompt — see `clearJevDecision`, which is the only way back to it.
 */
export type JevRoutingPhase =
  | { phase: 'idle' }
  /**
   * `request` is the per-request token of an A-50 ask in its 14 shape (ISSUE-195, see `jevSuggestAsked`): only
   * the answer to that very request may land. Today's Enter-time ask (`jevAsked`) carries none.
   */
  | { phase: 'asking'; request?: number }
  | { phase: 'decided'; decision: JevDecision }
  /** A-50's answer in its 14 shape, applied to the pickers (`jevSuggestAnswered`); held here only (INV-87). */
  | { phase: 'suggested'; suggestion: JevSuggestionView }
  | {
      phase: 'fellBack'
      reason: JevFallbackReason
      confidence?: number
      /**
       * The person's own configured default (jev-routing-profiles T4),
       * carried here only when `jevAnswered` actually applied it to the
       * pickers — see that function's own comment. Its presence is what
       * tells `useAgentLaunch.submit` to stop for a confirming Enter (or
       * fall straight through with `autoAccept`) exactly as a `decided`
       * phase does, and what tells `AddPanel` to word the fallback line as
       * "your default is set below" rather than today's #509/#523 ending.
       */
      appliedDefault?: JevLaunchDefault
    }

/**
 * The pickers' values a decision is about to overwrite, kept so
 * `clearJevDecision` can put them back exactly — Dismiss, and an edited
 * prompt, both read this rather than guessing what "before" was.
 */
export interface JevPreviousChoice {
  choice: LaunchChoice | null
  model: string | null
  effort: string | null
}

export interface JevState {
  availability: JevAvailability
  unavailableReason?: JevUnavailableReason
  /**
   * The person's own toggle for this panel session (#509) — off by default,
   * and never left on once `availability` stops being `ready`: a toggle for
   * an option that just stopped being offered is not a decision anybody made.
   */
  enabled: boolean
  /**
   * The #523 checkbox beside the toggle: with it on, the Enter that receives
   * a decision applies it AND launches, collapsing #509's two-Enter confirm.
   * The same session-only promise as `enabled`, the same forced-off guard —
   * and the same reason to exist: a choice the person can make once can be
   * made once for a whole panel.
   */
  autoAccept: boolean
  routing: JevRoutingPhase
  previousChoice: JevPreviousChoice | null
  /**
   * Whether the fallback now on screen fell through into a launch of the
   * pickers' own values (#509's case, which needs a chosen chip to fall
   * back ONTO) or was refused for want of one (#523). `AddPanel` words its
   * fallback line from this rather than from the current chips, because a
   * chip clicked afterwards would otherwise rewrite the past: a fallback
   * that launched nothing must never start claiming it launched.
   */
  launchedOnFallback: boolean
}

function closedJevState(): JevState {
  return {
    availability: 'hidden',
    enabled: false,
    autoAccept: false,
    routing: { phase: 'idle' },
    previousChoice: null,
    launchedOnFallback: false
  }
}

/**
 * Main's verdict on the Jev option has arrived (#509) — asked once, on open,
 * alongside the provider and model lists. A toggle left on from a still-
 * `ready` answer survives; anything else forces it off, for `JevState`'s own
 * reason.
 */
export function setJevSettings(state: LaunchState, settings: JevSettings): LaunchState {
  const availability = jevAvailability(settings)
  return {
    ...state,
    jev: {
      ...state.jev,
      availability,
      unavailableReason: settings.unavailableReason,
      enabled: availability === 'ready' && state.jev.enabled,
      // #523: the same guard for auto-accept, for the same reason — a checkbox
      // for an option that stopped being offered is nobody's decision either.
      autoAccept: availability === 'ready' && state.jev.autoAccept
    }
  }
}

/** The person's own toggle. A no-op outside `ready` — there is nothing to turn on. */
export function toggleJev(state: LaunchState): LaunchState {
  if (state.jev.availability !== 'ready') return state
  return { ...state, jev: { ...state.jev, enabled: !state.jev.enabled } }
}

/**
 * The #523 checkbox beside that toggle. Mirrors it exactly — a no-op outside
 * `ready`, because there is nothing to accept — and deliberately shares its
 * guard rather than also requiring `enabled`: the checkbox configures the next
 * ask, and checking it before pressing the toggle is pressing both.
 */
export function toggleJevAutoAccept(state: LaunchState): LaunchState {
  if (state.jev.availability !== 'ready') return state
  return { ...state, jev: { ...state.jev, autoAccept: !state.jev.autoAccept } }
}

/** The ask has left for TypeSafe. Only ever from idle — a second ask mid-flight would be a second request for one launch. */
export function jevAsked(state: LaunchState): LaunchState {
  if (state.jev.routing.phase !== 'idle') return state
  // The ask is the launch going out again (#635), so the last launch's notice goes with it.
  return { ...state, failure: null, jev: { ...state.jev, routing: { phase: 'asking' } } }
}

/**
 * Jev answered (#509). A decision APPLIES through the same paths a person's
 * own click would use — `chooseProvider`/`chooseModel`/`chooseEffort` — so
 * the row under the composer needs no second rendering path for "Jev chose
 * this" versus "I chose this", and the pre-decision values are kept so
 * `clearJevDecision` can put them back exactly. An absent model or effort is
 * left unset rather than guessed at, on the same "say nothing" reading the
 * row under the composer already holds. A fallback touches no picker at all
 * — issue #509's own acceptance criterion is that the launch still happens
 * on whatever they already show.
 *
 * Guarded to `asking` only: an answer arriving after the ask was abandoned
 * (the prompt changed under it — see `clearJevDecision`) describes a request
 * that is no longer this panel's own, and applying it would show a stale
 * suggestion as if it were live.
 */
export function jevAnswered(state: LaunchState, result: JevRouteLaunchResult): LaunchState {
  if (state.jev.routing.phase !== 'asking') return state
  if (result.kind === 'fallback') {
    // jev-routing-profiles T4: a configured default (Settings' Jev section)
    // is applied to the pickers exactly like a decision — the same
    // chooseProvider/chooseModel/chooseEffort paths, previousChoice kept so
    // Dismiss can put things back — rather than leaving the composer on
    // whatever it already showed. `useAgentLaunch.submit` reads
    // `appliedDefault` to stop for the confirming Enter this needs, the same
    // guard a `decided` phase already uses.
    if (result.fallbackTo?.provider !== undefined) {
      const previousChoice: JevPreviousChoice = {
        choice: state.choice,
        model: state.model,
        effort: state.effort
      }
      let applied = chooseProvider(state, result.fallbackTo.provider)
      if (result.fallbackTo.model !== undefined) {
        applied = chooseModel(applied, result.fallbackTo.model)
      }
      if (result.fallbackTo.effort !== undefined) {
        applied = chooseEffort(applied, result.fallbackTo.effort)
      }
      return {
        ...applied,
        jev: {
          ...applied.jev,
          routing: {
            phase: 'fellBack',
            reason: result.reason,
            confidence: result.confidence,
            appliedDefault: result.fallbackTo
          },
          previousChoice,
          // Whether THIS submit falls straight through to a launch is
          // autoAccept's own call, exactly as it is for a decision — see
          // useAgentLaunch.submit's matching guard. Read here, at answer
          // time, for the same reason #523 already reads it for the plain
          // fallback below: the sentence this feeds says what DID (or will).
          launchedOnFallback: state.jev.autoAccept
        }
      }
    }
    return {
      ...state,
      jev: {
        ...state.jev,
        routing: { phase: 'fellBack', reason: result.reason, confidence: result.confidence },
        // #523: recorded at the moment the answer lands, not read off the
        // chips later — the sentence this feeds says what DID, and the only
        // thing that can still say it truthfully is the gate as it stood.
        launchedOnFallback: state.choice !== null
      }
    }
  }
  const previousChoice: JevPreviousChoice = {
    choice: state.choice,
    model: state.model,
    effort: state.effort
  }
  let applied = chooseProvider(state, result.provider)
  if (result.model !== undefined) applied = chooseModel(applied, result.model)
  if (result.effort !== undefined) applied = chooseEffort(applied, result.effort)
  return {
    ...applied,
    jev: { ...applied.jev, routing: { phase: 'decided', decision: result }, previousChoice }
  }
}

/**
 * Throws away whatever the last ask left standing — the card, the fallback
 * line, or an ask still in flight — and restores the pickers a decision had
 * overwritten. Called on every keystroke in the composer: the ask was about
 * a PROMPT, and this panel does not carry an answer for one prompt forward
 * onto another it never asked about. The same function backs the decision
 * card's own Dismiss control — "revert to the pickers' previous values" is
 * exactly this restore, asked for explicitly rather than by editing.
 *
 * Deliberately not called from toggling Jev off: an existing card is about a
 * DECISION, not about whether Jev is enabled, and stays on screen until the
 * prompt or the panel actually changes — toggling off only stops the NEXT
 * submit from asking again.
 */
export function clearJevDecision(state: LaunchState): LaunchState {
  if (state.jev.routing.phase === 'idle') return state
  const restore = state.jev.previousChoice
  const restored: LaunchState =
    restore === null
      ? state
      : { ...state, choice: restore.choice, model: restore.model, effort: restore.effort }
  return {
    ...restored,
    jev: {
      ...restored.jev,
      routing: { phase: 'idle' },
      previousChoice: null,
      // The #523 promise belongs to the routing being cleared, so it goes
      // with it — no fallback line outlives the answer it describes, and no
      // stale promise reaches the next one.
      launchedOnFallback: false
    }
  }
}

/**
 * The sentence a no-chip Enter becomes when the Jev path cannot answer it
 * (#523) — the honest face of the return that used to be silent. It stands
 * ONLY where no fallback line is already saying the same thing on screen:
 * a routing-fallback with no chip owns its own reworded line, and this is for
 * everything else that can reach a submit with the composer open on nothing
 * but Jev (today: the answer that arrived after the prompt moved on).
 */
export const JEV_NO_CHOICE_REFUSAL =
  'Jev could not pick a provider for this prompt. Your prompt was kept — choose a provider to launch.'

/** Whether `submit` should ask Jev first rather than launch straight off the pickers. */
export function shouldAskJev(state: LaunchState): boolean {
  return (
    state.jev.availability === 'ready' && state.jev.enabled && state.jev.routing.phase === 'idle'
  )
}

/* --- end of the #509 block ------------------------------------------------- */

/* --- The launch-failure notice's model (#635) — one block, appended ------------ */

/**
 * The five causes the Add panel's launch-failure notice names (#635; decision log, Five
 * launch-failure causes, Jev cause of a failed launch; MESSAGE-QUESTIONS 14, 16 and 17).
 *
 * The renderer's own union, not the wire's. Main names the three causes it can know
 * (`LaunchFailureCause`), and `choice` is the supplier that launch went out on. The two Jev causes
 * are this panel's reading of a `JevFallbackReason` that left nothing to launch, which main never
 * sees as a failed launch at all (contracts.ts says why), so they stay out of contracts.
 */
export type LaunchFailure =
  | {
      cause: LaunchFailureCause
      choice: LaunchChoice | null
      /**
       * The tool's own last lines, as main captured them (`LaunchFailedPush.stderrTail`, already
       * redacted and bounded there), for the notice title's tooltip (MESSAGE-QUESTIONS 23). Only
       * when it printed something. They can hold local paths or account names: shown in the panel
       * and nowhere else, never logged or sent.
       */
      output?: string
    }
  /** Jev was asked and the service gave no usable answer: a retry can change that. */
  | { cause: 'jev-unreachable' }
  /** Jev fell back for a reason a retry cannot change; `confidence` only as the answer gave it. */
  | { cause: 'jev-could-not-choose'; reason: JevFallbackReason; confidence?: number }

/*
 * The reasons a retry can change: the service was asked and gave nothing usable. Every other
 * reason — no key, a refused key, nothing launchable, the budget, low confidence — is "Jev could
 * not choose" (decision log, Jev cause of a failed launch).
 */
const RETRYABLE_JEV_REASONS: ReadonlySet<JevFallbackReason> = new Set<JevFallbackReason>([
  'unreachable',
  'timeout',
  'rate-limited',
  'invalid-response'
])

/** The cause a Jev fallback that launched nothing is told by. */
export function jevFailureOf(reason: JevFallbackReason, confidence?: number): LaunchFailure {
  if (RETRYABLE_JEV_REASONS.has(reason)) return { cause: 'jev-unreachable' }
  return {
    cause: 'jev-could-not-choose',
    reason,
    ...(confidence === undefined ? {} : { confidence })
  }
}

function isJevFailure(failure: LaunchFailure | null): boolean {
  return failure?.cause === 'jev-unreachable' || failure?.cause === 'jev-could-not-choose'
}

/**
 * Jev fell back and nothing went out (#635): the only case a Jev cause is a failed launch at all.
 * A fallback onto a chosen chip launched on the pickers, and one that put the configured default
 * into them waits for Send the dwarf in; neither is a failure, and both are left exactly as they
 * are. A decision is not a fallback.
 */
export function jevLaunchedNothing(state: LaunchState): LaunchState {
  const routing = state.jev.routing
  if (routing.phase !== 'fellBack' || routing.appliedDefault !== undefined) return state
  if (state.choice !== null) return state
  return { ...state, error: null, failure: jevFailureOf(routing.reason, routing.confidence) }
}

/**
 * What Retry sends again (#635): the same launch. After a supplier's cause that is the pickers as
 * they stand — Jev's pick included, untouched. After a Jev cause Jev gave nothing to launch on, so
 * the same launch is asking Jev again, which needs the fallback cleared back to idle first.
 */
export function retryLaunch(state: LaunchState): LaunchState {
  return isJevFailure(state.failure) ? clearJevDecision(state) : state
}

/**
 * Pick manually (#635): Let Jev choose goes off so the chips and the three selects take over,
 * the notice goes, and the prompt stays. The fallback it answered goes too, since the pickers,
 * not Jev, choose the next launch.
 */
export function pickManually(state: LaunchState): LaunchState {
  const cleared = clearJevDecision(state)
  return { ...cleared, failure: null, jev: { ...cleared.jev, enabled: false } }
}

/* --- end of the #635 block --------------------------------------------------- */

/* --- MCP subtask delegation: the routedByJev marker (#511) — one block, appended --- */
/**
 * Whether a Jev DECISION was actually applied to the launch this submit is
 * about to send — gate level (2) of the three `delegationGate.ts` requires,
 * and the one fact `AgentLaunchRequest.routedByJev` / `HeldSessionLaunchRequest
 * .routedByJev` carry across the wire.
 *
 * `'decided'` only, never `'fellBack'` — the same honesty rule
 * `JevState.launchedOnFallback` already holds for the same distinction: a
 * launch on the fallback pickers, even one that applied a configured default,
 * is a launch on what the PERSON'S OWN settings say, not one Jev routed.
 * Reaching `'decided'` already implies `jev.enabled` (`jevAsked` only leaves
 * idle through `shouldAskJev`'s own gate), so there is nothing else to check.
 */
// AMENDED for ISSUE-001 (was: `'decided'` only): from 3a Jev's pick reaches the pickers as A-50's suggestion
// (ISSUE-195), the 14 phase of the same applied pick.
export function routedByJev(state: LaunchState): boolean {
  return state.jev.routing.phase === 'decided' || state.jev.routing.phase === 'suggested'
}
/* --- end of the #511 block ---------------------------------------------------- */

/* --- A-50 in its 14 shape: the Jev card while typing (ISSUE-195) — one block, appended --- */

/** A-50's answer as UI main returns it (14 §3.8 `routeJevLaunch`): a call error, or the domain outcome. */
export type JevSuggestAnswer = IpcResult<JevSuggestResult>

/** Whether the prompt as it stands is worth a Jev ask: the option is on and there is a prompt to ask about. */
export function shouldSuggest(state: LaunchState): boolean {
  return (
    state.open &&
    state.jev.availability === 'ready' &&
    state.jev.enabled &&
    launchPrompt(state) !== ''
  )
}

/** The A-50 request for the prompt as it stands (14 §3.4 `JevSuggestParams`). */
export function jevSuggestParams(state: LaunchState, mineId: MineId): JevSuggestParams {
  return { prompt: launchPrompt(state), mineId }
}

/** The prompt changed (or was first written): the last card goes, and a new ask leaves under `request`. */
export function jevSuggestAsked(state: LaunchState, request: number): LaunchState {
  const cleared = clearJevDecision(state)
  if (!shouldSuggest(cleared)) return cleared
  return { ...cleared, jev: { ...cleared.jev, routing: { phase: 'asking', request } } }
}

/**
 * A-50 answered `request`. Only the answer to the ask still in flight lands: one that arrives after Dismiss, an
 * emptied prompt or a newer ask describes a prompt this panel no longer holds, and is dropped (INV-87; 16 §6.5).
 *
 * A pick applies through the same paths a person's own click uses, keeping what stood before for Dismiss. Anything
 * else (a call error, `jev-unreachable`, `jev-could-not-choose`, `not-configured`, or a suggestion that names no
 * supplier these pickers offer) shows no card: the ask ends and the pickers stay as they stood before it, which the
 * ask itself never touched (US-LAUNCH-003.AC08).
 */
export function jevSuggestAnswered(
  state: LaunchState,
  request: number,
  answer: JevSuggestAnswer
): LaunchState {
  const routing = state.jev.routing
  if (routing.phase !== 'asking' || routing.request !== request) return state
  const suggestion = answer.ok && answer.value.ok ? answer.value.value : null
  const provider = suggestion?.providerId
  if (suggestion === null || !isDwarfProvider(provider)) {
    return {
      ...state,
      jev: {
        ...state.jev,
        routing: { phase: 'idle' },
        previousChoice: null,
        launchedOnFallback: false
      }
    }
  }
  const previousChoice: JevPreviousChoice = {
    choice: state.choice,
    model: state.model,
    effort: state.effort
  }
  let applied = chooseProvider(state, provider)
  if (suggestion.model !== undefined) applied = chooseModel(applied, suggestion.model)
  if (suggestion.effort !== undefined) applied = chooseEffort(applied, suggestion.effort)
  return {
    ...applied,
    jev: { ...applied.jev, routing: { phase: 'suggested', suggestion }, previousChoice }
  }
}

/* --- end of the ISSUE-195 block ------------------------------------------------- */

/* --- A-35 in its 14 shape: the launch the Host owns (ISSUE-001, the ISSUE-179 call side) — one block, appended --- */

/** Whether Let Jev choose stands for the way this launch goes (07 5A `ready`: a supplier, a custom command or Jev on). */
function jevChooses(state: LaunchState): boolean {
  return state.jev.availability === 'ready' && state.jev.enabled
}

/**
 * The A-35 request for the form as it stands (14 §3.4 `LaunchParams`; 07 5A S5.04, S5.08a): with Let Jev choose on
 * the Host's Jev way (it asks Jev at Send, S5.10), otherwise the chosen supplier; the model, effort and permission mode
 * only where the person chose them; the person's two Jev switches; `retryOf` for a Retry of a failed launch. Null for
 * Other… (a custom command is A-39, `customLaunchParamsOf`, ISSUE-186) or a form with no way to run.
 */
export function launchParamsOf(
  state: LaunchState,
  mineId: MineId,
  requestId: string,
  retryOf?: string,
  offeredModes: readonly string[] = []
): LaunchParams | null {
  if (state.choice === OTHER_CHOICE) return null
  const jev = jevChooses(state)
  if (!jev && state.choice === null) return null
  return {
    mineId,
    way:
      jev || state.choice === null
        ? { kind: 'jev' }
        : { kind: 'supplier', providerId: state.choice },
    ...launchTuning(state),
    ...permissionModeOf(state, jev ? [] : offeredModes),
    prompt: launchPrompt(state),
    jevOn: jev,
    jevAutoAccept: state.jev.autoAccept,
    ...(retryOf === undefined ? {} : { retryOf: retryOf as NonNullable<LaunchParams['retryOf']> }),
    requestId
  }
}

/**
 * The permission mode a supplier launch carries (ADR-011 item 1; US-LAUNCH-001.AC04): the one the select holds while
 * the entry offers it, else the first offered one, which is what the select shows; none when the entry offers none (a
 * supplier without an answer channel and no other mode, US-LAUNCH-001.AC14) or the launch is Jev's (no supplier).
 */
function permissionModeOf(
  state: LaunchState,
  offeredModes: readonly string[]
): { permissionMode?: string } {
  const held = state.permissionMode
  const mode = held !== null && offeredModes.includes(held) ? held : offeredModes[0]
  return mode === undefined ? {} : { permissionMode: mode }
}

/**
 * The Host accepted the launch (14 §1.7: `LaunchAccepted` at acceptance): it stays sending — "Sending the dwarf in…" —
 * under its `LaunchId`, until the Host's start or failure event (07 5A `sending`, no client timer; NFR-TIM-07).
 */
export function hostLaunchAccepted(state: LaunchState, launchId: string): LaunchState {
  if (!state.submitting) return state
  return { ...state, launchId, heldLaunchId: null, error: null }
}

/** The Host's failure in the notice's own vocabulary (ADR-020 D1): the cause, the supplier it was for, the tail. */
function hostFailureOf(failure: HostLaunchFailure, choice: LaunchChoice | null): LaunchFailure {
  if (failure.cause === 'jev-unreachable') return { cause: 'jev-unreachable' }
  if (failure.cause === 'jev-could-not-choose') {
    // The Host names the reason of every Jev cause (launching/application/launch.ts).
    return { cause: 'jev-could-not-choose', reason: failure.jevReason as JevFallbackReason }
  }
  return {
    cause: failure.cause,
    choice,
    ...(failure.toolOutputTail === undefined || failure.toolOutputTail.trim() === ''
      ? {}
      : { output: failure.toolOutputTail })
  }
}

/**
 * What the Host stated of this panel's launch (14 §4.1 `launches`; 07 5A S5.05–S5.07), applied while it is still in
 * flight and only for its own `LaunchId`:
 *
 * - failed (`launch.failed`) → the notice with the cause; the launch id stays, for Retry's `retryOf` (S5.06, S5.08a);
 * - succeeded with its dwarf → the MessagePanel on that dwarf (S5.05);
 * - handed back → ready again, the picks the Host handed back in the pickers, no notice (S5.07, OQ-38 B);
 * - anything else (routing, resolving, spawned) → still sending.
 */
export function hostLaunchFollowed(
  state: LaunchState,
  launch: HostLaunch | undefined
): LaunchState {
  if (!state.submitting || launch === undefined || launch.launchId !== state.launchId) return state
  if (launch.failure !== null) {
    return {
      ...state,
      submitting: false,
      error: null,
      failure: hostFailureOf(launch.failure, state.choice)
    }
  }
  const wire = launch.wire
  if (wire === null) return state
  if (wire.state === 'succeeded' && wire.dwarfId !== undefined) {
    return adoptLaunchedDwarf(state, wire.dwarfId)
  }
  if (wire.state === 'handed-back') {
    const provider: ProviderId | undefined = wire.picks?.providerId
    let back = isDwarfProvider(provider) ? chooseProvider(state, provider) : state
    if (wire.picks?.model !== undefined) back = chooseModel(back, wire.picks.model)
    if (wire.picks?.effort !== undefined) back = chooseEffort(back, wire.picks.effort)
    return { ...back, submitting: false, launchId: null, error: null, failure: null }
  }
  return state
}

/**
 * A launch the Host never stated within today's bound (ISSUE-001): one A-35 served through `PerProviderShapeAdapter`
 * for a provider not yet moved (21 §3.1), whose settlement is today's (A-P3 or its dwarf on the board), so it keeps
 * today's neutral way out (#263). A launch the Host stated is the Host's to settle, never a timer's (NFR-TIM-07).
 */
export function unstatedLaunchTimedOut(
  state: LaunchState,
  launchId: string,
  stated: boolean
): LaunchState {
  if (stated || !state.submitting || state.launchId !== launchId) return state
  if (state.launchedDwarfId !== null) return state
  return { ...state, submitting: false, launchId: null, error: DETACHED_TIMEOUT_MESSAGE }
}

/* --- end of the ISSUE-001 block ------------------------------------------------ */

/* --- A-39 in its 14 shape: the "Other…" launch the Host owns (ISSUE-186) — one block, appended --- */

/**
 * The A-39 request for an "Other…" form (14 §3.4 `LaunchCustomParams`; 07 5A S5.04, S5.08a; 21 §2 cut 3d): the
 * committed command as typed (the Host parses it, with no shell), the prompt, and `retryOf` for a Retry of a failed
 * launch. Null for any other choice (its request is A-35's, `launchParamsOf`).
 */
export function customLaunchParamsOf(
  state: LaunchState,
  mineId: MineId,
  requestId: string,
  retryOf?: string
): LaunchCustomParams | null {
  if (state.choice !== OTHER_CHOICE) return null
  return {
    mineId,
    command: launchCommand(state),
    prompt: launchPrompt(state),
    ...(retryOf === undefined
      ? {}
      : { retryOf: retryOf as NonNullable<LaunchCustomParams['retryOf']> }),
    requestId
  }
}

/* --- end of the ISSUE-186 block ------------------------------------------------ */
