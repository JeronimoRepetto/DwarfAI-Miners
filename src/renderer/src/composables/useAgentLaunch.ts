import { computed, ref, shallowRef, type ComputedRef, type Ref } from 'vue'
import type { IpcResult, LaunchAccepted, MineId, SupplierEntryView } from '@dwarfai/contracts'
import { launchedDwarfIn } from '../lib/launch/launchArrival'
import {
  applyLaunchFrame,
  hostLaunchesOf,
  launchInFlight,
  type HostFrame,
  type HostLaunch,
  type HostLaunches
} from '../lib/readModel/launches'
import { createReadModel, followHost, type HostFollower } from './readModel'
import { mintRequestId } from './requestIds'
import { launchSourcesOf } from '../lib/launch/supplierEntries'
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
  hostLaunchAccepted,
  hostLaunchFollowed,
  jevSuggestAnswered,
  jevSuggestAsked,
  jevSuggestParams,
  JEV_NO_CHOICE_REFUSAL,
  launchFailed,
  launchParamsOf,
  customLaunchParamsOf,
  launchPhase,
  launchPrompt,
  openLaunch,
  pickManually as pickManuallyInstead,
  retryLaunch,
  setJevSettings,
  submitRefused,
  submitStarted,
  toggleJev,
  toggleJevAutoAccept,
  typeCommand,
  typePrompt,
  unstatedLaunchTimedOut,
  type JevState,
  type JevSuggestAnswer,
  type LaunchChoice,
  type LaunchPermissionMode,
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
import { DEFAULT_JEV_SETTINGS } from '../types'
import { useHostConnection } from './useHostConnection'
import type {
  AgentModelCatalog,
  AgentProviderOption,
  JevSettings,
  LaunchFailedPush,
  Mine
} from '../types'

/*
 * THE LAUNCHES FROM THE HOST (ISSUE-179 read side, ISSUE-001 part C; ADR-020 D1; ADR-033 item 3; 14 §4.1, §4.3).
 *
 * A read model of the snapshot `launches` section and the `launch.changed` / `launch.failed` frames, driven by
 * `followHost` like the board and the chat (A-N02 first, then A-N01; frames at or below the snapshot seq dropped).
 * - "Sending the dwarf in…" lasts until the Host's event: a launch leaves "in flight" only on `launch.changed` or
 *   `launch.failed`, never on a timer (NFR-TIM-07).
 * - A failure is the Host's `LaunchFailure` as it came (cause, supplier label, actions, tool output tail); the words
 *   are the view's.
 * - A snapshot replaces every launch whole; a launch missing from it is simply gone (14 §4.3 rules 2, 7).
 *
 * From the step-3a switch (ISSUE-001) A-35 goes out with `LaunchParams` for every provider, and the launch it answered
 * settles from here (`hostLaunchFollowed`, after each settled batch); the dock starts this model on mount. Today's A-P3
 * push (`listenFailures`) still settles a launch of a provider not yet moved, served by `PerProviderShapeAdapter`
 * under the `LaunchId` it minted (21 §3.1; legacySettlementJoin.ts).
 */

/** The Host's launches as this composable reads them. Every read is reactive. */
export interface HostLaunchesReader {
  /** Follows the Host's launches; answers whether the Host now feeds them. */
  start(): Promise<boolean>
  /** Stops following and forgets what it held. */
  stop(): void
  of(launchId: string): HostLaunch | undefined
  /** Whether the Host last said this launch is on its way. */
  inFlight(launchId: string): boolean
  /** The launches of one mine, in-flight and failed, as the Host stated them. */
  inMine(mineId: string): HostLaunch[]
}

// Singleton store: module-scope state shared by every useAgentLaunch() caller,
// exactly as the mines, messaging and question stores are. At most one
// Add Panel exists — it shares the MessagePanel's one dock — so there is one
// launch in flight at a time and one place to hold it.
const state = ref<LaunchState>(closedLaunch())

