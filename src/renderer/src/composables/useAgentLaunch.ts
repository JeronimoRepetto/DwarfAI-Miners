import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { launchedDwarfIn } from '../lib/launch/launchArrival'
import {
  DETACHED_TIMEOUT_MS,
  adoptLaunchedDwarf,
  canSubmit,
  chooseEffort,
  chooseModel,
  choosePermissionMode,
  chooseProvider,
  clearJevDecision,
  closeLaunch,
  closedLaunch,
  commitCommand,
  composerEnabled,
  composerPlaceholder,
  detachedTimedOut,
  jevAnswered,
  jevAsked,
  JEV_NO_CHOICE_REFUSAL,
  launchCommand,
  launchFailed,
  launchPermissionMode,
  launchPhase,
  launchPrompt,
  launchTuning,
  openLaunch,
  routedByJev,
  setJevSettings,
  shouldAskJev,
  startedDetached,
  submitRefused,
  submitStarted,
  toggleJev,
  toggleJevAutoAccept,
  typeCommand,
  typePrompt,
  OTHER_CHOICE,
  type JevState,
  type LaunchChoice,
  type LaunchPhase,
  type LaunchState
} from '../lib/launch/launchState'
import {
  effortPicker,
  modelPicker,
  permissionsVisible,
  type EffortPicker,
  type ModelPicker
} from '../lib/launch/modelTuning'
import { launchRefusal, providerChips, type ProviderChip } from '../lib/launch/providerChips'
import { DEFAULT_JEV_SETTINGS, HELDABLE_PROVIDERS } from '../types'
import type {
  AgentLaunchRequest,
  AgentModelCatalog,
  AgentProviderOption,
  HeldPermissionMode,
  JevRouteLaunchResult,
  JevSettings,
  LaunchFailedPush,
  Mine,
  OpenCodeCredentialMissing
} from '../types'

/**
 * Launching an agent from inside a mine (#86, #194): the IPC, and the state the
 * design's gates are read off.
 *
 * App owns this composable — and therefore the bridge — for the reason it owns
 * every other one: AddPanel stays presentational, and the "render only what
 * main verified" rule lives in one place. The gates themselves are not here at
 * all; they are pure, in lib/launch, so this file is only the parts that need a
 * process on the other end.
 *
 * ## Why a channel this panel HOLDS, and not the detached one
 *
 * Three launch modes exist and all three belong. The detached one hands the
 * session over and lets go, so it outlives the panel; the held one keeps an
 * Agent SDK stream into a CLI this app knows; the HOSTED one keeps a pipe into
 * a program the person named themselves (#194). The design decides between
 * them: submitting has to open the MessagePanel with the submitted prompt as
 * the first message and then show the reply there. Only a stream this panel
 * holds gives it words FIRST-HAND — an observed session is read from a
 * transcript, second-hand and a write behind — so where a provider can be
 * held, it is.
 *
 * That is a preference between channels, and #191 settled what it never was:
 * an excuse for a detached launch to hand over to nothing. A detached session
 * does reach the MessagePanel, on the receipt below, and the panel then reads
 * its transcript on its own channel like any other session somebody else
 * started. Second-hand words beat none.
 *
 * ## Other is a launch now, not a refusal
 *
 * It was refused until #194 — `OTHER_NOT_LAUNCHABLE`, gone from
 * providerChips.ts along with its whole argument — on the ground that a custom
 * process writes no session store, so no dwarf could ever be drawn from it. The
 * maintainer reversed that: the panel is its stdio, so the panel is what
 * observes it.
 *
 * Nothing here gained a phase for it, and that is the test of the shape. A
 * hosted launch is adopted through the SAME receipt a held one is — the first
 * message of the arriving dwarf's conversation is the prompt this panel sent
 * (see launchedDwarfIn) — because main seeds a hosted process's conversation
 * exactly as the held registry seeds a session's. So `submit` gained one branch
 * and `observe` gained nothing at all.
 *
 * ## The first message is not shown twice
 *
 * Nothing here prepends the prompt to the conversation. `HeldSessionRegistry`
 * already seeds the session with it, so the MessagePanel draws main's own
 * record of what was sent rather than this panel's optimism about it — and the
 * spawning view below shows the prompt only while there is no dwarf to draw it
 * on, which is the window in which it exists nowhere else.
 */

