import type { z } from 'zod'
import {
  DEFAULT_TOGGLE_ACCELERATOR,
  formatAccelerator,
  validateAccelerator,
  type CHANNELS,
  type ShortcutPlatform
} from '@dwarfai/contracts'
import type { GlobalShortcutRegistry } from '../ports/globalShortcutRegistry'
import type { PanelWindowController } from '../ports/panelWindowController'

/** The A-10 / A-11 answer (14 §2.1, KEEP), taken from the channel registry, never restated. */
export type ShortcutState = z.infer<(typeof CHANNELS)['shortcut:get']['response']>

/**
 * The stored combination: the shortcut's UI-main persisted preference (ADR-024 item 1). It is not a key of
 * `UiPreferencesMap` (14 §3.9), so the use case asks for exactly what it reads and writes; the composition root binds
 * it to the shortcut's JSON store (ISSUE-048's `JsonUiPreferenceStore`, today's `shortcut-preference-v1.json`).
 */
export interface ShortcutPreference {
  /** The stored combination, or the default when none is stored. */
  load(): string
  save(accelerator: string): void
}

export interface ToggleShortcutDeps {
  registry: GlobalShortcutRegistry
  preference: ShortcutPreference
  /** What a press of the shortcut does: show the Panel if hidden, hide it if shown (ISSUE-047). */
  panel: PanelWindowController
  /** Whose key names the error text uses. */
  platform: ShortcutPlatform
}

export interface ToggleShortcut {
  /** Registers the stored (or default) combination and answers what really happened. */
  start(): ShortcutState
  /** The current state, with no side effect (A-10). */
  state(): ShortcutState
  /** Registers `accelerator` in place of the current one, stores the result and answers the real state (A-11). */
  set(accelerator: string): ShortcutState
  /** Releases the held combination (quit). */
  dispose(): void
}

/**
 * The Panel's global shortcut (05 §3.14; 16 §4.14; ADR-024 items 1, 9; 13 FM-047; NFR-PLAT-06), adapted from today's
 * `shell/shortcuts.ts` state machine behind `GlobalShortcutRegistry`. Two rules shape it:
 *
 * 1. `registered` is only ever what `register` answered: the state never shows a combination as working when the OS
 *    refused it (ADR-024 item 9, "the setter answers the real state").
 * 2. A refused change costs the person nothing: the working combination is registered again and reported, and the
 *    refused one is never stored. An invalid accelerator releases nothing.
 *
 * The error texts are today's (KEEP row, legacy failure shape `ShortcutState.error`, 14 §1.5); the General banner and
 * the row help that the renderer shows are its own copy (US-SET-002.AC04).
 */
export function createToggleShortcut(deps: ToggleShortcutDeps): ToggleShortcut {
  const { registry, preference, panel, platform } = deps
  const onFire = (): void => panel.toggleVisible()
  const loaded = validateAccelerator(preference.load())
  let accelerator = loaded.ok ? loaded.accelerator : DEFAULT_TOGGLE_ACCELERATOR
  let registered = false
  let error: string | undefined

  /** A fresh object every time, so a caller cannot reach back into the state. */
  function snapshot(): ShortcutState {
    const state: ShortcutState = { accelerator, registered, platform }
    if (error !== undefined) state.error = error
    return state
  }

  const shown = (accel: string): string => formatAccelerator(accel, platform)

  /** Stores the combination in use; a store that fails leaves the live registration as it is. */
  function store(): void {
    try {
      preference.save(accelerator)
    } catch {
      // The store logs its own failure (16 §4.14 `UiPreferenceStore`); the answer stays the real registration.
    }
  }

  function start(): ShortcutState {
    registered = registry.register(accelerator, onFire)
    error = registered
      ? undefined
      : `${shown(accelerator)} is already in use by another application. The panel can still be opened from the tray icon.`
    return snapshot()
  }

  function set(next: string): ShortcutState {
    const validated = validateAccelerator(next)
    if (!validated.ok) {
      error = validated.reason
      return snapshot()
    }
    if (validated.accelerator === accelerator && registered) {
      // Already exactly this, and it works: re-registering would leave it briefly unclaimed for nothing.
      error = undefined
      return snapshot()
    }

    const previous = accelerator
    // Release first, or the new claim could collide with our own; nothing is held after a failed start.
    if (registered) registry.unregister(previous)
    registered = false

    if (registry.register(validated.accelerator, onFire)) {
      accelerator = validated.accelerator
      registered = true
      error = undefined
      store()
      return snapshot()
    }

    registered = registry.register(previous, onFire)
    error = registered
      ? `${shown(validated.accelerator)} is already in use by another application. Still using ${shown(previous)}.`
      : `${shown(validated.accelerator)} is already in use by another application, and ${shown(previous)} could not be reclaimed. The panel can still be opened from the tray icon.`
    store()
    return snapshot()
  }

  function dispose(): void {
    if (registered) registry.unregister(accelerator)
    registered = false
  }

  return { start, state: snapshot, set, dispose }
}
