// CandidateLoginEntry: the window module's port to the candidate login entry (21 §2 cut 1, "Login autostart entry"),
// the one writer of the entry on an OS where S-027-4 has not passed (loginEntryGate.ts) until v1. It is not the frozen
// `AutostartPort` (16 §4.14): it writes today's entry (a Run value on Windows, a LaunchAgent plist on macOS, an XDG
// autostart file on Linux) with no `--background`, exactly as today's runtime did. Adapter `CandidateAutostart`, double
// `FakeCandidateLoginEntry`; both run `runCandidateLoginEntryContract`.

export interface CandidateLoginEntry {
  /** Writes the entry that starts the app at login; rejects when the OS refuses, so the default marker is not written. */
  enable(): Promise<void>
  /**
   * The one-time cleanup of a pre-rename release's entry (only Windows ever had one, the `AgentName` Run value): a
   * legacy value found is removed, and the entry is written under the new name when it was on. Elsewhere nothing.
   * Rejects when the OS refuses.
   */
  migrateLegacy(): Promise<void>
}

/** The once-only default marker: its file exists once the first packaged start turned the entry on. */
export interface CandidateDefaultMarker {
  exists(): Promise<boolean>
  /** Writes the marker; rejects when it already exists or cannot be written. */
  write(): Promise<void>
}
