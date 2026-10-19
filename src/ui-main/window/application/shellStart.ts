// The shell's own start work, run once per start before today's runtime is composed (21 §2 cut 5 preparation for
// ISSUE-243): what today's composition (`LegacyRuntimeRoute`) did at its own start and nothing else does, moved into UI
// main unchanged so the legacy runtime can be deleted without a behaviour change (21 §2 cut 5: no behaviour change).
//
// - macOS: the app lives in the tray with a hidden floating Panel, so it owns no Dock tile (`app.dock` exists on macOS
//   only; elsewhere there is nothing to hide).
// - The working folder's `.env` is read into the process environment, quietly, as today's start read it.
// - The candidate login autostart (candidateAutostart.ts), composed only in a packaged build of an OS where S-027-4 has
//   not passed (loginEntryGate.ts): the old writer of the entry until v1 (21 §2 cut 1).
//
// The order is today's: the Dock first, then `.env`, then the login entry.

/** The shell start's work, each part handed in by the Electron root. */
export interface UiShellStartDeps {
  /** Electron's `app.dock`: present on macOS only. */
  dock?: { hide(): void } | undefined
  /** Reads the working folder's `.env` into the process environment, quietly. */
  loadEnvironmentFile(): void
  /** The candidate login autostart, where it is composed (loginEntryGate.ts). */
  candidateAutostart?: () => Promise<void>
}

export interface UiShellStart {
  start(): Promise<void>
}

export function createUiShellStart(deps: UiShellStartDeps): UiShellStart {
  return {
    async start() {
      deps.dock?.hide()
      deps.loadEnvironmentFile()
      await deps.candidateAutostart?.()
    }
  }
}