const launches: HostLaunches = new Map()
/** The launches in a reactive mirror, rewritten whenever a snapshot or a batch of frames settled. */
const shownLaunches = shallowRef<ReadonlyMap<string, HostLaunch>>(new Map())

const launchesModel = createReadModel<HostLaunches, HostFrame>({
  state: launches,
  replace(data) {
    launches.clear()
    for (const [launchId, entry] of data) launches.set(launchId, entry)
  },
  apply: (frame) => applyLaunchFrame(launches, frame)
})

let launchesFollower: HostFollower | null = null

const hostLaunches: HostLaunchesReader = {
  start() {
    launchesFollower ??= followHost(
      {
        subscribe: (listener) =>
          window.api.onHostEvent((frames) => listener(frames as HostFrame[])),
        snapshot: (params) => window.api.getHostSnapshot(params)
      },
      {
        model: launchesModel,
        sections: ['launches'],
        dataOf: hostLaunchesOf,
        settled: () => {
          shownLaunches.value = new Map(launches)
          // The panel's own launch, as the Host now states it (07 5A S5.05–S5.07).
          const own = state.value.launchId
          if (own !== null)
            state.value = hostLaunchFollowed(state.value, launches.get(own as never))
        }
      }
    )
    return launchesFollower.start()
  },
  stop() {
    launchesFollower?.stop()
    launchesFollower = null
    launchesModel.seq = 0
    launches.clear()
    shownLaunches.value = new Map()
  },
  of: (launchId) => shownLaunches.value.get(launchId),
  inFlight(launchId) {
    const entry = shownLaunches.value.get(launchId)
    return entry !== undefined && launchInFlight(entry)
  },
  inMine: (mineId) => [...shownLaunches.value.values()].filter((entry) => entry.mineId === mineId)
}

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

const mineId = ref<string | null>(null)
const providers = ref<AgentProviderOption[]>([])
/** What each provider can start on, live (#239) — asked once per open, beside `providers`. */
const catalogs = ref<AgentModelCatalog[]>([])
/** The integration notice's action (ISSUE-228): idle until used, then running, then settled or failed. */
const noticeAction = ref<'idle' | 'enabling' | 'failed'>('idle')
/** Auto-accept paused on a Jev pick of a provider whose permission requests cannot be answered (S5.25). */
const pausedForNotice = ref(false)

const LOST_BRIDGE = 'The panel lost contact with the app.'
const NOT_LAUNCHED = 'The agent could not be started.'

/** A catalogue that could not be asked: no source, as a call error reads (lib/launch/supplierEntries.ts). */
const NO_CATALOGUE: IpcResult<readonly SupplierEntryView[]> = {
  ok: false,
  error: { code: 'INTERNAL', message: 'the catalogue could not be asked', retryable: true }
}

/**
 * The panel's provider entries of an A-36 answer (`launchSourcesOf`), each with the capability fields of its 14 §3.6
 * `SupplierEntryView` the integration notice and the Permissions list read (`answerChannel`, `offeredModes`).
 */
function providerEntriesOf(answer: IpcResult<readonly SupplierEntryView[]>): ProviderEntry[] {
  const views = answer.ok ? answer.value : []
  return launchSourcesOf(answer).providers.map((option) => {
    const view = views.find((entry) => entry.providerId === option.provider)
    return {
      ...option,
      ...(view?.answerChannel === undefined ? {} : { answerChannel: view.answerChannel }),
      ...(view?.offeredModes === undefined ? {} : { offeredModes: [...view.offeredModes] })
    }
  })
}

/** A Jev ask that reached nothing: no card, the pickers as they stood (US-LAUNCH-003.AC08). */
const NO_SUGGESTION: JevSuggestAnswer = {
  ok: false,
  error: { code: 'INTERNAL', message: 'the Jev ask reached nothing', retryable: true }
}

