/*
 * The redesigned Add panel's words (#635), `organisms/add-panel` in the design: the line beside
 * Send the dwarf in, the three selects of the tuning row, and the names on the supplier chips.
 * Everything here reads the launch model's own answers (launchState, modelTuning); the panel
 * draws it.
 */
import { providerLabel } from '../dwarf/dwarfTip'
import type { EffortPicker, ModelPicker } from './modelTuning'
import { OTHER_CHOICE, type LaunchChoice, type LaunchPhase } from './launchState'
import { HELD_PERMISSION_MODES, type HeldPermissionMode } from '../../types'

export interface AddPanelWhy {
  text: string
  /** A refused launch is an alert; everything else is the panel saying where it stands. */
  tone: 'alert' | 'status'
}

/**
 * The detached launch's own promise (#168, #191), kept word for word from the panel it replaces:
 * its dwarf carries nothing the panel can read, so it is recognised only once main has proved it
 * from the session's own transcript.
 */
export const DETACHED_NOTE =
  'The session started. Its dwarf joins the mine on the next sweep, and this panel opens on it once its transcript proves which one it is.'

/**
 * The line beside Send the dwarf in (screens/launch.md, As built): in order, "Choose a supplier,
 * or let Jev choose." · "Tell the dwarf what to work on." · "Ready. The dwarf walks into <mine>.",
 * and "Sending the dwarf in…" while the launch is in flight — which Jev being asked is part of. A
 * launch main refused says why first, and a chip that cannot start says why before the rest, as
 * the panel's own line always did. A prompt of pure whitespace is no prompt, as main reads it.
 *
 * A launch that failed for a cause the launch-failure notice names (#635) says only "The dwarf did
 * not go in." here (copy.md, Add a dwarf): the notice above it is the alert and says why.
 */
export function addPanelWhy(state: {
  phase: LaunchPhase
  enabled: boolean
  prompt: string
  refusal: string | null
  error: string | null
  mineName: string
  jevAsking: boolean
  /** The launch-failure notice is showing (#635). */
  failed?: boolean
}): AddPanelWhy {
  if (state.error !== null) return { text: state.error, tone: 'alert' }
  if (state.phase === 'started-detached') return { text: DETACHED_NOTE, tone: 'status' }
  if (state.phase === 'submitted-spawning' || state.jevAsking) {
    return { text: 'Sending the dwarf in…', tone: 'status' }
  }
  if (state.failed === true) return { text: 'The dwarf did not go in.', tone: 'status' }
  if (state.refusal !== null) return { text: state.refusal, tone: 'status' }
  if (!state.enabled) return { text: 'Choose a supplier, or let Jev choose.', tone: 'status' }
  if (state.prompt.trim() === '') return { text: 'Tell the dwarf what to work on.', tone: 'status' }
  return { text: 'Ready. The dwarf walks into ' + state.mineName + '.', tone: 'status' }
}

/*
 * The held session's permission modes in the design's words where it has them (sample-data.md,
 * providers: "Ask first", "Accept edits", "Plan only" for Claude). The Agent SDK's other two modes
 * have no word in the design, so they keep the SDK's own, spelled for reading.
 */
const PERMISSION_LABEL: Record<HeldPermissionMode, string> = {
  default: 'Ask first',
  acceptEdits: 'Accept edits',
  plan: 'Plan only',
  dontAsk: "Don't ask",
  auto: 'Auto'
}

export function permissionModeLabel(mode: HeldPermissionMode): string {
  return PERMISSION_LABEL[mode]
}

/** A supplier chip's name: the tool's own, as people know it, and "Other…" for a command. */
export function supplierLabel(choice: LaunchChoice): string {
  return choice === OTHER_CHOICE ? 'Other…' : providerLabel(choice)
}

export interface AddPanelSelect {
  label: 'Model' | 'Effort' | 'Permissions'
  options: { value: string; label: string }[]
  disabled: boolean
  /** The value the launch model holds, which the select shows; none held, its first. */
  value?: string
}

/** What the launch model holds for the three selects (launchState's model, effort, permissionMode). */
export interface AddPanelSelectValues {
  model: string | null
  effort: string | null
  permissionMode: HeldPermissionMode | null
}

/*
 * The one row of selects (screens/launch.md, As built): disabled with "Choose a supplier" until a
 * supplier is picked, "Jev decides" while Jev is on, "Custom" for Other…, since a command has no
 * lists; with a supplier, its own values, prefixed with the select's name ("Model: opus"). A
 * select the supplier has no values for — no effort levels, no permission modes — stays drawn,
 * disabled, on the session's own default, so the row keeps its three parts. Each shows the value
 * the launch model holds — the person's pick, or Jev's (decision log, Jev's pick fills the
 * pickers) — so the row reads as what would launch; a value its list lacks shows the first entry.
 */
export function addPanelSelects(state: {
  choice: LaunchChoice | null
  jevOn: boolean
  modelPicker: ModelPicker
  effortPicker: EffortPicker
  permissionsVisible: boolean
  values?: AddPanelSelectValues
}): AddPanelSelect[] {
  const LABELS = ['Model', 'Effort', 'Permissions'] as const
  const placeholder = (word: string): AddPanelSelect[] =>
    LABELS.map((label) => ({
      label,
      options: [{ value: '', label: label + ': ' + word }],
      disabled: true
    }))
  if (state.jevOn && state.choice === null) return placeholder('Jev decides')
  if (state.choice === null) return placeholder('Choose a supplier')
  if (state.choice === OTHER_CHOICE) return placeholder('Custom')
  const listed = (
    label: AddPanelSelect['label'],
    values: { value: string; label: string }[],
    held: string | null | undefined
  ): AddPanelSelect =>
    values.length === 0
      ? { label, options: [{ value: '', label: label + ': Default' }], disabled: true }
      : {
          label,
          options: values.map((entry) => ({
            value: entry.value,
            label: label + ': ' + entry.label
          })),
          disabled: false,
          ...(held === null || held === undefined ? {} : { value: held })
        }
  const model = listed(
    'Model',
    state.modelPicker.models.map((option) => ({
      value: option.value,
      label: option.label ?? option.value
    })),
    state.values?.model
  )
  return [
    state.modelPicker.disabled ? { ...model, disabled: true } : model,
    listed(
      'Effort',
      state.effortPicker.visible
        ? state.effortPicker.efforts.map((level) => ({ value: level, label: level }))
        : [],
      state.values?.effort
    ),
    listed(
      'Permissions',
      state.permissionsVisible
        ? HELD_PERMISSION_MODES.map((mode) => ({
            value: mode,
            label: PERMISSION_LABEL[mode]
          }))
        : [],
      state.values?.permissionMode
    )
  ]
}
