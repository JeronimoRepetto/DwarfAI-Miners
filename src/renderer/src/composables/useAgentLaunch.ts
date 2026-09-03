import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { launchedDwarfIn } from '../lib/launch/launchArrival'
import {
  adoptLaunchedDwarf,
  canSubmit,
  chooseProvider,
  closeLaunch,
  closedLaunch,
  commitCommand,
  composerEnabled,
  composerPlaceholder,
  launchPhase,
  launchPrompt,
  openLaunch,
  startedDetached,
  submitRefused,
  submitStarted,
  typeCommand,
  typePrompt,
  OTHER_CHOICE,
  type LaunchChoice,
  type LaunchPhase,
  type LaunchState
} from '../lib/launch/launchState'
import { launchRefusal, providerChips, type ProviderChip } from '../lib/launch/providerChips'
import { HELDABLE_PROVIDERS } from '../types'
import type { AgentProviderOption, Mine } from '../types'

/**
 * Launching an agent from inside a mine (#86): the IPC, and the state the
 * design's gates are read off.
 *
 * App owns this composable — and therefore the bridge — for the reason it owns
 * every other one: AddPanel stays presentational, and the "render only what
 * main verified" rule lives in one place. The gates themselves are not here at
 * all; they are pure, in lib/launch, so this file is only the parts that need a
 * process on the other end.
 *
 * ## Why the HELD channel and not the detached one
 *
 * Two launch modes exist and both belong. The detached one hands the session
 * over and lets go, so it outlives the panel; the held one keeps the stream and
 * its child dies with the panel. The design decides it: submitting has to open
 * the MessagePanel with the submitted prompt as the first message and then show
 * the agent's first reply there. Only a held session gives the panel words at
 * all — an observed one is read from a transcript, second-hand and a write
 * behind — so a detached launch would open a panel with nothing in it.
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
  open: (mine: string) => Promise<void>
  close: () => void
  choose: (choice: LaunchChoice) => void
  setCommand: (text: string) => void
  commit: () => void
  setPrompt: (text: string) => void
  submit: () => Promise<void>
  observe: (mines: readonly Mine[]) => void
}

export function useAgentLaunch(): AgentLaunch {
  const chips = computed(() => providerChips(providers.value, state.value.choice))
  const phase = computed(() => launchPhase(state.value))
  const refusal = computed(() => launchRefusal(providers.value, state.value.choice))

  /**
   * Open the panel on a mine, and ask what this machine has.
   *
   * Asked per open rather than held from startup: a CLI installed while the
   * panel was running would otherwise never appear, and detection's own TTL
   * makes reopening cost a map lookup rather than a disk walk.
   */
  async function open(mine: string): Promise<void> {
    mineId.value = mine
    state.value = openLaunch(state.value)
    try {
      providers.value = (await window.api.listAgentProviders()).providers
    } catch {
      // The bridge is the only source there is, and an empty list is honest:
      // nothing was detected. Other is appended regardless, so the panel still
      // offers what the design guarantees is always offered.
      providers.value = []
    }
  }

  function close(): void {
    state.value = closeLaunch(state.value)
    mineId.value = null
    providers.value = []
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
  }

  /**
   * Enter on a ready composer.
   *
   * A choice with no engine behind it is refused HERE and never sent. Sending
   * it anyway would start a Claude session for a command the user picked
   * instead of Claude — a launch nobody asked for is worse than a refusal that
   * says why, and it would be a real process in a real folder.
   */
  async function submit(): Promise<void> {
    if (!canSubmit(state.value) || mineId.value === null) return
    const refused = refusal.value
    if (refused !== null) {
      state.value = submitRefused(state.value, refused)
      return
    }

    // Past the refusal above, the choice is a real provider: OTHER_CHOICE is
    // the only non-provider value the union has, and it never gets here. The
    // guard is for the compiler and for anything that changes that later — a
    // launch with no provider named must not be sent at all (#168).
    const provider = state.value.choice
    if (provider === null || provider === OTHER_CHOICE) return

    const prompt = launchPrompt(state.value)
    const held = HELDABLE_PROVIDERS.includes(provider)
    state.value = submitStarted(state.value)
    try {
      const result = held
        ? await window.api.launchHeldSession({ mineId: mineId.value, provider, prompt })
        : await window.api.launchAgent({ mineId: mineId.value, provider, prompt })

      // A verdict of `launched: true` says a session STARTED and nothing more,
      // on either channel. What differs is what can be done with that fact.
      if (!result.launched) {
        state.value = submitRefused(state.value, result.error ?? NOT_LAUNCHED)
        return
      }
      // A held launch waits: its dwarf will arrive carrying the prompt this
      // panel sent, which is the receipt `observe` recognises. A detached one
      // never will — a conversation is held-sessions-only — so the panel stops
      // here and says so rather than watching for something that cannot come.
      if (!held) state.value = startedDetached(state.value)
    } catch {
      state.value = submitRefused(state.value, LOST_BRIDGE)
    }
  }

  /**
   * Every poll, while a launch is in flight: has its dwarf arrived.
   *
   * Recognised by the receipt the launch left on the board rather than by
   * timing — see `launchedDwarfIn` for why that distinction is the whole rule.
   */
  function observe(mines: readonly Mine[]): void {
    if (!state.value.submitting || mineId.value === null) return
    const mine = mines.find((entry) => entry.id === mineId.value)
    const dwarf = launchedDwarfIn(mine, launchPrompt(state.value))
    if (dwarf === undefined) return
    state.value = adoptLaunchedDwarf(state.value, dwarf.id)
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
    open,
    close,
    choose,
    setCommand,
    commit,
    setPrompt,
    submit,
    observe
  }
}