// Singleton store: module-scope state shared by every useAgentLaunch() caller,
// exactly as the mines, messaging, kicking and question stores are. At most one
// Add Panel exists — it shares the MessagePanel's one dock — so there is one
// launch in flight at a time and one place to hold it.
const state = ref<LaunchState>(closedLaunch())
const mineId = ref<string | null>(null)
const providers = ref<AgentProviderOption[]>([])
/** What each provider can start on, live (#239) — asked once per open, beside `providers`. */
const catalogs = ref<AgentModelCatalog[]>([])
/**
 * The provider and model main held the last detached launch back for, because
 * OpenCode has no login for that provider yet (#597 T5) — or null. The login
 * dialog opens on this; `heldBackRequest` beside it is the request itself, kept
 * so `relaunch` sends exactly what was refused rather than rebuilding it from
 * pickers that could have moved.
 */
const credentialMissing = ref<OpenCodeCredentialMissing | null>(null)
let heldBackRequest: AgentLaunchRequest | null = null

const LOST_BRIDGE = 'The panel lost contact with the app.'
const NOT_LAUNCHED = 'The agent could not be started.'

export interface AgentLaunch {
  state: Ref<LaunchState>
  /** The mine the panel was opened from; every launch starts in its folder. */
  mineId: Ref<string | null>
  providers: Ref<AgentProviderOption[]>
  chips: ComputedRef<ProviderChip[]>
  phase: ComputedRef<LaunchPhase>
  enabled: ComputedRef<boolean>
  placeholder: ComputedRef<string>
  /** Why the current choice cannot start a session, or null. */
  refusal: ComputedRef<string | null>
  /** The row under the composer (#239): what the model select should draw. */
  modelPicker: ComputedRef<ModelPicker>
  /** What the effort select should draw, empty when the chosen provider has none. */
  effortPicker: ComputedRef<EffortPicker>
  /** Whether the Permissions select belongs on screen — held Claude only. */
  permissionsVisible: ComputedRef<boolean>
  /** The Add Panel's Jev option (#509) — availability, the person's toggle, and the routing card/line. */
  jev: ComputedRef<JevState>
  /** Who the last launch needs an OpenCode login for (#597 T5), or null. */
  credentialMissing: Ref<OpenCodeCredentialMissing | null>
  /**
   * Send the launch `credentialMissing` was raised for again, byte for byte,
   * once the login dialog reports the provider connected (#597 T5). A no-op
   * when nothing was held back or the panel has since closed or moved on.
   */
  relaunch: () => Promise<void>
  open: (mine: string) => Promise<void>
  close: () => void
  choose: (choice: LaunchChoice) => void
  setCommand: (text: string) => void
  commit: () => void
  setPrompt: (text: string) => void
  /** Pick a model off the row under the composer. */
  setModel: (value: string) => void
  setEffort: (value: string) => void
  setPermissionMode: (value: HeldPermissionMode) => void
  /** The person's own Jev toggle (#509) — a no-op outside `ready`. */
  toggleJevEnabled: () => void
  /** The #523 checkbox beside it — same guard, same no-op, same session. */
  toggleJevAutoAccept: () => void
  /** Dismiss the decision card, restoring the pickers it overwrote (#509). */
  dismissJevDecision: () => void
  submit: () => Promise<void>
  observe: (mines: readonly Mine[]) => void
  /**
   * Subscribe to main's launch-failure push (#263). Returns the unsubscribe,
   * exactly like every other `window.api.on*` member — the caller (the
   * message-panel window, which owns this composable's lifetime) holds it
   * and calls it on unmount, the same pattern `useDwarfDelivery.listen()`
   * already uses.
   */
  listenFailures: () => () => void
}

