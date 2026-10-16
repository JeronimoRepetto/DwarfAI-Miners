import type { LaunchFailure } from './launchState'

/*
 * Machine 5A, the Add-panel form (07 §5A; ISSUE-261): the UI-local half of a launch, from the
 * first field edited to the Host's start or failure event. The Host owns the launch itself
 * (machine 5B); this form only says what the panel may do in each state and which command a
 * gesture sends.
 *
 * Pure: `addPanelForm(state, event)` is the transition table, one row per transition id, and
 * answers `ok: false` for every pair of a state and an event the table does not list, or whose
 * guard does not hold. Each guard is a fact the caller already knows (the Send rule, the Host
 * link, whether the chosen supplier's permission requests are off), passed in rather than read
 * here, so no provider id is compared in the renderer (R12).
 *
 * `addPanelFormStateOf` reads today's launch model (launchState) as a 5A state, which is what the
 * Add panel draws from; `enabling-integration` and `paused-for-notice` are not reachable from it
 * yet, because the OpenCode notice action (ISSUE-228) and Jev's typing-time pick (A-50) are built
 * later. The table holds them already, so the walk proves the whole machine.
 */

export type AddPanelFormState =
  'invalid' | 'ready' | 'enabling-integration' | 'paused-for-notice' | 'sending' | 'failed-shown'

/** A state, or where the form goes when it ends: the new dwarf's MessagePanel, or hidden. */
export type AddPanelFormTarget = AddPanelFormState | 'message-panel' | 'hidden'

export type AddPanelFormTransitionId =
  | 'S5.01'
  | 'S5.02'
  | 'S5.03'
  | 'S5.04'
  | 'S5.05'
  | 'S5.06'
  | 'S5.07'
  | 'S5.08a'
  | 'S5.08b'
  | 'S5.08c'
  | 'S5.08d'
  | 'S5.25'
  | 'S5.26'
  | 'S5.27'
  | 'S5.28'

/** The five launch failure causes (ADR-020 D1), as the renderer's launch-failure notice names them. */
export type AddPanelFormCause = LaunchFailure['cause']

export type AddPanelFormEvent =
  /**
   * A field edited: a chip, a select, the custom command, the prompt, or the Jev card dismissed.
   * `sendRule` is the Send rule after the edit; `gatedSupplierChosen` whether the supplier whose
   * permission requests are off is still the chosen one (S5.28).
   */
  | { type: 'fields-edited'; sendRule: boolean; gatedSupplierChosen?: boolean }
  /** The OpenCode notice's enable action; the guard is the chosen supplier's `answerChannel = 'gated-off'`. */
  | { type: 'notice-action'; integrationGatedOff: boolean }
  /** `IntegrationChanged` from the Host (S14.02 and its siblings). */
  | { type: 'integration-changed' }
  /** Send the dwarf in, or Ctrl+Enter; the guard is the Host link `connected` (12B). */
  | { type: 'send'; hostConnected: boolean }
  /** `DwarfLaunched`. */
  | { type: 'dwarf-launched' }
  /** `LaunchFailed`, with its cause. */
  | { type: 'launch-failed'; cause: AddPanelFormCause }
  /** The Host launch ended `handed-back` (S5.13): Jev's fallback filled the pickers. */
  | { type: 'handed-back' }
  /** The notice's Retry, for the cause it shows. */
  | { type: 'retry'; cause: AddPanelFormCause }
  /** The notice's Pick manually, for the cause it shows and whether a provider can be launched. */
  | { type: 'pick-manually'; cause: AddPanelFormCause; launchableProvider: boolean }
  /** Close. */
  | { type: 'close' }
  /** The Host link went `reconnecting` (12B). */
  | { type: 'host-reconnecting' }
  /** `JevSuggestResult` picked a supplier whose permission requests are off. */
  | { type: 'jev-suggested'; autoAccept: boolean; integrationGatedOff: boolean }

/** What a transition asks for besides its new state. Nothing here cancels a Host launch (S5.08c). */
export type AddPanelFormEffect =
  | { kind: 'update-helper-line' }
  | { kind: 'set-opencode-permissions'; enabled: true; origin: 'add-panel' }
  | { kind: 'rederive-permissions' }
  | { kind: 'launch'; retryOf?: true }
  | { kind: 'become-message-panel' }
  | { kind: 'show-notice'; cause: AddPanelFormCause }
  | { kind: 'show-configured-default' }
  | { kind: 'jev-off' }
  | { kind: 'focus-first-chip' }
  | { kind: 'hide-panel' }
  | { kind: 'show-suggestion' }
  | { kind: 'show-integration-notice' }
  | { kind: 'drop-suggestion' }
  | { kind: 'hide-integration-notice' }

export type AddPanelFormStep =
  | {
      ok: true
      id: AddPanelFormTransitionId
      from: AddPanelFormState
      to: AddPanelFormTarget
      effects: AddPanelFormEffect[]
    }
  | { ok: false; from: AddPanelFormState; event: AddPanelFormEvent['type'] }

/** The PO #104 notice's enable command (S5.02, S5.26): `preferences.setOpenCodePermissions(true,'add-panel')`. */
const ENABLE_PERMISSIONS: AddPanelFormEffect = {
  kind: 'set-opencode-permissions',
  enabled: true,
  origin: 'add-panel'
}