/** Each A-50 ask is numbered; only the answer to the last one may land (INV-87; ISSUE-195). */
let suggestions = 0

export interface AgentLaunch {
  state: Ref<LaunchState>
  /** The Host's launches read model (14 §4.1 `launches`; ISSUE-179 read side). */
  hostLaunches: HostLaunchesReader
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
  open: (mine: string) => Promise<void>
  close: () => void
  choose: (choice: LaunchChoice) => void
  setCommand: (text: string) => void
  commit: () => void
  setPrompt: (text: string) => void
  /** Pick a model off the row under the composer. */
  setModel: (value: string) => void
  setEffort: (value: string) => void
  setPermissionMode: (value: LaunchPermissionMode) => void
  /** The person's own Jev toggle (#509) — a no-op outside `ready`. */
  toggleJevEnabled: () => void
  /** The #523 checkbox beside it — same guard, same no-op, same session. */
  toggleJevAutoAccept: () => void
  /** Dismiss the decision card, restoring the pickers it overwrote (#509). */
  dismissJevDecision: () => void
  submit: () => Promise<void>
  /**
   * The launch-failure notice's Retry (#635): the same launch, sent again, once per press —
   * nothing retries on its own. After a Jev cause that means asking Jev again.
   */
  retry: () => Promise<void>
  /** The notice's Pick manually (#635): Let Jev choose off, so the pickers choose. */
  pickManually: () => void
  observe: (mines: readonly Mine[]) => void
  /**
   * Subscribe to main's launch-failure push (#263). Returns the unsubscribe,
   * exactly like every other `window.api.on*` member — the caller
   * (useMessageDock, which the shell holds for its lifetime) holds it and
   * calls it on unmount.
   */
  listenFailures: () => () => void
  /**
   * The notice over the composer while the chosen provider's permission requests cannot be answered from the app
   * (ADR-011 item 7; 07 5A S5.02): its entry is `answerChannel: 'gated-off'` until its integration is on. `offered`
   * shows the action, `enabling` while the action runs (no launch leaves meanwhile), `failed` when the option did not
   * turn on (the write failed, or the refreshed entry is still gated): the launch still goes out, without an answer
   * channel. The copy is the view's (ADR-011 O-14).
   */
  integrationNotice: ComputedRef<IntegrationNotice>
  /**
   * The Permissions list of the chosen provider as its entry offers it (14 §3.6 `offeredModes`, ADR-011 item 1), the
   * interactive mode ("Ask first") first once its permission requests can be answered; empty when the entry lists none.
   */
  offeredModes: ComputedRef<string[]>
  /**
   * Auto-accept paused on a Jev pick whose permission requests cannot be answered (PO #108; 07 S5.25): the pick is
   * shown as a suggestion with the notice, and nothing launches until the person acts.
   */
  pausedForNotice: ComputedRef<boolean>
  /** Whether Jev's card reads as accepted automatically (`jevCardEyebrow`): auto-accept on and not paused. */
  jevAccepted: ComputedRef<boolean>
  /**
   * The notice's action (07 S5.02, S5.26; US-LAUNCH-001.AC13): turns the option on (A-53, consent origin
   * `add-panel`), then asks the provider list again and redraws the Permissions list from it. Never launches; the
   * person's Send does, after it settled. A no-op while no notice is shown or the action already runs.
   */
  enableIntegration: () => Promise<void>
}

/** What the Add panel's integration notice shows (see `AgentLaunch.integrationNotice`). */
export type IntegrationNotice =
  { shown: false } | { shown: true; state: 'offered' | 'enabling' | 'failed' }

/**
 * A provider entry as the panel reads it: today's A-36 entry, plus the capability fields of 14 §3.6
 * `SupplierEntryView` the A-36 answer carries from its switch (`answerChannel`, `offeredModes`). Today's answer has
 * neither, so its providers show no notice and keep today's Permissions select (hidden until built, 21 §1 item 8).
 */