/**
 * Ask the bridge for one thing, and answer with `fallback` for EITHER way it
 * can fail to: a real rejection, or the member not existing on `window.api`
 * at all (a bare `vi.fn()`-free test double, or a build this bridge member
 * has not reached yet). The call itself happens inside the `try` — not
 * before it — so a missing member's synchronous throw is caught exactly like
 * a rejected promise's asynchronous one; see `open`'s own note on why this
 * had to keep that property while asking three members at once.
 */
async function safelyAsk<T>(ask: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await ask()
  } catch {
    return fallback
  }
}

export function useAgentLaunch(): AgentLaunch {
  const chips = computed(() => providerChips(providers.value, state.value.choice))
  const phase = computed(() => launchPhase(state.value))
  const refusal = computed(() => launchRefusal(providers.value, state.value.choice))
  const jev = computed(() => state.value.jev)

  /**
   * Open the panel on a mine, and ask what this machine has.
   *
   * Asked per open rather than held from startup: a CLI installed while the
   * panel was running would otherwise never appear, and detection's own TTL
   * makes reopening cost a map lookup rather than a disk walk.
   *
   * The model catalogue is asked alongside the provider list (#239), on the
   * same per-open cadence rather than per keystroke — see
   * createSdkModelCatalog's own note on what a live ask costs. A bridge that
   * cannot answer degrades to no catalogues, which reads as every model
   * picker showing 'This provider does not report its models.' rather than
   * the panel failing to open at all.
   *
   * Jev's settings verdict (#509) is asked the same way, alongside the other
   * two rather than after them — all three fire together through
   * `safelyAsk`, so a slow or unreachable Jev answer never holds up
   * providers or models reaching the panel, and a bridge that cannot answer
   * it degrades to `configured: false`, which reads as the option simply not
   * being offered yet — never a reason to fail the open itself.
   */
  async function open(mine: string): Promise<void> {
    mineId.value = mine
    state.value = openLaunch(state.value)
    const [providersAnswer, catalogsAnswer, jevSettings] = await Promise.all([
      safelyAsk(() => window.api.listAgentProviders(), { providers: [] }),
      safelyAsk(() => window.api.listAgentModels(), { catalogs: [] }),
      // AMENDED for the #509 follow-up: the fallback carries the documented
      // default's `preferences` too, now that JevSettings always has one.
      safelyAsk<JevSettings>(() => window.api.getJevSettings(), { ...DEFAULT_JEV_SETTINGS })
    ])
    providers.value = providersAnswer.providers
    catalogs.value = catalogsAnswer.catalogs
    state.value = setJevSettings(state.value, jevSettings)
  }

  function close(): void {
    state.value = closeLaunch(state.value)
    mineId.value = null
    providers.value = []
    catalogs.value = []
    forgetHeldBack()
  }

  function forgetHeldBack(): void {
    credentialMissing.value = null
    heldBackRequest = null
  }

  /**
   * The detached channel, for `submit` and `relaunch` alike — one place that
   * reads main's verdict, so a relaunch is handled exactly as the first try.
   */
  async function launchDetached(request: AgentLaunchRequest): Promise<void> {
    forgetHeldBack()
    const result = await window.api.launchAgent(request)
    if (!result.launched) {
      // #597 T5: the sentence still goes on the error line, so a person who
      // closes the login dialog is left with the reason, not a silent panel.
      if (result.credentialMissing !== undefined) {
        credentialMissing.value = { ...result.credentialMissing }
        heldBackRequest = request
      }
      state.value = submitRefused(state.value, result.error ?? NOT_LAUNCHED)
      return
    }
    // A detached session carries no conversation at all — that belongs to a
    // stream this panel holds — so it is recognised by the receipt main
    // opened here instead, which main stamps on the dwarf it proves from the
    // session's own opening prompt (#191).
    const launchId = result.launchId ?? null
    state.value = startedDetached(state.value, launchId)
    // #263. Only a receipted launch gets a timer. A launch main opened no
    // receipt for is already the terminal `started-detached` #168 gives
    // it — "the session started, and nothing can prove which dwarf it
    // became" — and that reading is not reopened here: there is nothing
    // for a later receipt or failure to correlate against, so there is
    // nothing a timeout would honestly add.
    if (launchId !== null) {
      setTimeout(() => {
        state.value = detachedTimedOut(state.value, launchId)
      }, DETACHED_TIMEOUT_MS)
    }
  }

  async function relaunch(): Promise<void> {
    const request = heldBackRequest
    if (request === null || request.mineId !== mineId.value || !canSubmit(state.value)) return
    state.value = submitStarted(state.value)
    try {
      await launchDetached(request)
    } catch {
      state.value = submitRefused(state.value, LOST_BRIDGE)
    }
  }

  function choose(choice: LaunchChoice): void {
    state.value = chooseProvider(state.value, choice)
  }

  function setCommand(text: string): void {
    state.value = typeCommand(state.value, text)
  }

  function commit(): void {
    state.value = commitCommand(state.value)
  }

  function setPrompt(text: string): void {
    state.value = typePrompt(state.value, text)
    // A Jev card or fallback line describes the PROMPT that produced it
    // (#509) — see clearJevDecision's own comment — so editing it here drops
    // whatever the last ask left standing, and puts back any picker values a
    // decision had overwritten, rather than let a stale answer outlive the
    // request it was about.
    state.value = clearJevDecision(state.value)
  }

  function setModel(value: string): void {
    state.value = chooseModel(state.value, value)
  }

  function setEffort(value: string): void {
    state.value = chooseEffort(state.value, value)
  }

  function setPermissionMode(value: HeldPermissionMode): void {
    state.value = choosePermissionMode(state.value, value)
  }

  function toggleJevEnabled(): void {
    state.value = toggleJev(state.value)
  }

  // Named apart from the transition it calls for the same reason
  // `toggleJevEnabled` is: a local `function` of the import's own name would
  // shadow it and make the body recurse.
  function toggleJevAutoAcceptChoice(): void {
    state.value = toggleJevAutoAccept(state.value)
  }

  function dismissJevDecision(): void {
    state.value = clearJevDecision(state.value)
  }

  /**
   * Enter on a ready composer.
   *
   * A choice with no engine behind it is refused HERE and never sent. Sending
   * it anyway would start a Claude session for a command the user picked
   * instead of Claude — a launch nobody asked for is worse than a refusal that
   * says why, and it would be a real process in a real folder.
   *
   * Which of the three channels a submit goes down is decided by what the
   * choice IS, and each is the only honest route for its own case: a command of
   * the person's own has no provider to name, a Claude session can be held, and
   * anything else is started detached.
   *
   * ## Jev's one detour (#509)
   *
   * When Jev is enabled and ready and nothing has asked it yet, this Enter
   * asks Jev FIRST rather than launching straight off the pickers. A decision
   * stops here — it is SHOWN, never acted on by itself, so the person presses
   * Launch again on the pickers it just applied, or changes them first. A
   * fallback falls straight through into the ordinary launch below, on
   * whatever the pickers already show, which is issue #509's own acceptance
   * criterion: every way Jev can fail still launches and says that it did.
   * The refusal check and everything after it therefore reads state AFTER
   * this detour, never before — a decision may have just changed `choice`.
   *
   * ## AMENDED for #523: the detour without a chip, and what it ends in
   *
   * The composer now opens on the toggle alone, so this detour is the whole
   * entry path, not a detour across a pickers' launch. Two rules moved with
   * that: a decision stops the Enter only while auto-accept is off — with it
   * on, the same Enter applies the decision and falls through to launch it —
   * and a fallback that falls through onto NO chip launches nothing and must
   * say so rather than swallow the press. It does not need the error line to
   * say it: `jevAnswered` has already left a `fellBack` routing with
   * `launchedOnFallback` false, and AddPanel words that line into the refusal
   * the moment the answer lands. The error line is for the one no-chip case
   * with no line of its own — the answer that arrived after the prompt moved
   * on, which leaves the routing idle and the screen otherwise silent.
   */
  async function submit(): Promise<void> {
    if (!canSubmit(state.value) || mineId.value === null) return
    // An ask in flight is this panel's one launch in flight, held by the model
    // and not only by the view's Enter guard: a second submit here would find
    // `shouldAskJev` false (the ask already left) and launch on the pickers
    // the decision has not reached yet, and the late answer would then
    // rewrite them behind a session already started.
    if (state.value.jev.routing.phase === 'asking') return

    if (shouldAskJev(state.value)) {
      state.value = jevAsked(state.value)
      let result: JevRouteLaunchResult
      try {
        result = await window.api.routeJevLaunch({ prompt: launchPrompt(state.value) })
      } catch {
        // The bridge refused or threw outright — 'invalid-response' names
        // exactly this: an answer that cannot be turned into something this
        // panel can act on, never a reason to hang on a promise that will
        // not resolve into a usable shape.
        result = { kind: 'fallback', reason: 'invalid-response' }
      }
      state.value = jevAnswered(state.value, result)
      // Read off `state`, not `result`: a prompt edited during the ask
      // already dropped this back to idle (clearJevDecision, via setPrompt),
      // and an answer that arrived too late to apply must not silently
      // swallow this Enter either.
      // #523: unless the person asked for exactly this — auto-accept collapses
      // the confirm, and the decision just applied IS the launch they pressed
      // for. A fallback was never up for auto-accepting UNLESS it applied a
      // configured default (jev-routing-profiles T4): that default was just
      // set on the pickers exactly like a decision (`jevAnswered`'s own
      // detour), so it shares the same stop-for-confirmation guard — a plain
      // fallback with no default carries no `appliedDefault` and keeps
      // falling straight through below, #509's own acceptance criterion.
      const routing = state.value.jev.routing
      const awaitingConfirmation =
        routing.phase === 'decided' ||
        (routing.phase === 'fellBack' && routing.appliedDefault !== undefined)
      if (awaitingConfirmation && !state.value.jev.autoAccept) return
    }

    const refused = refusal.value
    if (refused !== null) {
      state.value = submitRefused(state.value, refused)
      return
    }

    const choice = state.value.choice
    if (choice === null) {
      // #523. Silent until this line existed, because nothing could reach it:
      // only Jev's unlocked composer opens a submit with no chip. A fallback
      // owns its own reworded line (see the doc above) and this Enter has
      // already been answered by it; everything else that lands here — today,
      // the answer that arrived after the prompt moved on — gets the honest
      // refusal, prompt intact, manual path still open.
      if (state.value.jev.routing.phase !== 'fellBack') {
        state.value = submitRefused(state.value, JEV_NO_CHOICE_REFUSAL)
      }
      return
    }
    const prompt = launchPrompt(state.value)
    state.value = submitStarted(state.value)
    try {
      // A command of the person's own (#194). It names no provider because
      // there is none — the whole reason it is a channel of its own rather than
      // a nullable field on the launch request — and main parses the string
      // into a program plus an argv array, with no shell anywhere.
      if (choice === OTHER_CHOICE) {
        const hostedResult = await window.api.launchHostedProcess({
          mineId: mineId.value,
          command: launchCommand(state.value),
          prompt
        })
        // No `startedDetached` branch, because this panel IS holding that
        // process: its dwarf arrives carrying the prompt sent here, which is
        // the same receipt `observe` already recognises for a held session.
        if (!hostedResult.launched) {
          state.value = submitRefused(state.value, hostedResult.error ?? NOT_LAUNCHED)
        }
        return
      }

      // Kept as two calls rather than one verdict of a union type, because
      // the two verdicts differ in what they carry: only the detached one
      // opens a receipt (#191), and a branch that narrowed on a boolean would
      // have to assert its way to that field.
      if (HELDABLE_PROVIDERS.includes(choice)) {
        const permissionMode = launchPermissionMode(state.value)
        const heldResult = await window.api.launchHeldSession({
          mineId: mineId.value,
          provider: choice,
          prompt,
          ...launchTuning(state.value),
          ...(permissionMode === undefined ? {} : { permissionMode }),
          // #511: true only once a Jev DECISION was applied to this launch —
          // never on a fallback, whatever its own pickers ended up showing.
          ...(routedByJev(state.value) ? { routedByJev: true } : {})
        })
        // A verdict of `launched: true` says a session STARTED and nothing
        // more, on every channel. What differs is what can be done with it: a
        // held launch's dwarf arrives carrying the prompt this panel sent,
        // seeded into its conversation by main, so it needs nothing else here.
        if (!heldResult.launched) {
          state.value = submitRefused(state.value, heldResult.error ?? NOT_LAUNCHED)
        }
        return
      }

      await launchDetached({
        mineId: mineId.value,
        provider: choice,
        prompt,
        ...launchTuning(state.value),
        // Same rule and same reason as the held channel's own (#511).
        ...(routedByJev(state.value) ? { routedByJev: true } : {})
      })
    } catch {
      state.value = submitRefused(state.value, LOST_BRIDGE)
    }
  }

  /**
   * Every poll, while a launch is still this panel's own: has its dwarf
   * arrived.
   *
   * Recognised by the receipt the launch left on the board rather than by
   * timing — see `launchedDwarfIn` for why that distinction is the whole rule,
   * and for the two receipts a launch can hold.
   *
   * A detached launch is watched too (#191), which is the change: it is past
   * `submitting` — main answered the moment the process started — so watching
   * only in flight is what left Add > Codex stranded on "the session started"
   * while its dwarf appeared, replied and walked out again.
   */
  function observe(mines: readonly Mine[]): void {
    if (mineId.value === null) return
    if (!state.value.submitting && !state.value.detached) return
    const mine = mines.find((entry) => entry.id === mineId.value)
    const dwarf = launchedDwarfIn(mine, launchPrompt(state.value), state.value.launchId)
    if (dwarf === undefined) return
    state.value = adoptLaunchedDwarf(state.value, dwarf.id)
  }

  /**
   * Main's launch-failure push (#263), subscribed exactly like
   * `useDwarfDelivery.listen()` subscribes `onDwarfDeliveryReport`. Applies
   * `launchFailed` unconditionally — its own launchId/launchedDwarfId guard
   * is what keeps a push for a closed, retried or already-adopted launch
   * from touching this panel, so nothing here has to re-check what state
   * the push arrived on.
   */
  function listenFailures(): () => void {
    return window.api.onLaunchFailed((push: LaunchFailedPush) => {
      state.value = launchFailed(state.value, push)
    })
  }

  return {
    state,
    mineId,
    providers,
    chips,
    phase,
    enabled: computed(() => composerEnabled(state.value)),
    placeholder: computed(() => composerPlaceholder(state.value)),
    refusal,
    modelPicker: computed(() => modelPicker(catalogs.value, state.value.choice)),
    effortPicker: computed(() => effortPicker(catalogs.value, state.value.choice)),
    permissionsVisible: computed(() => permissionsVisible(state.value.choice)),
    jev,
    credentialMissing,
    relaunch,
    open,
    close,
    choose,
    setCommand,
    commit,
    setPrompt,
    setModel,
    setEffort,
    setPermissionMode,
    toggleJevEnabled,
    toggleJevAutoAccept: toggleJevAutoAcceptChoice,
    dismissJevDecision,
    submit,
    observe,
    listenFailures
  }
}
