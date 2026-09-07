import { HELDABLE_PROVIDERS } from '../../types'
import type { AgentModelCatalog, DwarfProvider, ModelOption } from '../../types'
import { OTHER_CHOICE, type LaunchChoice } from './launchState'

/**
 * Shaping the model/effort/permission row under the composer (#239), from
 * whatever `listAgentModels` answered and the chip currently chosen.
 *
 * Pure, like every other file in this folder: what main answered and what is
 * chosen are both plain data by the time they reach here, so the row's own
 * visibility, options and copy are a function of the two — no IPC, no DOM.
 */

/** Fixed copy for a model select main could not fill at all — see AgentModelSource. */
export const NO_MODEL_LIST = 'This provider does not report its models.'
/** Shown beside the select when the list came from history rather than the CLI's own word. */
export const MODEL_HISTORY_SOURCE = 'From this machine’s own history'

/** What the row's model select should draw for the provider currently chosen. */
export interface ModelPicker {
  /**
   * Whether the row belongs on screen at all — `launch.md`'s amendment: only
   * once a real provider chip is selected. Other has no provider identity for
   * a catalogue to answer about, so it never shows this row.
   */
  visible: boolean
  models: ModelOption[]
  /** True when there is nothing this select could honestly offer. */
  disabled: boolean
  /** A refusal reason, or the source note — never both; see AgentModelSource. */
  note: string | null
}

const HIDDEN_MODEL_PICKER: ModelPicker = { visible: false, models: [], disabled: true, note: null }

/**
 * The row's model select, for the chip currently chosen.
 *
 * A catalogue this build could not fill (`source: 'none'`) still shows the
 * select — disabled, with the reason — rather than hiding it: `launch.md`'s
 * amendment says exactly that ("shows the select disabled with the reason"),
 * so a provider without a live list still gets the same row shape as one
 * that answers, just with nothing to choose from it.
 */
export function modelPicker(
  catalogs: readonly AgentModelCatalog[],
  choice: LaunchChoice | null
): ModelPicker {
  if (choice === null || choice === OTHER_CHOICE) return HIDDEN_MODEL_PICKER
  const catalog = catalogs.find((entry) => entry.provider === choice)
  if (catalog === undefined || catalog.source === 'none') {
    return { visible: true, models: [], disabled: true, note: NO_MODEL_LIST }
  }
  return {
    visible: true,
    models: catalog.models,
    disabled: catalog.models.length === 0,
    note: catalog.source === 'history' ? MODEL_HISTORY_SOURCE : null
  }
}

/** What the row's effort select should draw for the provider currently chosen. */
export interface EffortPicker {
  /** `launch.md`: "Effort appears only for a provider that has one." */
  visible: boolean
  efforts: string[]
}

const HIDDEN_EFFORT_PICKER: EffortPicker = { visible: false, efforts: [] }

export function effortPicker(
  catalogs: readonly AgentModelCatalog[],
  choice: LaunchChoice | null
): EffortPicker {
  if (choice === null || choice === OTHER_CHOICE) return HIDDEN_EFFORT_PICKER
  const efforts = catalogs.find((entry) => entry.provider === choice)?.efforts ?? []
  return { visible: efforts.length > 0, efforts }
}

/**
 * Whether the row's Permissions select belongs on screen: `launch.md` —
 * "Permissions appears only for a held Claude session." Held, not merely
 * Claude, because the reasoning is the SDK's `canUseTool` callback existing
 * at all; if a second provider ever became heldable this reads for it too,
 * with no edit here.
 */
export function permissionsVisible(choice: LaunchChoice | null): boolean {
  if (choice === null || choice === OTHER_CHOICE) return false
  return (HELDABLE_PROVIDERS as readonly DwarfProvider[]).includes(choice)
}