type ProviderEntry = AgentProviderOption &
  Partial<Pick<SupplierEntryView, 'answerChannel' | 'offeredModes'>>

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
  /** The chosen provider's entry, read for its capabilities (R12: never its id). */
  const chosenEntry = computed((): ProviderEntry | undefined => {
    const choice = state.value.choice
    return choice === null
      ? undefined
      : (providers.value as ProviderEntry[]).find((entry) => entry.provider === choice)
  })
  /** ADR-011 item 7: the chosen provider's permission requests wait for an integration that is off. */
  const gated = computed(() => chosenEntry.value?.answerChannel === 'gated-off')
  const integrationNotice = computed((): IntegrationNotice => {
    if (noticeAction.value === 'enabling') return { shown: true, state: 'enabling' }
    if (!gated.value) return { shown: false }
    return { shown: true, state: noticeAction.value === 'failed' ? 'failed' : 'offered' }
  })

  /** A new choice, an open or a close forgets the notice's last outcome and any pause (07 S5.28). */
  function resetNotice(): void {
    if (noticeAction.value !== 'enabling') noticeAction.value = 'idle'
    pausedForNotice.value = false
  }

  async function enableIntegration(): Promise<void> {
    if (!gated.value || noticeAction.value === 'enabling') return
    noticeAction.value = 'enabling'
    try {
      // A-53 (14 §2.1): the option turns on as if from Settings, with the consent origin `add-panel` (the step-4a
      // switch gave the bridge its target shape, ISSUE-235).
      await window.api.setOpenCodePluginEnabled({
        on: true,
        origin: 'add-panel',
        requestId: mintRequestId()
      })
    } catch {
      // The provider list below tells whether the option turned on; the notice states it when it did not.
    }
    // A-36 again (07 S5.03; ADR-011 item 7 "re-derives its Permissions list"): the entry says whether its
    // permission requests can now be answered, and which modes are offered.
    const answer = await safelyAsk(
      () => window.api.listAgentProviders({ refresh: true }),
      NO_CATALOGUE
    )
    if (answer.ok) providers.value = providerEntriesOf(answer)
    const stillGated = gated.value
    noticeAction.value = stillGated ? 'failed' : 'idle'
    // S5.26: the pick applies and the form is ready; auto-accept does not resume, the person still sends.
    if (!stillGated) pausedForNotice.value = false
  }

  /**
   * Open the panel on a mine, and ask what this machine has.
   *
   * Asked per open rather than held from startup: a CLI installed while the
   * panel was running would otherwise never appear, and detection's own TTL
   * makes reopening cost a map lookup rather than a disk walk.
   *
   * AMENDED for ISSUE-001 (was: today's A-36 and A-37, asked together): from 3a
   * A-36 is the one catalogue (14 §2.1: `{ refresh }` on Add-panel open), every
   * provider's entry with its models (A-37 retired; a provider not yet moved
   * merged in by `CatalogMergeAdapter`, 21 §3.1), read into the chips' and the
   * pickers' own lists (lib/launch/supplierEntries.ts). A bridge that cannot
   * answer degrades to no catalogues, which reads as every model picker showing
   * 'This provider does not report its models.' rather than the panel failing
   * to open at all.
   *
   * Jev's settings verdict (#509) is asked the same way, alongside rather than
   * after — both fire together through `safelyAsk`, so a slow or unreachable Jev
   * answer never holds up the catalogue, and a bridge that cannot answer it
   * degrades to `configured: false`, which reads as the option simply not being
   * offered yet — never a reason to fail the open itself.
   */
  async function open(mine: string): Promise<void> {
    mineId.value = mine
    state.value = openLaunch(state.value)
    resetNotice()
    const [catalogue, jevSettings] = await Promise.all([
      safelyAsk(() => window.api.listAgentProviders({ refresh: true }), NO_CATALOGUE),
      // AMENDED for the #509 follow-up: the fallback carries the documented
      // default's `preferences` too, now that JevSettings always has one.
      safelyAsk<JevSettings>(() => window.api.getJevSettings(), { ...DEFAULT_JEV_SETTINGS })
    ])
    providers.value = providerEntriesOf(catalogue)
    catalogs.value = launchSourcesOf(catalogue).catalogs
    state.value = setJevSettings(state.value, jevSettings)
  }

  function close(): void {
    state.value = closeLaunch(state.value)
    resetNotice()
    mineId.value = null
    providers.value = []
    catalogs.value = []
  }

  function choose(choice: LaunchChoice): void {
    state.value = chooseProvider(state.value, choice)
    resetNotice()
  }

  function setCommand(text: string): void {
    state.value = typeCommand(state.value, text)
  }

  function commit(): void {
    state.value = commitCommand(state.value)
  }

  function setPrompt(text: string): void {
    state.value = typePrompt(state.value, text)
    // A Jev card describes the PROMPT that produced it (#509) — see
    // clearJevDecision's own comment — so editing it drops whatever the last
    // ask left standing and puts back the pickers it overwrote; with Let Jev
    // choose on, the changed prompt is asked about again (ISSUE-195; UC-009 a).
    void suggest()
  }

  /**
   * A-50 in its 14 shape (ISSUE-195; 14 §2.2 `routeJevLaunch(JevSuggestParams)`): the card while typing. The last
   * card goes, and with Let Jev choose on and a prompt written a new ask leaves under its own number; only the answer
   * to the last ask lands (INV-87), so one that arrives after Dismiss, an emptied prompt or a newer ask is dropped. The
   * suggestion lives in this panel's memory only, never a frame and never persisted (11 §6 O-11-11).
   */
  async function suggest(): Promise<void> {
    const request = ++suggestions
    state.value = jevSuggestAsked(state.value, request)
    const mine = mineId.value
    if (state.value.jev.routing.phase !== 'asking' || mine === null) return
    const answer = await safelyAsk(
      () => window.api.routeJevLaunch(jevSuggestParams(state.value, mine as MineId)),
      NO_SUGGESTION
    )
    state.value = jevSuggestAnswered(state.value, request, answer)
  }

  function setModel(value: string): void {
    state.value = chooseModel(state.value, value)
  }

  function setEffort(value: string): void {
    state.value = chooseEffort(state.value, value)
  }

  function setPermissionMode(value: LaunchPermissionMode): void {
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
    // A late answer to the ask Dismiss ends is dropped too (US-LAUNCH-004.AC01): its number is spent.
    suggestions += 1
    state.value = clearJevDecision(state.value)
  }

  /**
   * Enter on a ready composer.
   *
   * A choice with no engine behind it is refused HERE and never sent. Sending
   * it anyway would start a session for a command the user picked instead —
   * a launch nobody asked for is worse than a refusal that says why, and it
   * would be a real process in a real folder.
   *
   * AMENDED for ISSUE-001 (was: today's three channels, the held A-38, the
   * detached A-35 in today's shape and the hosted A-39, and Jev asked at Enter
   * through today's A-50): from 3a A-35 has its 14 shape for every provider
   * (21 §2 cut 3 common rules), `LaunchParams` → `IpcResult<LaunchAccepted>`
   * (`launchParamsOf`), with Let Jev choose on as the Host's Jev way — the Host
   * asks Jev at Send (07 5B S5.10), the card while typing is A-50's (`suggest`).
   * The answer is only the acceptance: the launch stays "Sending the dwarf in…"
   * until the Host states its start, its failure or a hand-back
   * (`hostLaunchFollowed`; 07 5A `sending`, no client timer, NFR-TIM-07). A
   * launch the Host never states — a provider not yet moved, served by
   * `PerProviderShapeAdapter` — settles on today's A-P3 under the same id, or on
   * today's bound (`unstatedLaunchTimedOut`). A Retry names the failed launch
   * (`retryOf`, 07 5A S5.08a).
   *
   * AMENDED for ISSUE-186 (was: Other… on A-39 in today's shape, answered by
   * today's `{ launched }` verdict): from 3d A-39 has its 14 shape too,
   * `LaunchCustomParams` → `IpcResult<LaunchAccepted>` (`customLaunchParamsOf`),
   * so an "Other…" launch is accepted and followed exactly like A-35's: its
   * start, its failure (a refused command included, `could-not-start`) and its
   * Retry are the Host's (21 §2 cut 3d).
   */
  async function submit(retryOf?: string): Promise<void> {
    // Read-only while the Host is not connected (ADR-002 D9; 13 FM-146): nothing leaves. The prompt stays.
    if (useHostConnection().readOnly.value) return
    if (!canSubmit(state.value) || mineId.value === null) return
    // The notice's action is running (ADR-011 item 7; 07 S5.02): the enable completes before any launch is sent.
    if (noticeAction.value === 'enabling') return
    pausedForNotice.value = false

    const refused = refusal.value
    if (refused !== null) {
      state.value = submitRefused(state.value, refused)
      return
    }

    const mine = mineId.value as MineId
    const requestId = mintRequestId()
    const params = launchParamsOf(state.value, mine, requestId, retryOf)
    const custom = customLaunchParamsOf(state.value, mine, requestId, retryOf)
    // A command of the person's own (#194) goes on A-39: it names no provider
    // because there is none — the whole reason it is a channel of its own
    // rather than a nullable field on the launch request — and the Host parses
    // the string into a program plus an argv array, with no shell anywhere
    // (ISSUE-186). Every other launch goes on A-35.
    const send: (() => Promise<IpcResult<LaunchAccepted>>) | null =
      custom !== null
        ? () => window.api.launchHostedProcess(custom)
        : params !== null
          ? () => window.api.launchAgent(params)
          : null
    if (send === null) {
      // #523: only Jev's unlocked composer opens a submit with no chip, and Jev
      // is off by now — the honest refusal, prompt intact, manual path open.
      state.value = submitRefused(state.value, JEV_NO_CHOICE_REFUSAL)
      return
    }
    state.value = submitStarted(state.value)
    try {
      let answer: IpcResult<LaunchAccepted>
      try {
        answer = await send()
      } catch {
        state.value = submitRefused(state.value, LOST_BRIDGE)
        return
      }
      if (!answer.ok) {
        state.value = submitRefused(state.value, NOT_LAUNCHED)
        return
      }
      const { launchId } = answer.value
      state.value = hostLaunchAccepted(state.value, launchId)
      // The Host may have stated it already (its `launch.changed` can arrive before the answer).
      state.value = hostLaunchFollowed(state.value, hostLaunches.of(launchId))
      setTimeout(() => {
        state.value = unstatedLaunchTimedOut(
          state.value,
          launchId,
          hostLaunches.of(launchId) !== undefined
        )
      }, DETACHED_TIMEOUT_MS)
    } catch {
      state.value = submitRefused(state.value, LOST_BRIDGE)
    }
  }

  async function retry(): Promise<void> {
    if (state.value.failure === null) return
    const failed = state.value.launchId ?? undefined
    state.value = retryLaunch(state.value)
    await submit(failed)
  }

  function pickManually(): void {
    state.value = pickManuallyInstead(state.value)
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
   * Main's launch-failure push (#263), subscribed like every other
   * `window.api.on*` member, returning the unsubscribe. Applies
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
    hostLaunches,
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
    submit: () => submit(),
    retry,
    pickManually,
    observe,
    listenFailures,
    integrationNotice,
    offeredModes: computed(() => [...(chosenEntry.value?.offeredModes ?? [])]),
    pausedForNotice: computed(() => pausedForNotice.value),
    jevAccepted: computed(() => state.value.jev.autoAccept && !pausedForNotice.value),
    enableIntegration
  }
}
