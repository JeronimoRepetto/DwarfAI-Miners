import {
  DEFAULT_TOGGLE_ACCELERATOR,
  formatAccelerator,
  validateAccelerator,
  type ShortcutPlatform
} from '../shared/accelerator'
import type { ShortcutState } from '../shared/contracts'

/**
 * The global panel toggle, now user-configurable (see #17).
 *
 * Previously this module owned a hardcoded `Control+Alt+Shift+P` and, when the
 * registration failed, told nobody but the console. It is now a small state
 * machine over ONE claim on the OS, and every method answers with the real
 * ShortcutState so the settings panel can render what actually happened.
 *
 * Two invariants shape the whole thing:
 *
 * 1. A failed change costs the user nothing. The previous working combination
 *    is re-claimed and reported; the rejected one is never left in the state.
 * 2. `registered` is only ever the value `globalShortcut.register` returned.
 *    The panel must never show a shortcut as live when the OS refused it.
 *
 * Electron is injected rather than imported so this is testable in plain Node,
 * the same reasoning as src/main/pinPreference.ts.
 */

/** The slice of Electron's `globalShortcut` this module uses. */
export interface GlobalShortcutLike {
  register: (accelerator: string, callback: () => void) => boolean
  unregister: (accelerator: string) => void
  unregisterAll: () => void
}

export interface ToggleShortcutOptions {
  /** The accelerator loaded from the preference store (or the default). */
  initial: string
  /** What the shortcut does; bound directly, so a test can invoke it. */
  onToggle: () => void
  /** Injected Electron surface — `globalShortcut` in production. */
  globalShortcut: GlobalShortcutLike
  /** Which platform's key names appear in the messages shown to the user. */
  platform?: ShortcutPlatform
}

export interface ToggleShortcutController {
  /** Claim the initial accelerator at startup and report what really happened. */
  start: () => ShortcutState
  /** The current state, with no side effects — answers the renderer's initial read. */
  state: () => ShortcutState
  /** Re-bind live, reverting to the last working combination on refusal. */
  apply: (accelerator: string) => ShortcutState
  /** Release every claim (app shutdown). */
  dispose: () => void
}

export function createToggleShortcut(options: ToggleShortcutOptions): ToggleShortcutController {
  const platform = options.platform ?? 'other'
  // A caller could hand us anything (a hand-edited file that slipped past the
  // store, a future config source); falling back to the documented default is
  // better than starting up with no shortcut at all.
  const loaded = validateAccelerator(options.initial)
  let accelerator = loaded.ok ? loaded.accelerator : DEFAULT_TOGGLE_ACCELERATOR
  let registered = false
  let error: string | undefined

  /** A fresh object every time, so a caller mutating it cannot reach back in. */
  function snapshot(): ShortcutState {
    const state: ShortcutState = { accelerator, registered, platform }
    if (error !== undefined) state.error = error
    return state
  }

  /**
   * `register` says no in two different ways: it returns false when another
   * application owns the combination, and it THROWS when its own parser
   * dislikes the string. Both mean the same thing to us.
   */
  function claim(target: string): boolean {
    try {
      return options.globalShortcut.register(target, options.onToggle)
    } catch {
      return false
    }
  }

  function taken(target: string): string {
    return `${formatAccelerator(target, platform)} is already in use by another application.`
  }

  function start(): ShortcutState {
    registered = claim(accelerator)
    error = registered
      ? undefined
      : `${taken(accelerator)} The panel can still be opened from the tray icon.`
    return snapshot()
  }

  function apply(next: string): ShortcutState {
    const validated = validateAccelerator(next)
    if (!validated.ok) {
      // Nothing is released: a request we refuse must never cost the user the
      // shortcut they already had working.
      error = validated.reason
      return snapshot()
    }

    if (validated.accelerator === accelerator && registered) {
      // Already exactly this, and it works. Re-registering would leave the
      // combination briefly unclaimed for no gain.
      error = undefined
      return snapshot()
    }

    const previous = accelerator
    // Release first: on most platforms the new claim would otherwise collide
    // with our own. Skipped when nothing is held (a failed startup), which is
    // also what lets "reset to default" retry a combination that has since
    // been freed by the application that owned it.
    if (registered) options.globalShortcut.unregister(previous)
    registered = false

    if (claim(validated.accelerator)) {
      accelerator = validated.accelerator
      registered = true
      error = undefined
      return snapshot()
    }

    // Refused. Put the user back where they were rather than leaving them with
    // nothing, and report the combination that actually works — never the one
    // they asked for.
    accelerator = previous
    registered = claim(previous)
    const rejected = formatAccelerator(validated.accelerator, platform)
    const kept = formatAccelerator(previous, platform)
    error = registered
      ? `${rejected} is already in use by another application. Still using ${kept}.`
      : `${rejected} is already in use by another application, and ${kept} could not be reclaimed. The panel can still be opened from the tray icon.`
    return snapshot()
  }

  function dispose(): void {
    options.globalShortcut.unregisterAll()
    registered = false
  }

  return { start, state: snapshot, apply, dispose }
}
