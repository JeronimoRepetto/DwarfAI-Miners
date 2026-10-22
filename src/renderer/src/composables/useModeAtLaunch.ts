/*
 * Settings › General "Mode at launch" (US-SET-002.AC09; 14 §2.2 A-N20, A-N21, A-N12; ADR-024 items 1, 9; ISSUE-294).
 *
 * - The options are the modes this build ships (`modeAtLaunchOptions`, ADR-034 item 2; BR-19): "Last used", "Panel",
 *   then each other shipped mode. With the Panel alone there is no choice, so nothing is read and no row is drawn.
 * - The row shows what UI main stored (A-N20), never the pick: a pick is written through A-N21 and the row takes the
 *   answer, so a refused write leaves it on the stored value (14 §1.4, ADR-024 item 9).
 * - After a Reset metrics (A-N12) the stored value is read again (14 §3.9, AMENDMENT-1).
 *
 * The bridge is injected (the house idiom over `vi.mock`); `modeAtLaunchPart` gives the window's own over `window.api`.
 */
import { readonly, ref, type Ref } from 'vue'
import type { UiPreferenceKey, UiPreferencesMap, UiPreferenceWrite } from '@dwarfai/contracts'
import {
  modeAtLaunchOptions,
  SHIPPED_MODES,
  type AppMode,
  type ModeAtLaunch
} from '../lib/shell/builtDestinations'

/** The seam A members the row uses (14 §2.2 A-N20, A-N21, A-N12). */
export interface ModeAtLaunchBridge {
  getUiPreferences(request: { keys: UiPreferenceKey[] }): Promise<Partial<UiPreferencesMap>>
  setUiPreference(write: UiPreferenceWrite): Promise<unknown>
  onUiPreferencesReset(h: (e: { epoch: number }) => void): () => void
}

export interface ModeAtLaunchPart {
  /** The options this build offers; none means the row is not drawn. */
  options: ModeAtLaunch[]
  /** What UI main stored; `null` until it answered. */
  value: Readonly<Ref<ModeAtLaunch | null>>
  /** Reads the stored value (A-N20). */
  read(): Promise<void>
  /** Writes a pick (A-N21) and shows what was stored. */
  pick(next: ModeAtLaunch): Promise<void>
  dispose(): void
}

/** A-N21's answer when it stored a "Mode at launch"; anything else (a refusal) is `undefined`. */
function storedPick(answer: unknown): ModeAtLaunch | undefined {
  const write = answer as Partial<UiPreferenceWrite> | null | undefined
  return write?.key === 'modeAtLaunch' ? (write.value as ModeAtLaunch) : undefined
}

export function useModeAtLaunch(deps: {
  bridge: ModeAtLaunchBridge
  shipped: readonly AppMode[]
}): ModeAtLaunchPart {
  const { bridge } = deps
  const options = modeAtLaunchOptions(deps.shipped)
  const value = ref<ModeAtLaunch | null>(null)

  async function read(): Promise<void> {
    if (options.length === 0) return
    try {
      const stored = (await bridge.getUiPreferences({ keys: ['modeAtLaunch'] })).modeAtLaunch
      if (stored !== undefined) value.value = stored
    } catch {
      // Not answered: the row keeps what it shows; the next read or pick tries again.
    }
  }

  async function pick(next: ModeAtLaunch): Promise<void> {
    if (!options.includes(next)) return
    try {
      const stored = storedPick(await bridge.setUiPreference({ key: 'modeAtLaunch', value: next }))
      if (stored !== undefined) value.value = stored
    } catch {
      // Not stored: the row stays on what UI main holds.
    }
  }

  const stopReset = options.length === 0 ? () => {} : bridge.onUiPreferencesReset(() => void read())

  return { options, value: readonly(value), read, pick, dispose: stopReset }
}

/** The window's row over `window.api` and this build's modes; a window without the members has none. */
export function modeAtLaunchPart(): ModeAtLaunchPart {
  const api = typeof window === 'undefined' ? undefined : window.api
  if (
    typeof api?.getUiPreferences !== 'function' ||
    typeof api.onUiPreferencesReset !== 'function'
  ) {
    return {
      options: [],
      value: readonly(ref(null)),
      read: () => Promise.resolve(),
      pick: () => Promise.resolve(),
      dispose: () => {}
    }
  }
  return useModeAtLaunch({ bridge: api, shipped: SHIPPED_MODES })
}