/** Retry is offered for every cause but `jev-could-not-choose`, which a retry cannot change (ADR-020 D8). */
function retryable(cause: AddPanelFormCause): boolean {
  return cause !== 'jev-could-not-choose'
}

/** Pick manually: Jev unreachable, or Jev could not choose with a provider left to pick (ADR-020 D2). */
function manualPickOffered(cause: AddPanelFormCause, launchableProvider: boolean): boolean {
  return cause === 'jev-unreachable' || (cause === 'jev-could-not-choose' && launchableProvider)
}

/** The transition table of 07 §5A. */
export function addPanelForm(state: AddPanelFormState, event: AddPanelFormEvent): AddPanelFormStep {
  const step = (
    id: AddPanelFormTransitionId,
    to: AddPanelFormTarget,
    effects: AddPanelFormEffect[] = []
  ): AddPanelFormStep => ({ ok: true, id, from: state, to, effects })
  const rejected: AddPanelFormStep = { ok: false, from: state, event: event.type }

  // S5.08c, from any state: the panel hides and the Host launch goes on (PO #27; BR-22).
  if (event.type === 'close') return step('S5.08c', 'hidden', [{ kind: 'hide-panel' }])

  switch (state) {
    case 'invalid':
      if (event.type === 'fields-edited') {
        return step('S5.01', event.sendRule ? 'ready' : 'invalid', [{ kind: 'update-helper-line' }])
      }
      return rejected
    case 'ready':
      switch (event.type) {
        case 'fields-edited':
          return step('S5.01', event.sendRule ? 'ready' : 'invalid', [
            { kind: 'update-helper-line' }
          ])
        case 'notice-action':
          return event.integrationGatedOff
            ? step('S5.02', 'enabling-integration', [ENABLE_PERMISSIONS])
            : rejected
        case 'send':
          return event.hostConnected ? step('S5.04', 'sending', [{ kind: 'launch' }]) : rejected
        case 'jev-suggested':
          return event.autoAccept && event.integrationGatedOff
            ? step('S5.25', 'paused-for-notice', [
                { kind: 'show-suggestion' },
                { kind: 'show-integration-notice' }
              ])
            : rejected
        default:
          return rejected
      }
    case 'enabling-integration':
      return event.type === 'integration-changed'
        ? step('S5.03', 'ready', [{ kind: 'rederive-permissions' }])
        : rejected
    case 'paused-for-notice':
      switch (event.type) {
        case 'notice-action':
          return step('S5.26', 'enabling-integration', [ENABLE_PERMISSIONS])
        case 'send':
          return step('S5.27', 'sending', [{ kind: 'launch' }])
        case 'fields-edited':
          return step(
            'S5.28',
            event.sendRule ? 'ready' : 'invalid',
            event.gatedSupplierChosen === true
              ? [{ kind: 'drop-suggestion' }]
              : [{ kind: 'drop-suggestion' }, { kind: 'hide-integration-notice' }]
          )
        default:
          return rejected
      }
    case 'sending':
      switch (event.type) {
        case 'dwarf-launched':
          return step('S5.05', 'message-panel', [{ kind: 'become-message-panel' }])
        case 'launch-failed':
          return step('S5.06', 'failed-shown', [{ kind: 'show-notice', cause: event.cause }])
        case 'handed-back':
          return step('S5.07', 'ready', [{ kind: 'show-configured-default' }])
        case 'host-reconnecting':
          return step('S5.08d', 'sending')
        default:
          return rejected
      }
    case 'failed-shown':
      switch (event.type) {
        case 'retry':
          return retryable(event.cause)
            ? step('S5.08a', 'sending', [{ kind: 'launch', retryOf: true }])
            : rejected
        case 'pick-manually':
          return manualPickOffered(event.cause, event.launchableProvider)
            ? step('S5.08b', 'ready', [{ kind: 'jev-off' }, { kind: 'focus-first-chip' }])
            : rejected
        default:
          return rejected
      }
  }
}

/**
 * The Send rule (07 §5A `ready`): a way to run the dwarf — a supplier, a custom command, or Jev
 * on — and a prompt. A prompt of pure whitespace is no prompt, as the Host reads it.
 */
export function addPanelSendRule(input: { wayToRun: boolean; prompt: string }): boolean {
  return input.wayToRun && input.prompt.trim() !== ''
}

/**
 * Today's launch model read as a 5A state, for the Add panel to draw from: a launch in flight is
 * `sending` (the detached wait for its receipt included), a shown failure notice `failed-shown`,
 * and otherwise the Send rule decides between `ready` and `invalid`.
 */
export function addPanelFormStateOf(view: {
  inFlight: boolean
  failureShown: boolean
  sendRule: boolean
}): AddPanelFormState {
  if (view.inFlight) return 'sending'
  if (view.failureShown) return 'failed-shown'
  return view.sendRule ? 'ready' : 'invalid'
}

/** `sending` disables every control but Close and keeps their values (07 §5A; US-LAUNCH-004.AC04). */
export function addPanelFormLocked(state: AddPanelFormState): boolean {
  return state === 'sending'
}
